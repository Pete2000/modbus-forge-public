import type { FunctionCode, ModbusRequest, ModbusResult } from "./protocol";
import type { ClientTestConfig, SignalConfig, TestConfigs, TestKind, TestRun, TestSessions } from "./test-session";

export interface TcpConnectionConfig {
  kind: "tcp";
  host: string;
  port: number;
  timeoutMs: number;
}

export interface RtuConnectionConfig {
  kind: "rtu";
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: "none" | "even" | "odd" | "mark" | "space";
  stopBits: 1 | 1.5 | 2;
  timeoutMs: number;
}

export type ConnectionConfig = TcpConnectionConfig | RtuConnectionConfig;

export interface TcpSlaveServerConfig {
  kind: "tcp";
  host: string;
  port: number;
}

export interface RtuSlaveServerConfig {
  kind: "rtu";
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: "none" | "even" | "odd" | "mark" | "space";
  stopBits: 1 | 1.5 | 2;
}

export type SlaveServerConfig = TcpSlaveServerConfig | RtuSlaveServerConfig;
export type SlaveTransportKind = SlaveServerConfig["kind"];
export type SlaveServerStatus = "stopped" | "starting" | "listening" | "faulted" | "stopping";
export type SlaveDataArea = "coils" | "discreteInputs" | "holdingRegisters" | "inputRegisters";

export interface SlaveDataRange {
  unitId: number;
  area: SlaveDataArea;
  address: number;
  quantity: number;
}

export interface SlaveDataEntry extends Omit<SlaveDataRange, "quantity"> {
  values: boolean[] | number[];
}

export interface SlaveWorkspace {
  servers: {
    tcp: TcpSlaveServerConfig;
    rtu: RtuSlaveServerConfig;
  };
  data: SlaveDataEntry[];
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "faulted" | "closing";

export interface RequestTrace {
  timestamp: string;
  transport: "tcp" | "rtu";
  role: "master" | "slave";
  request?: ModbusRequest;
  rawRequest: string;
  rawResponse?: string;
  result?: ModbusResult;
  error?: { code: string; message: string };
  peer?: string;
  elapsedMs?: number;
  /** TCP server: complete frame handling to local socket write callback; not peer RTT. */
  serverProcessingMs?: number;
  /** Raw TCP server request function byte, including PDUs rejected before parsing. */
  serverFunctionCode?: number;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface WritePreparation {
  token: string;
  summary: string;
  expiresAt: string;
}

export interface WatchItem {
  id: string;
  name: string;
  request: ModbusRequest;
  intervalMs: number;
  enabled: boolean;
}

export interface Workspace {
  version: 2;
  connection: ConnectionConfig;
  draftRequest: {
    unitId: number;
    functionCode: FunctionCode;
    address: number;
    quantity: number;
    valuesText: string;
  };
  watches: WatchItem[];
  slave: SlaveWorkspace;
  testConfigs?: TestConfigs;
  view?: WorkspaceView;
}

export interface WorkspaceView {
  workbenchTab: "master" | "slave" | "verify";
  channelTab: "master" | "slave";
  channelCollapsed: boolean;
  leftWidthPct: number;
  decodeMode: "u16" | "i16" | "u32-be" | "u32-swap" | "i32-be" | "i32-swap" | "f32-be" | "f32-swap" | "ascii";
  slaveTransport: SlaveTransportKind;
  slavePage: SlaveDataRange;
  numberBase: "dec" | "hex";
}

/** Automatic preferences omit live register data and runtime authorization. */
export type WorkspaceSettings = Omit<Workspace, "slave"> & { slave: Pick<SlaveWorkspace, "servers"> };

export interface ModbusForgeApi {
  getStatus(): Promise<ConnectionStatus>;
  connect(config: ConnectionConfig): Promise<ConnectionStatus>;
  disconnect(): Promise<ConnectionStatus>;
  cancelActiveRequest(): Promise<ConnectionStatus>;
  listSerialPorts(): Promise<SerialPortInfo[]>;
  request(request: ModbusRequest): Promise<RequestTrace>;
  prepareWrite(request: ModbusRequest): Promise<WritePreparation>;
  executeWrite(token: string, request: ModbusRequest): Promise<RequestTrace>;
  cancelWrite(token: string, request: ModbusRequest): Promise<void>;
  getSlaveStatuses(): Promise<Record<SlaveTransportKind, SlaveServerStatus>>;
  startSlave(config: SlaveServerConfig): Promise<SlaveServerStatus>;
  stopSlave(kind: SlaveTransportKind): Promise<SlaveServerStatus>;
  readSlaveData(range: SlaveDataRange): Promise<SlaveDataEntry>;
  writeSlaveData(entry: SlaveDataEntry): Promise<void>;
  getSlaveDataset(): Promise<SlaveDataEntry[]>;
  loadSlaveDataset(entries: SlaveDataEntry[]): Promise<void>;
  loadWorkspace(): Promise<Workspace | null>;
  saveWorkspace(workspace: Workspace): Promise<void>;
  rememberWorkspace(settings: WorkspaceSettings): Promise<void>;
  closeWithWorkspace(settings: WorkspaceSettings | null): Promise<void>;
  onBeforeClose(listener: () => void): () => void;
  importWorkspace(): Promise<Workspace | null>;
  exportWorkspace(workspace: Workspace): Promise<boolean>;
  exportTraces(traces: RequestTrace[]): Promise<boolean>;
  getTestSessions(): Promise<TestSessions>;
  startClientTest(config: ClientTestConfig): Promise<TestRun | null>;
  startSignalGenerator(config: SignalConfig): Promise<TestRun | null>;
  stopTest(kind: TestKind): Promise<void>;
  exportTestSessions(): Promise<boolean>;
  onTestSessions(listener: (sessions: TestSessions) => void): () => void;
  onTrace(listener: (trace: RequestTrace) => void): () => void;
  onSlaveDataChanged(listener: (entry: SlaveDataEntry | undefined) => void): () => void;
}
