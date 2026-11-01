import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEST_CONFIGS, parseClientTestConfig, parseTestConfigs } from "../shared/test-session";
import { ModbusProtocolError, type ModbusRequest } from "../shared/protocol";
import { ModbusService, TcpTransport } from "./modbus-service";
import { ModbusSlaveService } from "./slave-service";
import { TestSessionService } from "./test-session-service";

const config = { ...DEFAULT_TEST_CONFIGS.client, intervalMs: 250, pollIntervalMs: 250, readbackDelayMs: 0, durationSeconds: 10 };
let master: ModbusService;
let slave: ModbusSlaveService;
let tests: TestSessionService;
let remote: number[];
const startClient = (value: unknown, epoch: number) => tests.startClient(value, epoch, tests.authorizationVersion("client"));
const startGenerator = (value: unknown) => tests.startGenerator(value, tests.authorizationVersion("generator"));

beforeEach(async () => {
  vi.useFakeTimers();
  remote = [0, 0];
  vi.spyOn(TcpTransport.prototype, "connect").mockResolvedValue();
  vi.spyOn(TcpTransport.prototype, "request").mockImplementation(async (request) => response(request));
  master = new ModbusService(); slave = new ModbusSlaveService(); tests = new TestSessionService(master, slave);
  await master.connect({ kind: "tcp", host: "127.0.0.1", port: 15020, timeoutMs: 1000 });
});

afterEach(async () => {
  await tests.stopAll("测试清理"); await master.disconnect(); await slave.stopAll();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function response(request: ModbusRequest) {
  if (request.functionCode === 16) remote = [...request.values!] as number[];
  return { rawRequest: Buffer.from([request.functionCode]), rawResponse: Buffer.from([request.functionCode]),
    result: request.functionCode === 16 ? { kind: "write" as const, address: request.address, quantity: 2 } : { kind: "registers" as const, values: [...remote] } };
}

describe("test configuration boundary", () => {
  it("defaults legacy workspaces without restoring any running authorization", () => {
    const parsed = parseTestConfigs(undefined);
    expect(parsed).toEqual(DEFAULT_TEST_CONFIGS);
    expect(parsed).not.toHaveProperty("running");
    parsed.client.address = 42;
    expect(DEFAULT_TEST_CONFIGS.client.address).toBe(110);
  });
  it.each([
    { unitId: 255 }, { address: 65535 }, { address: -1 }, { randomMin: -1 }, { randomMax: 65536 },
    { randomMin: 99, randomMax: 5 }, { intervalMs: NaN }, { intervalMs: 249 }, { intervalMs: 250.5 },
    { durationSeconds: Infinity }, { durationSeconds: 0 }, { pollIntervalMs: 0 }, { readbackDelayMs: 5001 }, { stopOnError: "yes" }
  ])("rejects invalid test parameters %j", (override) => {
    expect(() => parseClientTestConfig({ ...config, ...override })).toThrow(ModbusProtocolError);
  });
  it("allows full register boundaries and fixed values", () => {
    expect(parseClientTestConfig({ ...config, address: 65534, randomMin: 65535, randomMax: 65535 }).randomMax).toBe(65535);
  });
});

describe("main-process scheduled read/write lifecycle", () => {
  it("writes sequences and bounded random values, verifies, polls and keeps the local generator independent", async () => {
    startClient({ ...config, randomMin: 65535, randomMax: 65535 }, master.getSession().epoch);
    startGenerator({ ...DEFAULT_TEST_CONFIGS.generator, intervalMs: 250 });
    await vi.advanceTimersByTimeAsync(800);
    const snapshot = tests.snapshot();
    expect(snapshot.client!.stats.writesAcknowledged).toBeGreaterThanOrEqual(3);
    expect(snapshot.client!.stats.reads).toBeGreaterThan(snapshot.client!.stats.writesAcknowledged);
    expect(snapshot.client!.records.every((record) => record.outcome === "match")).toBe(true);
    expect(snapshot.client!.records.filter((record) => record.operation === "write-readback").map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
    expect(snapshot.client!.records[0].actual).toEqual([1, 65535]);
    expect(snapshot.generator!.stats.generated).toBe(4);
    await tests.stop("client");
    const writes = tests.snapshot().client!.stats.writesAcknowledged;
    await vi.advanceTimersByTimeAsync(600);
    expect(tests.snapshot().client!.stats.writesAcknowledged).toBe(writes);
    expect(tests.snapshot().generator!.stats.generated).toBeGreaterThan(4);
  });

  it("does not send a queued write after stop", async () => {
    vi.mocked(TcpTransport.prototype.request).mockImplementation(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 500)); return response(request);
    });
    const monitor = master.request({ unitId: 1, functionCode: 3, address: 0, quantity: 2 });
    startClient(config, master.getSession().epoch);
    await vi.advanceTimersByTimeAsync(1);
    const stopped = tests.stop("client");
    await vi.advanceTimersByTimeAsync(500);
    await monitor; await stopped;
    expect(vi.mocked(TcpTransport.prototype.request).mock.calls.map(([request]) => request.functionCode)).toEqual([3]);
    expect(tests.snapshot().client!.stats.writeAttempts).toBe(0);
    expect(tests.snapshot().client!.stats.cancelled).toBe(1);
  });

  it("cancels a pending write-read delay and sends no read or next write", async () => {
    startClient({ ...config, readbackDelayMs: 5000 }, master.getSession().epoch);
    await vi.advanceTimersByTimeAsync(0);
    await tests.stop("client");
    await vi.advanceTimersByTimeAsync(6000);
    expect(vi.mocked(TcpTransport.prototype.request).mock.calls.map(([request]) => request.functionCode)).toEqual([16]);
    expect(tests.snapshot().client!.status).toBe("stopped");
    expect(tests.snapshot().client!.stats.writesAcknowledged).toBe(1);
    expect(tests.snapshot().client!.stats.cancelled).toBe(1);
  });

  it("does not overlap or accumulate cycles during slow responses", async () => {
    let active = 0; let maxActive = 0;
    vi.mocked(TcpTransport.prototype.request).mockImplementation(async (request) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 600));
      active -= 1; return response(request);
    });
    startClient(config, master.getSession().epoch);
    await vi.advanceTimersByTimeAsync(3000);
    expect(maxActive).toBe(1);
    expect(tests.snapshot().client!.stats.writeAttempts).toBeLessThanOrEqual(2);
    const stopped = tests.stop("client");
    await vi.advanceTimersByTimeAsync(1500); await stopped;
  });

  it("stops on actual mismatch and retains expected/actual evidence", async () => {
    vi.mocked(TcpTransport.prototype.request).mockImplementation(async (request) => {
      const result = response(request);
      if (result.result.kind === "registers") result.result.values = [0, 0];
      return result;
    });
    startClient(config, master.getSession().epoch);
    await vi.advanceTimersByTimeAsync(1000);
    const run = tests.snapshot().client!;
    expect(run.status).toBe("faulted"); expect(run.stats.mismatches).toBe(1);
    expect(run.records[0].actual).toEqual([0, 0]); expect(run.records[0].expected![0]).toBe(1);
    expect(run.stats.writeAttempts).toBe(1);
  });

  it("separates timeouts from acknowledgements and stops by default", async () => {
    vi.mocked(TcpTransport.prototype.request).mockRejectedValue(new ModbusProtocolError("RESPONSE_TIMEOUT", "模拟超时"));
    startClient(config, master.getSession().epoch);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tests.snapshot().client).toMatchObject({ status: "faulted", stats: { writeAttempts: 1, writesAcknowledged: 0, reads: 0, errors: 1, timeouts: 1 } });
  });

  it("continues with new sequence when stop-on-error is disabled", async () => {
    vi.mocked(TcpTransport.prototype.request).mockRejectedValueOnce(new ModbusProtocolError("RESPONSE_TIMEOUT", "一次超时"));
    startClient({ ...config, stopOnError: false }, master.getSession().epoch);
    await vi.advanceTimersByTimeAsync(600);
    expect(tests.snapshot().client).toMatchObject({ status: "running", stats: { errors: 1, timeouts: 1 } });
    expect(tests.snapshot().client!.stats.matches).toBeGreaterThan(0);
  });

  it("ends at duration, never auto-resumes on reconnect and rejects obsolete confirmation", async () => {
    const original = master.getSession().epoch;
    startClient({ ...config, durationSeconds: 1 }, original);
    await vi.advanceTimersByTimeAsync(1500);
    expect(tests.snapshot().client!.status).toBe("completed");
    const count = vi.mocked(TcpTransport.prototype.request).mock.calls.length;
    await master.connect({ kind: "tcp", host: "127.0.0.1", port: 15021, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(TcpTransport.prototype.request).mock.calls.length).toBe(count);
    expect(() => startClient(config, original)).toThrow(/连接已改变/);
  });

  it("stops active tests on connection change and rejects overlapping starts", async () => {
    startClient(config, master.getSession().epoch);
    expect(() => startClient(config, master.getSession().epoch)).toThrow(/停止当前测试/);
    await master.disconnect(); await vi.advanceTimersByTimeAsync(1000);
    expect(tests.snapshot().client!.status).toBe("stopped");
    expect(vi.mocked(TcpTransport.prototype.request)).not.toHaveBeenCalled();
  });

  it("keeps bounded history, full totals, a cloned snapshot and wraps the sequence", async () => {
    startGenerator({ ...DEFAULT_TEST_CONFIGS.generator, intervalMs: 250, durationSeconds: 86400 });
    await vi.advanceTimersByTimeAsync(65535 * 250);
    const run = tests.snapshot().generator!;
    expect(run.stats.generated).toBe(65536); expect(run.records).toHaveLength(1000);
    expect(run.recordsDropped).toBe(64536); expect(run.records.at(-1)!.sequence).toBe(1);
    run.stats.generated = -1;
    expect(tests.snapshot().generator!.stats.generated).toBe(65536);
  }, 30000);
});

describe("connection generation guards", () => {
  it("does not let an earlier simultaneous connect overwrite the later connection", async () => {
    const first = master.connect({ kind: "tcp", host: "127.0.0.1", port: 15030, timeoutMs: 1000 });
    const second = master.connect({ kind: "tcp", host: "127.0.0.1", port: 15031, timeoutMs: 1000 });
    const result = await Promise.allSettled([first, second]);
    expect(result[0].status).toBe("rejected"); expect(result[1].status).toBe("fulfilled");
    expect(master.getSession().config).toMatchObject({ port: 15031 });
  });

  it("closes an in-progress candidate when disconnected before connect completes", async () => {
    let resolveConnect!: () => void;
    let enteredConnect!: () => void;
    const entered = new Promise<void>((resolve) => { enteredConnect = resolve; });
    vi.mocked(TcpTransport.prototype.connect).mockImplementationOnce(() => new Promise<void>((resolve) => { resolveConnect = resolve; enteredConnect(); }));
    const candidate = master.connect({ kind: "tcp", host: "127.0.0.1", port: 15032, timeoutMs: 1000 });
    const rejected = expect(candidate).rejects.toThrow(/取消或替换/);
    await entered;
    await master.disconnect(); resolveConnect(); await rejected;
    expect(master.getStatus()).toBe("disconnected");
  });

  it("revokes both pending confirmations even when neither test has started", async () => {
    const clientVersion = tests.authorizationVersion("client");
    const generatorVersion = tests.authorizationVersion("generator");
    await tests.stopAll("导入工作区");
    expect(() => tests.startClient(config, master.getSession().epoch, clientVersion)).toThrow(/重新启动并确认/);
    expect(() => tests.startGenerator(DEFAULT_TEST_CONFIGS.generator, generatorVersion)).toThrow(/重新启动并确认/);
  });

  it("revokes accepted manual writes queued in a previous connection", async () => {
    vi.mocked(TcpTransport.prototype.request).mockImplementationOnce(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 500)); return response(request);
    });
    const read = master.request({ unitId: 1, functionCode: 3, address: 0, quantity: 2 });
    const write = { unitId: 1, functionCode: 16 as const, address: 9, values: [1, 2] };
    const prepared = master.prepareWrite(write);
    const queued = master.executeWrite(prepared.token, write);
    const rejected = expect(queued).rejects.toThrow(/原会话排队请求已撤销/);
    await vi.advanceTimersByTimeAsync(1);
    await master.connect({ kind: "tcp", host: "127.0.0.1", port: 15033, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(500); await read; await rejected;
    expect(vi.mocked(TcpTransport.prototype.request).mock.calls.map(([request]) => request.functionCode)).toEqual([3]);
  });
});
