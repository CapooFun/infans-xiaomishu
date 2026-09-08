import { Activity, Cpu, HardDrive, MemoryStick, RefreshCw, Server, ShieldCheck, Sparkles, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Card, Kicker, fmtBytes, fmtDateTime, fmtRate, jsonFetch } from "../../page-shared";
import type { CodexCleanupReceipt, DeviceDutyDevice, DeviceDutySnapshot } from "../../types";

function percent(value: number | null) {
  return value == null ? "采样中" : `${Math.round(value)}%`;
}

function deviceIcon(id: DeviceDutyDevice["id"]) {
  return id === "nas" ? <Server size={18} /> : <Activity size={18} />;
}

function metricTone(value: number | null, warning: number, danger: number) {
  if (value == null) return "";
  if (value >= danger) return "is-hot";
  if (value >= warning) return "is-watch";
  return "";
}

function duration(seconds: number) {
  if (seconds < 60) return "刚打开";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时`;
  return `${Math.floor(seconds / 86_400)} 天`;
}

function DeviceRow({ device }: { device: DeviceDutyDevice }) {
  const writing = device.diskWriteBytesPerSecond;
  return (
    <article className={`device-duty-device is-${device.level}`}>
      <header>
        <span className="device-duty-icon">{deviceIcon(device.id)}</span>
        <div>
          <strong>{device.label}</strong>
          <small>{device.reason}</small>
        </div>
        <em>{device.statusLabel}</em>
      </header>
      <div className="device-duty-metrics" aria-label={`${device.label} 当前资源占用`}>
        <div className={metricTone(device.cpuPercent, 65, 88)}>
          <Cpu size={14} /><span>CPU</span><strong>{percent(device.cpuPercent)}</strong>
        </div>
        <div className={metricTone(device.memoryPercent, 85, 94)}>
          <MemoryStick size={14} /><span>内存</span><strong>{device.available ? percent(device.memoryPercent) : "—"}</strong>
        </div>
        <div className={metricTone(writing, 24 * 1024 * 1024, 80 * 1024 * 1024)}>
          <HardDrive size={14} /><span>写盘</span><strong>{writing == null ? "采样中" : fmtRate(writing)}</strong>
        </div>
        <div>
          <Activity size={14} /><span>{device.temperatureC != null ? "温度" : "风扇"}</span>
          <strong>{device.temperatureC != null ? `${Math.round(device.temperatureC)}°C` : device.fanRpm != null ? `${Math.round(device.fanRpm)} RPM` : "未开放"}</strong>
        </div>
      </div>
      {device.topProcesses.length ? (
        <details className="device-duty-processes" open={device.level === "watch" || device.level === "hot"}>
          <summary>看看是谁在忙 <span>{device.topProcesses.slice(0, 3).map((row) => row.name).join(" · ")}</span></summary>
          <div className="device-duty-process-head" aria-hidden="true"><span>进程</span><span>CPU</span><span>内存</span><span>写盘</span></div>
          <ol>
            {device.topProcesses.slice(0, 6).map((process) => (
              <li key={`${device.id}-${process.pid}`}>
                <span title={`PID ${process.pid}`}>{process.name}</span>
                <strong>{percent(process.cpuPercent)}</strong>
                <strong>{fmtBytes(process.memoryBytes)}</strong>
                <strong>{process.writeBytesPerSecond == null ? "—" : fmtRate(process.writeBytesPerSecond)}</strong>
              </li>
            ))}
          </ol>
          {device.id === "nas" ? <p>NAS 的进程 CPU 与内存来自只读系统表；单进程写盘归属暂不冒充精确值。</p> : null}
        </details>
      ) : null}
    </article>
  );
}

export default function DeviceDutyPanel({ active }: { active: boolean }) {
  const [data, setData] = useState<DeviceDutySnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [cleanup, setCleanup] = useState<CodexCleanupReceipt | null>(null);
  const [cleanupState, setCleanupState] = useState<"idle" | "dispatch">("idle");
  const [cleanupNote, setCleanupNote] = useState("");
  const inFlight = useRef(false);

  const load = useCallback(async (force = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await jsonFetch<DeviceDutySnapshot>(`/api/tools/device-duty?active=1${force ? "&force=1" : ""}`);
      setData(next);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时读不到设备状态");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const loadCleanup = useCallback(async () => {
    try {
      setCleanup(await jsonFetch<CodexCleanupReceipt>("/api/tools/device-duty/codex-cleanup"));
    } catch {
      // 性能诊断主体仍可独立使用；投递失败只在本人点击时明确显示。
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadCleanup();
    const timer = window.setInterval(() => { void loadCleanup(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, loadCleanup]);

  const dispatchCleanup = async () => {
    if (cleanupState !== "idle") return;
    setCleanupState("dispatch");
    setCleanupNote("");
    try {
      const receipt = await jsonFetch<CodexCleanupReceipt>("/api/tools/device-duty/codex-cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      setCleanup(receipt);
    } catch (reason) {
      setCleanupNote(reason instanceof Error ? reason.message : "暂时没能把任务交给 Codex");
    } finally {
      setCleanupState("idle");
    }
  };

  const attention = data?.devices.some((device) => device.level === "watch" || device.level === "hot");
  const cleanupRunning = cleanup?.status === "starting" || cleanup?.status === "running";
  const coveredFullDay = data?.startedAt ? Date.now() - new Date(data.startedAt).getTime() >= 24 * 60 * 60_000 : false;
  const eventWindow = coveredFullDay ? "近 24 小时" : data?.startedAt ? `从 ${fmtDateTime(data.startedAt)} 开始` : "本次值守";
  return (
    <Card className={`device-duty-panel ${attention ? "has-attention" : ""}`}>
      <div className="device-duty-head">
        <div>
          <Kicker>性能诊断</Kicker>
          <h3>{loading && !data ? "正在听" : data?.headline || "设备状态还没接上"}</h3>
          <p>{error || data?.note || "谁在占 CPU、吃内存、写硬盘，会在这里留下简短线索。"}</p>
        </div>
        <div className="device-duty-sampling">
          <span>{data?.mode === "watch" ? "临时细看" : data?.mode === "observed" ? "正在查看" : "低频值守"}</span>
          <small>
            {data ? `${data.sampleIntervalSeconds} 秒采样 · 只存内存${data.lastSampleMs != null ? ` · 上次 ${data.lastSampleMs}ms` : ""}` : "不另写硬盘"}
          </small>
          <button type="button" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} size={14} />现在听一次
          </button>
        </div>
      </div>
      <div className="device-duty-grid">
        {(data?.devices || []).map((device) => <DeviceRow key={device.id} device={device} />)}
      </div>
      <div className="device-duty-assistants">
        <details className="device-duty-terminal">
          <summary>
            <span className="device-duty-assistant-icon"><SquareTerminal size={16} /></span>
            <span><strong>活动终端</strong><small>按会话计数，不重复计算子进程</small></span>
            <em>{data?.terminals.available ? `${data.terminals.count} 个` : "未读到"}</em>
          </summary>
          {data?.terminals.available ? (
            data.terminals.sessions.length ? <ol>
              {data.terminals.sessions.map((session) => <li key={session.id}>
                <span><strong>{session.source}</strong><small>{session.shell} · 已开 {duration(session.elapsedSeconds)}</small></span>
                <em className={session.busy ? "is-busy" : ""}>{session.activeCommand || "空闲"}</em>
              </li>)}
            </ol> : <p>目前没有带 TTY 的交互终端会话。</p>
          ) : <p>{data?.terminals.error || "暂时读不到终端会话。"}</p>}
        </details>
        <section className="device-duty-cleanup">
          <header>
            <span className="device-duty-assistant-icon"><Sparkles size={16} /></span>
            <span><strong>交给 Codex 清理</strong><small>创建受限任务，网页本身不碰文件</small></span>
            <button type="button" onClick={() => void dispatchCleanup()} disabled={cleanupState !== "idle" || cleanupRunning}>
              {cleanupState === "dispatch" ? "正在交接…" : cleanupRunning ? "Codex 处理中" : cleanup?.status === "completed" ? "再清理一次" : "交给 Codex"}
            </button>
          </header>
          {cleanup && cleanup.status !== "idle" ? <div className={`device-duty-cleanup-status is-${cleanup.status}`} aria-live="polite">
            <p><ShieldCheck size={14} />{cleanup.message}</p>
            {cleanup.threadId ? <small>任务 {cleanup.threadId.slice(-8)} · 可在 Codex“工作区”查看</small> : null}
          </div> : null}
          {cleanupNote ? <p className="device-duty-cleanup-note" aria-live="polite">{cleanupNote}</p> : null}
          <footer>Codex 会重新核对并走自己的沙箱与审批；不终止进程，不碰 Vault、NAS 和个人原件。</footer>
        </section>
      </div>
      <footer className="device-duty-foot">
        <span>{data?.events.length ? `${eventWindow}记到 ${data.events.length} 段持续动静` : `${eventWindow}还没有持续异常记录`}</span>
        <small>{data?.observedAt ? `最近采样 ${fmtDateTime(data.observedAt)}` : "等待第一次采样"}</small>
      </footer>
    </Card>
  );
}
