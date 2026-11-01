import { EventEmitter } from "node:events";
import net from "node:net";
import { SerialPort } from "serialport";
import {
  buildExceptionPdu,
  buildResponsePdu,
  crc16,
  expectedRtuRequestFrameLength,
  formatHex,
  ModbusProtocolError,
  parseRequestPdu,
  type ModbusRequest,
  type ModbusResult
} from "../shared/protocol";
import type {
  RequestTrace,
  RtuSlaveServerConfig,
  SlaveDataArea,
  SlaveDataEntry,
  SlaveDataRange,
  SlaveServerConfig,
  SlaveServerStatus,
  SlaveTransportKind,
  TcpSlaveServerConfig
} from "../shared/api";

interface UnitData {
  coils: Uint8Array;
  discreteInputs: Uint8Array;
  holdingRegisters: Uint16Array;
  inputRegisters: Uint16Array;
}

interface ServerSerialPortDevice {
  readonly isOpen: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  open(callback: (error: Error | null | undefined) => void): void;
  write(data: Buffer, callback: (error: Error | null | undefined) => void): void;
  close(callback: (error: Error | null | undefined) => void): void;
}

type SerialPortOptions = ConstructorParameters<typeof SerialPort>[0];
export type SlaveSerialPortFactory = (options: SerialPortOptions) => ServerSerialPortDevice;

const MAX_ADDRESS = 0xffff;

export class SlaveDataStore extends EventEmitter {
  private readonly units = new Map<number, UnitData>();

  read(range: SlaveDataRange): SlaveDataEntry {
    validateRange(range);
    const unit = this.unit(range.unitId);
    const source = unit[range.area];
    const values = Array.from(source.subarray(range.address, range.address + range.quantity), (value) => isBitArea(range.area) ? Boolean(value) : value);
    return { unitId: range.unitId, area: range.area, address: range.address, values: values as boolean[] | number[] };
  }

  write(entry: SlaveDataEntry): void {
    const range: SlaveDataRange = { unitId: entry.unitId, area: entry.area, address: entry.address, quantity: entry.values.length };
    validateRange(range);
    if (isBitArea(entry.area)) {
      if (!entry.values.every((value) => typeof value === "boolean")) throw new ModbusProtocolError("INVALID_SLAVE_DATA", "位数据只能使用 true 或 false。 ");
    } else if (!entry.values.every(isRegisterValue)) {
      throw new ModbusProtocolError("INVALID_SLAVE_DATA", "寄存器数据必须是 0 到 65535 的整数。 ");
    }
    const destination = this.unit(entry.unitId)[entry.area];
    entry.values.forEach((value, index) => { destination[entry.address + index] = typeof value === "boolean" ? Number(value) : value; });
    const changed: SlaveDataEntry = isBitArea(entry.area)
      ? { ...entry, values: [...entry.values] as boolean[] }
      : { ...entry, values: [...entry.values] as number[] };
    this.emit("changed", changed);
  }

  clear(): void {
    this.units.clear();
    this.emit("cleared");
  }

  load(entries: SlaveDataEntry[]): void {
    if (!Array.isArray(entries)) throw new ModbusProtocolError("INVALID_SLAVE_DATA", "本机数据集格式无效。 ");
    this.units.clear();
    for (const entry of entries) this.write(entry);
    this.emit("loaded");
  }

  snapshot(): SlaveDataEntry[] {
    const entries: SlaveDataEntry[] = [];
    for (const [unitId, unit] of this.units) {
      for (const area of ["coils", "discreteInputs", "holdingRegisters", "inputRegisters"] as const) {
        const values = unit[area];
        let cursor = 0;
        while (cursor < values.length) {
          while (cursor < values.length && values[cursor] === 0) cursor += 1;
          if (cursor >= values.length) break;
          const start = cursor;
          const run: Array<boolean | number> = [];
          while (cursor < values.length && values[cursor] !== 0 && run.length < 512) {
            run.push(isBitArea(area) ? Boolean(values[cursor]) : values[cursor]);
            cursor += 1;
          }
          entries.push({ unitId, area, address: start, values: run as boolean[] | number[] });
        }
      }
    }
    return entries;
  }

  execute(request: ModbusRequest): ModbusResult {
    const readRange = (area: SlaveDataArea) => this.read({ unitId: request.unitId, area, address: request.address, quantity: request.quantity! }).values;
    switch (request.functionCode) {
      case 1: return { kind: "bits", values: readRange("coils") as boolean[] };
      case 2: return { kind: "bits", values: readRange("discreteInputs") as boolean[] };
      case 3: return { kind: "registers", values: readRange("holdingRegisters") as number[] };
      case 4: return { kind: "registers", values: readRange("inputRegisters") as number[] };
      case 5:
      case 15:
        this.write({ unitId: request.unitId, area: "coils", address: request.address, values: request.values! as boolean[] });
        return { kind: "write", address: request.address, quantity: request.values!.length };
      case 6:
      case 16:
        this.write({ unitId: request.unitId, area: "holdingRegisters", address: request.address, values: request.values! as number[] });
        return { kind: "write", address: request.address, quantity: request.values!.length };
    }
  }

  private unit(unitId: number): UnitData {
    let unit = this.units.get(unitId);
    if (!unit) {
      unit = {
        coils: new Uint8Array(MAX_ADDRESS + 1),
        discreteInputs: new Uint8Array(MAX_ADDRESS + 1),
        holdingRegisters: new Uint16Array(MAX_ADDRESS + 1),
        inputRegisters: new Uint16Array(MAX_ADDRESS + 1)
      };
      this.units.set(unitId, unit);
    }
    return unit;
  }
}

interface PduHandlingResult {
  request?: ModbusRequest;
  result?: ModbusResult;
  response: Buffer;
  error?: { code: string; message: string };
}

export function handleSlavePdu(store: SlaveDataStore, unitId: number, pdu: Buffer): PduHandlingResult {
  try {
    const request = parseRequestPdu(unitId, pdu);
    const result = store.execute(request);
    return { request, result, response: buildResponsePdu(request, result) };
  } catch (error) {
    const normalized = asError(error);
    const rawFunctionCode = pdu.length > 0 ? pdu.readUInt8(0) : 0;
    return {
      response: buildExceptionPdu(rawFunctionCode, exceptionCodeFor(normalized)),
      error: { code: normalized instanceof ModbusProtocolError ? normalized.code : "SLAVE_DEVICE_FAILURE", message: normalized.message }
    };
  }
}

export class TcpSlaveServer extends EventEmitter {
  private server?: net.Server;
  private readonly clients = new Set<net.Socket>();
  private status: SlaveServerStatus = "stopped";

  constructor(private readonly config: TcpSlaveServerConfig, private readonly store: SlaveDataStore) {
    super();
  }

  getStatus(): SlaveServerStatus {
    return this.status;
  }

  async start(): Promise<void> {
    validateTcpServerConfig(this.config);
    if (this.server) throw new ModbusProtocolError("SLAVE_ALREADY_RUNNING", "Modbus TCP 服务器已在运行。 ");
    this.status = "starting";
    const server = net.createServer((socket) => this.attachClient(socket));
    server.on("error", (error) => {
      this.status = "faulted";
      this.emit("fault", asError(error));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.config.port, this.config.host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      this.server = server;
      this.status = "listening";
    } catch (error) {
      this.status = "faulted";
      server.close();
      throw asError(error);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      this.status = "stopped";
      return;
    }
    this.status = "stopping";
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.status = "stopped";
  }

  private attachClient(socket: net.Socket): void {
    this.clients.add(socket);
    let buffer = Buffer.alloc(0);
    const peer = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`;
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 7) {
        const length = buffer.readUInt16BE(4);
        const frameLength = 6 + length;
        if (buffer.readUInt16BE(2) !== 0 || length < 2 || frameLength > 260) {
          this.emit("trace", malformedTrace("tcp", formatHex(buffer), "MALFORMED_REQUEST", "Modbus TCP MBAP 头无效。 ", peer));
          socket.destroy();
          return;
        }
        if (buffer.length < frameLength) return;
        const frame = buffer.subarray(0, frameLength);
        buffer = buffer.subarray(frameLength);
        // Each complete frame owns its clock, including when several arrive together.
        const startedAt = performance.now();
        const handling = handleSlavePdu(this.store, frame.readUInt8(6), frame.subarray(7));
        const response = Buffer.alloc(7 + handling.response.length);
        frame.copy(response, 0, 0, 4);
        response.writeUInt16BE(handling.response.length + 1, 4);
        response.writeUInt8(frame.readUInt8(6), 6);
        handling.response.copy(response, 7);
        socket.write(response, (error) => {
          // Completion here is local OS submission (or failure), not PLC receipt.
          const serverProcessingMs = Math.max(0, performance.now() - startedAt);
          this.emit("trace", {
            ...traceFromHandling("tcp", frame, response, handling, peer, error ? asError(error) : undefined),
            serverProcessingMs,
            serverFunctionCode: frame.readUInt8(7)
          } satisfies RequestTrace);
        });
      }
    });
  }
}

export class RtuSlaveServer extends EventEmitter {
  private port?: ServerSerialPortDevice;
  private receiveBuffer = Buffer.alloc(0);
  private status: SlaveServerStatus = "stopped";

  constructor(
    private readonly config: RtuSlaveServerConfig,
    private readonly store: SlaveDataStore,
    private readonly createPort: SlaveSerialPortFactory = (options) => new SerialPort(options)
  ) {
    super();
  }

  getStatus(): SlaveServerStatus {
    return this.status;
  }

  async start(): Promise<void> {
    validateRtuServerConfig(this.config);
    if (this.port?.isOpen) throw new ModbusProtocolError("SLAVE_ALREADY_RUNNING", "Modbus RTU 从站已在运行。 ");
    this.status = "starting";
    const { kind: _kind, ...portOptions } = this.config;
    const port = this.createPort({ ...portOptions, autoOpen: false });
    port.on("data", (chunk: Buffer) => this.onData(Buffer.from(chunk)));
    port.on("error", (error: Error) => {
      this.status = "faulted";
      this.emit("fault", asError(error));
    });
    try {
      await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
      this.port = port;
      this.status = "listening";
    } catch (error) {
      this.status = "faulted";
      throw asError(error);
    }
  }

  async stop(): Promise<void> {
    const port = this.port;
    this.port = undefined;
    this.receiveBuffer = Buffer.alloc(0);
    if (!port?.isOpen) {
      this.status = "stopped";
      return;
    }
    this.status = "stopping";
    await new Promise<void>((resolve) => port.close(() => resolve()));
    this.status = "stopped";
  }

  private onData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    while (this.receiveBuffer.length >= 2) {
      const expectedLength = expectedRtuRequestFrameLength(this.receiveBuffer);
      if (expectedLength === undefined) return;
      if (expectedLength > 260) {
        this.receiveBuffer = this.receiveBuffer.subarray(1);
        continue;
      }
      if (this.receiveBuffer.length < expectedLength) return;
      const frame = this.receiveBuffer.subarray(0, expectedLength);
      this.receiveBuffer = this.receiveBuffer.subarray(expectedLength);
      const actualCrc = frame.readUInt16LE(frame.length - 2);
      const expectedCrc = crc16(frame.subarray(0, frame.length - 2));
      if (actualCrc !== expectedCrc) {
        this.emit("trace", malformedTrace("rtu", formatHex(frame), "CRC_MISMATCH", "RTU 请求 CRC 校验失败。 "));
        continue;
      }
      const handling = handleSlavePdu(this.store, frame.readUInt8(0), frame.subarray(1, frame.length - 2));
      const body = Buffer.concat([Buffer.from([frame.readUInt8(0)]), handling.response]);
      const response = Buffer.alloc(body.length + 2);
      body.copy(response);
      response.writeUInt16LE(crc16(body), body.length);
      this.port?.write(response, (error) => this.emit("trace", traceFromHandling("rtu", frame, response, handling, undefined, error ? asError(error) : undefined)));
    }
  }
}

export class ModbusSlaveService extends EventEmitter {
  readonly data = new SlaveDataStore();
  private tcp?: TcpSlaveServer;
  private rtu?: RtuSlaveServer;

  constructor() {
    super();
    this.data.on("changed", (entry: SlaveDataEntry) => this.emit("data-changed", entry));
    this.data.on("cleared", () => this.emit("data-changed", undefined));
  }

  getStatuses(): Record<SlaveTransportKind, SlaveServerStatus> {
    return { tcp: this.tcp?.getStatus() ?? "stopped", rtu: this.rtu?.getStatus() ?? "stopped" };
  }

  async start(config: SlaveServerConfig): Promise<SlaveServerStatus> {
    if (config.kind === "tcp") {
      validateTcpServerConfig(config);
      await this.tcp?.stop();
      const server = new TcpSlaveServer(config, this.data);
      this.forwardServerEvents(server);
      this.tcp = server;
      await server.start();
      return server.getStatus();
    }
    validateRtuServerConfig(config);
    await this.rtu?.stop();
    const server = new RtuSlaveServer(config, this.data);
    this.forwardServerEvents(server);
    this.rtu = server;
    await server.start();
    return server.getStatus();
  }

  async stop(kind: SlaveTransportKind): Promise<SlaveServerStatus> {
    if (kind === "tcp") {
      await this.tcp?.stop();
      this.tcp = undefined;
    } else {
      await this.rtu?.stop();
      this.rtu = undefined;
    }
    return "stopped";
  }

  async stopAll(): Promise<void> {
    await Promise.all([this.stop("tcp"), this.stop("rtu")]);
  }

  readData(range: SlaveDataRange): SlaveDataEntry {
    return this.data.read(range);
  }

  writeData(entry: SlaveDataEntry): void {
    this.data.write(entry);
  }

  dataset(): SlaveDataEntry[] {
    return this.data.snapshot();
  }

  loadDataset(entries: SlaveDataEntry[]): void {
    this.data.load(entries);
  }

  private forwardServerEvents(server: EventEmitter): void {
    server.on("trace", (trace: RequestTrace) => this.emit("trace", trace));
    server.on("fault", (error: Error) => this.emit("fault", error));
  }
}

function traceFromHandling(transport: "tcp" | "rtu", rawRequest: Buffer, rawResponse: Buffer, handling: PduHandlingResult, peer?: string, transportError?: Error): RequestTrace {
  return {
    timestamp: new Date().toISOString(),
    role: "slave",
    transport,
    request: handling.request,
    rawRequest: formatHex(rawRequest),
    rawResponse: formatHex(rawResponse),
    result: handling.result,
    peer,
    error: transportError ? { code: "TRANSPORT_ERROR", message: transportError.message } : handling.error
  };
}

function malformedTrace(transport: "tcp" | "rtu", rawRequest: string, code: string, message: string, peer?: string): RequestTrace {
  return { timestamp: new Date().toISOString(), role: "slave", transport, rawRequest, peer, error: { code, message } };
}

function validateRange(range: SlaveDataRange): void {
  if (!Number.isInteger(range.unitId) || range.unitId < 1 || range.unitId > 247) throw new ModbusProtocolError("INVALID_SLAVE_DATA", "Unit ID 必须是 1 到 247。 ");
  if (!Number.isInteger(range.address) || range.address < 0 || range.address > MAX_ADDRESS) throw new ModbusProtocolError("INVALID_SLAVE_DATA", "数据区起始地址必须是 0 到 65535。 ");
  if (!Number.isInteger(range.quantity) || range.quantity < 1 || range.quantity > MAX_ADDRESS + 1 || range.address + range.quantity - 1 > MAX_ADDRESS) {
    throw new ModbusProtocolError("INVALID_SLAVE_DATA", "数据区数量或地址范围无效。 ");
  }
}

function validateTcpServerConfig(config: TcpSlaveServerConfig): void {
  if (!config.host.trim()) throw new ModbusProtocolError("INVALID_HOST", "TCP 监听地址不能为空。 ");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new ModbusProtocolError("INVALID_PORT", "TCP 监听端口必须是 1 到 65535。 ");
}

function validateRtuServerConfig(config: RtuSlaveServerConfig): void {
  if (!config.path.trim()) throw new ModbusProtocolError("INVALID_SERIAL_PATH", "必须选择串口。 ");
  if (!Number.isInteger(config.baudRate) || config.baudRate < 300 || config.baudRate > 4000000) throw new ModbusProtocolError("INVALID_BAUD_RATE", "波特率必须是 300 到 4000000 的整数。 ");
  if (![5, 6, 7, 8].includes(config.dataBits)) throw new ModbusProtocolError("INVALID_DATA_BITS", "数据位必须为 5、6、7 或 8。 ");
  if (!["none", "even", "odd", "mark", "space"].includes(config.parity)) throw new ModbusProtocolError("INVALID_PARITY", "串口校验参数无效。 ");
  if (![1, 1.5, 2].includes(config.stopBits)) throw new ModbusProtocolError("INVALID_STOP_BITS", "停止位必须为 1、1.5 或 2。 ");
}

function isBitArea(area: SlaveDataArea): boolean {
  return area === "coils" || area === "discreteInputs";
}

function isRegisterValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function exceptionCodeFor(error: Error): number {
  if (!(error instanceof ModbusProtocolError)) return 4;
  if (error.code === "ILLEGAL_FUNCTION") return 1;
  if (error.code === "ILLEGAL_DATA_ADDRESS") return 2;
  if (error.code === "ILLEGAL_DATA_VALUE" || error.code.startsWith("INVALID_")) return 3;
  return 4;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
