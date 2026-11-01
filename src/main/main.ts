import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { ModbusProtocolError, type ModbusRequest, validateRequest } from "../shared/protocol";
import type { ConnectionConfig, RequestTrace, SlaveDataEntry, SlaveDataRange, SlaveServerConfig, SlaveTransportKind, Workspace, WorkspaceSettings } from "../shared/api";
import { parseWorkspaceView } from "../shared/workspace-view";
import { WorkspaceStore, writeWorkspaceFile } from "./workspace-store";
import { ModbusService } from "./modbus-service";
import { roleLabel } from "../shared/role-label";
import { ModbusSlaveService } from "./slave-service";
import { TestSessionService } from "./test-session-service";
import { parseClientTestConfig, parseSignalConfig, parseTestConfigs, type ClientTestConfig, type SignalConfig, type TestKind } from "../shared/test-session";

const service = new ModbusService();
const slaveService = new ModbusSlaveService();
const testService = new TestSessionService(service, slaveService);
const workspaceStore = new WorkspaceStore(() => app.getPath("userData"), parseWorkspace);
const closingWindows = new WeakSet<BrowserWindow>();
const pendingCloses = new WeakSet<BrowserWindow>();
const pendingImports = new WeakSet<BrowserWindow>();

const DEFAULT_SLAVE = {
  servers: {
    tcp: { kind: "tcp" as const, host: "127.0.0.1", port: 5020 },
    rtu: { kind: "rtu" as const, path: "", baudRate: 9600, dataBits: 8 as const, parity: "none" as const, stopBits: 1 as const }
  },
  data: []
};

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Modbus Forge",
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: "#080e16",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0d1724", symbolColor: "#e4eef9", height: 36 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  window.setMenuBarVisibility(false);
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (closingWindows.has(window) || window.webContents.isLoading() || window.webContents.isCrashed()) return;
    event.preventDefault();
    window.webContents.send("workspace:before-close");
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL;
    if (allowed && url.startsWith(allowed)) return;
    event.preventDefault();
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(path.join(__dirname, "../../dist/renderer/index.html"));
  }
  return window;
}

async function readWorkspace(filePath: string): Promise<Workspace | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parseWorkspace(parsed);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

function parseWorkspace(value: unknown): Workspace {
  if (!isRecord(value) || ![1, 2].includes(value.version as number) || !isConnectionConfig(value.connection) || !isDraft(value.draftRequest) || !Array.isArray(value.watches)) {
    throw new ModbusProtocolError("INVALID_WORKSPACE", "工作区文件格式无效。 ");
  }
  const watches = value.watches.map(parseWatch);
  const slave = value.version === 2 ? parseSlaveWorkspace(value.slave) : { ...DEFAULT_SLAVE, servers: { ...DEFAULT_SLAVE.servers }, data: [] };
  return { version: 2, connection: value.connection, draftRequest: value.draftRequest, watches, slave, testConfigs: parseTestConfigs(value.testConfigs), view: parseWorkspaceView(value.view) };
}

function parseSlaveWorkspace(value: unknown): Workspace["slave"] {
  if (!isRecord(value) || !isRecord(value.servers) || !isTcpSlaveConfig(value.servers.tcp) || !isRtuSlaveConfig(value.servers.rtu) || !Array.isArray(value.data)) {
    throw new ModbusProtocolError("INVALID_WORKSPACE", "监听数据工作区格式无效。 ");
  }
  const data = value.data.map(parseSlaveDataEntry);
  return { servers: { tcp: value.servers.tcp, rtu: value.servers.rtu }, data };
}

function parseSlaveDataEntry(value: unknown): SlaveDataEntry {
  if (!isRecord(value) || !isInteger(value.unitId) || typeof value.area !== "string" || !isInteger(value.address) || !Array.isArray(value.values)) {
    throw new ModbusProtocolError("INVALID_WORKSPACE", "本机数据项格式无效。 ");
  }
  if (!["coils", "discreteInputs", "holdingRegisters", "inputRegisters"].includes(value.area)) throw new ModbusProtocolError("INVALID_WORKSPACE", "本机数据区类型无效。 ");
  if (value.values.length < 1) throw new ModbusProtocolError("INVALID_WORKSPACE", "本机数据项不能为空。 ");
  const bitArea = value.area === "coils" || value.area === "discreteInputs";
  if (bitArea ? !value.values.every((item) => typeof item === "boolean") : !value.values.every((item) => isInteger(item) && item >= 0 && item <= 65535)) {
    throw new ModbusProtocolError("INVALID_WORKSPACE", "本机数据值无效。 ");
  }
  if (value.unitId < 1 || value.unitId > 247 || value.address < 0 || value.address + value.values.length - 1 > 65535) throw new ModbusProtocolError("INVALID_WORKSPACE", "本机数据地址范围无效。 ");
  return { unitId: value.unitId, area: value.area as SlaveDataEntry["area"], address: value.address, values: value.values as boolean[] | number[] };
}

function parseWatch(value: unknown): Workspace["watches"][number] {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.intervalMs !== "number" || value.intervalMs < 250 || value.intervalMs > 60000 || typeof value.enabled !== "boolean" || !isRecord(value.request)) {
    throw new ModbusProtocolError("INVALID_WORKSPACE", "监视项格式无效。 ");
  }
  const request = value.request as unknown as ModbusRequest;
  validateRequest(request);
  if ([5, 6, 15, 16].includes(request.functionCode)) {
    throw new ModbusProtocolError("INVALID_WORKSPACE", "监视项只能保存只读 Modbus 请求。 ");
  }
  return { id: value.id, name: value.name.slice(0, 100), intervalMs: value.intervalMs, enabled: value.enabled, request };
}

function isDraft(value: unknown): value is Workspace["draftRequest"] {
  return isRecord(value) && isInteger(value.unitId) && isInteger(value.functionCode) && isInteger(value.address) && isInteger(value.quantity) && typeof value.valuesText === "string";
}

function isConnectionConfig(value: unknown): value is ConnectionConfig {
  if (!isRecord(value) || typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 120000) return false;
  if (value.kind === "tcp") return typeof value.host === "string" && value.host.trim().length > 0 && isInteger(value.port) && value.port > 0 && value.port <= 65535;
  return value.kind === "rtu" && typeof value.path === "string" && value.path.trim().length > 0 && isInteger(value.baudRate) && [5, 6, 7, 8].includes(value.dataBits as number) && ["none", "even", "odd", "mark", "space"].includes(value.parity as string) && [1, 1.5, 2].includes(value.stopBits as number);
}

function isTcpSlaveConfig(value: unknown): value is Extract<SlaveServerConfig, { kind: "tcp" }> {
  return isRecord(value) && value.kind === "tcp" && typeof value.host === "string" && value.host.trim().length > 0 && isInteger(value.port) && value.port > 0 && value.port <= 65535;
}

function isRtuSlaveConfig(value: unknown): value is Extract<SlaveServerConfig, { kind: "rtu" }> {
  return isRecord(value) && value.kind === "rtu" && typeof value.path === "string" && isInteger(value.baudRate) && [5, 6, 7, 8].includes(value.dataBits as number) && ["none", "even", "odd", "mark", "space"].includes(value.parity as string) && [1, 1.5, 2].includes(value.stopBits as number);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function broadcastTrace(trace: RequestTrace): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("modbus:trace", trace);
}

function broadcastSlaveData(entry: SlaveDataEntry | undefined): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("modbus:slave-data-changed", entry);
}

export function registerIpc(): void {
  ipcMain.handle("modbus:get-status", () => service.getStatus());
  ipcMain.handle("modbus:connect", (_event, config: ConnectionConfig) => service.connect(config));
  ipcMain.handle("modbus:disconnect", () => service.disconnect());
  ipcMain.handle("modbus:cancel-active-request", () => service.cancelActiveRequest());
  ipcMain.handle("modbus:list-serial-ports", () => service.listSerialPorts());
  ipcMain.handle("modbus:request", (_event, request: ModbusRequest) => service.request(request));
  ipcMain.handle("modbus:prepare-write", (_event, request: ModbusRequest) => service.prepareWrite(request));
  ipcMain.handle("modbus:execute-write", (_event, token: string, request: ModbusRequest) => service.executeWrite(token, request));
  ipcMain.handle("modbus:cancel-write", (_event, token: string, request: ModbusRequest) => service.cancelWrite(token, request));
  ipcMain.handle("slave:get-statuses", () => slaveService.getStatuses());
  ipcMain.handle("slave:start", (_event, config: SlaveServerConfig) => slaveService.start(config));
  ipcMain.handle("slave:stop", async (_event, kind: SlaveTransportKind) => {
    await testService.stop("generator", "stopped", "停止监听，自动变值已停止。");
    return slaveService.stop(kind);
  });
  ipcMain.handle("slave:read-data", (_event, range: SlaveDataRange) => slaveService.readData(range));
  ipcMain.handle("slave:write-data", (_event, entry: SlaveDataEntry) => slaveService.writeData(entry));
  ipcMain.handle("slave:get-dataset", () => slaveService.dataset());
  ipcMain.handle("slave:load-dataset", async (_event, entries: SlaveDataEntry[]) => {
    await testService.stopAll("载入工作区数据，运行授权已撤销。");
    return slaveService.loadDataset(entries);
  });
  ipcMain.handle("tests:get", () => testService.snapshot());
  ipcMain.handle("tests:stop", (_event, kind: TestKind) => testService.stop(kind));
  ipcMain.handle("tests:start-client", async (_event, value: ClientTestConfig) => {
    const config = parseClientTestConfig(value);
    const session = service.getSession();
    const authorization = testService.authorizationVersion("client");
    const target = session.config.kind === "tcp" ? `${session.config.host}:${session.config.port}` : session.config.path;
    const approved = await confirmTest(`向 ${target} 的站号 ${config.unitId} 持续写入`, config,
      `FC16 写入地址 ${config.address}、${config.address + 1}；FC03 每 ${config.pollIntervalMs} ms 读取，写后等待 ${config.readbackDelayMs} ms 再读回比对。\n仅限已确认可写的测试寄存器。停止后不再发送后续写入，已发送请求不能撤回。`, _event.sender);
    return approved ? testService.startClient(config, session.epoch, authorization) : null;
  });
  ipcMain.handle("tests:start-generator", async (_event, value: SignalConfig) => {
    const config = parseSignalConfig(value);
    const authorization = testService.authorizationVersion("generator");
    const approved = await confirmTest(`更新本机 Unit ID ${config.unitId} 的数据`, config,
      `本机保持寄存器地址 ${config.address}、${config.address + 1} 将持续变化，TCP/RTU 共用该数据区。\n外部 PLC 下一次读取将获得新值；请让外部写入使用独立地址。此操作不会向 PLC 发起写请求。`, _event.sender);
    return approved ? testService.startGenerator(config, authorization) : null;
  });
  ipcMain.handle("tests:export", async () => {
    const report = { schemaVersion: 1, exportedAt: new Date().toISOString(), sessions: testService.snapshot(),
      notes: "每类保留最近一次运行；累计统计覆盖整次运行，明细最多1000轮。peerReads/peerWrites统计生成器运行期间该站号所有外部请求，不代表PLC应用已处理。原始帧请另用会话日志导出。" };
    const chosen = await dialog.showSaveDialog({ title: "导出双角色验证记录", defaultPath: "modbus-forge-dual-role-test.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (chosen.canceled || !chosen.filePath) return false;
    await fs.writeFile(chosen.filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return true;
  });
  ipcMain.handle("workspace:load", () => workspaceStore.load());
  ipcMain.handle("workspace:save", (_event, workspace: Workspace) => workspaceStore.save(workspace));
  ipcMain.handle("workspace:remember", (_event, settings: WorkspaceSettings) => workspaceStore.remember(settings));
  ipcMain.handle("workspace:close", async (event, settings: WorkspaceSettings | null) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || pendingCloses.has(owner)) return;
    pendingCloses.add(owner);
    try {
      if (settings) {
        try { await workspaceStore.remember(settings); }
        catch (error) {
          const choice = await dialog.showMessageBox(owner, {
            type: "warning", title: "配置尚未保存", message: "最后的配置未能保存。",
            detail: error instanceof Error ? error.message : String(error),
            buttons: ["返回修改", "放弃未保存配置并退出"], defaultId: 0, cancelId: 0, noLink: true
          });
          if (choice.response !== 1) return;
        }
      }
      closingWindows.add(owner);
      owner.close();
    } finally { pendingCloses.delete(owner); }
  });
  ipcMain.handle("workspace:import", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) throw new ModbusProtocolError("WINDOW_CLOSED", "发起导入的窗口已关闭。");
    if (pendingImports.has(owner)) throw new ModbusProtocolError("IMPORT_PENDING", "请先完成当前导入。");
    pendingImports.add(owner);
    try {
    const chosen = await dialog.showOpenDialog(owner, { title: "导入 Modbus Forge 工作区", properties: ["openFile"], filters: [{ name: "Modbus Forge 工作区", extensions: ["json"] }] });
    if (chosen.canceled || chosen.filePaths.length === 0) return null;
    if (owner.isDestroyed()) throw new ModbusProtocolError("WINDOW_CLOSED", "发起导入的窗口已关闭。");
    const workspace = await readWorkspace(chosen.filePaths[0]);
    await testService.stopAll("导入工作区，运行授权已撤销。");
    await service.disconnect();
    await slaveService.stopAll();
    if (workspace) await workspaceStore.save(workspace);
    return workspace;
    } finally { pendingImports.delete(owner); }
  });
  ipcMain.handle("workspace:export", async (_event, workspace: Workspace) => {
    parseWorkspace(workspace);
    const chosen = await dialog.showSaveDialog({ title: "导出 Modbus Forge 工作区", defaultPath: "modbus-forge-workspace.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (chosen.canceled || !chosen.filePath) return false;
    // Explicit export is a snapshot at the selected path, independent of automatic preferences.
    const normalized = parseWorkspace(workspace);
    await writeWorkspaceFile(chosen.filePath, normalized);
    return true;
  });
  ipcMain.handle("traces:export", async (_event, traces: RequestTrace[]) => {
    if (!Array.isArray(traces)) throw new ModbusProtocolError("INVALID_LOG_EXPORT", "日志导出内容无效。 ");
    const chosen = await dialog.showSaveDialog({ title: "导出 Modbus Forge 会话日志", defaultPath: "modbus-forge-session.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (chosen.canceled || !chosen.filePath) return false;
    await fs.writeFile(chosen.filePath, `${JSON.stringify({ exportedAt: new Date().toISOString(), traces: traces.map((trace) => ({ ...trace, roleName: roleLabel(trace.transport, trace.role) })) }, null, 2)}\n`, "utf8");
    return true;
  });
}

let testConfirmationPending = false;
async function confirmTest(title: string, config: SignalConfig, detail: string, sender: Electron.WebContents): Promise<boolean> {
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner || owner.isDestroyed()) throw new ModbusProtocolError("WINDOW_CLOSED", "发起测试的窗口已关闭。");
  if (testConfirmationPending) throw new ModbusProtocolError("TEST_CONFIRMATION_PENDING", "请先完成当前测试确认。");
  testConfirmationPending = true;
  try {
  const result = await dialog.showMessageBox(owner, { type: "warning", title: "确认本次持续测试", message: title,
    detail: `${detail}\n\n数据顺序：[序号1–65535循环，随机值${config.randomMin}–${config.randomMax}]。\n更新间隔 ${config.intervalMs} ms；运行 ${config.durationSeconds} 秒。\n重新开始会替换该类上次统计，建议先导出。`,
    buttons: ["取消", "确认并启动本次测试"], defaultId: 0, cancelId: 0, noLink: true });
  return result.response === 1 && !owner.isDestroyed();
  } finally { testConfirmationPending = false; }
}

service.on("trace", broadcastTrace);
slaveService.on("trace", broadcastTrace);
slaveService.on("data-changed", broadcastSlaveData);
testService.on("changed", (sessions) => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("tests:changed", sessions);
});

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  void testService.stopAll("应用退出，运行授权已撤销。");
  void service.disconnect();
  void slaveService.stopAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
