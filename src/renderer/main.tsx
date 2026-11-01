import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import type {
  ConnectionConfig,
  ConnectionStatus,
  RequestTrace,
  SerialPortInfo,
  SlaveDataArea,
  SlaveServerConfig,
  SlaveServerStatus,
  SlaveTransportKind,
  WatchItem,
  Workspace,
  WorkspaceSettings,
  WritePreparation
} from "../shared/api";
import type { ModbusRequest } from "../shared/protocol";
import { roleLabel } from "../shared/role-label";
import { DEFAULT_TEST_CONFIGS, type TestConfigs } from "../shared/test-session";
import { ChannelStrip } from "./channel-strip";
import { MasterPanel } from "./master-panel";
import { MonitorPane } from "./monitor-pane";
import { SlavePanel } from "./slave-panel";
import "./styles.css";
import { TestPanel } from "./test-panel";
import {
  type ChannelTab,
  type DecodeMode,
  DEFAULT_CONNECTION,
  DEFAULT_DRAFT,
  DEFAULT_SLAVE_SERVERS,
  type DraftRequest,
  errorMessage,
  formatTimestampMs,
  formatWatchResult,
  isBitArea,
  isWriteCode,
  type NoticeState,
  type NoticeTone,
  rangesOverlap,
  requestFromDraft,
  slaveStatusLabel,
  statusLabel,
  validSlavePage,
  type WatchRuntimeState,
  type WorkbenchTab
} from "./workbench-utils";

function App(): JSX.Element {
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("master");
  const [channelTab, setChannelTab] = useState<ChannelTab>("master");
  const [channelCollapsed, setChannelCollapsed] = useState(false);
  const [leftWidthPct, setLeftWidthPct] = useState(52);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const closeInFlight = useRef(false);
  const [importing, setImporting] = useState(false);
  const importInFlight = useRef(false);
  const [saveState, setSaveState] = useState("正在读取配置…");
  const [saveError, setSaveError] = useState("");

  const [connection, setConnection] = useState<ConnectionConfig>(DEFAULT_CONNECTION);
  const [draft, setDraft] = useState<DraftRequest>(DEFAULT_DRAFT);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([]);
  const [traces, setTraces] = useState<RequestTrace[]>([]);
  const [watches, setWatches] = useState<WatchItem[]>([]);
  const [watchRuntime, setWatchRuntime] = useState<Record<string, WatchRuntimeState>>({});
  const [testConfigs, setTestConfigs] = useState<TestConfigs>(structuredClone(DEFAULT_TEST_CONFIGS));
  const [runningTestCount, setRunningTestCount] = useState(0);

  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    request: ModbusRequest;
    preparation: WritePreparation;
  } | null>(null);
  const [confirmRemainingSec, setConfirmRemainingSec] = useState(60);
  const [decodeMode, setDecodeMode] = useState<DecodeMode>("u16");

  const [slaveServers, setSlaveServers] = useState<Workspace["slave"]["servers"]>(DEFAULT_SLAVE_SERVERS);
  const [slaveTransport, setSlaveTransport] = useState<SlaveTransportKind>("tcp");
  const [slaveStatuses, setSlaveStatuses] = useState<Record<SlaveTransportKind, SlaveServerStatus>>({
    tcp: "stopped",
    rtu: "stopped"
  });
  const [slaveUnitId, setSlaveUnitId] = useState(1);
  const [slaveArea, setSlaveArea] = useState<SlaveDataArea>("holdingRegisters");
  const [slaveAddress, setSlaveAddress] = useState(0);
  const [slaveQuantity, setSlaveQuantity] = useState(16);
  const [numberBase, setNumberBase] = useState<"dec" | "hex">("dec");
  const [slaveValues, setSlaveValues] = useState<Array<boolean | number>>([]);
  const [changedAddresses, setChangedAddresses] = useState<Set<number>>(new Set());

  const watchInFlight = useRef(new Set<string>());
  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  const notify = useCallback((text: string, tone: NoticeTone = "info"): void => {
    setNotice({ text: text.trim(), tone });
  }, []);

  useEffect(() => {
    if (!notice || notice.tone === "error" || notice.tone === "warning") return;
    const timer = window.setTimeout(() => {
      setNotice((curr) => (curr === notice ? null : curr));
    }, 4800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const requestRole = roleLabel(connection.kind, "master");
  const listenerRole = roleLabel(slaveTransport, "slave");
  const endpoint =
    connection.kind === "tcp"
      ? `${connection.host}:${connection.port}`
      : connection.path || "未选串口";
  const slaveConfig = slaveServers[slaveTransport];
  const slaveIsBitArea = isBitArea(slaveArea);

  const refreshPorts = useCallback(async (): Promise<void> => {
    try {
      const ports = await window.modbusForge.listSerialPorts();
      setSerialPorts(ports);
    } catch (error) {
      notify(`读取串口列表失败：${errorMessage(error)}`, "error");
    }
  }, [notify]);

  const refreshSlaveStatuses = useCallback(async (): Promise<void> => {
    setSlaveStatuses(await window.modbusForge.getSlaveStatuses());
  }, []);

  const refreshSlaveData = useCallback(async (): Promise<void> => {
    if (!validSlavePage(slaveUnitId, slaveAddress, slaveQuantity)) return;
    const entry = await window.modbusForge.readSlaveData({
      unitId: slaveUnitId,
      area: slaveArea,
      address: slaveAddress,
      quantity: slaveQuantity
    });
    setSlaveValues(entry.values);
  }, [slaveUnitId, slaveArea, slaveAddress, slaveQuantity]);

  const settings: WorkspaceSettings = {
    version: 2,
    connection,
    draftRequest: draft,
    watches: watches.map((watch) => ({ ...watch, enabled: false })),
    testConfigs,
    slave: { servers: slaveServers },
    view: {
      workbenchTab, channelTab, channelCollapsed, leftWidthPct, decodeMode, slaveTransport, numberBase,
      slavePage: { unitId: slaveUnitId, area: slaveArea, address: slaveAddress, quantity: slaveQuantity }
    }
  };
  const settingsKey = JSON.stringify(settings);
  const latestSettings = useRef<WorkspaceSettings | null>(null);
  useLayoutEffect(() => { latestSettings.current = workspaceReady ? settings : null; });

  const captureWorkspace = async (): Promise<Workspace> => {
    const data = await window.modbusForge.getSlaveDataset();
    const current = latestSettings.current ?? settings;
    return { ...current, slave: { servers: current.slave.servers, data } };
  };

  useEffect(() => {
    if (!workspaceReady || importing) return;
    let cancelled = false;
    setSaveState("正在记住配置…");
    const timer = window.setTimeout(() => {
      void window.modbusForge.rememberWorkspace(JSON.parse(settingsKey) as WorkspaceSettings)
        .then(() => { if (!cancelled) { setSaveState("配置已自动记住"); setSaveError(""); } })
        .catch((error: unknown) => { if (!cancelled) { setSaveState("配置未保存"); setSaveError(errorMessage(error)); } });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [workspaceReady, importing, settingsKey]);

  useEffect(() => window.modbusForge.onBeforeClose(() => {
    setClosing(true);
  }), []);

  useEffect(() => {
    if (!closing || importing) return;
    if (closeInFlight.current) return;
    closeInFlight.current = true;
    void window.modbusForge.closeWithWorkspace(latestSettings.current)
      .catch((error: unknown) => notify(`退出前保存失败：${errorMessage(error)}`, "error"))
      .finally(() => { closeInFlight.current = false; setClosing(false); });
  }, [closing, importing, notify]);

  const applyWorkspace = async (saved: Workspace): Promise<void> => {
    await window.modbusForge.loadSlaveDataset(saved.slave.data);
    setConnection(saved.connection);
    setDraft(saved.draftRequest);
    setWatches(saved.watches.map((watch) => ({ ...watch, enabled: false })));
    setWatchRuntime({});
    setSlaveServers(saved.slave.servers);
    setTestConfigs(saved.testConfigs ?? structuredClone(DEFAULT_TEST_CONFIGS));
    if (saved.view) {
      const view = saved.view;
      setWorkbenchTab(view.workbenchTab); setChannelTab(view.channelTab); setChannelCollapsed(view.channelCollapsed);
      setLeftWidthPct(view.leftWidthPct); setDecodeMode(view.decodeMode); setSlaveTransport(view.slaveTransport);
      setSlaveUnitId(view.slavePage.unitId); setSlaveArea(view.slavePage.area); setSlaveAddress(view.slavePage.address);
      setSlaveQuantity(view.slavePage.quantity); setNumberBase(view.numberBase);
    }
    setStatus(await window.modbusForge.getStatus());
    await refreshSlaveStatuses();
    if (saved.connection.kind === "rtu" || saved.slave.servers.rtu.path) {
      void refreshPorts();
    }
  };

  useEffect(() => {
    let disposed = false;
    void refreshPorts();
    void window.modbusForge
      .getStatus()
      .then((next) => !disposed && setStatus(next))
      .catch((error: unknown) => !disposed && notify(`读取请求端状态失败：${errorMessage(error)}`, "error"));
    void refreshSlaveStatuses().catch(
      (error: unknown) => !disposed && notify(`读取监听端状态失败：${errorMessage(error)}`, "error")
    );
    void window.modbusForge
      .loadWorkspace()
      .then(async (saved) => {
        if (disposed) return;
        if (saved) await applyWorkspace(saved);
        if (!disposed) {
          setWorkspaceReady(true);
          setInitialLoading(false);
          if (saved) notify("已恢复上次配置，连接、监听与轮询等待手动启动。", "info");
        }
      })
      .catch((error: unknown) => {
        if (!disposed) { setInitialLoading(false); setSaveState("配置读取失败"); setSaveError(errorMessage(error)); notify(`读取工作区失败：${errorMessage(error)}`, "error"); }
      });

    const unsubscribe = window.modbusForge.onTrace((trace) => {
      if (!disposed) setTraces((current) => [trace, ...current].slice(0, 1000));
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void refreshSlaveData().catch((error: unknown) =>
      notify(`读取本机数据区失败：${errorMessage(error)}`, "error")
    );
  }, [refreshSlaveData, notify]);

  useEffect(() => {
    return window.modbusForge.onSlaveDataChanged((entry) => {
      if (!entry) {
        void refreshSlaveData().catch((error: unknown) =>
          notify(`刷新数据区失败：${errorMessage(error)}`, "error")
        );
        return;
      }
      if (
        entry.unitId === slaveUnitId &&
        entry.area === slaveArea &&
        rangesOverlap(entry.address, entry.values.length, slaveAddress, slaveQuantity)
      ) {
        const touched: number[] = [];
        for (let i = 0; i < entry.values.length; i += 1) {
          const addr = entry.address + i;
          if (addr >= slaveAddress && addr < slaveAddress + slaveQuantity) touched.push(addr);
        }
        if (touched.length > 0) {
          setChangedAddresses((prev) => {
            const next = new Set(prev);
            touched.forEach((a) => next.add(a));
            return next;
          });
          window.setTimeout(() => {
            setChangedAddresses((prev) => {
              const next = new Set(prev);
              touched.forEach((a) => next.delete(a));
              return next;
            });
          }, 1100);
        }
        void refreshSlaveData().catch((error: unknown) =>
          notify(`刷新数据区失败：${errorMessage(error)}`, "error")
        );
      }
    });
  }, [slaveUnitId, slaveArea, slaveAddress, slaveQuantity, refreshSlaveData, notify]);

  useEffect(() => {
    if (status !== "connected") return;
    const timers = watches
      .filter((watch) => watch.enabled)
      .map((watch) =>
        window.setInterval(() => {
          if (watchInFlight.current.has(watch.id)) return;
          watchInFlight.current.add(watch.id);
          void window.modbusForge
            .request(watch.request)
            .then((trace) =>
              setWatchRuntime((current) => ({
                ...current,
                [watch.id]: {
                  text: formatWatchResult(trace.result),
                  updatedAt: formatTimestampMs(trace.timestamp),
                  isError: false
                }
              }))
            )
            .catch((error: unknown) =>
              setWatchRuntime((current) => ({
                ...current,
                [watch.id]: {
                  text: errorMessage(error),
                  updatedAt: formatTimestampMs(new Date().toISOString()),
                  isError: true
                }
              }))
            )
            .finally(() => watchInFlight.current.delete(watch.id));
        }, watch.intervalMs)
      );
    return () => timers.forEach((timer) => window.clearInterval(timer));
  }, [status, watches]);

  useEffect(() => {
    if (!confirmation) return;
    const updateCountdown = (): void => {
      const rem = Math.max(0, Math.ceil((Date.parse(confirmation.preparation.expiresAt) - Date.now()) / 1000));
      setConfirmRemainingSec(rem);
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 500);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") void cancelWrite();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [confirmation]);

  const connectMaster = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await window.modbusForge.connect(connection));
      notify(`${requestRole}已连接 ${endpoint}。`, "success");
    } catch (error) {
      setStatus("faulted");
      notify(`${requestRole}连接失败：${errorMessage(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const disconnectMaster = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await window.modbusForge.disconnect());
      notify(`${requestRole}连接已断开。`, "info");
    } catch (error) {
      notify(`关闭${requestRole}失败：${errorMessage(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const sendRequest = async (): Promise<void> => {
    let request: ModbusRequest;
    try {
      request = requestFromDraft(draft);
    } catch (error) {
      notify(errorMessage(error), "error");
      return;
    }
    setBusy(true);
    try {
      if (isWriteCode(request.functionCode)) {
        const preparation = await window.modbusForge.prepareWrite(request);
        setConfirmation({ request, preparation });
      } else {
        await window.modbusForge.request(request);
      }
    } catch (error) {
      notify(`请求失败：${errorMessage(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const confirmWrite = async (): Promise<void> => {
    if (!confirmation) return;
    setBusy(true);
    try {
      await window.modbusForge.executeWrite(confirmation.preparation.token, confirmation.request);
      notify("写入报文已发送并收到从站确认。", "success");
    } catch (error) {
      notify(`写入失败：${errorMessage(error)}`, "error");
    } finally {
      setConfirmation(null);
      setBusy(false);
    }
  };

  const cancelWrite = async (): Promise<void> => {
    if (!confirmation) return;
    try {
      await window.modbusForge.cancelWrite(confirmation.preparation.token, confirmation.request);
      notify("已取消写入确认；未发送任何写入报文。", "info");
    } catch (error) {
      notify(`取消确认失败：${errorMessage(error)}`, "error");
    } finally {
      setConfirmation(null);
    }
  };

  const cancelActiveRequest = async (): Promise<void> => {
    try {
      setStatus(await window.modbusForge.cancelActiveRequest());
      notify("已取消在途请求并关闭连接。", "warning");
    } catch (error) {
      notify(`取消请求失败：${errorMessage(error)}`, "error");
    }
  };

  const importWorkspace = async (): Promise<void> => {
    if (importInFlight.current) return;
    importInFlight.current = true;
    const wasReady = workspaceReady;
    let applied = false;
    setImporting(true);
    try {
      const imported = await window.modbusForge.importWorkspace();
      if (!imported) return;
      await applyWorkspace(imported);
      applied = true;
      notify("已导入工作区配置（连接与监听保持未启动安全状态）。", "success");
    } catch (error) {
      notify(`导入失败：${errorMessage(error)}`, "error");
    } finally {
      setWorkspaceReady(applied || wasReady);
      importInFlight.current = false;
      setImporting(false);
    }
  };

  const saveWorkspace = async (exportFile: boolean): Promise<void> => {
    try {
      const captured = await captureWorkspace();
      const saved = exportFile
        ? await window.modbusForge.exportWorkspace(captured)
        : (await window.modbusForge.saveWorkspace(captured), true);
      if (saved) {
        notify(exportFile ? "工作区已导出为 JSON 文件。" : "工作区已保存到本机。", "success");
      }
    } catch (error) {
      notify(`保存工作区失败：${errorMessage(error)}`, "error");
    }
  };

  const updateSlaveConfig = (config: SlaveServerConfig): void => {
    setSlaveServers((current) => ({ ...current, [config.kind]: config }));
  };

  const startSlave = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.modbusForge.startSlave(slaveConfig);
      await refreshSlaveStatuses();
      notify(`${listenerRole}已开始监听。`, "success");
    } catch (error) {
      await refreshSlaveStatuses().catch(() => undefined);
      notify(`启动监听失败：${errorMessage(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const stopSlave = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.modbusForge.stopSlave(slaveTransport);
      await refreshSlaveStatuses();
      notify(`${listenerRole}已停止监听。`, "info");
    } catch (error) {
      notify(`停止监听失败：${errorMessage(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const updateSlaveValue = async (index: number, value: boolean | number): Promise<void> => {
    if (
      slaveIsBitArea
        ? typeof value !== "boolean"
        : typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535
    ) {
      notify("数据值无效。", "error");
      return;
    }
    const previous = slaveValues;
    setSlaveValues((current) => current.map((item, idx) => (idx === index ? value : item)));
    try {
      await window.modbusForge.writeSlaveData({
        unitId: slaveUnitId,
        area: slaveArea,
        address: slaveAddress + index,
        values: [value] as boolean[] | number[]
      });
    } catch (error) {
      setSlaveValues(previous);
      notify(`写入本机数据区失败：${errorMessage(error)}`, "error");
    }
  };

  const clearSlavePage = async (): Promise<void> => {
    const values = Array.from({ length: slaveQuantity }, () =>
      slaveIsBitArea ? false : 0
    ) as boolean[] | number[];
    try {
      await window.modbusForge.writeSlaveData({
        unitId: slaveUnitId,
        area: slaveArea,
        address: slaveAddress,
        values
      });
      notify(`已将地址 ${slaveAddress}–${slaveAddress + slaveQuantity - 1} 清零。`, "info");
    } catch (error) {
      notify(`清零失败：${errorMessage(error)}`, "error");
    }
  };

  const exportTraces = (): void => {
    void window.modbusForge
      .exportTraces(traces)
      .then((saved) => saved && notify("会话收发报文日志已导出。", "success"))
      .catch((error: unknown) => notify(`导出日志失败：${errorMessage(error)}`, "error"));
  };

  const startSplitDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    const onMove = (moveEvent: PointerEvent): void => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setLeftWidthPct(Math.max(38, Math.min(66, Number(pct.toFixed(1)))));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing");
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const activeWatchCount = watches.filter((w) => w.enabled).length;
  const anySlaveListening = slaveStatuses.tcp === "listening" || slaveStatuses.rtu === "listening";

  return (
    <>
    <div className="window-titlebar"><span className="window-title">Modbus Forge</span></div>
    <main className="app-shell" inert={closing || importing}>
      <header className="top-bar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            MF
          </div>
          <div>
            <div className="brand-title-row">
              <h1>Modbus Forge</h1>
              <span className="version-tag">v0.2.3</span>
            </div>
            <p className="brand-eyebrow">TCP / RTU INDUSTRIAL WORKBENCH</p>
          </div>
        </div>

        <div className="runtime-Cluster" aria-label="实时运行状态">
          <button
            type="button"
            className="status-pill"
            onClick={() => {
              setChannelTab("master");
              setChannelCollapsed(false);
            }}
            title="点击展开请求端通道配置"
          >
            <i className={`status-dot ${status}`} />
            <b>{requestRole}</b>
            <em className="mono">{status === "connected" ? endpoint : statusLabel(status)}</em>
          </button>

          <button
            type="button"
            className="status-pill"
            onClick={() => {
              setChannelTab("slave");
              setSlaveTransport("tcp");
              setChannelCollapsed(false);
            }}
            title="点击展开 TCP 服务器监听配置"
          >
            <i className={`status-dot ${slaveStatuses.tcp}`} />
            <b>TCP 服务器</b>
            <em className="mono">
              {slaveStatuses.tcp === "listening"
                ? `${slaveServers.tcp.host}:${slaveServers.tcp.port}`
                : slaveStatusLabel(slaveStatuses.tcp)}
            </em>
          </button>

          <button
            type="button"
            className="status-pill"
            onClick={() => {
              setChannelTab("slave");
              setSlaveTransport("rtu");
              setChannelCollapsed(false);
            }}
            title="点击展开 RTU 从站监听配置"
          >
            <i className={`status-dot ${slaveStatuses.rtu}`} />
            <b>RTU 从站</b>
            <em className="mono">
              {slaveStatuses.rtu === "listening"
                ? slaveServers.rtu.path
                : slaveStatusLabel(slaveStatuses.rtu)}
            </em>
          </button>
        </div>

        <div className="workspace-toolbar" aria-label="工作区管理">
          <span className={`autosave-status ${saveError ? "has-error" : ""}`} role="status" title={saveError || "参数变更后自动保存；关闭窗口前再次保存最后的配置。"}>{saveState}</span>
          <button type="button" disabled={!workspaceReady} onClick={() => void saveWorkspace(false)} title="保存配置与本机数据到默认工作区">
            保存工作区
          </button>
          <button type="button" disabled={initialLoading} className="ghost-btn" onClick={() => void importWorkspace()}>
            导入
          </button>
          <button type="button" disabled={!workspaceReady} className="ghost-btn" onClick={() => void saveWorkspace(true)}>
            导出
          </button>
        </div>
      </header>

      {notice && (
        <div className={`notice-banner tone-${notice.tone}`} role="status">
          <span className="notice-text">{notice.text}</span>
          <button type="button" className="notice-close" onClick={() => setNotice(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="channel-config-container" inert={!workspaceReady}>
      <ChannelStrip
        activeTab={channelTab}
        onTabChange={setChannelTab}
        collapsed={channelCollapsed}
        onToggleCollapsed={() => setChannelCollapsed((c) => !c)}
        connection={connection}
        onConnectionChange={setConnection}
        status={status}
        busy={busy}
        onConnect={() => void connectMaster()}
        onDisconnect={() => void disconnectMaster()}
        slaveTransport={slaveTransport}
        onSlaveTransportChange={setSlaveTransport}
        slaveServers={slaveServers}
        onSlaveConfigChange={updateSlaveConfig}
        slaveStatuses={slaveStatuses}
        onStartSlave={() => void startSlave()}
        onStopSlave={() => void stopSlave()}
        serialPorts={serialPorts}
        onRefreshPorts={() => void refreshPorts()}
      />
      </div>

      <div className="workbench-split" ref={splitContainerRef} inert={!workspaceReady}>
        <section
          className="left-workbench"
          style={{ "--left-pane-width": `${leftWidthPct}%` } as React.CSSProperties}
        >
          <nav className="workbench-tabs" role="tablist" aria-label="调试功能模块">
            <button
              type="button"
              role="tab"
              aria-selected={workbenchTab === "master"}
              className={`wb-tab ${workbenchTab === "master" ? "active" : ""}`}
              onClick={() => {
                setWorkbenchTab("master");
                setChannelTab("master");
              }}
            >
              <span>单次读写 & 轮询</span>
              {activeWatchCount > 0 && status === "connected" && (
                <em className="tab-counter ok">{activeWatchCount}</em>
              )}
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={workbenchTab === "slave"}
              className={`wb-tab ${workbenchTab === "slave" ? "active" : ""}`}
              onClick={() => {
                setWorkbenchTab("slave");
                setChannelTab("slave");
              }}
            >
              <span>从站本机数据区</span>
              {anySlaveListening && <em className="tab-counter ok">监听中</em>}
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={workbenchTab === "verify"}
              className={`wb-tab ${workbenchTab === "verify" ? "active" : ""}`}
              onClick={() => setWorkbenchTab("verify")}
            >
              <span>双角色连续验证</span>
              {runningTestCount > 0 && (
                <em className="tab-counter pulse">{runningTestCount} 运行中</em>
              )}
            </button>
          </nav>

          <div className="workbench-pane-body">
            <div className={workbenchTab === "master" ? "tab-pane" : "tab-pane is-hidden"}>
              <MasterPanel
                requestRole={requestRole}
                connected={status === "connected"}
                busy={busy}
                draft={draft}
                onDraftChange={setDraft}
                onSendRequest={() => void sendRequest()}
                onCancelActiveRequest={() => void cancelActiveRequest()}
                onFocusConnect={() => {
                  setChannelTab("master");
                  setChannelCollapsed(false);
                }}
                watches={watches}
                onWatchesChange={(updater) => setWatches(updater)}
                watchRuntime={watchRuntime}
                onNotify={notify}
              />
            </div>

            <div className={workbenchTab === "slave" ? "tab-pane" : "tab-pane is-hidden"}>
              <SlavePanel
                listenerRole={listenerRole}
                slaveStatuses={slaveStatuses}
                slaveServers={slaveServers}
                onFocusListenerConfig={(kind) => {
                  setChannelTab("slave");
                  setSlaveTransport(kind);
                  setChannelCollapsed(false);
                  if (kind === "rtu") void refreshPorts();
                }}
                unitId={slaveUnitId}
                onUnitIdChange={setSlaveUnitId}
                area={slaveArea}
                onAreaChange={setSlaveArea}
                address={slaveAddress}
                onAddressChange={setSlaveAddress}
                quantity={slaveQuantity}
                onQuantityChange={setSlaveQuantity}
                values={slaveValues}
                changedAddresses={changedAddresses}
                numberBase={numberBase}
                onNumberBaseChange={setNumberBase}
                onRefresh={() =>
                  void refreshSlaveData().catch((error: unknown) =>
                    notify(errorMessage(error), "error")
                  )
                }
                onUpdateValue={updateSlaveValue}
                onClearPage={clearSlavePage}
                onNotify={notify}
              />
            </div>

            <div className={workbenchTab === "verify" ? "tab-pane" : "tab-pane is-hidden"}>
              <TestPanel
                transport={connection.kind}
                configs={testConfigs}
                onChange={setTestConfigs}
                connected={status === "connected"}
                onNotice={notify}
                onActiveStateChange={setRunningTestCount}
              />
            </div>
          </div>
        </section>

        <div
          className="split-handle"
          role="separator"
          aria-orientation="vertical"
          title="拖动调整左右工作区宽度（双击复位）"
          onPointerDown={startSplitDrag}
          onDoubleClick={() => setLeftWidthPct(52)}
        />

        <MonitorPane
          traces={traces}
          onExportTraces={exportTraces}
          onClearTraces={() => setTraces([])}
          decodeMode={decodeMode}
          onDecodeModeChange={setDecodeMode}
        />
      </div>

      {confirmation && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) void cancelWrite();
          }}
        >
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <div className="confirm-header">
              <span className="badge badge-danger">受控写入二次确认</span>
              <span className="mono text-muted">
                {confirmRemainingSec > 0 ? `令牌有效剩余 ${confirmRemainingSec}s` : "令牌已过期"}
              </span>
            </div>
            <h2 id="confirm-title">确认向目标设备发送写入报文？</h2>
            <p className="confirm-summary">{confirmation.preparation.summary}</p>
            <p className="confirm-hint">
              点击“取消”或按 Esc 不会发出任何报文，仅在会话日志记入一条已取消记录。
            </p>
            <div className="modal-actions">
              <button type="button" disabled={busy} onClick={() => void cancelWrite()}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy || confirmRemainingSec <= 0}
                onClick={() => void confirmWrite()}
              >
                {busy ? "正在发送…" : "确认并发送写入"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
