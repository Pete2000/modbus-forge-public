export type FunctionCode = 1 | 2 | 3 | 4 | 5 | 6 | 15 | 16;

export type ReadFunctionCode = 1 | 2 | 3 | 4;
export type WriteFunctionCode = 5 | 6 | 15 | 16;

export interface ModbusRequest {
  unitId: number;
  functionCode: FunctionCode;
  address: number;
  quantity?: number;
  values?: number[] | boolean[];
}

export interface BitReadResult {
  kind: "bits";
  values: boolean[];
}

export interface RegisterReadResult {
  kind: "registers";
  values: number[];
}

export interface WriteResult {
  kind: "write";
  address: number;
  quantity: number;
}

export type ModbusResult = BitReadResult | RegisterReadResult | WriteResult;

export class ModbusProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModbusProtocolError";
    this.code = code;
  }
}

const MAX_ADDRESS = 0xffff;
const MAX_READ_BITS = 2000;
const MAX_READ_REGISTERS = 125;
const MAX_WRITE_COILS = 1968;
const MAX_WRITE_REGISTERS = 123;

export function isWriteFunction(functionCode: FunctionCode): functionCode is WriteFunctionCode {
  return functionCode === 5 || functionCode === 6 || functionCode === 15 || functionCode === 16;
}

export function isReadFunction(functionCode: FunctionCode): functionCode is ReadFunctionCode {
  return functionCode >= 1 && functionCode <= 4;
}

export function validateRequest(request: ModbusRequest): void {
  if (!Number.isInteger(request.unitId) || request.unitId < 1 || request.unitId > 247) {
    throw new ModbusProtocolError("INVALID_UNIT_ID", "Unit ID 必须是 1 到 247 的整数。");
  }
  if (!Number.isInteger(request.address) || request.address < 0 || request.address > MAX_ADDRESS) {
    throw new ModbusProtocolError("INVALID_ADDRESS", "寄存器或线圈地址必须是 0 到 65535 的整数。");
  }

  const functionCode = request.functionCode;
  if (![1, 2, 3, 4, 5, 6, 15, 16].includes(functionCode)) {
    throw new ModbusProtocolError("UNSUPPORTED_FUNCTION", `不支持功能码 ${functionCode}。`);
  }

  if (functionCode >= 1 && functionCode <= 4) {
    const quantity = request.quantity;
    const max = functionCode <= 2 ? MAX_READ_BITS : MAX_READ_REGISTERS;
    if (!Number.isInteger(quantity) || quantity === undefined || quantity < 1 || quantity > max) {
      throw new ModbusProtocolError("INVALID_QUANTITY", `功能码 ${functionCode} 的读取数量必须是 1 到 ${max}。`);
    }
    ensureAddressRange(request.address, quantity);
    return;
  }

  if (functionCode === 5) {
    if (!Array.isArray(request.values) || request.values.length !== 1 || typeof request.values[0] !== "boolean") {
      throw new ModbusProtocolError("INVALID_VALUE", "写单线圈需要一个布尔值。");
    }
    return;
  }

  if (functionCode === 6) {
    if (!Array.isArray(request.values) || request.values.length !== 1 || !isRegisterValue(request.values[0])) {
      throw new ModbusProtocolError("INVALID_VALUE", "写单寄存器需要一个 0 到 65535 的整数。 ");
    }
    return;
  }

  if (functionCode === 15) {
    if (!Array.isArray(request.values) || request.values.length < 1 || request.values.length > MAX_WRITE_COILS || !request.values.every((value) => typeof value === "boolean")) {
      throw new ModbusProtocolError("INVALID_VALUE", `写多个线圈需要 1 到 ${MAX_WRITE_COILS} 个布尔值。`);
    }
    ensureAddressRange(request.address, request.values.length);
    return;
  }

  if (!Array.isArray(request.values) || request.values.length < 1 || request.values.length > MAX_WRITE_REGISTERS || !request.values.every(isRegisterValue)) {
    throw new ModbusProtocolError("INVALID_VALUE", `写多个寄存器需要 1 到 ${MAX_WRITE_REGISTERS} 个 0 到 65535 的整数。`);
  }
  ensureAddressRange(request.address, request.values.length);
}

export function buildRequestPdu(request: ModbusRequest): Buffer {
  validateRequest(request);
  const functionCode = request.functionCode;
  const address = request.address;

  if (functionCode >= 1 && functionCode <= 4) {
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(functionCode, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(request.quantity!, 3);
    return pdu;
  }

  if (functionCode === 5) {
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(functionCode, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE((request.values![0] as boolean) ? 0xff00 : 0x0000, 3);
    return pdu;
  }

  if (functionCode === 6) {
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(functionCode, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(request.values![0] as number, 3);
    return pdu;
  }

  if (functionCode === 15) {
    const values = request.values as boolean[];
    const byteCount = Math.ceil(values.length / 8);
    const pdu = Buffer.alloc(6 + byteCount);
    pdu.writeUInt8(functionCode, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(values.length, 3);
    pdu.writeUInt8(byteCount, 5);
    values.forEach((value, index) => {
      if (value) pdu[6 + Math.floor(index / 8)] |= 1 << (index % 8);
    });
    return pdu;
  }

  const values = request.values as number[];
  const pdu = Buffer.alloc(6 + values.length * 2);
  pdu.writeUInt8(16, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(values.length, 3);
  pdu.writeUInt8(values.length * 2, 5);
  values.forEach((value, index) => pdu.writeUInt16BE(value, 6 + index * 2));
  return pdu;
}

export function parseResponsePdu(request: ModbusRequest, pdu: Buffer): ModbusResult {
  if (pdu.length < 1) throw new ModbusProtocolError("MALFORMED_RESPONSE", "响应 PDU 为空。");
  const functionCode = pdu.readUInt8(0);
  if (functionCode === (request.functionCode | 0x80)) {
    const exceptionCode = pdu.length > 1 ? pdu.readUInt8(1) : undefined;
    throw new ModbusProtocolError(exceptionName(exceptionCode), `设备返回 Modbus 异常：${exceptionDescription(exceptionCode)}。`);
  }
  if (functionCode !== request.functionCode) {
    throw new ModbusProtocolError("FUNCTION_MISMATCH", `响应功能码 ${functionCode} 与请求功能码 ${request.functionCode} 不一致。`);
  }

  if (functionCode === 1 || functionCode === 2) {
    const byteCount = requireByteCount(pdu);
    const quantity = request.quantity!;
    if (byteCount !== Math.ceil(quantity / 8) || pdu.length !== byteCount + 2) {
      throw new ModbusProtocolError("MALFORMED_RESPONSE", "位读取响应长度与请求数量不一致。");
    }
    const values = Array.from({ length: quantity }, (_, index) => Boolean(pdu[2 + Math.floor(index / 8)] & (1 << (index % 8))));
    return { kind: "bits", values };
  }

  if (functionCode === 3 || functionCode === 4) {
    const byteCount = requireByteCount(pdu);
    const quantity = request.quantity!;
    if (byteCount !== quantity * 2 || pdu.length !== byteCount + 2) {
      throw new ModbusProtocolError("MALFORMED_RESPONSE", "寄存器读取响应长度与请求数量不一致。");
    }
    const values = Array.from({ length: quantity }, (_, index) => pdu.readUInt16BE(2 + index * 2));
    return { kind: "registers", values };
  }

  if (pdu.length !== 5 || pdu.readUInt16BE(1) !== request.address) {
    throw new ModbusProtocolError("MALFORMED_RESPONSE", "写入响应的地址不正确。 ");
  }
  const expectedQuantity = functionCode === 5 || functionCode === 6 ? 1 : request.values!.length;
  const responseQuantity = pdu.readUInt16BE(3);
  if (functionCode === 5) {
    const expected = (request.values![0] as boolean) ? 0xff00 : 0;
    if (responseQuantity !== expected) throw new ModbusProtocolError("MALFORMED_RESPONSE", "写单线圈响应的值不正确。 ");
  } else if (functionCode === 6) {
    if (responseQuantity !== request.values![0]) throw new ModbusProtocolError("MALFORMED_RESPONSE", "写单寄存器响应的值不正确。 ");
  } else if (responseQuantity !== expectedQuantity) {
    throw new ModbusProtocolError("MALFORMED_RESPONSE", "写多个值响应的数量不正确。 ");
  }
  return { kind: "write", address: request.address, quantity: expectedQuantity };
}

/** Decode a request PDU received by a Modbus server. The Unit ID belongs to its TCP/RTU envelope. */
export function parseRequestPdu(unitId: number, pdu: Buffer): ModbusRequest {
  if (!Number.isInteger(unitId) || unitId < 1 || unitId > 247) {
    throw new ModbusProtocolError("ILLEGAL_DATA_VALUE", "Unit ID 必须是 1 到 247。 ");
  }
  if (pdu.length < 1) throw new ModbusProtocolError("ILLEGAL_FUNCTION", "请求 PDU 为空。 ");
  const rawFunctionCode = pdu.readUInt8(0);
  if (![1, 2, 3, 4, 5, 6, 15, 16].includes(rawFunctionCode)) {
    throw new ModbusProtocolError("ILLEGAL_FUNCTION", `不支持功能码 ${rawFunctionCode}。`);
  }
  const functionCode = rawFunctionCode as FunctionCode;
  if (functionCode <= 4) {
    requireExactRequestLength(pdu, 5);
    return validateServerRequest({ unitId, functionCode, address: pdu.readUInt16BE(1), quantity: pdu.readUInt16BE(3) });
  }
  if (functionCode === 5) {
    requireExactRequestLength(pdu, 5);
    const encodedValue = pdu.readUInt16BE(3);
    if (encodedValue !== 0 && encodedValue !== 0xff00) {
      throw new ModbusProtocolError("ILLEGAL_DATA_VALUE", "写单线圈的值必须为 0x0000 或 0xFF00。 ");
    }
    return validateServerRequest({ unitId, functionCode, address: pdu.readUInt16BE(1), values: [encodedValue === 0xff00] });
  }
  if (functionCode === 6) {
    requireExactRequestLength(pdu, 5);
    return validateServerRequest({ unitId, functionCode, address: pdu.readUInt16BE(1), values: [pdu.readUInt16BE(3)] });
  }
  if (pdu.length < 6) throw new ModbusProtocolError("ILLEGAL_DATA_VALUE", "写多个值请求长度不足。 ");
  const address = pdu.readUInt16BE(1);
  const quantity = pdu.readUInt16BE(3);
  const byteCount = pdu.readUInt8(5);
  if (pdu.length !== 6 + byteCount) throw new ModbusProtocolError("ILLEGAL_DATA_VALUE", "写多个值请求的字节计数不匹配。 ");
  if (functionCode === 15) {
    if (byteCount !== Math.ceil(quantity / 8)) throw new ModbusProtocolError("ILLEGAL_DATA_VALUE", "写多个线圈的字节计数不匹配。 ");
    const values = Array.from({ length: quantity }, (_, index) => Boolean(pdu[6 + Math.floor(index / 8)] & (1 << (index % 8))));
    return validateServerRequest({ unitId, functionCode, address, values });
  }
  if (byteCount !== quantity * 2) throw new ModbusProtocolError("ILLEGAL_DATA_VALUE", "写多个寄存器的字节计数不匹配。 ");
  const values = Array.from({ length: quantity }, (_, index) => pdu.readUInt16BE(6 + index * 2));
  return validateServerRequest({ unitId, functionCode, address, values });
}

/** Encode the normal PDU returned by a Modbus server for a validated request. */
export function buildResponsePdu(request: ModbusRequest, result: ModbusResult): Buffer {
  validateRequest(request);
  if (request.functionCode === 1 || request.functionCode === 2) {
    if (result.kind !== "bits" || result.values.length !== request.quantity) throw new ModbusProtocolError("SLAVE_DEVICE_FAILURE", "设备位数据长度不正确。 ");
    const byteCount = Math.ceil(result.values.length / 8);
    const pdu = Buffer.alloc(2 + byteCount);
    pdu.writeUInt8(request.functionCode, 0);
    pdu.writeUInt8(byteCount, 1);
    result.values.forEach((value, index) => { if (value) pdu[2 + Math.floor(index / 8)] |= 1 << (index % 8); });
    return pdu;
  }
  if (request.functionCode === 3 || request.functionCode === 4) {
    if (result.kind !== "registers" || result.values.length !== request.quantity) throw new ModbusProtocolError("SLAVE_DEVICE_FAILURE", "设备寄存器数据长度不正确。 ");
    const pdu = Buffer.alloc(2 + result.values.length * 2);
    pdu.writeUInt8(request.functionCode, 0);
    pdu.writeUInt8(result.values.length * 2, 1);
    result.values.forEach((value, index) => pdu.writeUInt16BE(value, 2 + index * 2));
    return pdu;
  }
  if (result.kind !== "write" || result.address !== request.address) throw new ModbusProtocolError("SLAVE_DEVICE_FAILURE", "设备写入结果不正确。 ");
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(request.functionCode, 0);
  pdu.writeUInt16BE(request.address, 1);
  if (request.functionCode === 5) pdu.writeUInt16BE((request.values![0] as boolean) ? 0xff00 : 0, 3);
  else if (request.functionCode === 6) pdu.writeUInt16BE(request.values![0] as number, 3);
  else pdu.writeUInt16BE(request.values!.length, 3);
  return pdu;
}

export function buildExceptionPdu(functionCode: number, exceptionCode: number): Buffer {
  return Buffer.from([functionCode | 0x80, exceptionCode]);
}

export function crc16(payload: Buffer): number {
  let crc = 0xffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

export function buildRtuFrame(request: ModbusRequest): Buffer {
  const body = Buffer.concat([Buffer.from([request.unitId]), buildRequestPdu(request)]);
  const frame = Buffer.alloc(body.length + 2);
  body.copy(frame);
  frame.writeUInt16LE(crc16(body), body.length);
  return frame;
}

export function parseRtuFrame(request: ModbusRequest, frame: Buffer): ModbusResult {
  if (frame.length < 5) throw new ModbusProtocolError("MALFORMED_RESPONSE", "RTU 响应长度不足。 ");
  if (frame.readUInt8(0) !== request.unitId) throw new ModbusProtocolError("UNIT_ID_MISMATCH", "RTU 响应的从站地址不匹配。 ");
  const actualCrc = frame.readUInt16LE(frame.length - 2);
  const expectedCrc = crc16(frame.subarray(0, frame.length - 2));
  if (actualCrc !== expectedCrc) throw new ModbusProtocolError("CRC_MISMATCH", "RTU 响应 CRC 校验失败。 ");
  return parseResponsePdu(request, frame.subarray(1, frame.length - 2));
}

export function parseRtuRequestFrame(frame: Buffer): ModbusRequest {
  if (frame.length < 8) throw new ModbusProtocolError("ILLEGAL_DATA_VALUE", "RTU 请求长度不足。 ");
  const actualCrc = frame.readUInt16LE(frame.length - 2);
  const expectedCrc = crc16(frame.subarray(0, frame.length - 2));
  if (actualCrc !== expectedCrc) throw new ModbusProtocolError("CRC_MISMATCH", "RTU 请求 CRC 校验失败。 ");
  return parseRequestPdu(frame.readUInt8(0), frame.subarray(1, frame.length - 2));
}

export function expectedRtuFrameLength(buffer: Buffer): number | undefined {
  if (buffer.length < 2) return undefined;
  const functionCode = buffer.readUInt8(1);
  if ((functionCode & 0x80) !== 0) return 5;
  if ([1, 2, 3, 4].includes(functionCode)) {
    if (buffer.length < 3) return undefined;
    return 5 + buffer.readUInt8(2);
  }
  if ([5, 6, 15, 16].includes(functionCode)) return 8;
  return undefined;
}

/** Length of an incoming RTU request, including Unit ID and CRC. */
export function expectedRtuRequestFrameLength(buffer: Buffer): number | undefined {
  if (buffer.length < 2) return undefined;
  const functionCode = buffer.readUInt8(1);
  if ([1, 2, 3, 4, 5, 6].includes(functionCode)) return 8;
  if ([15, 16].includes(functionCode)) {
    if (buffer.length < 7) return undefined;
    return 9 + buffer.readUInt8(6);
  }
  return 8;
}

export function formatHex(buffer: Buffer): string {
  return buffer.toString("hex").toUpperCase().replace(/(..)/g, "$1 ").trim();
}

function ensureAddressRange(address: number, quantity: number): void {
  if (address + quantity - 1 > MAX_ADDRESS) throw new ModbusProtocolError("ADDRESS_RANGE", "起始地址和数量超出 0 到 65535 的范围。 ");
}

function isRegisterValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function requireByteCount(pdu: Buffer): number {
  if (pdu.length < 2) throw new ModbusProtocolError("MALFORMED_RESPONSE", "响应缺少字节计数字段。 ");
  return pdu.readUInt8(1);
}

function requireExactRequestLength(pdu: Buffer, expectedLength: number): void {
  if (pdu.length !== expectedLength) throw new ModbusProtocolError("ILLEGAL_DATA_VALUE", "请求 PDU 长度不正确。 ");
}

function validateServerRequest(request: ModbusRequest): ModbusRequest {
  try {
    validateRequest(request);
    return request;
  } catch (error) {
    if (!(error instanceof ModbusProtocolError)) throw error;
    const exceptionCode = error.code === "INVALID_ADDRESS" || error.code === "ADDRESS_RANGE" ? "ILLEGAL_DATA_ADDRESS" : "ILLEGAL_DATA_VALUE";
    throw new ModbusProtocolError(exceptionCode, error.message);
  }
}

function exceptionName(code: number | undefined): string {
  return ["ILLEGAL_FUNCTION", "ILLEGAL_DATA_ADDRESS", "ILLEGAL_DATA_VALUE", "SLAVE_DEVICE_FAILURE", "ACKNOWLEDGE", "SLAVE_DEVICE_BUSY", "MEMORY_PARITY_ERROR", "GATEWAY_PATH_UNAVAILABLE", "GATEWAY_TARGET_FAILED"].at((code ?? 0) - 1) ?? "MODBUS_EXCEPTION";
}

function exceptionDescription(code: number | undefined): string {
  const descriptions: Record<number, string> = {
    1: "非法功能码",
    2: "非法数据地址",
    3: "非法数据值",
    4: "设备故障",
    5: "设备已确认，正在处理",
    6: "设备忙",
    8: "内存奇偶校验错误",
    10: "网关路径不可用",
    11: "网关目标设备响应失败"
  };
  return descriptions[code ?? -1] ?? `未知异常码 ${code ?? "缺失"}`;
}
