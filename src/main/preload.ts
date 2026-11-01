import { contextBridge, ipcRenderer } from "electron";
import type { ConnectionConfig, ModbusForgeApi, RequestTrace, SlaveDataEntry, SlaveDataRange, SlaveServerConfig, SlaveTransportKind, Workspace } from "../shared/api";
import type { ModbusRequest } from "../shared/protocol";

const api: ModbusForgeApi = {
  getStatus: () => ipcRenderer.invoke("modbus:get-status"),
  connect: (config: ConnectionConfig) => ipcRenderer.invoke("modbus:connect", config),
  disconnect: () => ipcRenderer.invoke("modbus:disconnect"),
  cancelActiveRequest: () => ipcRenderer.invoke("modbus:cancel-active-request"),
  listSerialPorts: () => ipcRenderer.invoke("modbus:list-serial-ports"),
  request: (request: ModbusRequest) => ipcRenderer.invoke("modbus:request", request),
  prepareWrite: (request: ModbusRequest) => ipcRenderer.invoke("modbus:prepare-write", request),
  executeWrite: (token: string, request: ModbusRequest) => ipcRenderer.invoke("modbus:execute-write", token, request),
  cancelWrite: (token: string, request: ModbusRequest) => ipcRenderer.invoke("modbus:cancel-write", token, request),
  getSlaveStatuses: () => ipcRenderer.invoke("slave:get-statuses"),
  startSlave: (config: SlaveServerConfig) => ipcRenderer.invoke("slave:start", config),
  stopSlave: (kind: SlaveTransportKind) => ipcRenderer.invoke("slave:stop", kind),
  readSlaveData: (range: SlaveDataRange) => ipcRenderer.invoke("slave:read-data", range),
  writeSlaveData: (entry: SlaveDataEntry) => ipcRenderer.invoke("slave:write-data", entry),
  getSlaveDataset: () => ipcRenderer.invoke("slave:get-dataset"),
  loadSlaveDataset: (entries: SlaveDataEntry[]) => ipcRenderer.invoke("slave:load-dataset", entries),
  loadWorkspace: () => ipcRenderer.invoke("workspace:load"),
  saveWorkspace: (workspace: Workspace) => ipcRenderer.invoke("workspace:save", workspace),
  rememberWorkspace: (settings) => ipcRenderer.invoke("workspace:remember", settings),
  closeWithWorkspace: (settings) => ipcRenderer.invoke("workspace:close", settings),
  onBeforeClose: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("workspace:before-close", handler);
    return () => ipcRenderer.removeListener("workspace:before-close", handler);
  },
  importWorkspace: () => ipcRenderer.invoke("workspace:import"),
  exportWorkspace: (workspace: Workspace) => ipcRenderer.invoke("workspace:export", workspace),
  exportTraces: (traces: RequestTrace[]) => ipcRenderer.invoke("traces:export", traces),
  getTestSessions: () => ipcRenderer.invoke("tests:get"),
  startClientTest: (config) => ipcRenderer.invoke("tests:start-client", config),
  startSignalGenerator: (config) => ipcRenderer.invoke("tests:start-generator", config),
  stopTest: (kind) => ipcRenderer.invoke("tests:stop", kind),
  exportTestSessions: () => ipcRenderer.invoke("tests:export"),
  onTestSessions: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, sessions: import("../shared/test-session").TestSessions) => listener(sessions);
    ipcRenderer.on("tests:changed", handler);
    return () => ipcRenderer.removeListener("tests:changed", handler);
  },
  onTrace: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, trace: RequestTrace) => listener(trace);
    ipcRenderer.on("modbus:trace", handler);
    return () => ipcRenderer.removeListener("modbus:trace", handler);
  },
  onSlaveDataChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: SlaveDataEntry | undefined) => listener(entry);
    ipcRenderer.on("modbus:slave-data-changed", handler);
    return () => ipcRenderer.removeListener("modbus:slave-data-changed", handler);
  }
};

contextBridge.exposeInMainWorld("modbusForge", api);
