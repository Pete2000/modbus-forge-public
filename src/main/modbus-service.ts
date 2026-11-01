import { EventEmitter } from "node:events";
import net from "node:net";
import { SerialPort } from "serialport";
import { randomUUID } from "node:crypto";
import {
  buildRequestPdu,
  buildRtuFrame,
  expectedRtuFrameLength,
  formatHex,
  isWriteFunction,
  ModbusProtocolError,
  type ModbusRequest,
  parseResponsePdu,
  parseRtuFrame,
  type ModbusResult,
  validateRequest
} from "../shared/protocol";
import type { ConnectionConfig, ConnectionStatus, RequestTrace, RtuConnectionConfig, SerialPortInfo, TcpConnectionConfig } from "../shared/api";

interface TransportResponse {
  rawRequest: Buffer;
  rawResponse: Buffer;
  result: ModbusResult;
}

interface Transport {
  request(request: ModbusRequest): Promise<TransportResponse>;
  close(): Promise<void>;
}

interface PendingTcpRequest {
  transactionId: number;
  unitId: number;
  request: ModbusRequest;
  rawRequest: Buffer;
  resolve: (value: TransportResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class TcpTransport implements Transport {
  private socket?: net.Socket;
  private receiveBuffer = Buffer.alloc(0);
  private pending?: PendingTcpRequest;
  private transactionId = 0;

  constructor(private readonly config: TcpConnectionConfig) {}

  async connect(): Promise<void> {
    if (!this.config.host.trim()) throw new ModbusProtocolError("INVALID_HOST", "TCP 主机不能为空。 ");
    if (!Number.isInteger(this.config.port) || this.config.port < 1 || this.config.port > 65535) {
      throw new ModbusProtocolError("INVALID_PORT", "TCP 端口必须是 1 到 65535 的整数。 ");
    }
    const socket = new net.Socket();
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error) => this.rejectPending(error));
    socket.on("close", () => this.rejectPending(new ModbusProtocolError("CONNECTION_CLOSED", "TCP 连接已关闭。 ")));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ModbusProtocolError("CONNECT_TIMEOUT", "TCP 连接超时。 "));
      }, this.config.timeoutMs);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.connect(this.config.port, this.config.host, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.socket = socket;
  }

  request(request: ModbusRequest): Promise<TransportResponse> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new ModbusProtocolError("NOT_CONNECTED", "TCP 尚未连接。 "));
    if (this.pending) return Promise.reject(new ModbusProtocolError("TRANSPORT_BUSY", "TCP 传输层已有进行中的请求。 "));
    const transactionId = this.nextTransactionId();
    const pdu = buildRequestPdu(request);
    const rawRequest = Buffer.alloc(7 + pdu.length);
    rawRequest.writeUInt16BE(transactionId, 0);
    rawRequest.writeUInt16BE(0, 2);
    rawRequest.writeUInt16BE(pdu.length + 1, 4);
    rawRequest.writeUInt8(request.unitId, 6);
    pdu.copy(rawRequest, 7);

    return new Promise<TransportResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectPending(new ModbusProtocolError("RESPONSE_TIMEOUT", "等待 Modbus TCP 响应超时。 ")), this.config.timeoutMs);
      this.pending = { transactionId, unitId: request.unitId, request, rawRequest, resolve, reject, timer };
      this.socket!.write(rawRequest, (error) => {
        if (error) this.rejectPending(error);
      });
    });
  }

  async close(): Promise<void> {
    this.rejectPending(new ModbusProtocolError("REQUEST_CANCELLED", "连接关闭，已取消等待中的请求。 "));
    const socket = this.socket;
    this.socket = undefined;
    this.receiveBuffer = Buffer.alloc(0);
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.end(() => socket.destroy());
    });
  }

  private onData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    while (this.receiveBuffer.length >= 7) {
      const length = this.receiveBuffer.readUInt16BE(4);
      const frameLength = 6 + length;
      if (length < 2 || frameLength > 260) {
        this.receiveBuffer = Buffer.alloc(0);
        this.rejectPending(new ModbusProtocolError("MALFORMED_RESPONSE", "TCP MBAP 长度字段无效。 "));
        return;
      }
      if (this.receiveBuffer.length < frameLength) return;
      const frame = this.receiveBuffer.subarray(0, frameLength);
      this.receiveBuffer = this.receiveBuffer.subarray(frameLength);
      const pending = this.pending;
      if (!pending) continue;
      const transactionId = frame.readUInt16BE(0);
      const unitId = frame.readUInt8(6);
      if (transactionId !== pending.transactionId || unitId !== pending.unitId) {
        this.rejectPending(new ModbusProtocolError("RESPONSE_MISMATCH", "收到不属于当前请求的 Modbus TCP 响应。 "));
        return;
      }
      try {
        const result = parseResponsePdu(pending.request, frame.subarray(7));
        this.resolvePending({ rawRequest: pending.rawRequest, rawResponse: frame, result });
      } catch (error) {
        this.rejectPending(asError(error));
      }
    }
  }

  private nextTransactionId(): number {
    this.transactionId = this.transactionId === 0xffff ? 1 : this.transactionId + 1;
    return this.transactionId;
  }

  private resolvePending(value: TransportResponse): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

interface PendingRtuRequest {
  request: ModbusRequest;
  rawRequest: Buffer;
  resolve: (value: TransportResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SerialPortDevice {
  readonly isOpen: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  open(callback: (error: Error | null | undefined) => void): void;
  write(data: Buffer, callback: (error: Error | null | undefined) => void): void;
  drain(callback: (error: Error | null | undefined) => void): void;
  close(callback: (error: Error | null | undefined) => void): void;
}

type SerialPortOptions = ConstructorParameters<typeof SerialPort>[0];
export type SerialPortFactory = (options: SerialPortOptions) => SerialPortDevice;

export class RtuTransport implements Transport {
  private port?: SerialPortDevice;
  private receiveBuffer = Buffer.alloc(0);
  private pending?: PendingRtuRequest;

  constructor(
    private readonly config: RtuConnectionConfig,
    private readonly createPort: SerialPortFactory = (options) => new SerialPort(options)
  ) {}

  async connect(): Promise<void> {
    if (!this.config.path.trim()) throw new ModbusProtocolError("INVALID_SERIAL_PATH", "必须选择串口。 ");
    if (!Number.isInteger(this.config.baudRate) || this.config.baudRate < 300) throw new ModbusProtocolError("INVALID_BAUD_RATE", "波特率无效。 ");
    const { kind: _kind, timeoutMs: _timeoutMs, ...portOptions } = this.config;
    const port = this.createPort({ ...portOptions, autoOpen: false });
    port.on("data", (chunk: Buffer) => this.onData(chunk));
    port.on("error", (error) => this.rejectPending(error));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ModbusProtocolError("CONNECT_TIMEOUT", "打开串口超时。 ")), this.config.timeoutMs);
      port.open((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
    this.port = port;
  }

  request(request: ModbusRequest): Promise<TransportResponse> {
    if (!this.port?.isOpen) return Promise.reject(new ModbusProtocolError("NOT_CONNECTED", "串口尚未打开。 "));
    if (this.pending) return Promise.reject(new ModbusProtocolError("TRANSPORT_BUSY", "RTU 传输层已有进行中的请求。 "));
    const rawRequest = buildRtuFrame(request);
    this.receiveBuffer = Buffer.alloc(0);
    return new Promise<TransportResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectPending(new ModbusProtocolError("RESPONSE_TIMEOUT", "等待 Modbus RTU 响应超时。 ")), this.config.timeoutMs);
      this.pending = { request, rawRequest, resolve, reject, timer };
      this.port!.write(rawRequest, (error) => {
        if (error) {
          this.rejectPending(error);
          return;
        }
        this.port!.drain((drainError) => {
          if (drainError) this.rejectPending(drainError);
        });
      });
    });
  }

  async close(): Promise<void> {
    this.rejectPending(new ModbusProtocolError("REQUEST_CANCELLED", "连接关闭，已取消等待中的请求。 "));
    const port = this.port;
    this.port = undefined;
    this.receiveBuffer = Buffer.alloc(0);
    if (!port?.isOpen) return;
    await new Promise<void>((resolve) => port.close(() => resolve()));
  }

  private onData(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    const pending = this.pending;
    if (!pending) return;
    while (this.receiveBuffer.length > 0) {
      const offset = this.receiveBuffer.indexOf(pending.request.unitId);
      if (offset === -1) {
        this.receiveBuffer = Buffer.alloc(0);
        return;
      }
      if (offset > 0) this.receiveBuffer = this.receiveBuffer.subarray(offset);
      const expectedLength = expectedRtuFrameLength(this.receiveBuffer);
      if (expectedLength === undefined || this.receiveBuffer.length < expectedLength) return;
      const frame = this.receiveBuffer.subarray(0, expectedLength);
      this.receiveBuffer = this.receiveBuffer.subarray(expectedLength);
      try {
        const result = parseRtuFrame(pending.request, frame);
        this.resolvePending({ rawRequest: pending.rawRequest, rawResponse: frame, result });
      } catch (error) {
        this.rejectPending(asError(error));
      }
      return;
    }
  }

  private resolvePending(value: TransportResponse): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

interface WritePermission {
  requestSignature: string;
  expiresAt: number;
}

export class ModbusService extends EventEmitter {
  private transport?: Transport;
  private config?: ConnectionConfig;
  private status: ConnectionStatus = "disconnected";
  private queue: Promise<void> = Promise.resolve();
  private readonly writePermissions = new Map<string, WritePermission>();
  private epoch = 0;

  getSession(): { epoch: number; config: ConnectionConfig } {
    if (!this.config || this.status !== "connected") throw new ModbusProtocolError("NOT_CONNECTED", "请先建立连接。 ");
    return { epoch: this.epoch, config: { ...this.config } };
  }

  // Test operations share the manual/monitor queue. Every send checks the connection
  // generation and the run's cancellation/deadline guard, including queued writes.
  runTestOperation<T>(epoch: number, isActive: () => boolean, operation: (send: (request: ModbusRequest) => Promise<RequestTrace>) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const send = (request: ModbusRequest): Promise<RequestTrace> => {
        this.assertEpoch(epoch);
        if (!isActive()) throw new ModbusProtocolError("TEST_CANCELLED", "测试已停止，未发送后续请求。");
        validateRequest(request);
        return this.performRequest(request);
      };
      this.assertEpoch(epoch);
      if (!isActive()) throw new ModbusProtocolError("TEST_CANCELLED", "测试已停止，未发送排队请求。");
      return operation(send);
    });
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  async connect(config: ConnectionConfig): Promise<ConnectionStatus> {
    validateConnectionConfig(config);
    const epoch = this.epoch + 1;
    await this.disconnect();
    this.assertEpoch(epoch);
    this.status = "connecting";
    try {
      const transport = config.kind === "tcp" ? new TcpTransport(config) : new RtuTransport(config);
      if (transport instanceof TcpTransport || transport instanceof RtuTransport) await transport.connect();
      if (epoch !== this.epoch) {
        await transport.close();
        throw new ModbusProtocolError("CONNECTION_CHANGED", "连接操作已被取消或替换。");
      }
      this.transport = transport;
      this.config = { ...config };
      this.status = "connected";
      return this.status;
    } catch (error) {
      if (epoch === this.epoch) this.status = "faulted";
      throw asError(error);
    }
  }

  async disconnect(): Promise<ConnectionStatus> {
    this.epoch += 1;
    const epoch = this.epoch;
    this.emit("session-changed");
    this.status = this.transport ? "closing" : "disconnected";
    this.writePermissions.clear();
    const transport = this.transport;
    this.transport = undefined;
    this.config = undefined;
    if (transport) await transport.close();
    if (epoch === this.epoch) this.status = "disconnected";
    return this.status;
  }

  async request(request: ModbusRequest): Promise<RequestTrace> {
    validateRequest(request);
    if (isWriteFunction(request.functionCode)) {
      throw new ModbusProtocolError("WRITE_CONFIRMATION_REQUIRED", "写入请求必须先调用 prepareWrite 并取得一次性确认令牌。 ");
    }
    const epoch = this.epoch;
    return this.enqueue(() => { this.assertEpoch(epoch); return this.performRequest(request); });
  }

  prepareWrite(request: ModbusRequest): { token: string; summary: string; expiresAt: string } {
    validateRequest(request);
    if (!isWriteFunction(request.functionCode)) throw new ModbusProtocolError("NOT_A_WRITE", "只有写入功能码需要确认。 ");
    if (!this.transport || !this.config) throw new ModbusProtocolError("NOT_CONNECTED", "请先建立连接。 ");
    const token = randomUUID();
    const expiresAt = Date.now() + 60_000;
    this.writePermissions.set(token, { requestSignature: signatureFor(request), expiresAt });
    const target = this.config.kind === "tcp" ? `${this.config.host}:${this.config.port}` : this.config.path;
    const valueText = request.values!.join(", ");
    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      summary: `即将向 ${target} 的${this.config.kind === "tcp" ? "服务器 Unit ID" : "RTU 从站地址"} ${request.unitId} 写入：功能码 ${request.functionCode}，地址 ${request.address}，值 [${valueText}]。请确认目标设备允许此操作。`
    };
  }

  async executeWrite(token: string, request: ModbusRequest): Promise<RequestTrace> {
    validateRequest(request);
    const permission = this.writePermissions.get(token);
    this.writePermissions.delete(token);
    if (!permission || permission.expiresAt < Date.now() || permission.requestSignature !== signatureFor(request)) {
      throw new ModbusProtocolError("WRITE_CONFIRMATION_INVALID", "写入确认已失效、已使用或与当前请求不匹配。 ");
    }
    const epoch = this.epoch;
    return this.enqueue(() => { this.assertEpoch(epoch); return this.performRequest(request); });
  }

  cancelWrite(token: string, request: ModbusRequest): void {
    const permission = this.writePermissions.get(token);
    this.writePermissions.delete(token);
    if (!permission || permission.requestSignature !== signatureFor(request)) {
      throw new ModbusProtocolError("WRITE_CONFIRMATION_INVALID", "写入确认已失效、已使用或与当前请求不匹配。 ");
    }
    const trace: RequestTrace = {
      timestamp: new Date().toISOString(),
      role: "master",
      transport: this.config?.kind ?? "tcp",
      request,
      rawRequest: formatHex(this.config?.kind === "rtu" ? buildRtuFrame(request) : buildRequestPdu(request)),
      error: { code: "WRITE_CANCELLED", message: "用户取消了写入确认；未发送写入报文。" }
    };
    this.emit("trace", trace);
  }

  async cancelActiveRequest(): Promise<ConnectionStatus> {
    await this.disconnect();
    return this.status;
  }

  async listSerialPorts(): Promise<SerialPortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      vendorId: port.vendorId,
      productId: port.productId
    }));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const operationPromise = this.queue.then(operation, operation);
    this.queue = operationPromise.then(() => undefined, () => undefined);
    return operationPromise;
  }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new ModbusProtocolError("CONNECTION_CHANGED", "连接已改变，原会话排队请求已撤销。");
  }

  private async performRequest(request: ModbusRequest): Promise<RequestTrace> {
    if (!this.transport || !this.config || this.status !== "connected") throw new ModbusProtocolError("NOT_CONNECTED", "请先建立连接。 ");
    const timestamp = new Date().toISOString();
    const startedAt = performance.now();
    const transportKind = this.config.kind;
    try {
      const response = await this.transport.request(request);
      const trace: RequestTrace = {
        timestamp,
        role: "master",
        transport: transportKind,
        request,
        rawRequest: formatHex(response.rawRequest),
        rawResponse: formatHex(response.rawResponse),
        result: response.result,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
      };
      this.emit("trace", trace);
      return trace;
    } catch (error) {
      const normalized = asError(error);
      const trace: RequestTrace = {
        timestamp,
        role: "master",
        transport: transportKind,
        request,
        rawRequest: formatHex(transportKind === "rtu" ? buildRtuFrame(request) : buildRequestPdu(request)),
        error: { code: normalized instanceof ModbusProtocolError ? normalized.code : "TRANSPORT_ERROR", message: normalized.message },
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
      };
      this.emit("trace", trace);
      throw normalized;
    }
  }
}

function signatureFor(request: ModbusRequest): string {
  return JSON.stringify({ ...request, values: request.values ? [...request.values] : undefined });
}

function validateConnectionConfig(config: ConnectionConfig): void {
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 120000) {
    throw new ModbusProtocolError("INVALID_TIMEOUT", "超时必须是 100 到 120000 毫秒的整数。 ");
  }
  if (config.kind === "tcp") {
    if (!config.host.trim()) throw new ModbusProtocolError("INVALID_HOST", "TCP 主机不能为空。 ");
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new ModbusProtocolError("INVALID_PORT", "TCP 端口必须是 1 到 65535 的整数。 ");
    }
    return;
  }
  if (!config.path.trim()) throw new ModbusProtocolError("INVALID_SERIAL_PATH", "必须选择串口。 ");
  if (!Number.isInteger(config.baudRate) || config.baudRate < 300 || config.baudRate > 4000000) {
    throw new ModbusProtocolError("INVALID_BAUD_RATE", "波特率必须是 300 到 4000000 的整数。 ");
  }
  if (![5, 6, 7, 8].includes(config.dataBits)) throw new ModbusProtocolError("INVALID_DATA_BITS", "数据位必须为 5、6、7 或 8。 ");
  if (!["none", "even", "odd", "mark", "space"].includes(config.parity)) throw new ModbusProtocolError("INVALID_PARITY", "串口校验参数无效。 ");
  if (![1, 1.5, 2].includes(config.stopBits)) throw new ModbusProtocolError("INVALID_STOP_BITS", "停止位必须为 1、1.5 或 2。 ");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
