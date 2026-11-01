import { ModbusProtocolError } from "./protocol";

export interface SignalConfig {
  unitId: number;
  address: number;
  randomMin: number;
  randomMax: number;
  intervalMs: number;
  durationSeconds: number;
}

export interface ClientTestConfig extends SignalConfig {
  pollIntervalMs: number;
  readbackDelayMs: number;
  stopOnError: boolean;
}

export interface TestConfigs {
  client: ClientTestConfig;
  generator: SignalConfig;
}

export const DEFAULT_TEST_CONFIGS: TestConfigs = {
  client: { unitId: 1, address: 110, randomMin: 1, randomMax: 30000, intervalMs: 2000, durationSeconds: 600, pollIntervalMs: 1000, readbackDelayMs: 100, stopOnError: true },
  generator: { unitId: 1, address: 20, randomMin: 1, randomMax: 30000, intervalMs: 3000, durationSeconds: 600 }
};

export type TestKind = "client" | "generator";
export type TestStatus = "idle" | "running" | "stopping" | "stopped" | "completed" | "faulted";

export interface TestRecord {
  timestamp: string;
  operation: "write-readback" | "poll" | "generate";
  sequence?: number;
  expected?: number[];
  actual?: number[];
  outcome: "match" | "mismatch" | "generated" | "error" | "cancelled";
  elapsedMs: number;
  error?: { code: string; message: string };
}

export interface TestRun {
  id: string;
  kind: TestKind;
  status: TestStatus;
  target: string;
  config: ClientTestConfig | SignalConfig;
  startedAt: string;
  endedAt?: string;
  stopReason?: string;
  stats: {
    cycles: number;
    writeAttempts: number;
    writesAcknowledged: number;
    reads: number;
    matches: number;
    mismatches: number;
    errors: number;
    timeouts: number;
    cancelled: number;
    generated: number;
    peerReads: number;
    peerWrites: number;
    peerErrors: number;
    totalElapsedMs: number;
    maxElapsedMs: number;
  };
  records: TestRecord[];
  recordsDropped: number;
}

export type TestSessions = Record<TestKind, TestRun | null>;

export function parseSignalConfig(value: unknown): SignalConfig {
  if (!value || typeof value !== "object") invalid("测试配置必须是对象。");
  const data = value as Record<string, unknown>;
  const unitId = integer(data.unitId, 1, 247, "Unit ID");
  const address = integer(data.address, 0, 65534, "起始地址（需要连续两个寄存器）");
  const randomMin = integer(data.randomMin, 0, 65535, "随机最小值");
  const randomMax = integer(data.randomMax, 0, 65535, "随机最大值");
  if (randomMin > randomMax) invalid("随机最小值不能大于最大值。");
  return { unitId, address, randomMin, randomMax, intervalMs: integer(data.intervalMs, 250, 60000, "更新间隔 ms"), durationSeconds: integer(data.durationSeconds, 1, 86400, "运行秒数") };
}

export function parseClientTestConfig(value: unknown): ClientTestConfig {
  const base = parseSignalConfig(value);
  const data = value as Record<string, unknown>;
  if (typeof data.stopOnError !== "boolean") invalid("遇错停止必须是布尔值。");
  return { ...base, pollIntervalMs: integer(data.pollIntervalMs, 250, 60000, "读取间隔 ms"), readbackDelayMs: integer(data.readbackDelayMs, 0, 5000, "写后等待 ms"), stopOnError: data.stopOnError };
}

export function parseTestConfigs(value: unknown): TestConfigs {
  if (value === undefined) return structuredClone(DEFAULT_TEST_CONFIGS);
  if (!value || typeof value !== "object") invalid("测试配置格式无效。");
  const data = value as Record<string, unknown>;
  return { client: parseClientTestConfig(data.client), generator: parseSignalConfig(data.generator) };
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) invalid(`${label}必须是 ${min} 到 ${max} 的整数。`);
  return value as number;
}

function invalid(message: string): never { throw new ModbusProtocolError("INVALID_TEST_CONFIG", message); }
