import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ModbusService, TcpTransport } from "./modbus-service";

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startServer(respond: (request: Buffer) => Buffer | undefined): Promise<number> {
  const server = net.createServer((socket) => socket.on("data", (request) => {
    const response = respond(request);
    if (response) socket.write(response);
  }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
  return address.port;
}

function tcpResponse(request: Buffer, pdu: string, transactionOffset = 0): Buffer {
  const resultPdu = Buffer.from(pdu, "hex");
  const result = Buffer.alloc(7 + resultPdu.length);
  result.writeUInt16BE((request.readUInt16BE(0) + transactionOffset) & 0xffff, 0);
  result.writeUInt16BE(0, 2);
  result.writeUInt16BE(resultPdu.length + 1, 4);
  result.writeUInt8(request.readUInt8(6), 6);
  resultPdu.copy(result, 7);
  return result;
}

describe("TCP transport against a controlled Modbus simulator", () => {
  it("rejects invalid connection parameters before closing a usable connection", async () => {
    const service = new ModbusService();
    await expect(service.connect({ kind: "tcp", host: "", port: 502, timeoutMs: 500 })).rejects.toThrow(/主机不能为空/);
    await expect(service.connect({ kind: "tcp", host: "127.0.0.1", port: 0, timeoutMs: 500 })).rejects.toThrow(/端口/);
    await expect(service.connect({ kind: "tcp", host: "127.0.0.1", port: 502, timeoutMs: 99 })).rejects.toThrow(/超时/);
  });

  it("exchanges a complete MBAP-framed read request and response", async () => {
    const port = await startServer((request) => tcpResponse(request, "0304000a000b"));
    const transport = new TcpTransport({ kind: "tcp", host: "127.0.0.1", port, timeoutMs: 500 });
    await transport.connect();
    const response = await transport.request({ unitId: 1, functionCode: 3, address: 0, quantity: 2 });
    expect(response.rawRequest.subarray(2, 7).toString("hex")).toBe("0000000601");
    expect(response.result).toEqual({ kind: "registers", values: [10, 11] });
    await transport.close();
  });

  it("rejects a response with a mismatched transaction ID", async () => {
    const port = await startServer((request) => tcpResponse(request, "0302000a", 1));
    const transport = new TcpTransport({ kind: "tcp", host: "127.0.0.1", port, timeoutMs: 500 });
    await transport.connect();
    await expect(transport.request({ unitId: 1, functionCode: 3, address: 0, quantity: 1 })).rejects.toThrow(/不属于当前请求/);
    await transport.close();
  });

  it("reports a deterministic timeout when the controlled device does not reply", async () => {
    const port = await startServer(() => undefined);
    const transport = new TcpTransport({ kind: "tcp", host: "127.0.0.1", port, timeoutMs: 50 });
    await transport.connect();
    await expect(transport.request({ unitId: 1, functionCode: 3, address: 0, quantity: 1 })).rejects.toThrow(/超时/);
    await transport.close();
  });

  it("requires a one-time confirmation before a write reaches the simulator", async () => {
    let requestCount = 0;
    const port = await startServer((request) => {
      requestCount += 1;
      return tcpResponse(request, request.subarray(7).toString("hex"));
    });
    const service = new ModbusService();
    await service.connect({ kind: "tcp", host: "127.0.0.1", port, timeoutMs: 500 });
    const write = { unitId: 1, functionCode: 6 as const, address: 7, values: [123] };
    await expect(service.request(write)).rejects.toThrow(/确认/);
    expect(requestCount).toBe(0);
    const cancelled = service.prepareWrite(write);
    service.cancelWrite(cancelled.token, write);
    expect(requestCount).toBe(0);
    const prepared = service.prepareWrite(write);
    await service.executeWrite(prepared.token, write);
    expect(requestCount).toBe(1);
    await expect(service.executeWrite(prepared.token, write)).rejects.toThrow(/失效/);
    await service.disconnect();
  });

  it("serializes simultaneous calls on a single connection", async () => {
    let requestCount = 0;
    let firstResponseSent = false;
    let sawSecondBeforeFirstResponse = false;
    const server = net.createServer((socket) => socket.on("data", (request) => {
      requestCount += 1;
      if (requestCount === 1) {
        setTimeout(() => {
          firstResponseSent = true;
          socket.write(tcpResponse(request, "0302000a"));
        }, 30);
      } else {
        sawSecondBeforeFirstResponse = !firstResponseSent;
        socket.write(tcpResponse(request, "0302000b"));
      }
    }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
    const port = address.port;
    const service = new ModbusService();
    await service.connect({ kind: "tcp", host: "127.0.0.1", port, timeoutMs: 500 });
    const first = service.request({ unitId: 1, functionCode: 3, address: 0, quantity: 1 });
    const second = service.request({ unitId: 1, functionCode: 3, address: 1, quantity: 1 });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(sawSecondBeforeFirstResponse).toBe(false);
    await service.disconnect();
  });
});
