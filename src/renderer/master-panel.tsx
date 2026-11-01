import { useState, type JSX } from "react";
import type { WatchItem } from "../shared/api";
import type { FunctionCode, ModbusRequest } from "../shared/protocol";
import {
  type DraftRequest,
  errorMessage,
  formatPlcAddressHint,
  FUNCTION_OPTIONS,
  isBitCode,
  isWriteCode,
  type NoticeTone,
  requestFromDraft,
  summarizeRequest,
  type WatchRuntimeState
} from "./workbench-utils";

interface MasterPanelProps {
  requestRole: string;
  connected: boolean;
  busy: boolean;
  draft: DraftRequest;
  onDraftChange: (draft: DraftRequest) => void;
  onSendRequest: () => void;
  onCancelActiveRequest: () => void;
  onFocusConnect: () => void;
  watches: WatchItem[];
  onWatchesChange: (updater: (current: WatchItem[]) => WatchItem[]) => void;
  watchRuntime: Record<string, WatchRuntimeState>;
  onNotify: (text: string, tone?: NoticeTone) => void;
}

const QTY_PRESETS = [1, 2, 4, 8, 16];
const INTERVAL_PRESETS = [250, 500, 1000, 2000, 5000];

export function MasterPanel(props: MasterPanelProps): JSX.Element {
  const {
    requestRole,
    connected,
    busy,
    draft,
    onDraftChange,
    onSendRequest,
    onCancelActiveRequest,
    onFocusConnect,
    watches,
    onWatchesChange,
    watchRuntime,
    onNotify
  } = props;

  const [addingWatch, setAddingWatch] = useState(false);
  const [watchName, setWatchName] = useState("");
  const [watchInterval, setWatchInterval] = useState(1000);

  const selectedIsWrite = isWriteCode(draft.functionCode);
  const selectedIsBit = isBitCode(draft.functionCode);
  const selectedSingleWrite = draft.functionCode === 5 || draft.functionCode === 6;
  const addressHint = formatPlcAddressHint(draft.functionCode, draft.address);

  const parsedTokens = draft.valuesText
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const openWatchCreator = (): void => {
    try {
      const request = requestFromDraft(draft);
      if (isWriteCode(request.functionCode)) {
        onNotify("轮询队列仅支持只读功能码（FC 01 / 02 / 03 / 04）。", "warning");
        return;
      }
      const fcLabel = FUNCTION_OPTIONS.find((item) => item.code === request.functionCode)?.short ?? "读取";
      setWatchName(`${fcLabel} · ID ${request.unitId} @${request.address} (×${request.quantity ?? 1})`);
      setWatchInterval(1000);
      setAddingWatch(true);
    } catch (error) {
      onNotify(errorMessage(error), "error");
    }
  };

  const confirmAddWatch = (): void => {
    try {
      const request: ModbusRequest = requestFromDraft(draft);
      if (isWriteCode(request.functionCode)) {
        throw new Error("监视项只允许保存读取请求。");
      }
      const trimmed = watchName.trim();
      if (!trimmed) {
        throw new Error("请填写监视项名称。");
      }
      if (!Number.isInteger(watchInterval) || watchInterval < 250 || watchInterval > 60000) {
        throw new Error("轮询间隔必须是 250 到 60000 毫秒的整数。");
      }
      onWatchesChange((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          name: trimmed.slice(0, 100),
          request,
          intervalMs: watchInterval,
          enabled: true
        }
      ]);
      setAddingWatch(false);
      onNotify(`已将「${trimmed}」加入轮询队列。`, "success");
    } catch (error) {
      onNotify(errorMessage(error), "error");
    }
  };

  const loadWatchToDraft = (watch: WatchItem): void => {
    onDraftChange({
      unitId: watch.request.unitId,
      functionCode: watch.request.functionCode,
      address: watch.request.address,
      quantity: watch.request.quantity ?? 1,
      valuesText: ""
    });
    onNotify(`已将「${watch.name}」参数载入单次请求构造器。`, "info");
  };

  const activeWatchCount = watches.filter((w) => w.enabled).length;

  return (
    <div className="workbench-stack">
      <section className="card request-card">
        <header className="card-header">
          <div>
            <div className="card-title-row">
              <h2>{requestRole} · 单次请求构造</h2>
              <span className={`badge ${selectedIsWrite ? "badge-warn" : "badge-info"}`}>
                {selectedIsWrite ? "受控写入（二次确认）" : "只读查询"}
              </span>
            </div>
            <p className="card-subtitle">构造一条标准 Modbus PDU，发送后在右侧实时观测收发报文与寄存器解码</p>
          </div>
          {!connected && (
            <button type="button" className="ghost-btn accent-link" onClick={onFocusConnect}>
              尚未连接 · 去连接通道 →
            </button>
          )}
        </header>

        <div className={`request-builder-grid ${selectedIsWrite ? "is-write" : "is-read"}`}>
          <label className="field">
            <span>功能码 (Function Code)</span>
            <select
              value={draft.functionCode}
              onChange={(e) => {
                const nextFc = Number(e.target.value) as FunctionCode;
                if (isWriteCode(nextFc)) setAddingWatch(false);
                onDraftChange({ ...draft, functionCode: nextFc });
              }}
            >
              <optgroup label="读取功能码 (只读安全)">
                {FUNCTION_OPTIONS.filter((o) => !o.write).map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="写入功能码 (需确认令牌)">
                {FUNCTION_OPTIONS.filter((o) => o.write).map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          <label className="field">
            <span>站号 (ID)</span>
            <input
              type="number"
              min={1}
              max={247}
              value={draft.unitId}
              onChange={(e) => onDraftChange({ ...draft, unitId: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span className="field-label-split">
              <b>零基地址</b>
              <small>{addressHint}</small>
            </span>
            <input
              type="number"
              min={0}
              max={65535}
              value={draft.address}
              onChange={(e) => onDraftChange({ ...draft, address: Number(e.target.value) })}
            />
          </label>

          {!selectedIsWrite && (
            <div className="field">
              <div className="field-label-split">
                <span>数量</span>
                <div className="preset-chips" aria-label="快捷数量">
                  {QTY_PRESETS.map((qty) => (
                    <button
                      key={qty}
                      type="button"
                      className={`chip-btn ${draft.quantity === qty ? "active" : ""}`}
                      onClick={() => onDraftChange({ ...draft, quantity: qty })}
                    >
                      {qty}
                    </button>
                  ))}
                </div>
              </div>
              <input
                type="number"
                min={1}
                max={selectedIsBit ? 2000 : 125}
                value={draft.quantity}
                onChange={(e) => onDraftChange({ ...draft, quantity: Number(e.target.value) })}
              />
            </div>
          )}

          {selectedIsWrite && (
            <label className="field span-full">
              <span className="field-label-split">
                <b>
                  {selectedIsBit
                    ? `写入线圈值 (${selectedSingleWrite ? "单个值" : "多个值以逗号/空格分隔"}：1/0 或 true/false)`
                    : `写入寄存器值 (${selectedSingleWrite ? "单个值" : "多个值以逗号/空格分隔"}：0–65535 或 0xFFFF)`}
                </b>
                <small>已识别 {parsedTokens.length} 项</small>
              </span>
              <input
                value={draft.valuesText}
                placeholder={
                  draft.functionCode === 5
                    ? "例如：true 或 1"
                    : draft.functionCode === 6
                      ? "例如：100 或 0x0064"
                      : draft.functionCode === 15
                        ? "例如：1, 0, 1, 1"
                        : "例如：100, 200, 0x01F4"
                }
                onChange={(e) => onDraftChange({ ...draft, valuesText: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && connected && !busy) onSendRequest();
                }}
              />
            </label>
          )}
        </div>

        {selectedIsWrite && (
          <div className="inline-callout warn">
            <span>安全保护：点击“准备写入”不会立即发包，系统将生成 60 秒一次性确认令牌并展示目标摘要。</span>
          </div>
        )}

        <div className="action-bar">
          <div className="action-group">
            <button
              type="button"
              className={selectedIsWrite ? "danger" : "primary"}
              disabled={busy || !connected}
              onClick={onSendRequest}
            >
              {selectedIsWrite ? "准备写入…" : "发送读取请求"}
            </button>
            {!selectedIsWrite && (
              <button
                type="button"
                disabled={busy}
                onClick={() => (addingWatch ? setAddingWatch(false) : openWatchCreator())}
              >
                {addingWatch ? "收起轮询表单" : "+ 加入轮询队列"}
              </button>
            )}
          </div>
          <button
            type="button"
            className="ghost-btn"
            disabled={!connected}
            onClick={onCancelActiveRequest}
            title="取消当前排队/等待中的请求并断开连接"
          >
            取消请求并断开
          </button>
        </div>

        {addingWatch && !selectedIsWrite && (
          <div
            className="watch-creator-box"
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmAddWatch();
              if (e.key === "Escape") setAddingWatch(false);
            }}
          >
            <div className="watch-creator-grid">
              <label className="field">
                <span>监视项名称</span>
                <input
                  autoFocus
                  value={watchName}
                  placeholder="例如：出水压力寄存器"
                  onChange={(e) => setWatchName(e.target.value)}
                />
              </label>
              <div className="field">
                <div className="field-label-split">
                  <span>轮询间隔 (250–60000 ms)</span>
                  <div className="preset-chips">
                    {INTERVAL_PRESETS.map((ms) => (
                      <button
                        key={ms}
                        type="button"
                        className={`chip-btn ${watchInterval === ms ? "active" : ""}`}
                        onClick={() => setWatchInterval(ms)}
                      >
                        {ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  type="number"
                  min={250}
                  max={60000}
                  step={50}
                  value={watchInterval}
                  onChange={(e) => setWatchInterval(Number(e.target.value))}
                />
              </div>
            </div>
            <div className="action-group" style={{ marginTop: 10 }}>
              <button type="button" className="primary" onClick={confirmAddWatch}>
                确认添加
              </button>
              <button type="button" className="ghost-btn" onClick={() => setAddingWatch(false)}>
                取消
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card watch-card fill-card">
        <header className="card-header">
          <div>
            <div className="card-title-row">
              <h2>只读轮询监视队列</h2>
              <span className={`badge ${activeWatchCount > 0 && connected ? "badge-ok" : "badge-neutral"}`}>
                {connected ? `运行中 ${activeWatchCount}` : "待连接"} / 共 {watches.length} 项
              </span>
            </div>
            <p className="card-subtitle">同一连接自动串行排队执行，防止 RTU 串口帧穿插冲突</p>
          </div>
          {watches.length > 0 && (
            <div className="action-group compact-btns">
              <button
                type="button"
                onClick={() => onWatchesChange((list) => list.map((w) => ({ ...w, enabled: true })))}
                disabled={activeWatchCount === watches.length}
              >
                全部恢复
              </button>
              <button
                type="button"
                onClick={() => onWatchesChange((list) => list.map((w) => ({ ...w, enabled: false })))}
                disabled={activeWatchCount === 0}
              >
                全部暂停
              </button>
              <button type="button" className="ghost-btn" onClick={() => onWatchesChange(() => [])}>
                清空
              </button>
            </div>
          )}
        </header>

        {watches.length === 0 ? (
          <div className="empty-placeholder compact">
            <strong>暂无轮询监视项</strong>
            <span>在上方构造读取请求后点击「+ 加入轮询队列」，即可按设定周期持续观测数值变化。</span>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>请求参数</th>
                  <th>周期</th>
                  <th>最新返回值 / 状态</th>
                  <th>更新时间</th>
                  <th className="align-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {watches.map((watch) => {
                  const runtime = watchRuntime[watch.id];
                  const isRunning = connected && watch.enabled;
                  return (
                    <tr key={watch.id} className={!watch.enabled ? "row-muted" : ""}>
                      <td>
                        <div className="watch-name-cell">
                          <i
                            className={`inline-dot ${
                              runtime?.isError
                                ? "faulted"
                                : isRunning
                                  ? "connected"
                                  : "stopped"
                            }`}
                          />
                          <strong>{watch.name}</strong>
                        </div>
                      </td>
                      <td className="mono">{summarizeRequest(watch.request)}</td>
                      <td className="mono">{watch.intervalMs} ms</td>
                      <td className={`mono watch-value-cell ${runtime?.isError ? "text-error" : ""}`}>
                        {runtime?.text ?? (watch.enabled ? (connected ? "等待首轮…" : "等待连接") : "已暂停")}
                      </td>
                      <td className="mono text-muted">{runtime?.updatedAt ?? "—"}</td>
                      <td className="row-actions align-right">
                        <button
                          type="button"
                          onClick={() =>
                            onWatchesChange((list) =>
                              list.map((item) =>
                                item.id === watch.id ? { ...item, enabled: !item.enabled } : item
                              )
                            )
                          }
                        >
                          {watch.enabled ? "暂停" : "恢复"}
                        </button>
                        <button type="button" className="ghost-btn" onClick={() => loadWatchToDraft(watch)}>
                          载入
                        </button>
                        <button
                          type="button"
                          className="ghost-btn text-danger"
                          onClick={() => onWatchesChange((list) => list.filter((item) => item.id !== watch.id))}
                        >
                          移除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
