import { describe, expect, it } from "vitest";
import {
  buildRequestPdu,
  buildResponsePdu,
  buildRtuFrame,
  crc16,
  expectedRtuFrameLength,
  expectedRtuRequestFrameLength,
  ModbusProtocolError,
  parseRequestPdu,
  parseResponsePdu,
  parseRtuFrame,
  validateRequest
} from "./protocol";

describe("Modbus PDU", () => {
  it("builds all first-release function-code request forms", () => {
    expect(buildRequestPdu({ unitId: 1, functionCode: 1, address: 19, quantity: 10 }).toString("hex")).toBe("010013000a");
    expect(buildRequestPdu({ unitId: 1, functionCode: 2, address: 19, quantity: 10 }).toString("hex")).toBe("020013000a");
    expect(buildRequestPdu({ unitId: 1, functionCode: 3, address: 19, quantity: 10 }).toString("hex")).toBe("030013000a");
    expect(buildRequestPdu({ unitId: 1, functionCode: 4, address: 19, quantity: 10 }).toString("hex")).toBe("040013000a");
    expect(buildRequestPdu({ unitId: 1, functionCode: 5, address: 19, values: [true] }).toString("hex")).toBe("050013ff00");
    expect(buildRequestPdu({ unitId: 1, functionCode: 6, address: 19, values: [42] }).toString("hex")).toBe("060013002a");
    expect(buildRequestPdu({ unitId: 1, functionCode: 15, address: 19, values: [true, false, true, true, false, false, false, false, true] }).toString("hex")).toBe("0f00130009020d01");
    expect(buildRequestPdu({ unitId: 1, functionCode: 16, address: 19, values: [1, 65535] }).toString("hex")).toBe("1000130002040001ffff");
  });

  it("enforces protocol limits and address ranges before I/O", () => {
    expect(() => validateRequest({ unitId: 0, functionCode: 3, address: 0, quantity: 1 })).toThrow(ModbusProtocolError);
    expect(() => validateRequest({ unitId: 1, functionCode: 3, address: 65535, quantity: 2 })).toThrow(/超出/);
    expect(() => validateRequest({ unitId: 1, functionCode: 1, address: 0, quantity: 2001 })).toThrow(/2000/);
    expect(() => validateRequest({ unitId: 1, functionCode: 16, address: 0, values: [] })).toThrow(/1 到 123/);
  });

  it("decodes normal responses and rejects mismatches or device exceptions", () => {
    const read = { unitId: 1, functionCode: 3 as const, address: 10, quantity: 2 };
    expect(parseResponsePdu(read, Buffer.from("0304000a000b", "hex"))).toEqual({ kind: "registers", values: [10, 11] });
    expect(() => parseResponsePdu(read, Buffer.from("0404000a000b", "hex"))).toThrow(/不一致/);
    expect(() => parseResponsePdu(read, Buffer.from("8302", "hex"))).toThrow(/非法数据地址/);
    expect(() => parseResponsePdu(read, Buffer.from("0302000a", "hex"))).toThrow(/长度/);
  });

  it("decodes bit reads and validates all write acknowledgements", () => {
    expect(parseResponsePdu({ unitId: 1, functionCode: 1, address: 0, quantity: 9 }, Buffer.from("01020d01", "hex"))).toEqual({ kind: "bits", values: [true, false, true, true, false, false, false, false, true] });
    expect(parseResponsePdu({ unitId: 1, functionCode: 5, address: 7, values: [true] }, Buffer.from("050007ff00", "hex"))).toEqual({ kind: "write", address: 7, quantity: 1 });
    expect(parseResponsePdu({ unitId: 1, functionCode: 6, address: 7, values: [12] }, Buffer.from("060007000c", "hex"))).toEqual({ kind: "write", address: 7, quantity: 1 });
    expect(parseResponsePdu({ unitId: 1, functionCode: 15, address: 7, values: [true, false, true] }, Buffer.from("0f00070003", "hex"))).toEqual({ kind: "write", address: 7, quantity: 3 });
    expect(parseResponsePdu({ unitId: 1, functionCode: 16, address: 7, values: [12, 13] }, Buffer.from("1000070002", "hex"))).toEqual({ kind: "write", address: 7, quantity: 2 });
  });

  it("decodes server requests and encodes matching server responses", () => {
    const write = parseRequestPdu(7, Buffer.from("1000130002040001ffff", "hex"));
    expect(write).toEqual({ unitId: 7, functionCode: 16, address: 19, values: [1, 65535] });
    expect(buildResponsePdu(write, { kind: "write", address: 19, quantity: 2 }).toString("hex")).toBe("1000130002");
    const read = parseRequestPdu(7, Buffer.from("0100130009", "hex"));
    expect(buildResponsePdu(read, { kind: "bits", values: [true, false, true, true, false, false, false, false, true] }).toString("hex")).toBe("01020d01");
    expect(() => parseRequestPdu(7, Buffer.from("0500130001", "hex"))).toThrow(/0x0000/);
  });
});

describe("Modbus RTU frames", () => {
  it("builds and validates a CRC-protected frame", () => {
    const request = { unitId: 1, functionCode: 3 as const, address: 0, quantity: 10 };
    const frame = buildRtuFrame(request);
    expect(frame.toString("hex")).toBe("01030000000ac5cd");
    expect(crc16(Buffer.from("01030000000a", "hex"))).toBe(0xcdc5);
    const responseBody = Buffer.from("010304000a000b", "hex");
    const response = Buffer.alloc(responseBody.length + 2);
    responseBody.copy(response);
    response.writeUInt16LE(crc16(responseBody), responseBody.length);
    expect(parseRtuFrame({ ...request, quantity: 2 }, response)).toEqual({ kind: "registers", values: [10, 11] });
  });

  it("detects CRC failure and handles streamed response lengths", () => {
    const request = { unitId: 1, functionCode: 3 as const, address: 0, quantity: 2 };
    expect(() => parseRtuFrame(request, Buffer.from("010304000a000b0000", "hex"))).toThrow(/CRC/);
    expect(expectedRtuFrameLength(Buffer.from("010304", "hex"))).toBe(9);
    expect(expectedRtuFrameLength(Buffer.from("018302", "hex"))).toBe(5);
    expect(expectedRtuFrameLength(Buffer.from("01", "hex"))).toBeUndefined();
    expect(expectedRtuRequestFrameLength(Buffer.from("010300000002", "hex"))).toBe(8);
    expect(expectedRtuRequestFrameLength(Buffer.from("01100000000204", "hex"))).toBe(13);
  });
});
