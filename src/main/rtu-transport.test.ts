import { afterEach, describe, expect, it } from "vitest";
import { SerialPortMock } from "serialport";
import { crc16 } from "../shared/protocol";
import { RtuTransport, type SerialPortDevice } from "./modbus-service";

const MOCK_PATH = "COM-MODBUS-FORGE-TEST";

afterEach(() => {
  SerialPortMock.binding.reset();
});

function responseFrame(hexBody: string): Buffer {
  const body = Buffer.from(hexBody, "hex");
  const frame = Buffer.alloc(body.length + 2);
  body.copy(frame);
  frame.writeUInt16LE(crc16(body), body.length);
  return frame;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("RTU transport against the SerialPort controlled simulator", () => {
  it("writes a full RTU request and parses a chunked simulator response", async () => {
    SerialPortMock.binding.createPort(MOCK_PATH, { record: true });
    let serial: SerialPortMock | undefined;
    const transport = new RtuTransport(
      { kind: "rtu", path: MOCK_PATH, baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1, timeoutMs: 500 },
      (options) => {
        serial = new SerialPortMock(options);
        return serial as unknown as SerialPortDevice;
      }
    );
    await transport.connect();
    const pending = transport.request({ unitId: 1, functionCode: 3, address: 0, quantity: 2 });
    await nextTick();
    const binding = serial!.port!;
    expect(binding.lastWrite?.toString("hex")).toBe("010300000002c40b");
    const frame = responseFrame("010304000a000b");
    binding.emitData(frame.subarray(0, 3));
    binding.emitData(frame.subarray(3));
    await expect(pending).resolves.toMatchObject({ result: { kind: "registers", values: [10, 11] } });
    await transport.close();
  });

  it("rejects a simulated RTU response with an invalid CRC", async () => {
    SerialPortMock.binding.createPort(MOCK_PATH, { record: true });
    let serial: SerialPortMock | undefined;
    const transport = new RtuTransport(
      { kind: "rtu", path: MOCK_PATH, baudRate: 19200, dataBits: 8, parity: "even", stopBits: 1, timeoutMs: 500 },
      (options) => {
        serial = new SerialPortMock(options);
        return serial as unknown as SerialPortDevice;
      }
    );
    await transport.connect();
    const pending = transport.request({ unitId: 1, functionCode: 3, address: 0, quantity: 1 });
    await nextTick();
    serial!.port!.emitData(Buffer.from("010302002a0000", "hex"));
    await expect(pending).rejects.toThrow(/CRC/);
    await transport.close();
  });
});
