import net from "node:net";
import { expect, it } from "vitest";
import { DEFAULT_TEST_CONFIGS } from "../shared/test-session";
import { ModbusService } from "./modbus-service";
import { ModbusSlaveService } from "./slave-service";
import { TestSessionService } from "./test-session-service";

async function availablePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

it("runs two real TCP peers simultaneously as client and server, polling, writing and verifying independently", async () => {
  const pcMaster = new ModbusService(); const plcMaster = new ModbusService();
  const pcServer = new ModbusSlaveService(); const plcServer = new ModbusSlaveService();
  const pcTests = new TestSessionService(pcMaster, pcServer); const plcTests = new TestSessionService(plcMaster, plcServer);
  const traces: number[] = [];
  pcMaster.on("trace", (trace) => { if (trace.request) traces.push(trace.request.functionCode); });
  try {
    const pcPort = await availablePort(); await pcServer.start({ kind: "tcp", host: "127.0.0.1", port: pcPort });
    const plcPort = await availablePort(); await plcServer.start({ kind: "tcp", host: "127.0.0.1", port: plcPort });
    await pcMaster.connect({ kind: "tcp", host: "127.0.0.1", port: plcPort, timeoutMs: 500 });
    await plcMaster.connect({ kind: "tcp", host: "127.0.0.1", port: pcPort, timeoutMs: 500 });
    const generator = { ...DEFAULT_TEST_CONFIGS.generator, intervalMs: 250, durationSeconds: 1 };
    pcTests.startGenerator(generator, pcTests.authorizationVersion("generator"));
    plcTests.startGenerator(generator, plcTests.authorizationVersion("generator"));
    const client = { ...DEFAULT_TEST_CONFIGS.client, intervalMs: 250, pollIntervalMs: 250, readbackDelayMs: 10, durationSeconds: 1 };
    pcTests.startClient(client, pcMaster.getSession().epoch, pcTests.authorizationVersion("client"));
    plcTests.startClient(client, plcMaster.getSession().epoch, plcTests.authorizationVersion("client"));
    const poll = await plcMaster.request({ unitId: 1, functionCode: 3, address: 20, quantity: 2 });
    expect(poll.result).toMatchObject({ kind: "registers", values: [1, expect.any(Number)] });
    await new Promise((resolve) => setTimeout(resolve, 1250));
    for (const engine of [pcTests, plcTests]) {
      const { client: run, generator: signal } = engine.snapshot();
      expect(run!.status).toBe("completed"); expect(signal!.status).toBe("completed");
      expect(run!.stats.writesAcknowledged).toBeGreaterThanOrEqual(3);
      expect(run!.stats.matches).toBeGreaterThanOrEqual(3);
      expect(run!.stats.mismatches).toBe(0); expect(run!.stats.errors).toBe(0);
      expect(signal!.stats.peerReads).toBeGreaterThan(0); expect(signal!.stats.peerWrites).toBeGreaterThan(0);
      expect(run!.records.every((record) => record.expected?.join() === record.actual?.join())).toBe(true);
    }
    expect(traces).toContain(16); expect(traces).toContain(3);
  } finally {
    await pcTests.stopAll("清理"); await plcTests.stopAll("清理");
    await pcMaster.disconnect(); await plcMaster.disconnect(); await pcServer.stopAll(); await plcServer.stopAll();
  }
});
