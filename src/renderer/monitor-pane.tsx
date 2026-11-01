import { useMemo, useState, type JSX } from "react";
import type { RequestTrace } from "../shared/api";
import { roleLabel } from "../shared/role-label";
import {
  buildDecodedRows,
  DECODE_OPTIONS,
  type DecodeMode,
  filterTraces,
  formatTimestampMs,
  summarizeServerWrites,
  summarizeTrace
} from "./workbench-utils";

interface MonitorPaneProps {
  traces: RequestTrace[];
  onExportTraces: () => void;
  onClearTraces: () => void;
  decodeMode: DecodeMode;
  onDecodeModeChange: (mode: DecodeMode) => void;
}

export function MonitorPane(props: MonitorPaneProps): JSX.Element {
  const { traces, onExportTraces, onClearTraces, decodeMode, onDecodeModeChange } = props;

  const [roleFilter, setRoleFilter] = useState<"all" | "master" | "slave">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error">("all");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozenSnapshot, setFrozenSnapshot] = useState<RequestTrace[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<RequestTrace | null>(null);
  const [decoderCollapsed, setDecoderCollapsed] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const activeSource = paused ? frozenSnapshot : traces;
  const bufferedCount = paused ? Math.max(0, traces.length - frozenSnapshot.length) : 0;

  const visibleTraces = useMemo(
    () => filterTraces(activeSource, { roleFilter, statusFilter, query }),
    [activeSource, roleFilter, statusFilter, query]
  );
  const serverWrites = useMemo(() => summarizeServerWrites(visibleTraces), [visibleTraces]);

  const togglePause = (): void => {
    if (!paused) {
      setFrozenSnapshot(traces);
      setPaused(true);
    } else {
      setPaused(false);
      setFrozenSnapshot([]);
    }
  };

  const inspectedTrace = useMemo(() => {
    if (selectedTrace) return selectedTrace;
    return (
      activeSource.find((t) => t.role === "master" && (t.result || t.error)) ??
      activeSource.find((t) => Boolean(t.result || t.error)) ??
      null
    );
  }, [selectedTrace, activeSource]);

  const decodedRows = useMemo(() => {
    if (!inspectedTrace?.result) return [];
    const startAddr = inspectedTrace.request?.address ?? 0;
    return buildDecodedRows(inspectedTrace.result, startAddr, decodeMode);
  }, [inspectedTrace, decodeMode]);

  const copyHex = (id: string, hex: string): void => {
    void navigator.clipboard?.writeText(hex).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1400);
    });
  };

  return (
    <aside className={`monitor-pane ${decoderCollapsed ? "decoder-collapsed" : ""}`} aria-label="实时通信监控与解码">
      <section className="card traffic-card">
        <header className="traffic-toolbar">
          <div className="traffic-toolbar-row">
            <div className="traffic-title-group">
              <h2>实时收发报文</h2>
              <span className="mono text-muted">
                {visibleTraces.length} / {activeSource.length} 条
              </span>
            </div>

            <div className="traffic-actions">
              <button
                type="button"
                className={paused ? "warn-btn" : ""}
                onClick={togglePause}
                title="暂停列表滚动，便于仔细排查某帧报文"
              >
                {paused ? `▶ 恢复${bufferedCount > 0 ? ` (+${bufferedCount})` : ""}` : "⏸ 暂停"}
              </button>
              <button type="button" onClick={onExportTraces} disabled={traces.length === 0}>
                导出
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={traces.length === 0}
                onClick={() => {
                  setSelectedTrace(null);
                  setFrozenSnapshot([]);
                  setPaused(false);
                  onClearTraces();
                }}
              >
                清空
              </button>
            </div>
          </div>

          <div className="traffic-filter-row">
            <div className="segmented-control mini" aria-label="角色筛选">
              <button
                type="button"
                className={roleFilter === "all" ? "active" : ""}
                onClick={() => setRoleFilter("all")}
              >
                全部
              </button>
              <button
                type="button"
                className={roleFilter === "master" ? "active" : ""}
                onClick={() => setRoleFilter("master")}
              >
                请求端
              </button>
              <button
                type="button"
                className={roleFilter === "slave" ? "active" : ""}
                onClick={() => setRoleFilter("slave")}
              >
                监听端
              </button>
            </div>

            <select
              className="toolbar-select"
              aria-label="状态筛选"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            >
              <option value="all">全部结果</option>
              <option value="success">仅成功</option>
              <option value="error">仅异常</option>
            </select>

            <input
              type="search"
              className="toolbar-search"
              placeholder="筛选 FC / 站号 / @地址 / 错误码 / HEX…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </header>

        <section className="server-timing-summary" aria-label="TCP 服务器写请求处理耗时">
          <div className="server-timing-values">
            <strong>TCP 服务器写请求 · 处理耗时</strong>
            <span className="mono">最近 {serverWrites.latestMs?.toFixed(3) ?? "—"} ms</span>
            <span className="mono">平均 {serverWrites.averageMs?.toFixed(3) ?? "—"} ms</span>
            <span className="mono">峰值 {serverWrites.maxMs?.toFixed(3) ?? "—"} ms</span>
          </div>
          <span>当前筛选 {serverWrites.samples} 条计时样本 · 成功 {serverWrites.samples - serverWrites.errors} / 异常 {serverWrites.errors} · 均含入统计</span>
          <span>完整请求开始处理 → 本机响应发送回调；不含 PLC 轮询等待与完整网络往返。暂停、清空随报文列表生效，最多 1000 条。</span>
        </section>

        <div className="traffic-stream">
          {visibleTraces.length === 0 ? (
            <div className="empty-placeholder">
              <strong>{traces.length === 0 ? "等待 Modbus 收发报文" : "没有匹配当前筛选条件的报文"}</strong>
              <span>
                {traces.length === 0
                  ? "连接请求端发起读写，或启动监听端接收外部主站请求，原始十六进制帧将实时显示在此。"
                  : "可尝试切换“全部”角色或清空搜索关键词。"}
              </span>
            </div>
          ) : (
            visibleTraces.map((trace, index) => {
              const role = roleLabel(trace.transport, trace.role);
              const inLabel = trace.role === "slave" ? "RX" : "TX";
              const outLabel = trace.role === "slave" ? "TX" : "RX";
              const isSelected = selectedTrace === trace;
              const rowId = `${trace.timestamp}-${index}`;
              return (
                <article
                  key={rowId}
                  className={`trace-item ${trace.error ? "is-error" : ""} ${isSelected ? "is-selected" : ""}`}
                  onClick={() => {
                    setSelectedTrace((curr) => (curr === trace ? null : trace));
                    if (decoderCollapsed) setDecoderCollapsed(false);
                  }}
                  title="点击锁定该条报文并在下方解码查看"
                >
                  <header className="trace-head">
                    <div className="trace-head-left">
                      <span className={`role-tag role-${trace.role}`}>{role}</span>
                      <strong className="trace-summary">{summarizeTrace(trace)}</strong>
                      {trace.peer && <span className="peer-tag mono">{trace.peer}</span>}
                    </div>
                    <div className="trace-head-right mono">
                      {trace.elapsedMs !== undefined && (
                        <span className="rtt-pill" title="客户端请求到响应或错误返回的耗时">请求 {trace.elapsedMs} ms</span>
                      )}
                      {trace.serverProcessingMs !== undefined && (
                        <span className="rtt-pill server-timing-pill" title="完整请求开始处理到本机响应发送回调；不代表 PLC 已收到响应。异常项计时到处理或发送失败。">
                          服务器处理 {trace.serverProcessingMs.toFixed(3)} ms
                        </span>
                      )}
                      <time>{formatTimestampMs(trace.timestamp)}</time>
                    </div>
                  </header>

                  <div className="hex-row">
                    <span className={`dir-badge dir-${inLabel.toLowerCase()}`}>{inLabel}</span>
                    <code className="hex-code">{trace.rawRequest}</code>
                    <button
                      type="button"
                      className="copy-mini-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyHex(`${rowId}-req`, trace.rawRequest);
                      }}
                    >
                      {copiedId === `${rowId}-req` ? "已复制" : "复制"}
                    </button>
                  </div>

                  {trace.rawResponse && (
                    <div className="hex-row">
                      <span className={`dir-badge dir-${outLabel.toLowerCase()}`}>{outLabel}</span>
                      <code className="hex-code is-response">{trace.rawResponse}</code>
                      <button
                        type="button"
                        className="copy-mini-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyHex(`${rowId}-res`, trace.rawResponse!);
                        }}
                      >
                        {copiedId === `${rowId}-res` ? "已复制" : "复制"}
                      </button>
                    </div>
                  )}

                  {trace.error && <p className="trace-error-msg">{trace.error.message}</p>}
                </article>
              );
            })
          )}
        </div>

        <footer className="traffic-footer">
          <span>缓冲区上限 1000 条 · 点击任意帧可在下方锁定解码</span>
          <span className="mono">客户端/主站: TX→RX · 服务器/从站: RX→TX</span>
        </footer>
      </section>

      <section className={`card decoder-card ${decoderCollapsed ? "is-collapsed" : ""}`}>
        <header className="decoder-header">
          <div className="decoder-title-group">
            <h2>响应解码与帧检查器</h2>
            {selectedTrace ? (
              <span className="badge badge-warn">
                已锁定 {formatTimestampMs(selectedTrace.timestamp)}
              </span>
            ) : (
              <span className="badge badge-neutral">自动跟随最新</span>
            )}
            {selectedTrace && (
              <button type="button" className="chip-btn" onClick={() => setSelectedTrace(null)}>
                恢复跟随
              </button>
            )}
          </div>

          <div className="decoder-controls">
            {!decoderCollapsed && (
              <select
                className="toolbar-select"
                aria-label="寄存器解释方式"
                value={decodeMode}
                onChange={(e) => onDecodeModeChange(e.target.value as DecodeMode)}
              >
                {DECODE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setDecoderCollapsed((c) => !c)}
            >
              {decoderCollapsed ? "展开解码 ▴" : "收起 ▾"}
            </button>
          </div>
        </header>

        {!decoderCollapsed && (
          <div className="decoder-body">
            {!inspectedTrace ? (
              <div className="empty-placeholder compact">
                <strong>等待可解析的响应数据</strong>
                <span>发送读取请求后，此处将按地址对照展示十进制、十六进制及多字节浮点/整型解码结果。</span>
              </div>
            ) : inspectedTrace.error ? (
              <div className="inspect-callout is-error">
                <strong>
                  异常帧 · {inspectedTrace.error.code}（{roleLabel(inspectedTrace.transport, inspectedTrace.role)}）
                </strong>
                <p>{inspectedTrace.error.message}</p>
                <code className="mono">原始帧: {inspectedTrace.rawResponse ?? inspectedTrace.rawRequest}</code>
              </div>
            ) : inspectedTrace.result?.kind === "write" ? (
              <div className="inspect-callout is-ok">
                <strong>写入确认成功（{summarizeTrace(inspectedTrace)}）</strong>
                <p>
                  设备已确认写入起始零基地址 <b>{inspectedTrace.result.address}</b>，共{" "}
                  <b>{inspectedTrace.result.quantity}</b> 项。
                </p>
                <div className="raw-pair mono">
                  <div>
                    <b>请求帧：</b>
                    <span>{inspectedTrace.rawRequest}</span>
                  </div>
                  {inspectedTrace.rawResponse && (
                    <div>
                      <b>响应帧：</b>
                      <span>{inspectedTrace.rawResponse}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : decodedRows.length > 0 ? (
              <div className="table-scroll">
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th>零基地址</th>
                      <th>HEX 地址</th>
                      <th>原始值 (DEC)</th>
                      <th>原始值 (HEX)</th>
                      <th>解码值 ({DECODE_OPTIONS.find((d) => d.value === decodeMode)?.label.split(" ")[0]})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {decodedRows.map((row) => (
                      <tr key={row.addressLabel}>
                        <td className="mono">{row.addressLabel}</td>
                        <td className="mono text-muted">{row.hexAddress}</td>
                        <td className="mono">{row.rawDec}</td>
                        <td className="mono text-accent">{row.rawHex}</td>
                        <td className="mono decoded-highlight">{row.decoded}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-placeholder compact">
                <strong>该帧不含寄存器/位读取载荷</strong>
              </div>
            )}
          </div>
        )}
      </section>
    </aside>
  );
}
