import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DEFAULT_TEST_CONFIGS } from "../shared/test-session";
import { TcpTransport } from "./modbus-service";
import type { WorkspaceSettings } from "../shared/api";
import { ModbusService } from "./modbus-service";
import { ModbusSlaveService } from "./slave-service";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  owner: { isDestroyed: () => false, close: vi.fn() },
  showMessageBox: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn(),
  readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), rm: vi.fn()
}));
vi.mock("electron", () => ({
  app: { whenReady: () => new Promise(() => {}), on: vi.fn(), getPath: () => "mock-user-data" },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => electron.owner },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => electron.handlers.set(name, handler) },
  dialog: electron
}));
vi.mock("node:fs/promises", () => ({ default: { readFile: electron.readFile, writeFile: electron.writeFile, mkdir: electron.mkdir, rename: electron.rename, rm: electron.rm } }));

const call = (name: string, ...args: any[]) => electron.handlers.get(name)!({ sender: {} }, ...args);

const settingsFixture = (): WorkspaceSettings => ({
  version: 2, connection: { kind: "tcp", host: "192.0.2.188", port: 502, timeoutMs: 1000 },
  draftRequest: { unitId: 1, functionCode: 3, address: 200, quantity: 1, valuesText: "" }, watches: [],
  slave: { servers: { tcp: { kind: "tcp", host: "192.0.2.20", port: 502 }, rtu: { kind: "rtu", path: "", baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1 } } },
  testConfigs: DEFAULT_TEST_CONFIGS,
  view: { workbenchTab: "slave", channelTab: "slave", channelCollapsed: false, leftWidthPct: 52,
    decodeMode: "i16", slaveTransport: "tcp", numberBase: "hex", slavePage: { unitId: 1, area: "holdingRegisters", address: 200, quantity: 16 } }
});

beforeAll(async () => { const main = await import("./main"); main.registerIpc(); });
afterEach(async () => {
  await call("tests:stop", "client"); await call("tests:stop", "generator"); await call("modbus:disconnect");
  vi.restoreAllMocks(); electron.showMessageBox.mockReset(); electron.showSaveDialog.mockReset(); electron.showOpenDialog.mockReset(); electron.readFile.mockReset();
  electron.writeFile.mockReset(); electron.mkdir.mockReset(); electron.rename.mockReset();
  electron.rm.mockReset(); electron.owner.close.mockReset();
});

it("cancels native confirmation without changing server data and binds dialog to owner", async () => {
  electron.showMessageBox.mockResolvedValue({ response: 0 });
  expect(await call("tests:start-generator", DEFAULT_TEST_CONFIGS.generator)).toBeNull();
  const options = electron.showMessageBox.mock.calls[0];
  expect(options[0]).toBe(electron.owner); expect(options[1].cancelId).toBe(0);
  expect(await call("slave:read-data", { unitId: 1, area: "holdingRegisters", address: 20, quantity: 2 })).toMatchObject({ values: [0, 0] });
});

it("rejects confirmation completed after stop, including a generator that was not yet running", async () => {
  let approve!: (value: unknown) => void;
  electron.showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { approve = resolve; }));
  const pending = call("tests:start-generator", DEFAULT_TEST_CONFIGS.generator);
  const rejected = expect(pending).rejects.toThrow(/重新启动并确认/);
  await call("tests:stop", "generator"); approve({ response: 1 }); await rejected;
});

it("rejects a second pending native dialog", async () => {
  let approve!: (value: unknown) => void;
  electron.showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { approve = resolve; }));
  const pending = call("tests:start-generator", DEFAULT_TEST_CONFIGS.generator);
  await expect(call("tests:start-generator", DEFAULT_TEST_CONFIGS.generator)).rejects.toThrow(/完成当前测试确认/);
  approve({ response: 0 }); await pending;
});

it("confirms the actual connected endpoint, never the edited target fields, and honors cancellation", async () => {
  vi.spyOn(TcpTransport.prototype, "connect").mockResolvedValue();
  const send = vi.spyOn(TcpTransport.prototype, "request");
  await call("modbus:connect", { kind: "tcp", host: "127.0.0.1", port: 15040, timeoutMs: 500 });
  electron.showMessageBox.mockResolvedValue({ response: 0 });
  expect(await call("tests:start-client", DEFAULT_TEST_CONFIGS.client)).toBeNull();
  expect(electron.showMessageBox.mock.calls[0][1].message).toContain("127.0.0.1:15040");
  expect(send).not.toHaveBeenCalled();
});

it("round trips configuration through workspace save without persisting run authorization", async () => {
  const workspace = {
    version: 2, connection: { kind: "tcp", host: "127.0.0.1", port: 502, timeoutMs: 1000 },
    draftRequest: { unitId: 1, functionCode: 3, address: 0, quantity: 1, valuesText: "" }, watches: [],
    slave: { servers: { tcp: { kind: "tcp", host: "127.0.0.1", port: 5020 }, rtu: { kind: "rtu", path: "", baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1 } }, data: [] },
    testConfigs: DEFAULT_TEST_CONFIGS
  };
  await call("workspace:save", workspace);
  const saved = JSON.parse(electron.writeFile.mock.calls[0][1]);
  expect(saved.testConfigs).toEqual(DEFAULT_TEST_CONFIGS); expect(saved).not.toHaveProperty("running");
  electron.readFile.mockResolvedValue(JSON.stringify(saved));
  expect((await call("workspace:load")).testConfigs).toEqual(DEFAULT_TEST_CONFIGS);
  delete saved.testConfigs;
  electron.readFile.mockResolvedValue(JSON.stringify(saved));
  expect((await call("workspace:load")).testConfigs).toEqual(DEFAULT_TEST_CONFIGS);
});

it("remembers view and parameters without live data, authorization or automatic communication", async () => {
  const connect = vi.spyOn(ModbusService.prototype, "connect");
  const start = vi.spyOn(ModbusSlaveService.prototype, "start");
  const settings = { ...settingsFixture(), running: true, authorization: "must-not-persist", slave: { ...settingsFixture().slave, data: [{ unitId: 1, area: "holdingRegisters", address: 200, values: [1234] }] } };
  await call("workspace:remember", settings);
  const persisted = JSON.parse(electron.writeFile.mock.calls[0][1]);
  expect(persisted.view).toEqual(settings.view);
  expect(persisted.slave.data).toEqual([]);
  expect(persisted).not.toHaveProperty("running");
  expect(persisted).not.toHaveProperty("authorization");
  electron.readFile.mockRejectedValueOnce(Object.assign(new Error("absent"), {code:"ENOENT"})).mockResolvedValueOnce(JSON.stringify(persisted));
  expect((await call("workspace:load")).view.slavePage.address).toBe(200);
  expect(connect).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});

it("validates preferences and view before changing files", async () => {
  const settings = settingsFixture();
  settings.view!.slavePage.address = 65535; settings.view!.slavePage.quantity = 2;
  await expect(async () => call("workspace:remember", settings)).rejects.toThrow(/界面配置无效/);
  expect(electron.writeFile).not.toHaveBeenCalled();
});

it("binds import to its window, rejects concurrent import and persists the imported snapshot for recovery", async () => {
  let choose!: (value: unknown) => void;
  electron.showOpenDialog.mockImplementationOnce(() => new Promise(resolve => { choose = resolve; }));
  const pending = call("workspace:import");
  await expect(call("workspace:import")).rejects.toThrow(/先完成当前导入/);
  expect(electron.showOpenDialog.mock.calls[0][0]).toBe(electron.owner);
  const imported = { ...settingsFixture(), slave: { ...settingsFixture().slave, data: [{ unitId: 1, area: "holdingRegisters", address: 200, values: [2004] }] } };
  electron.readFile.mockResolvedValueOnce(JSON.stringify(imported));
  choose({canceled:false,filePaths:["imported.json"]});
  expect((await pending).view.slavePage.address).toBe(200);
  expect(electron.writeFile).toHaveBeenCalledTimes(2);
  expect(JSON.parse(electron.writeFile.mock.calls[0][1]).slave.data[0].values).toEqual([2004]);
  expect(JSON.parse(electron.writeFile.mock.calls[1][1]).slave.data).toEqual([]);
});

it("waits for final disk replacement before closing and ignores duplicate close requests", async () => {
  let finish!: () => void;
  electron.rename.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = call("workspace:close", settingsFixture());
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(electron.owner.close).not.toHaveBeenCalled();
  await call("workspace:close", settingsFixture());
  expect(electron.writeFile).toHaveBeenCalledTimes(1);
  finish(); await pending;
  expect(electron.owner.close).toHaveBeenCalledTimes(1);
});

it("keeps the window open on close-save failure unless the user chooses to discard", async () => {
  electron.rename.mockRejectedValue(new Error("disk unavailable"));
  electron.showMessageBox.mockResolvedValueOnce({response:0});
  await call("workspace:close", settingsFixture());
  expect(electron.owner.close).not.toHaveBeenCalled();
  expect(electron.showMessageBox.mock.calls[0][1].message).toContain("未能保存");
  electron.showMessageBox.mockResolvedValueOnce({response:1});
  await call("workspace:close", settingsFixture());
  expect(electron.owner.close).toHaveBeenCalledTimes(1);
});

it("exports authoritative run timestamps, counters and retained records as JSON", async () => {
  electron.showMessageBox.mockResolvedValue({ response: 1 });
  await call("tests:start-generator", { ...DEFAULT_TEST_CONFIGS.generator, randomMin: 1234, randomMax: 1234 });
  await call("tests:stop", "generator");
  electron.showSaveDialog.mockResolvedValue({ filePath: "mock-report.json", canceled: false });
  expect(await call("tests:export")).toBe(true);
  const report = JSON.parse(electron.writeFile.mock.calls[0][1]);
  expect(report.schemaVersion).toBe(1); expect(report.sessions.generator.endedAt).toBeTruthy();
  expect(report.sessions.generator.stats.generated).toBe(1);
  expect(report.sessions.generator.records[0].actual).toEqual([1, 1234]);
});

it("exports transport-specific role names while retaining original role codes and frames", async () => {
  electron.showSaveDialog.mockResolvedValue({ filePath: "mock-traces.json", canceled: false });
  const traces = [
    { transport: "tcp", role: "master", rawRequest: "00 01", rawResponse: "00 02", elapsedMs: 12 },
    { transport: "tcp", role: "slave", rawRequest: "00 03", rawResponse: "00 04", serverProcessingMs: 0.125, serverFunctionCode: 16 },
    { transport: "rtu", role: "master", rawRequest: "01 03" },
    { transport: "rtu", role: "slave", rawRequest: "01 06" }
  ];
  expect(await call("traces:export", traces)).toBe(true);
  const result = JSON.parse(electron.writeFile.mock.calls[0][1]);
  expect(result.traces.map((trace: { roleName: string }) => trace.roleName)).toEqual(["TCP 客户端", "TCP 服务器", "RTU 主站", "RTU 从站"]);
  expect(result.traces.map(({ roleName: _roleName, ...trace }: { roleName: string }) => trace)).toEqual(traces);
});
