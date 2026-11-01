import { useEffect, useState, type JSX } from "react";
import type {
  RtuSlaveServerConfig,
  SlaveDataArea,
  SlaveServerStatus,
  SlaveTransportKind,
  TcpSlaveServerConfig
} from "../shared/api";
import {
  errorMessage,
  formatHex16,
  formatPlcAddressHint,
  formatRegister,
  isBitArea,
  type NoticeTone,
  type NumberBase,
  parseRegisterInput,
  SLAVE_AREAS,
  slaveStatusLabel
} from "./workbench-utils";

interface SlavePanelProps {
  listenerRole: string;
  slaveStatuses: Record<SlaveTransportKind, SlaveServerStatus>;
  slaveServers: { tcp: TcpSlaveServerConfig; rtu: RtuSlaveServerConfig };
  onFocusListenerConfig: (kind: SlaveTransportKind) => void;
  unitId: number;
  onUnitIdChange: (unitId: number) => void;
  area: SlaveDataArea;
  onAreaChange: (area: SlaveDataArea) => void;
  address: number;
  onAddressChange: (address: number) => void;
  quantity: number;
  onQuantityChange: (quantity: number) => void;
  values: Array<boolean | number>;
  changedAddresses: Set<number>;
  numberBase: NumberBase;
  onNumberBaseChange: (base: NumberBase) => void;
  onRefresh: () => void;
  onUpdateValue: (index: number, value: boolean | number) => Promise<void>;
  onClearPage: () => Promise<void>;
  onNotify: (text: string, tone?: NoticeTone) => void;
}

const PAGE_SIZES = [16, 32, 64];

export function SlavePanel(props: SlavePanelProps): JSX.Element {
  const {
    slaveStatuses,
    slaveServers,
    onFocusListenerConfig,
    unitId,
    onUnitIdChange,
    area,
    onAreaChange,
    address,
    onAddressChange,
    quantity,
    onQuantityChange,
    values,
    changedAddresses,
    numberBase,
    onNumberBaseChange: setNumberBase,
    onRefresh,
    onUpdateValue,
    onClearPage,
    onNotify
  } = props;

  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  const bitMode = isBitArea(area);
  const currentAreaMeta = SLAVE_AREAS.find((a) => a.value === area)!;
  const maxStart = Math.max(0, 65536 - quantity);

  const stepPage = (delta: number): void => {
    const next = Math.max(0, Math.min(maxStart, address + delta));
    onAddressChange(next);
  };

  const handleClearClick = (): void => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    void onClearPage();
  };

  return (
    <div className="workbench-stack">
      <section className="card listener-overview-card">
        <div className="listener-overview-grid">
          <div className="listener-pill-card">
            <div className="listener-pill-info">
              <i className={`status-dot ${slaveStatuses.tcp}`} />
              <div>
                <strong>TCP 服务器</strong>
                <span className="mono text-muted">
                  {slaveServers.tcp.host}:{slaveServers.tcp.port} · {slaveStatusLabel(slaveStatuses.tcp)}
                </span>
              </div>
            </div>
            <button type="button" className="ghost-btn" onClick={() => onFocusListenerConfig("tcp")}>
              {slaveStatuses.tcp === "listening" ? "管理" : "去启动"}
            </button>
          </div>

          <div className="listener-pill-card">
            <div className="listener-pill-info">
              <i className={`status-dot ${slaveStatuses.rtu}`} />
              <div>
                <strong>RTU 从站</strong>
                <span className="mono text-muted">
                  {slaveServers.rtu.path || "未选 COM 口"} · {slaveStatusLabel(slaveStatuses.rtu)}
                </span>
              </div>
            </div>
            <button type="button" className="ghost-btn" onClick={() => onFocusListenerConfig("rtu")}>
              {slaveStatuses.rtu === "listening" ? "管理" : "去配置"}
            </button>
          </div>
        </div>
        <p className="listener-note">
          TCP 服务器与 RTU 从站共享下方本机数据模型（按 Unit ID 独立隔离），可同时运行。注意：RTU 主站与从站不能同时占用同一物理 COM 口。
        </p>
      </section>

      <section className="card data-editor-card fill-card">
        <header className="card-header">
          <div>
            <div className="card-title-row">
              <h2>本机数据区编辑器</h2>
              <span className={`badge ${currentAreaMeta.writableByPeer ? "badge-ok" : "badge-neutral"}`}>
                {currentAreaMeta.fcHint}
              </span>
            </div>
            <p className="card-subtitle">
              {bitMode
                ? "点击单元即可切换线圈/离散量状态，下一条外部读取立即生效"
                : "输入十进制或 0x 十六进制后按 Enter 或失焦提交，避免逐键输入产生中间脏数据"}
            </p>
          </div>

          <div className="action-group compact-btns">
            {!bitMode && (
              <div className="segmented-control mini" aria-label="数据显示进制">
                <button
                  type="button"
                  className={numberBase === "dec" ? "active" : ""}
                  onClick={() => setNumberBase("dec")}
                >
                  DEC
                </button>
                <button
                  type="button"
                  className={numberBase === "hex" ? "active" : ""}
                  onClick={() => setNumberBase("hex")}
                >
                  HEX
                </button>
              </div>
            )}
            <button type="button" onClick={onRefresh}>
              刷新
            </button>
            <button
              type="button"
              className={confirmClear ? "danger" : "ghost-btn text-danger"}
              onClick={handleClearClick}
            >
              {confirmClear ? "确认清零当前页？" : "当前页清零"}
            </button>
          </div>
        </header>

        <div className="slave-filter-grid">
          <label className="field">
            <span>Unit ID (1–247)</span>
            <input
              type="number"
              min={1}
              max={247}
              value={unitId}
              onChange={(e) => onUnitIdChange(Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span>数据区类型</span>
            <select value={area} onChange={(e) => onAreaChange(e.target.value as SlaveDataArea)}>
              {SLAVE_AREAS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label} · {item.fcHint}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span className="field-label-split">
              <b>起始地址</b>
              <small>{formatPlcAddressHint(area, address)}</small>
            </span>
            <div className="input-with-btn">
              <button
                type="button"
                disabled={address <= 0}
                onClick={() => stepPage(-quantity)}
                title={`向前翻 ${quantity} 个地址`}
              >
                ◀
              </button>
              <input
                type="number"
                min={0}
                max={maxStart}
                value={address}
                onChange={(e) => onAddressChange(Number(e.target.value))}
              />
              <button
                type="button"
                disabled={address >= maxStart}
                onClick={() => stepPage(quantity)}
                title={`向后翻 ${quantity} 个地址`}
              >
                ▶
              </button>
            </div>
          </div>

          <div className="field">
            <div className="field-label-split">
              <span>页大小</span>
              <div className="preset-chips">
                {PAGE_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`chip-btn ${quantity === size ? "active" : ""}`}
                    onClick={() => {
                      onQuantityChange(size);
                      if (address + size > 65536) onAddressChange(65536 - size);
                    }}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="number"
              min={1}
              max={64}
              value={quantity}
              onChange={(e) => onQuantityChange(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="register-grid-scroll">
          <div className={`register-grid ${bitMode ? "bit-grid" : ""}`}>
            {values.map((val, index) => {
              const cellAddr = address + index;
              const isChanged = changedAddresses.has(cellAddr);
              return bitMode ? (
                <button
                  key={cellAddr}
                  type="button"
                  className={`bit-cell ${Boolean(val) ? "is-on" : "is-off"} ${isChanged ? "is-changed" : ""}`}
                  onClick={() => void onUpdateValue(index, !Boolean(val))}
                >
                  <span className="cell-addr">
                    <b>{cellAddr}</b>
                    <small>{formatHex16(cellAddr)}</small>
                  </span>
                  <strong className="bit-badge">{Boolean(val) ? "ON · 1" : "OFF · 0"}</strong>
                </button>
              ) : (
                <RegisterCell
                  key={`${unitId}-${area}-${cellAddr}`}
                  address={cellAddr}
                  value={Number(val)}
                  base={numberBase}
                  changed={isChanged}
                  onCommit={(nextVal) => onUpdateValue(index, nextVal)}
                  onInvalid={(msg) => onNotify(`地址 ${cellAddr}：${msg}`, "error")}
                />
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function RegisterCell({
  address,
  value,
  base,
  changed,
  onCommit,
  onInvalid
}: {
  address: number;
  value: number;
  base: NumberBase;
  changed: boolean;
  onCommit: (next: number) => Promise<void>;
  onInvalid: (msg: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue = draft !== null ? draft : formatRegister(value, base);
  const isDirty = draft !== null && draft.trim() !== formatRegister(value, base);

  const commitDraft = (): void => {
    if (draft === null) return;
    const raw = draft;
    setDraft(null);
    if (raw.trim() === formatRegister(value, base)) return;
    try {
      const parsed = parseRegisterInput(raw, base);
      if (parsed !== value) {
        void onCommit(parsed);
      }
    } catch (error) {
      onInvalid(errorMessage(error));
    }
  };

  return (
    <label className={`reg-cell ${isDirty ? "is-dirty" : ""} ${changed ? "is-changed" : ""}`}>
      <span className="cell-addr">
        <b>{address}</b>
        <small>{formatHex16(address)}</small>
      </span>
      <input
        type="text"
        inputMode={base === "dec" ? "numeric" : "text"}
        value={displayValue}
        onFocus={(e) => {
          setDraft(formatRegister(value, base));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
