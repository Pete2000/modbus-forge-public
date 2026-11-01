import { useEffect, useState, type JSX } from "react";
import { roleLabel } from "../shared/role-label";
import type {
  SignalConfig,
  TestConfigs,
  TestKind,
  TestRun,
  TestSessions
} from "../shared/test-session";
import { errorMessage, formatTimestampMs, type NoticeTone } from "./workbench-utils";

interface TestPanelProps {
  transport: "tcp" | "rtu";
  configs: TestConfigs;
  onChange: (configs: TestConfigs) => void;
  connected: boolean;
  onNotice: (message: string, tone?: NoticeTone) => void;
  onActiveStateChange?: (runningCount: number) => void;
}

export function TestPanel(props: TestPanelProps): JSX.Element {
  const { transport, configs, onChange, connected, onNotice, onActiveStateChange } = props;
  const requestRole = roleLabel(transport, "master");
  const [sessions, setSessions] = useState<TestSessions>({ client: null, generator: null });
  const [busy, setBusy] = useState<TestKind | "export" | null>(null);
  const [now, setNow] = useState(Date.now());

  const updateSessions = (next: TestSessions): void => {
    setSessions(next);
    const count = (isActiveRun(next.client) ? 1 : 0) + (isActiveRun(next.generator) ? 1 : 0);
    onActiveStateChange?.(count);
  };

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.modbusForge.onTestSessions((next) => {
      if (!disposed) updateSessions(next);
    });
    void window.modbusForge
      .getTestSessions()
      .then((next) => {
        if (!disposed) updateSessions(next);
      })
      .catch((error: unknown) => onNotice(errorMessage(error), "error"));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isActiveRun(sessions.client) && !isActiveRun(sessions.generator)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sessions.client?.status, sessions.generator?.status]);

  const start = async (kind: TestKind): Promise<void> => {
    setBusy(kind);
    try {
      const run =
        kind === "client"
          ? await window.modbusForge.startClientTest(configs.client)
          : await window.modbusForge.startSignalGenerator(configs.generator);
      if (run) {
        updateSessions(await window.modbusForge.getTestSessions());
        onNotice(
          kind === "client"
            ? "持续读写验证已启动；右侧可同步观测实时收发帧。"
            : "本机数据自动变值已启动；外部 PLC 可读取该连续双寄存器。",
          "success"
        );
      }
    } catch (error) {
      onNotice(`启动失败：${errorMessage(error)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const stop = async (kind: TestKind): Promise<void> => {
    try {
      await window.modbusForge.stopTest(kind);
      updateSessions(await window.modbusForge.getTestSessions());
      onNotice(kind === "client" ? "已停止请求端读写测试。" : "已停止本机自动变值。", "info");
    } catch (error) {
      onNotice(`停止失败：${errorMessage(error)}`, "error");
    }
  };

  const exportReport = async (): Promise<void> => {
    setBusy("export");
    try {
      if (await window.modbusForge.exportTestSessions()) {
        onNotice("双角色验证统计报告已导出为 JSON。", "success");
      }
    } catch (error) {
      onNotice(`导出失败：${errorMessage(error)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="workbench-stack test-workbench">
      <section className="card test-header-card">
        <div className="card-header no-margin">
          <div>
            <div className="card-title-row">
              <h2>双角色连续读写压力验证</h2>
              <span className="badge badge-info">独立后台调度</span>
            </div>
            <p className="card-subtitle">
              请求端闭环读写与本机数据自动变值可同时运行；切换左侧标签页不会中断测试，每类保留最近一次统计（明细最多 1000 轮）。
            </p>
          </div>
          <button type="button" disabled={busy !== null} onClick={() => void exportReport()}>
            导出验证报告
          </button>
        </div>
      </section>

      <div className="test-cards-stack">
        <section className="card test-card">
          <header className="card-header">
            <div>
              <div className="card-title-row">
                <h3>{requestRole} · 定时写入与读回比对</h3>
                <RunStateBadge run={sessions.client} />
              </div>
              <p className="card-subtitle">
                FC 10 周期写入 [序号, 随机数]，等待设定延时后以 FC 03 读回比对，并独立按读取间隔轮询同一地址。
              </p>
            </div>
          </header>

          <fieldset disabled={isActiveRun(sessions.client) || busy !== null} className="clean-fieldset">
            <SignalFields
              config={configs.client}
              onChange={(client) => onChange({ ...configs, client: { ...configs.client, ...client } })}
              intervalLabel="写入间隔 (ms)"
            />
            <div className="test-fields-grid three-col">
              <NumberField
                label="轮询间隔 (ms)"
                value={configs.client.pollIntervalMs}
                min={250}
                max={60000}
                onChange={(pollIntervalMs) =>
                  onChange({ ...configs, client: { ...configs.client, pollIntervalMs } })
                }
              />
              <NumberField
                label="写后等待 (ms)"
                value={configs.client.readbackDelayMs}
                min={0}
                max={5000}
                onChange={(readbackDelayMs) =>
                  onChange({ ...configs, client: { ...configs.client, readbackDelayMs } })
                }
              />
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={configs.client.stopOnError}
                  onChange={(e) =>
                    onChange({
                      ...configs,
                      client: { ...configs.client, stopOnError: e.target.checked }
                    })
                  }
                />
                <span>遇数据差异或异常立即停止</span>
              </label>
            </div>
          </fieldset>

          <div className="inline-callout neutral">
            <span>
              目标远端保持寄存器：<b>{configs.client.address}</b>（循环序号 1–65535）、
              <b>{configs.client.address + 1}</b>（随机数），十进制零基地址。
            </span>
          </div>

          <div className="action-group">
            <button
              type="button"
              className="danger"
              disabled={!connected || isActiveRun(sessions.client) || busy !== null}
              onClick={() => void start("client")}
            >
              {connected ? "确认并启动持续写入" : "请先连接请求端通道"}
            </button>
            <button
              type="button"
              disabled={!isActiveRun(sessions.client)}
              onClick={() => void stop("client")}
            >
              停止读写测试
            </button>
          </div>

          <RunReport run={sessions.client} now={now} />
        </section>

        <section className="card test-card">
          <header className="card-header">
            <div>
              <div className="card-title-row">
                <h3>本机数据区 · 自动信号发生器</h3>
                <RunStateBadge run={sessions.generator} />
              </div>
              <p className="card-subtitle">
                自动刷新本机保持寄存器 [序号, 随机数]，供外部 PLC / 主站读取验证（请勿与外部写入地址重叠）。
              </p>
            </div>
          </header>

          <fieldset disabled={isActiveRun(sessions.generator) || busy !== null} className="clean-fieldset">
            <SignalFields
              config={configs.generator}
              onChange={(generator) => onChange({ ...configs, generator })}
              intervalLabel="变值间隔 (ms)"
            />
          </fieldset>

          <div className="inline-callout neutral">
            <span>
              本机保持寄存器：<b>{configs.generator.address}</b>（循环序号）、
              <b>{configs.generator.address + 1}</b>（随机数）。外部读取需先启动 TCP 服务器或 RTU 从站监听。
            </span>
          </div>

          <div className="action-group">
            <button
              type="button"
              className="primary"
              disabled={isActiveRun(sessions.generator) || busy !== null}
              onClick={() => void start("generator")}
            >
              启动本机自动变值
            </button>
            <button
              type="button"
              disabled={!isActiveRun(sessions.generator)}
              onClick={() => void stop("generator")}
            >
              停止自动变值
            </button>
          </div>

          <RunReport run={sessions.generator} now={now} />
        </section>
      </div>
    </div>
  );
}

function RunStateBadge({ run }: { run: TestRun | null }): JSX.Element {
  if (!run) return <span className="badge badge-neutral">未运行</span>;
  const label = {
    idle: "未运行",
    running: "运行中",
    stopping: "停止中",
    stopped: "已停止",
    completed: "已完成",
    faulted: "异常停止"
  }[run.status];
  const cls =
    run.status === "running"
      ? "badge-ok"
      : run.status === "faulted"
        ? "badge-danger"
        : run.status === "stopping"
          ? "badge-warn"
          : "badge-neutral";
  return <span className={`badge ${cls}`}>{label}</span>;
}

function SignalFields({
  config,
  onChange,
  intervalLabel
}: {
  config: SignalConfig;
  onChange: (config: SignalConfig) => void;
  intervalLabel: string;
}): JSX.Element {
  const change = (key: keyof SignalConfig, value: number): void => onChange({ ...config, [key]: value });
  return (
    <div className="test-fields-grid three-col">
      <NumberField label="Unit ID" value={config.unitId} min={1} max={247} onChange={(v) => change("unitId", v)} />
      <NumberField
        label="起始零基地址"
        value={config.address}
        min={0}
        max={65534}
        onChange={(v) => change("address", v)}
      />
      <NumberField
        label={intervalLabel}
        value={config.intervalMs}
        min={250}
        max={60000}
        onChange={(v) => change("intervalMs", v)}
      />
      <NumberField
        label="随机最小值"
        value={config.randomMin}
        min={0}
        max={65535}
        onChange={(v) => change("randomMin", v)}
      />
      <NumberField
        label="随机最大值"
        value={config.randomMax}
        min={0}
        max={65535}
        onChange={(v) => change("randomMax", v)}
      />
      <NumberField
        label="持续时长 (秒)"
        value={config.durationSeconds}
        min={1}
        max={86400}
        onChange={(v) => change("durationSeconds", v)}
      />
    </div>
  );
}

function RunReport({ run, now }: { run: TestRun | null; now: number }): JSX.Element {
  if (!run) {
    return <p className="test-idle-note">尚未运行。启动时将弹窗确认实际连接目标与测试寄存器范围。</p>;
  }
  const stats = run.stats;
  const elapsed = Math.max(
    0,
    Math.round(
      ((run.endedAt ? Date.parse(run.endedAt) : Math.max(now, Date.parse(run.startedAt))) -
        Date.parse(run.startedAt)) /
        1000
    )
  );
  const progressPct = Math.min(100, Math.round((elapsed / Math.max(1, run.config.durationSeconds)) * 100));
  const latest = run.records.at(-1);

  return (
    <div className="test-report-box">
      <div className="test-progress-header">
        <span className="mono">
          目标 <b>{run.target}</b> · ID {run.config.unitId} · @{run.config.address}–{run.config.address + 1}
        </span>
        <span className="mono">
          已运行 <b>{elapsed}s</b> / {run.config.durationSeconds}s ({progressPct}%)
        </span>
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill ${run.status === "faulted" ? "is-error" : ""}`}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <dl className="kpi-grid">
        {run.kind === "client" ? (
          <>
            <Stat label="写入确认 / 尝试" value={`${stats.writesAcknowledged} / ${stats.writeAttempts}`} />
            <Stat label="成功读取" value={stats.reads} />
            <Stat
              label="比对一致 / 差异"
              value={`${stats.matches} / ${stats.mismatches}`}
              highlight={stats.mismatches > 0 ? "error" : "ok"}
            />
            <Stat
              label="异常 / 其中超时"
              value={`${stats.errors} / ${stats.timeouts}`}
              highlight={stats.errors > 0 ? "error" : undefined}
            />
            <Stat label="取消轮次" value={stats.cancelled} />
          </>
        ) : (
          <>
            <Stat label="本机变值次数" value={stats.generated} highlight="ok" />
            <Stat label="该站号外部读取" value={stats.peerReads} />
            <Stat label="该站号外部写入" value={stats.peerWrites} />
            <Stat
              label="外部请求异常"
              value={stats.peerErrors}
              highlight={stats.peerErrors > 0 ? "error" : undefined}
            />
          </>
        )}
        <Stat
          label="耗时 均值 / 峰值"
          value={`${stats.cycles ? (stats.totalElapsedMs / stats.cycles).toFixed(1) : "0"} / ${stats.maxElapsedMs.toFixed(0)} ms`}
        />
      </dl>

      {latest && (
        <div className="latest-compare mono">
          <span>最近期望：[{latest.expected?.join(", ") ?? "—"}]</span>
          <span>最近实际：[{latest.actual?.join(", ") ?? "—"}]</span>
        </div>
      )}
      {run.stopReason && <p className="test-stop-reason">{run.stopReason}</p>}

      {run.records.length > 0 && (
        <div className="table-scroll compact-scroll">
          <table className="data-table compact">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>序号</th>
                <th>结果</th>
                <th className="align-right">耗时</th>
              </tr>
            </thead>
            <tbody>
              {run.records
                .slice(-12)
                .reverse()
                .map((record, index) => (
                  <tr key={`${record.timestamp}-${index}`}>
                    <td className="mono">{formatTimestampMs(record.timestamp)}</td>
                    <td>
                      {record.operation === "poll"
                        ? "轮询读"
                        : record.operation === "generate"
                          ? "本机变值"
                          : "写后读回"}
                    </td>
                    <td className="mono">{record.sequence ?? "—"}</td>
                    <td
                      className={
                        record.outcome === "error" || record.outcome === "mismatch"
                          ? "text-error"
                          : record.outcome === "match" || record.outcome === "generated"
                            ? "text-ok"
                            : "text-muted"
                      }
                      title={record.error?.message}
                    >
                      {{
                        match: "一致",
                        mismatch: "差异",
                        generated: "已更新",
                        error: "错误",
                        cancelled: "已取消"
                      }[record.outcome]}
                      {record.error && ` (${record.error.code})`}
                    </td>
                    <td className="mono align-right">{record.elapsedMs} ms</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight
}: {
  label: string;
  value: string | number;
  highlight?: "ok" | "error";
}): JSX.Element {
  return (
    <div className={`kpi-cell ${highlight ? `kpi-${highlight}` : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function isActiveRun(run: TestRun | null): boolean {
  return run !== null && (run.status === "running" || run.status === "stopping");
}
