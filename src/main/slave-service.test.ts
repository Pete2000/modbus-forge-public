import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SerialPortMock } from "serialport";
import type { RequestTrace } from "../shared/api";
import { buildRtuFrame, crc16 } from "../shared/protocol";
import { ModbusSlaveService, RtuSlaveServer, SlaveDataStore, TcpSlaveServer, handleSlavePdu } from "./slave-service";
import { TcpTransport } from "./modbus-service";

const MOCK_PATH = "COM-MODBUS-FORGE-SLAVE-TEST";

afterEach(() => {
  vi.restoreAllMocks();
  SerialPortMock.binding.reset();
});

async function availablePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Port probe did not bind.");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function tcpFrame(transactionId: number, pduHex: string): Buffer {
  const pdu = Buffer.from(pduHex, "hex");
  const frame = Buffer.alloc(7 + pdu.length);
  frame.writeUInt16BE(transactionId, 0);
  frame.writeUInt16BE(0, 2);
  frame.writeUInt16BE(pdu.length + 1, 4);
  frame.writeUInt8(1, 6);
  pdu.copy(frame, 7);
  return frame;
}

describe("Modbus slave data model", () => {
  it("serves all four areas and applies writable coil/register requests", () => {
    const store = new SlaveDataStore();
    store.write({ unitId: 1, area: "discreteInputs", address: 4, values: [true, false] });
    store.write({ unitId: 1, area: "inputRegisters", address: 9, values: [11, 12] });
    expect(handleSlavePdu(store, 1, Buffer.from("0200040002", "hex")).response.toString("hex")).toBe("020101");
    expect(handleSlavePdu(store, 1, Buffer.from("0400090002", "hex")).response.toString("hex")).toBe("0404000b000c");
    expect(handleSlavePdu(store, 1, Buffer.from("0f000300030105", "hex")).response.toString("hex")).toBe("0f00030003");
    expect(handleSlavePdu(store, 1, Buffer.from("0100030003", "hex")).response.toString("hex")).toBe("010105");
    expect(handleSlavePdu(store, 1, Buffer.from("9900000001", "hex")).response.toString("hex")).toBe("9901");
  });
});

describe("Modbus slave transports", () => {
  it("runs a TCP slave that a real master transport can write and read", async () => {
    const service = new ModbusSlaveService();
    const traces: RequestTrace[] = [];
    service.on("trace", (trace: RequestTrace) => traces.push(trace));
    const port = await availablePort();
    await service.start({ kind: "tcp", host: "127.0.0.1", port });
    const master = new TcpTransport({ kind: "tcp", host: "127.0.0.1", port, timeoutMs: 500 });
    await master.connect();
    await expect(master.request({ unitId: 3, functionCode: 16, address: 12, values: [77, 88] })).resolves.toMatchObject({ result: { kind: "write", address: 12, quantity: 2 } });
    await expect(master.request({ unitId: 3, functionCode: 3, address: 12, quantity: 2 })).resolves.toMatchObject({ result: { kind: "registers", values: [77, 88] } });
    await vi.waitFor(() => expect(traces).toHaveLength(2));
    expect(traces[0]).toMatchObject({ transport: "tcp", role: "slave", request: { functionCode: 16, address: 12 }, result: { kind: "write" } });
    for (const trace of traces) {
      expect(Number.isFinite(trace.serverProcessingMs)).toBe(true);
      expect(trace.serverProcessingMs).toBeGreaterThanOrEqual(0);
      expect(trace.elapsedMs).toBeUndefined();
    }
    await master.close();
    await service.stopAll();
  });

  it("times complete frames independently until their own write callbacks, including failures", () => {
    const server = new TcpSlaveServer({ kind: "tcp", host: "127.0.0.1", port: 5020 }, new SlaveDataStore());
    const socket = new net.Socket();
    const callbacks: Array<(error?: Error | null) => void> = [];
    vi.spyOn(socket, "write").mockImplementation(((_data: Buffer, callback: (error?: Error | null) => void) => {
      callbacks.push(callback);
      return true;
    }) as typeof socket.write);
    // Isolate the accepted-socket boundary without opening a port or injecting a production clock.
    (server as unknown as { attachClient(socket: net.Socket): void }).attachClient(socket);
    const traces: RequestTrace[] = [];
    server.on("trace", (trace: RequestTrace) => traces.push(trace));
    const clock = vi.spyOn(performance, "now");
    const write = tcpFrame(21, "1000c800010207d4"); // address 200, value 2004
    socket.emit("data", write.subarray(0, 8));
    expect(clock).not.toHaveBeenCalled(); // partial-frame wait is excluded
    clock.mockReturnValueOnce(100).mockReturnValueOnce(200);
    socket.emit("data", Buffer.concat([write.subarray(8), tcpFrame(22, "0300c80001")]));
    expect(traces).toHaveLength(0); // queuing a response is not completion
    clock.mockReturnValueOnce(300.125);
    callbacks[1]();
    clock.mockReturnValueOnce(400.25);
    callbacks[0](new Error("local send failed"));
    expect(traces[0]).toMatchObject({ serverProcessingMs: 100.125, rawRequest: "00 16 00 00 00 06 01 03 00 C8 00 01" });
    expect(traces[1]).toMatchObject({ serverProcessingMs: 300.25, request: { functionCode: 16, values: [2004] }, error: { code: "TRANSPORT_ERROR" } });
    clock.mockReturnValueOnce(500);
    socket.emit("data", tcpFrame(23, "9900000001"));
    clock.mockReturnValueOnce(501.375);
    callbacks[2]();
    expect(traces[2]).toMatchObject({ serverProcessingMs: 1.375, error: { code: "ILLEGAL_FUNCTION" } });
    clock.mockReturnValueOnce(600);
    socket.emit("data", tcpFrame(24, "1000c800010107")); // invalid byte count, still an incoming FC16 write
    clock.mockReturnValueOnce(600.125);
    callbacks[3]();
    expect(traces[3]).toMatchObject({ serverProcessingMs: 0.125, serverFunctionCode: 16 });
    expect(traces[3].request).toBeUndefined();
    expect(traces[3].error).toBeDefined();
    socket.destroy();
  });

  it("preserves timing and endpoint identity for concurrent TCP clients", async () => {
    const service = new ModbusSlaveService();
    const traces: RequestTrace[] = [];
    service.on("trace", (trace: RequestTrace) => traces.push(trace));
    const port = await availablePort();
    const clients = [1, 2].map(() => new TcpTransport({ kind: "tcp", host: "127.0.0.1", port, timeoutMs: 500 }));
    try {
      await service.start({ kind: "tcp", host: "127.0.0.1", port });
      await Promise.all(clients.map((client) => client.connect()));
      await Promise.all(clients.map((client, index) => client.request({ unitId: 1, functionCode: 16, address: 200 + index, values: [2004 + index] })));
      await vi.waitFor(() => expect(traces).toHaveLength(2));
      expect(new Set(traces.map((trace) => trace.peer)).size).toBe(2);
      expect(traces.map((trace) => trace.request?.address).sort()).toEqual([200, 201]);
      expect(traces.every((trace) => Number.isFinite(trace.serverProcessingMs) && trace.serverProcessingMs! >= 0)).toBe(true);
      expect(service.readData({ unitId: 1, area: "holdingRegisters", address: 200, quantity: 2 }).values).toEqual([2004, 2005]);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await service.stopAll();
    }
  });

  it("keeps MBAP transaction IDs while processing multiple TCP requests from one chunk", async () => {
    const service = new ModbusSlaveService();
    const port = await availablePort();
    service.writeData({ unitId: 1, area: "holdingRegisters", address: 0, values: [21, 22] });
    await service.start({ kind: "tcp", host: "127.0.0.1", port });
    const socket = net.createConnection(port, "127.0.0.1");
    const response = await new Promise<Buffer>((resolve, reject) => {
      let received = Buffer.alloc(0);
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= 22) resolve(received);
      });
      socket.once("connect", () => socket.write(Buffer.concat([tcpFrame(9, "0300000001"), tcpFrame(10, "0300010001")])))
    });
    expect(response.subarray(0, 11).toString("hex")).toBe("0009000000050103020015");
    expect(response.subarray(11, 22).toString("hex")).toBe("000a000000050103020016");
    socket.destroy();
    await service.stopAll();
  });

  it("forms an RTU slave response after receiving a CRC-protected request in chunks", async () => {
    SerialPortMock.binding.createPort(MOCK_PATH, { record: true });
    const store = new SlaveDataStore();
    store.write({ unitId: 1, area: "holdingRegisters", address: 0, values: [42] });
    let serial: SerialPortMock | undefined;
    const server = new RtuSlaveServer(
      { kind: "rtu", path: MOCK_PATH, baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1 },
      store,
      (options) => {
        serial = new SerialPortMock(options);
        return serial as never;
      }
    );
    await server.start();
    const request = buildRtuFrame({ unitId: 1, functionCode: 3, address: 0, quantity: 1 });
    serial!.port!.emitData(request.subarray(0, 3));
    serial!.port!.emitData(request.subarray(3));
    await nextTick();
    const body = Buffer.from("010302002a", "hex");
    const expected = Buffer.alloc(body.length + 2);
    body.copy(expected);
    expected.writeUInt16LE(crc16(body), body.length);
    expect(serial!.port!.lastWrite).toEqual(expected);
    await server.stop();
  });
});
