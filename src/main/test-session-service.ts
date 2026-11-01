import { EventEmitter } from "node:events";
import { randomInt, randomUUID } from "node:crypto";
import type { RequestTrace } from "../shared/api";
import { ModbusProtocolError } from "../shared/protocol";
import { parseClientTestConfig, parseSignalConfig, type ClientTestConfig, type SignalConfig, type TestKind, type TestRecord, type TestRun, type TestSessions, type TestStatus } from "../shared/test-session";
import { ModbusService } from "./modbus-service";
import { ModbusSlaveService } from "./slave-service";

interface Runtime {
  run: TestRun;
  epoch?: number;
  deadline: number;
  sequence: number;
  expected?: number[];
  nextWriteAt: number;
  nextPollAt: number;
  timer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
  inFlight?: Promise<void>;
  cancelWait?: () => void;
  terminalStatus?: TestStatus;
}

export class TestSessionService extends EventEmitter {
  private readonly runs: Partial<Record<TestKind, Runtime>> = {};
  private readonly authorization = { client: 0, generator: 0 };

  authorizationVersion(kind: TestKind): number { return this.authorization[kind]; }

  constructor(private readonly master: ModbusService, private readonly slave: ModbusSlaveService) {
    super();
    master.on("session-changed", () => { void this.stop("client", "stopped", "请求连接改变，运行授权已撤销。"); });
    slave.on("trace", (trace: RequestTrace) => this.onPeerTrace(trace));
  }

  snapshot(recordLimit = 1000): TestSessions {
    const limited = (runtime: Runtime | undefined) => runtime ? { ...runtime.run, records: runtime.run.records.slice(-recordLimit) } : null;
    return structuredClone({ client: limited(this.runs.client), generator: limited(this.runs.generator) });
  }

  startClient(value: unknown, confirmedEpoch: number, confirmedVersion: number): TestRun {
    this.assertAuthorization("client", confirmedVersion);
    const config = parseClientTestConfig(value);
    const session = this.master.getSession();
    if (session.epoch !== confirmedEpoch) throw new ModbusProtocolError("CONNECTION_CHANGED", "确认期间请求连接已改变，请重新确认。");
    const target = session.config.kind === "tcp" ? `${session.config.host}:${session.config.port}` : session.config.path;
    const runtime = this.createRun("client", config, target);
    runtime.epoch = confirmedEpoch;
    this.scheduleClient(runtime, 0);
    return structuredClone(runtime.run);
  }

  startGenerator(value: unknown, confirmedVersion: number): TestRun {
    this.assertAuthorization("generator", confirmedVersion);
    const config = parseSignalConfig(value);
    const runtime = this.createRun("generator", config, "本机保持寄存器数据区（TCP 服务器/RTU 从站共用）");
    this.generate(runtime);
    return structuredClone(runtime.run);
  }

  async stop(kind: TestKind, status: TestStatus = "stopped", reason = "用户停止；已发送的请求不能撤回。"): Promise<void> {
    if (kind !== "client" && kind !== "generator") throw new ModbusProtocolError("INVALID_TEST_KIND", "测试类型无效。");
    this.authorization[kind] += 1;
    const runtime = this.runs[kind];
    if (!runtime || !["running", "stopping"].includes(runtime.run.status)) return;
    runtime.terminalStatus ??= status;
    runtime.run.stopReason ??= reason;
    runtime.run.status = "stopping";
    clearTimeout(runtime.timer);
    clearTimeout(runtime.deadlineTimer);
    runtime.cancelWait?.();
    this.broadcast();
    await runtime.inFlight;
    this.finish(runtime);
  }

  async stopAll(reason: string): Promise<void> {
    await Promise.all([this.stop("client", "stopped", reason), this.stop("generator", "stopped", reason)]);
  }

  private createRun(kind: TestKind, config: SignalConfig | ClientTestConfig, target: string): Runtime {
    if (this.runs[kind] && ["running", "stopping"].includes(this.runs[kind]!.run.status)) throw new ModbusProtocolError("TEST_ALREADY_RUNNING", "请先停止当前测试。");
    const now = Date.now();
    const runtime: Runtime = {
      run: { id: randomUUID(), kind, status: "running", target, config, startedAt: new Date(now).toISOString(), records: [], recordsDropped: 0,
        stats: { cycles: 0, writeAttempts: 0, writesAcknowledged: 0, reads: 0, matches: 0, mismatches: 0, errors: 0, timeouts: 0, cancelled: 0, generated: 0, peerReads: 0, peerWrites: 0, peerErrors: 0, totalElapsedMs: 0, maxElapsedMs: 0 } },
      deadline: now + config.durationSeconds * 1000, sequence: 0, nextWriteAt: now, nextPollAt: now
    };
    this.runs[kind] = runtime;
    runtime.deadlineTimer = setTimeout(() => { void this.stop(kind, "completed", "达到设定运行时长。"); }, config.durationSeconds * 1000);
    this.broadcast();
    return runtime;
  }

  private assertAuthorization(kind: TestKind, version: number): void {
    if (version !== this.authorization[kind]) throw new ModbusProtocolError("TEST_AUTHORIZATION_REVOKED", "确认期间测试已停止或工作区已改变，请重新启动并确认。");
  }

  private isActive(runtime: Runtime): boolean {
    return this.runs[runtime.run.kind] === runtime && runtime.run.status === "running" && Date.now() < runtime.deadline;
  }

  private scheduleClient(runtime: Runtime, waitMs: number): void {
    runtime.timer = setTimeout(() => {
      if (!this.isActive(runtime)) { void this.stop("client", "completed", "达到设定运行时长。"); return; }
      runtime.inFlight = this.clientCycle(runtime).finally(() => {
        runtime.inFlight = undefined;
        if (runtime.run.status === "stopping") this.finish(runtime);
        else if (this.isActive(runtime)) this.scheduleClient(runtime, Math.max(1, Math.min(runtime.nextWriteAt, runtime.nextPollAt) - Date.now()));
        else if (runtime.run.status === "running") void this.stop("client", "completed", "达到设定运行时长。");
      });
    }, waitMs);
  }

  private async clientCycle(runtime: Runtime): Promise<void> {
    const config = runtime.run.config as ClientTestConfig;
    const writing = Date.now() >= runtime.nextWriteAt;
    const started = performance.now();
    const record: TestRecord = { timestamp: new Date().toISOString(), operation: writing ? "write-readback" : "poll", outcome: "error", elapsedMs: 0 };
    try {
      await this.master.runTestOperation(runtime.epoch!, () => this.isActive(runtime), async (send) => {
        if (writing) {
          runtime.sequence = runtime.sequence % 65535 + 1;
          runtime.expected = [runtime.sequence, randomInt(config.randomMin, config.randomMax + 1)];
          record.sequence = runtime.sequence;
          record.expected = [...runtime.expected];
          runtime.run.stats.writeAttempts += 1;
          await send({ unitId: config.unitId, functionCode: 16, address: config.address, values: [...runtime.expected] });
          runtime.run.stats.writesAcknowledged += 1;
          await this.wait(runtime, config.readbackDelayMs);
        }
        record.sequence = runtime.sequence;
        record.expected = runtime.expected ? [...runtime.expected] : undefined;
        const trace = await send({ unitId: config.unitId, functionCode: 3, address: config.address, quantity: 2 });
        runtime.run.stats.reads += 1;
        if (trace.result?.kind !== "registers") throw new ModbusProtocolError("MALFORMED_RESPONSE", "测试需要保持寄存器响应。");
        record.actual = [...trace.result.values];
        const matched = record.expected?.length === record.actual.length && record.actual.every((value, index) => value === record.expected![index]);
        record.outcome = matched ? "match" : "mismatch";
        if (matched) runtime.run.stats.matches += 1;
        else {
          runtime.run.stats.mismatches += 1;
          if (config.stopOnError) this.markFault(runtime, "读回值与本轮发送值不一致。");
        }
      });
    } catch (error) {
      const code = error instanceof ModbusProtocolError ? error.code : "TRANSPORT_ERROR";
      const cancelled = !this.isActive(runtime) || code === "TEST_CANCELLED" || code === "CONNECTION_CHANGED";
      record.outcome = cancelled ? "cancelled" : "error";
      record.error = { code, message: error instanceof Error ? error.message : String(error) };
      if (cancelled) runtime.run.stats.cancelled += 1;
      else {
        runtime.run.stats.errors += 1;
        if (code.includes("TIMEOUT")) runtime.run.stats.timeouts += 1;
        if (config.stopOnError || ["NOT_CONNECTED", "CONNECTION_CLOSED", "REQUEST_CANCELLED"].includes(code)) this.markFault(runtime, record.error.message);
      }
    } finally {
      record.elapsedMs = Math.round((performance.now() - started) * 10) / 10;
      this.record(runtime, record);
      if (writing) runtime.nextWriteAt = Date.now() + config.intervalMs;
      else runtime.nextPollAt = Date.now() + config.pollIntervalMs;
    }
  }

  private generate(runtime: Runtime): void {
    if (!this.isActive(runtime)) { void this.stop("generator", "completed", "达到设定运行时长。"); return; }
    const config = runtime.run.config;
    const started = performance.now();
    runtime.sequence = runtime.sequence % 65535 + 1;
    const values = [runtime.sequence, randomInt(config.randomMin, config.randomMax + 1)];
    this.slave.writeData({ unitId: config.unitId, area: "holdingRegisters", address: config.address, values });
    runtime.run.stats.generated += 1;
    this.record(runtime, { timestamp: new Date().toISOString(), operation: "generate", sequence: runtime.sequence, expected: values, actual: values, outcome: "generated", elapsedMs: Math.round((performance.now() - started) * 10) / 10 });
    runtime.timer = setTimeout(() => this.generate(runtime), config.intervalMs);
  }

  private onPeerTrace(trace: RequestTrace): void {
    const runtime = this.runs.generator;
    if (!runtime || !this.isActive(runtime) || trace.request?.unitId !== runtime.run.config.unitId) return;
    if (trace.error) runtime.run.stats.peerErrors += 1;
    else if ([1, 2, 3, 4].includes(trace.request.functionCode)) runtime.run.stats.peerReads += 1;
    else runtime.run.stats.peerWrites += 1;
    this.broadcast();
  }

  private wait(runtime: Runtime, ms: number): Promise<void> {
    if (ms === 0 || !this.isActive(runtime)) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); runtime.cancelWait = undefined; resolve(); };
      const timer = setTimeout(finish, ms);
      runtime.cancelWait = finish;
    });
  }

  private markFault(runtime: Runtime, reason: string): void {
    runtime.terminalStatus = "faulted";
    runtime.run.stopReason = reason;
    runtime.run.status = "stopping";
    clearTimeout(runtime.timer);
    clearTimeout(runtime.deadlineTimer);
  }

  private finish(runtime: Runtime): void {
    runtime.run.status = runtime.terminalStatus ?? "stopped";
    runtime.run.endedAt ??= new Date().toISOString();
    clearTimeout(runtime.timer);
    clearTimeout(runtime.deadlineTimer);
    this.broadcast();
  }

  private record(runtime: Runtime, record: TestRecord): void {
    const run = runtime.run;
    run.stats.cycles += 1;
    run.stats.totalElapsedMs += record.elapsedMs;
    run.stats.maxElapsedMs = Math.max(run.stats.maxElapsedMs, record.elapsedMs);
    run.records.push(record);
    if (run.records.length > 1000) { run.records.shift(); run.recordsDropped += 1; }
    this.broadcast();
  }

  private broadcast(): void {
    // UI shows eight recent cycles. Keep full history for explicit fetch/export,
    // rather than cloning and sending 1000 records on every frame/update.
    if (this.listenerCount("changed") > 0) this.emit("changed", this.snapshot(8));
  }
}
