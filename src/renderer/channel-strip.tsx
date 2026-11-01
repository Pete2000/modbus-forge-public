import type { JSX } from "react";
import type {
  ConnectionConfig,
  ConnectionStatus,
  RtuConnectionConfig,
  RtuSlaveServerConfig,
  SerialPortInfo,
  SlaveServerConfig,
  SlaveServerStatus,
  SlaveTransportKind,
  TcpConnectionConfig,
  TcpSlaveServerConfig
} from "../shared/api";
import { roleLabel } from "../shared/role-label";
import {
  BAUD_RATE_OPTIONS,
  type ChannelTab,
  slaveStatusLabel,
  statusLabel
} from "./workbench-utils";

interface ChannelStripProps {
  activeTab: ChannelTab;
  onTabChange: (tab: ChannelTab) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  connection: ConnectionConfig;
  onConnectionChange: (config: ConnectionConfig) => void;
  status: ConnectionStatus;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  slaveTransport: SlaveTransportKind;
  onSlaveTransportChange: (kind: SlaveTransportKind) => void;
  slaveServers: { tcp: TcpSlaveServerConfig; rtu: RtuSlaveServerConfig };
  onSlaveConfigChange: (config: SlaveServerConfig) => void;
  slaveStatuses: Record<SlaveTransportKind, SlaveServerStatus>;
  onStartSlave: () => void;
  onStopSlave: () => void;
  serialPorts: SerialPortInfo[];
  onRefreshPorts: () => void;
}

export function ChannelStrip(props: ChannelStripProps): JSX.Element {
  const {
    activeTab,
    onTabChange,
    collapsed,
    onToggleCollapsed,
    connection,
    onConnectionChange,
    status,
    busy,
    onConnect,
    onDisconnect,
    slaveTransport,
    onSlaveTransportChange,
    slaveServers,
    onSlaveConfigChange,
    slaveStatuses,
    onStartSlave,
    onStopSlave,
    serialPorts,
    onRefreshPorts
  } = props;

  const requestRole = roleLabel(connection.kind, "master");
  const masterLocked = busy || !["disconnected", "faulted"].includes(status);
  const masterEndpoint =
    connection.kind === "tcp"
      ? `${connection.host}:${connection.port}`
      : connection.path || "未选串口";

  const slaveConfig = slaveServers[slaveTransport];
  const slaveStatus = slaveStatuses[slaveTransport];
  const slaveLocked = busy || ["listening", "starting", "stopping"].includes(slaveStatus);
  const activeListeners = (["tcp", "rtu"] as const).filter((k) => slaveStatuses[k] === "listening");
  const listenerSummary =
    activeListeners.length === 0
      ? "未启动监听"
      : activeListeners
          .map((k) => (k === "tcp" ? `TCP ${slaveServers.tcp.port}` : `RTU ${slaveServers.rtu.path || "COM"}`))
          .join(" + ");

  const switchMasterTransport = (kind: "tcp" | "rtu"): void => {
    if (masterLocked || connection.kind === kind) return;
    if (kind === "tcp") {
      onConnectionChange({ kind: "tcp", host: "127.0.0.1", port: 502, timeoutMs: connection.timeoutMs });
    } else {
      onRefreshPorts();
      onConnectionChange({
        kind: "rtu",
        path: serialPorts[0]?.path ?? "",
        baudRate: 9600,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        timeoutMs: connection.timeoutMs
      });
    }
  };

  const switchSlaveTransport = (kind: SlaveTransportKind): void => {
    onSlaveTransportChange(kind);
    if (kind === "rtu") onRefreshPorts();
  };

  return (
    <section className={`channel-strip ${collapsed ? "is-collapsed" : ""}`} aria-label="通信通道配置">
      <div className="channel-strip-bar">
        <div className="channel-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "master"}
            className={`channel-tab ${activeTab === "master" ? "active" : ""}`}
            onClick={() => {
              onTabChange("master");
              if (collapsed) onToggleCollapsed();
            }}
          >
            <i className={`status-dot ${status}`} />
            <span className="channel-tab-title">请求端通道 ({requestRole})</span>
            <code className="channel-tab-meta">
              {status === "connected" ? masterEndpoint : statusLabel(status)}
            </code>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "slave"}
            className={`channel-tab ${activeTab === "slave" ? "active" : ""}`}
            onClick={() => {
              onTabChange("slave");
              if (collapsed) onToggleCollapsed();
            }}
          >
            <i
              className={`status-dot ${
                activeListeners.length > 0
                  ? "listening"
                  : slaveStatuses.tcp === "faulted" || slaveStatuses.rtu === "faulted"
                    ? "faulted"
                    : "stopped"
              }`}
            />
            <span className="channel-tab-title">本机监听服务 (Server / 从站)</span>
            <code className="channel-tab-meta">{listenerSummary}</code>
          </button>
        </div>

        <button
          type="button"
          className="ghost-btn collapse-toggle"
          onClick={onToggleCollapsed}
          title={collapsed ? "展开通信参数栏" : "收起通信参数栏以扩大工作区"}
        >
          {collapsed ? "展开连接配置 ▾" : "收起参数 ▴"}
        </button>
      </div>

      {!collapsed && (
        <div className="channel-strip-body">
          {activeTab === "master" ? (
            <>
              <div className="segmented-control">
                <button
                  type="button"
                  disabled={masterLocked}
                  className={connection.kind === "tcp" ? "active" : ""}
                  onClick={() => switchMasterTransport("tcp")}
                >
                  TCP 客户端
                </button>
                <button
                  type="button"
                  disabled={masterLocked}
                  className={connection.kind === "rtu" ? "active" : ""}
                  onClick={() => switchMasterTransport("rtu")}
                >
                  RTU 主站
                </button>
              </div>

              <fieldset disabled={masterLocked} className="channel-form-grid">
                {connection.kind === "tcp" ? (
                  <MasterTcpFields config={connection} onChange={onConnectionChange} />
                ) : (
                  <MasterRtuFields
                    config={connection}
                    ports={serialPorts}
                    onChange={onConnectionChange}
                    onRefresh={onRefreshPorts}
                  />
                )}
                <label className="field compact-field">
                  <span>超时 (ms)</span>
                  <input
                    type="number"
                    min={100}
                    max={120000}
                    value={connection.timeoutMs}
                    onChange={(e) => onConnectionChange({ ...connection, timeoutMs: Number(e.target.value) })}
                  />
                </label>
              </fieldset>

              <div className="channel-cta">
                {status === "connected" ? (
                  <button type="button" className="danger-outline" disabled={busy} onClick={onDisconnect}>
                    断开连接
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || status === "connecting"}
                    onClick={onConnect}
                  >
                    {status === "connecting" ? "连接中…" : "建立连接"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="segmented-control">
                <button
                  type="button"
                  className={slaveTransport === "tcp" ? "active" : ""}
                  onClick={() => switchSlaveTransport("tcp")}
                >
                  <i className={`inline-dot ${slaveStatuses.tcp}`} />
                  TCP 服务器
                </button>
                <button
                  type="button"
                  className={slaveTransport === "rtu" ? "active" : ""}
                  onClick={() => switchSlaveTransport("rtu")}
                >
                  <i className={`inline-dot ${slaveStatuses.rtu}`} />
                  RTU 从站
                </button>
              </div>

              <fieldset disabled={slaveLocked} className="channel-form-grid">
                {slaveConfig.kind === "tcp" ? (
                  <SlaveTcpFields config={slaveConfig} onChange={onSlaveConfigChange} />
                ) : (
                  <SlaveRtuFields
                    config={slaveConfig}
                    ports={serialPorts}
                    onChange={onSlaveConfigChange}
                    onRefresh={onRefreshPorts}
                  />
                )}
              </fieldset>

              <div className="channel-cta">
                <span className="channel-state-hint">{slaveStatusLabel(slaveStatus)}</span>
                {slaveStatus === "listening" ? (
                  <button type="button" className="danger-outline" disabled={busy} onClick={onStopSlave}>
                    停止监听
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || slaveStatus === "starting"}
                    onClick={onStartSlave}
                  >
                    {slaveStatus === "starting" ? "启动中…" : "开始监听"}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function MasterTcpFields({
  config,
  onChange
}: {
  config: TcpConnectionConfig;
  onChange: (config: ConnectionConfig) => void;
}): JSX.Element {
  return (
    <>
      <label className="field host-field">
        <span>目标主机 / IP</span>
        <input
          value={config.host}
          placeholder="127.0.0.1"
          onChange={(e) => onChange({ ...config, host: e.target.value })}
        />
      </label>
      <label className="field compact-field">
        <span>端口</span>
        <input
          type="number"
          min={1}
          max={65535}
          value={config.port}
          onChange={(e) => onChange({ ...config, port: Number(e.target.value) })}
        />
      </label>
    </>
  );
}

function MasterRtuFields({
  config,
  ports,
  onChange,
  onRefresh
}: {
  config: RtuConnectionConfig;
  ports: SerialPortInfo[];
  onChange: (config: ConnectionConfig) => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <>
      <SerialPortPicker
        label="串口 (COM)"
        value={config.path}
        ports={ports}
        onChange={(path) => onChange({ ...config, path })}
        onRefresh={onRefresh}
      />
      <SerialParamsFields config={config} onChange={onChange} />
    </>
  );
}

function SlaveTcpFields({
  config,
  onChange
}: {
  config: TcpSlaveServerConfig;
  onChange: (config: SlaveServerConfig) => void;
}): JSX.Element {
  return (
    <>
      <label className="field host-field">
        <span>绑定监听地址</span>
        <input
          value={config.host}
          placeholder="127.0.0.1"
          onChange={(e) => onChange({ ...config, host: e.target.value })}
        />
      </label>
      <label className="field compact-field">
        <span>监听端口</span>
        <input
          type="number"
          min={1}
          max={65535}
          value={config.port}
          onChange={(e) => onChange({ ...config, port: Number(e.target.value) })}
        />
      </label>
    </>
  );
}

function SlaveRtuFields({
  config,
  ports,
  onChange,
  onRefresh
}: {
  config: RtuSlaveServerConfig;
  ports: SerialPortInfo[];
  onChange: (config: SlaveServerConfig) => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <>
      <SerialPortPicker
        label="监听串口 (COM)"
        value={config.path}
        ports={ports}
        onChange={(path) => onChange({ ...config, path })}
        onRefresh={onRefresh}
      />
      <SerialParamsFields config={config} onChange={onChange} />
    </>
  );
}

function SerialPortPicker({
  label,
  value,
  ports,
  onChange,
  onRefresh
}: {
  label: string;
  value: string;
  ports: SerialPortInfo[];
  onChange: (path: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  const hasCurrent = !value || ports.some((p) => p.path === value);
  return (
    <label className="field port-picker-field">
      <span>{label}</span>
      <div className="input-with-btn">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{ports.length === 0 ? "未检测到串口（点击刷新）" : "选择 COM 口"}</option>
          {!hasCurrent && value && <option value={value}>{value}（已保存）</option>}
          {ports.map((port) => (
            <option key={port.path} value={port.path}>
              {port.path}
              {port.manufacturer ? ` · ${port.manufacturer}` : ""}
            </option>
          ))}
        </select>
        <button type="button" onClick={onRefresh} title="重新扫描本机串口">
          刷新
        </button>
      </div>
    </label>
  );
}

function SerialParamsFields<
  T extends {
    baudRate: number;
    dataBits: 5 | 6 | 7 | 8;
    parity: "none" | "even" | "odd" | "mark" | "space";
    stopBits: 1 | 1.5 | 2;
  }
>({ config, onChange }: { config: T; onChange: (next: T) => void }): JSX.Element {
  const baudOptions = BAUD_RATE_OPTIONS.includes(config.baudRate)
    ? BAUD_RATE_OPTIONS
    : [config.baudRate, ...BAUD_RATE_OPTIONS];
  return (
    <>
      <label className="field compact-field">
        <span>波特率</span>
        <select
          value={config.baudRate}
          onChange={(e) => onChange({ ...config, baudRate: Number(e.target.value) })}
        >
          {baudOptions.map((rate) => (
            <option key={rate} value={rate}>
              {rate}
            </option>
          ))}
        </select>
      </label>
      <label className="field tiny-field">
        <span>数据位</span>
        <select
          value={config.dataBits}
          onChange={(e) => onChange({ ...config, dataBits: Number(e.target.value) as T["dataBits"] })}
        >
          {[8, 7, 6, 5].map((bits) => (
            <option key={bits} value={bits}>
              {bits}
            </option>
          ))}
        </select>
      </label>
      <label className="field compact-field">
        <span>校验位</span>
        <select
          value={config.parity}
          onChange={(e) => onChange({ ...config, parity: e.target.value as T["parity"] })}
        >
          <option value="none">无 (None)</option>
          <option value="even">偶 (Even)</option>
          <option value="odd">奇 (Odd)</option>
          <option value="mark">Mark</option>
          <option value="space">Space</option>
        </select>
      </label>
      <label className="field tiny-field">
        <span>停止位</span>
        <select
          value={config.stopBits}
          onChange={(e) => onChange({ ...config, stopBits: Number(e.target.value) as T["stopBits"] })}
        >
          {[1, 1.5, 2].map((stop) => (
            <option key={stop} value={stop}>
              {stop}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
