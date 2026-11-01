import type {
  ConnectionConfig,
  ConnectionStatus,
  RequestTrace,
  SlaveDataArea,
  SlaveServerStatus,
  Workspace
} from "../shared/api";
import type { FunctionCode, ModbusRequest, ModbusResult } from "../shared/protocol";
import { roleLabel } from "../shared/role-label";

export type DraftRequest = Workspace["draftRequest"];
export type WorkbenchTab = "master" | "slave" | "verify";
export type ChannelTab = "master" | "slave";
export type DecodeMode =
  | "u16"
  | "i16"
  | "u32-be"
  | "u32-swap"
  | "i32-be"
  | "i32-swap"
  | "f32-be"
  | "f32-swap"
  | "ascii";
export type NumberBase = "dec" | "hex";
export type NoticeTone = "info" | "success" | "warning" | "error";

export interface NoticeState {
  text: string;
  tone: NoticeTone;
}

export interface WatchRuntimeState {
  text: string;
  updatedAt: string;
  isError: boolean;
}

export interface DecodedRow {
  addressLabel: string;
  hexAddress: string;
  rawDec: string;
  rawHex: string;
  decoded: string;
}

export const DEFAULT_CONNECTION: ConnectionConfig = {
  kind: "tcp",
  host: "127.0.0.1",
  port: 502,
  timeoutMs: 1000
};

export const DEFAULT_DRAFT: DraftRequest = {
  unitId: 1,
  functionCode: 3,
  address: 0,
  quantity: 2,
  valuesText: ""
};

export const DEFAULT_SLAVE_SERVERS: Workspace["slave"]["servers"] = {
  tcp: { kind: "tcp", host: "127.0.0.1", port: 5020 },
  rtu: { kind: "rtu", path: "", baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1 }
};

export const FUNCTION_OPTIONS: Array<{ code: FunctionCode; label: string; short: string; write: boolean }> = [
  { code: 1, label: "01 读线圈 (Coils)", short: "FC 01", write: false },
  { code: 2, label: "02 读离散输入 (Discrete Inputs)", short: "FC 02", write: false },
  { code: 3, label: "03 读保持寄存器 (Holding Regs)", short: "FC 03", write: false },
  { code: 4, label: "04 读输入寄存器 (Input Regs)", short: "FC 04", write: false },
  { code: 5, label: "05 写单个线圈 (Write Single Coil)", short: "FC 05", write: true },
  { code: 6, label: "06 写单个寄存器 (Write Single Reg)", short: "FC 06", write: true },
  { code: 15, label: "0F 写多个线圈 (Write Multi Coils)", short: "FC 0F", write: true },
  { code: 16, label: "10 写多个寄存器 (Write Multi Regs)", short: "FC 10", write: true }
];

export const SLAVE_AREAS: Array<{ value: SlaveDataArea; label: string; fcHint: string; writableByPeer: boolean }> = [
  { value: "holdingRegisters", label: "保持寄存器 (4x)", fcHint: "FC 03 / 06 / 10", writableByPeer: true },
  { value: "inputRegisters", label: "输入寄存器 (3x)", fcHint: "FC 04 只读", writableByPeer: false },
  { value: "coils", label: "线圈 (0x)", fcHint: "FC 01 / 05 / 0F", writableByPeer: true },
  { value: "discreteInputs", label: "离散输入 (1x)", fcHint: "FC 02 只读", writableByPeer: false }
];

export const DECODE_OPTIONS: Array<{ value: DecodeMode; label: string }> = [
  { value: "u16", label: "无符号 16 位 (UInt16)" },
  { value: "i16", label: "有符号 16 位 (Int16)" },
  { value: "u32-be", label: "无符号 32 位 · 高字在前 (ABCD)" },
  { value: "u32-swap", label: "无符号 32 位 · 字交换 (CDAB)" },
  { value: "i32-be", label: "有符号 32 位 · 高字在前 (ABCD)" },
  { value: "i32-swap", label: "有符号 32 位 · 字交换 (CDAB)" },
  { value: "f32-be", label: "IEEE 754 浮点 · 高字在前 (ABCD)" },
  { value: "f32-swap", label: "IEEE 754 浮点 · 字交换 (CDAB)" },
  { value: "ascii", label: "ASCII 双字节字符" }
];

export const BAUD_RATE_OPTIONS = [
  300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600
];

export function isWriteCode(code: number): boolean {
  return code === 5 || code === 6 || code === 15 || code === 16;
}

export function isBitCode(code: FunctionCode): boolean {
  return code === 1 || code === 2 || code === 5 || code === 15;
}

export function isBitArea(area: SlaveDataArea): boolean {
  return area === "coils" || area === "discreteInputs";
}

export function validSlavePage(unitId: number, address: number, quantity: number): boolean {
  return (
    Number.isInteger(unitId) &&
    unitId >= 1 &&
    unitId <= 247 &&
    Number.isInteger(address) &&
    address >= 0 &&
    address <= 65535 &&
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= 64 &&
    address + quantity - 1 <= 65535
  );
}

export function rangesOverlap(firstStart: number, firstLength: number, secondStart: number, secondLength: number): boolean {
  return firstStart <= secondStart + secondLength - 1 && secondStart <= firstStart + firstLength - 1;
}

export function statusLabel(status: ConnectionStatus): string {
  return {
    disconnected: "未连接",
    connecting: "正在连接",
    connected: "已连接",
    faulted: "故障",
    closing: "正在关闭"
  }[status];
}

export function slaveStatusLabel(status: SlaveServerStatus): string {
  return {
    stopped: "已停止",
    starting: "正在启动",
    listening: "监听中",
    faulted: "故障",
    stopping: "正在停止"
  }[status];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error).trim();
}

export function formatHex16(value: number): string {
  const clamped = Math.max(0, Math.min(0xffff, value >>> 0));
  return `0x${clamped.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function formatRegister(value: number, base: NumberBase): string {
  if (base === "hex") return formatHex16(value);
  return String(value);
}

export function parseRegisterInput(raw: string, base: NumberBase = "dec"): number {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("请输入寄存器数值。");
  let parsed: number;
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    parsed = Number.parseInt(trimmed.slice(2), 16);
  } else if (base === "hex" && /^[0-9a-f]+$/i.test(trimmed)) {
    parsed = Number.parseInt(trimmed, 16);
  } else if (/^\d+$/.test(trimmed)) {
    parsed = Number.parseInt(trimmed, 10);
  } else {
    throw new Error(base === "hex" ? "请输入有效十六进制值（0x0000–0xFFFF）。" : "寄存器值必须是 0–65535 的整数或 0x 十六进制。");
  }
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("寄存器值超出范围（0–65535 / 0x0000–0xFFFF）。");
  }
  return parsed;
}

export function requestFromDraft(draft: DraftRequest): ModbusRequest {
  const base = {
    unitId: draft.unitId,
    functionCode: draft.functionCode,
    address: draft.address
  };
  if (!isWriteCode(draft.functionCode)) {
    return { ...base, quantity: draft.quantity };
  }
  const tokens = draft.valuesText
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("请填写至少一个要写入的数值。");
  }
  if (draft.functionCode === 5 || draft.functionCode === 15) {
    const values = tokens.map((token) => {
      const lower = token.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "on") return true;
      if (lower === "false" || lower === "0" || lower === "off") return false;
      throw new Error("线圈值只能使用 true/false、1/0 或 on/off。");
    });
    if (draft.functionCode === 5 && values.length !== 1) {
      throw new Error("FC 05（写单个线圈）只能填写 1 个值；多值请改用 FC 0F。");
    }
    return { ...base, values };
  }
  const values = tokens.map((token) => parseRegisterInput(token, "dec"));
  if (draft.functionCode === 6 && values.length !== 1) {
    throw new Error("FC 06（写单个寄存器）只能填写 1 个值；多值请改用 FC 10。");
  }
  return { ...base, values };
}

export function formatPlcAddressHint(areaOrFc: SlaveDataArea | FunctionCode, address: number): string {
  if (!Number.isInteger(address) || address < 0 || address > 65535) return "地址范围 0–65535";
  const hex = formatHex16(address);
  let prefix = 4;
  if (areaOrFc === "coils" || areaOrFc === 1 || areaOrFc === 5 || areaOrFc === 15) prefix = 0;
  else if (areaOrFc === "discreteInputs" || areaOrFc === 2) prefix = 1;
  else if (areaOrFc === "inputRegisters" || areaOrFc === 4) prefix = 3;
  const oneBased = address + 1;
  const classic =
    oneBased <= 9999
      ? `${prefix}${String(oneBased).padStart(4, "0")}`
      : `${prefix}${String(oneBased).padStart(5, "0")}`;
  return `${hex} · 参考 ${classic}`;
}

export function formatTimestampMs(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function formatFunctionCodeHex(code: FunctionCode): string {
  return code.toString(16).toUpperCase().padStart(2, "0");
}

export function summarizeRequest(request: ModbusRequest): string {
  const fc = formatFunctionCodeHex(request.functionCode);
  const count = isWriteCode(request.functionCode) ? (request.values?.length ?? 0) : (request.quantity ?? 1);
  return `FC ${fc} · ID ${request.unitId} · @${request.address}${count > 1 ? ` ×${count}` : ""}`;
}

export function summarizeTrace(trace: RequestTrace): string {
  if (trace.request) {
    const base = summarizeRequest(trace.request);
    return trace.error ? `${base} · ${trace.error.code}` : base;
  }
  return trace.error ? trace.error.code : "协议报文";
}

export function formatWatchResult(result: ModbusResult | undefined): string {
  if (!result) return "无结果";
  if (result.kind === "write") return `已写 @${result.address} ×${result.quantity}`;
  if (result.kind === "bits") {
    return result.values.map((bit) => (bit ? "1 (ON)" : "0 (OFF)")).join(", ");
  }
  return result.values.join(", ");
}

export function buildDecodedRows(result: ModbusResult, startAddress: number, mode: DecodeMode): DecodedRow[] {
  if (result.kind === "write") return [];
  if (result.kind === "bits") {
    return result.values.map((bit, index) => {
      const addr = startAddress + index;
      return {
        addressLabel: String(addr),
        hexAddress: formatHex16(addr),
        rawDec: bit ? "1" : "0",
        rawHex: bit ? "0x01" : "0x00",
        decoded: bit ? "ON (闭合)" : "OFF (断开)"
      };
    });
  }

  const words = result.values;
  if (mode === "u16" || mode === "i16" || mode === "ascii") {
    return words.map((word, index) => {
      const addr = startAddress + index;
      let decoded = String(word);
      if (mode === "i16") {
        decoded = String(word > 0x7fff ? word - 0x10000 : word);
      } else if (mode === "ascii") {
        const hi = (word >>> 8) & 0xff;
        const lo = word & 0xff;
        decoded = `"${printableAscii(hi)}${printableAscii(lo)}"`;
      }
      return {
        addressLabel: String(addr),
        hexAddress: formatHex16(addr),
        rawDec: String(word),
        rawHex: formatHex16(word),
        decoded
      };
    });
  }

  const rows: DecodedRow[] = [];
  for (let index = 0; index < words.length; index += 2) {
    const addr = startAddress + index;
    if (index + 1 >= words.length) {
      rows.push({
        addressLabel: String(addr),
        hexAddress: formatHex16(addr),
        rawDec: String(words[index]),
        rawHex: formatHex16(words[index]),
        decoded: "尾字未配对（32 位解码需偶数个寄存器）"
      });
      break;
    }
    const w0 = words[index];
    const w1 = words[index + 1];
    const first = mode.endsWith("swap") ? w1 : w0;
    const second = mode.endsWith("swap") ? w0 : w1;
    const view = new DataView(new ArrayBuffer(4));
    view.setUint16(0, first, false);
    view.setUint16(2, second, false);

    let decoded: string;
    if (mode.startsWith("f32")) {
      const floatVal = view.getFloat32(0, false);
      decoded = Number.isFinite(floatVal) ? Number(floatVal.toPrecision(7)).toString() : String(floatVal);
    } else if (mode.startsWith("i32")) {
      decoded = String(view.getInt32(0, false));
    } else {
      decoded = String(view.getUint32(0, false));
    }

    rows.push({
      addressLabel: `${addr}–${addr + 1}`,
      hexAddress: `${formatHex16(addr)}`,
      rawDec: `${w0}, ${w1}`,
      rawHex: `${formatHex16(w0)} ${formatHex16(w1)}`,
      decoded
    });
  }
  return rows;
}

function printableAscii(byte: number): string {
  if (byte === 0) return "·";
  if (byte >= 32 && byte <= 126) return String.fromCharCode(byte);
  return `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

export function filterTraces(
  traces: RequestTrace[],
  options: {
    roleFilter: "all" | "master" | "slave";
    statusFilter: "all" | "success" | "error";
    query: string;
  }
): RequestTrace[] {
  const needle = options.query.trim().toLowerCase();
  return traces.filter((trace) => {
    if (options.roleFilter !== "all" && trace.role !== options.roleFilter) return false;
    if (options.statusFilter === "error" && !trace.error) return false;
    if (options.statusFilter === "success" && Boolean(trace.error)) return false;
    if (!needle) return true;

    const roleText = roleLabel(trace.transport, trace.role).toLowerCase();
    const summaryText = summarizeTrace(trace).toLowerCase();
    const rawReq = trace.rawRequest.toLowerCase();
    const rawRes = (trace.rawResponse ?? "").toLowerCase();
    const errText = trace.error ? `${trace.error.code} ${trace.error.message}`.toLowerCase() : "";
    const peerText = (trace.peer ?? "").toLowerCase();

    return (
      roleText.includes(needle) ||
      summaryText.includes(needle) ||
      rawReq.includes(needle) ||
      rawRes.includes(needle) ||
      errText.includes(needle) ||
      peerText.includes(needle)
    );
  });
}

/** Input order is newest first, matching the retained monitor buffer. */
export function summarizeServerWrites(traces: RequestTrace[]): {
  samples: number;
  errors: number;
  latestMs: number | null;
  averageMs: number | null;
  maxMs: number | null;
} {
  const samples = traces.filter((trace) =>
    trace.transport === "tcp" && trace.role === "slave" &&
    isWriteCode(trace.request?.functionCode ?? trace.serverFunctionCode ?? 0) &&
    typeof trace.serverProcessingMs === "number" &&
    Number.isFinite(trace.serverProcessingMs) && trace.serverProcessingMs >= 0
  );
  const timings = samples.map((trace) => trace.serverProcessingMs!);
  return {
    samples: samples.length,
    errors: samples.filter((trace) => Boolean(trace.error)).length,
    latestMs: timings[0] ?? null,
    averageMs: timings.length ? timings.reduce((sum, ms) => sum + ms, 0) / timings.length : null,
    maxMs: timings.length ? Math.max(...timings) : null
  };
}
