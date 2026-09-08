import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { CalendarDays, MessageCircleHeart } from "lucide-react";
import { PageTrail } from "../../shell/PageNavigation";
import type { DialogueLogDayDetail, DialogueLogDayList, DialogueLogDaySummary } from "../../types";
import { Empty, jsonFetch, navigate } from "../../page-shared";
import { createToolSessionCache } from "../../tool-session-cache";

const dialogueListCache = createToolSessionCache<"list", DialogueLogDayList>(() => jsonFetch<DialogueLogDayList>("/api/tools/dialogue-diaries"));
const dialogueDetailCache = createToolSessionCache<string, DialogueLogDayDetail>((date) => jsonFetch<DialogueLogDayDetail>(`/api/tools/dialogue-diaries?date=${encodeURIComponent(date)}`));
const DIALOGUE_SESSION_MAX_AGE_MS = 60_000;

const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) => <a href={href} {...rest}>{children}</a>,
};

function selectedDateFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const isLegacyPath = window.location.pathname === "/tools/diary-mode";
  const isCollaborationPath = window.location.pathname === "/tools/collaboration-records" && params.get("view") === "dialogue";
  if (!isLegacyPath && !isCollaborationPath) return null;
  const date = params.get("date") || "";
  return /^20\d{2}-\d{2}-\d{2}$/u.test(date) ? date : null;
}

function dialogueHref(date?: string) {
  if (window.location.pathname === "/tools/diary-mode") {
    return date ? `/tools/diary-mode?date=${encodeURIComponent(date)}` : "/tools/diary-mode";
  }
  const params = new URLSearchParams({ view: "dialogue" });
  if (date) params.set("date", date);
  return `/tools/collaboration-records?${params.toString()}`;
}

function dateParts(date: string) {
  const [year, month, day] = date.split("-");
  return { year, month, day };
}

function DialogueDayCard({
  log,
  secretaryAvatarSrc,
  onOpen,
}: {
  log: DialogueLogDaySummary;
  secretaryAvatarSrc: string;
  onOpen: () => void;
}) {
  const { year, month, day } = dateParts(log.date);
  return (
    <button type="button" className="dialogue-day-card collaboration-record-card" onClick={onOpen} aria-label={`打开 ${log.dateLabel} 的对话日志`}>
      <span className="dialogue-day-date collaboration-record-date" aria-hidden="true">
        <strong>{day}</strong>
        <small>{year}.{month}</small>
      </span>
      <span className="dialogue-day-copy collaboration-record-copy">
        <strong>{log.dateLabel}</strong>
        <span>{log.description}</span>
        <small>{log.messageCount} 条对话</small>
      </span>
      <span className="dialogue-day-avatars" aria-hidden="true">
        <img src="/api/avatar" alt="" />
        <img src={secretaryAvatarSrc} alt="" />
      </span>
    </button>
  );
}

export default function DiaryModeView({
  active,
  secretaryName,
  secretaryAvatarSrc,
}: {
  active: boolean;
  secretaryName: string;
  secretaryAvatarSrc: string;
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(() => selectedDateFromLocation());
  const [logs, setLogs] = useState<DialogueLogDaySummary[]>(() => dialogueListCache.get("list")?.logs || []);
  const [detail, setDetail] = useState<DialogueLogDayDetail | null>(() => {
    const date = selectedDateFromLocation();
    return date ? dialogueDetailCache.get(date) : null;
  });
  const [loading, setLoading] = useState(() => {
    const date = selectedDateFromLocation();
    return date ? !dialogueDetailCache.get(date) : !dialogueListCache.get("list");
  });
  const [error, setError] = useState("");

  useEffect(() => {
    const sync = () => setSelectedDate(selectedDateFromLocation());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const cached = selectedDate ? dialogueDetailCache.get(selectedDate) : dialogueListCache.get("list");
    setLoading(!cached);
    setError("");
    if (selectedDate) {
      setDetail(dialogueDetailCache.get(selectedDate));
      dialogueDetailCache.load(selectedDate, { maxAgeMs: DIALOGUE_SESSION_MAX_AGE_MS })
        .then((payload) => { if (!cancelled) setDetail(payload); })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "读不到这天的对话"); })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      setDetail(null);
      const list = dialogueListCache.get("list");
      if (list) setLogs(list.logs);
      dialogueListCache.load("list", { maxAgeMs: DIALOGUE_SESSION_MAX_AGE_MS })
        .then((payload) => { if (!cancelled) setLogs(payload.logs); })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "读不到对话日志"); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [active, selectedDate]);

  if (selectedDate) {
    return (
      <section className="dialogue-log-reader" aria-labelledby="dialogue-log-reader-title">
        <PageTrail items={[{ label: "协作记录", href: "/tools/collaboration-records" }, { label: "对话日志", href: dialogueHref() }, { label: detail?.summary.dateLabel || selectedDate }]} />
        <header className="dialogue-reader-head collaboration-reader-head">
          <div>
            <small>对话日志</small>
            <h2 id="dialogue-log-reader-title">{detail?.summary.dateLabel || selectedDate}</h2>
            {detail ? <p>{detail.summary.description}</p> : null}
          </div>
          {detail ? <span>{detail.summary.messageCount} 条</span> : null}
        </header>

        {loading ? <Empty>正在打开这一天的对话。</Empty> : null}
        {error ? <div className="dialogue-log-error" role="alert">{error}</div> : null}
        {detail ? (
          <div className="dialogue-thread">
            {detail.items.map((item) => item.kind === "divider" ? (
              <div className="dialogue-thread-divider" key={item.id}><span>{item.label}</span></div>
            ) : (
              <article className={`dialogue-message is-${item.role}`} key={item.id}>
                <img className="dialogue-message-avatar" src={item.role === "user" ? "/api/avatar" : secretaryAvatarSrc} alt="" />
                <div className="dialogue-message-stack">
                  <small>{item.role === "user" ? "我" : item.speaker || secretaryName}</small>
                  <div className="dialogue-message-bubble">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={markdownComponents}>
                      {item.markdown}
                    </ReactMarkdown>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="dialogue-log-index" aria-labelledby="dialogue-log-index-title">
      <header className="dialogue-log-index-head collaboration-index-head">
        <div className="collaboration-index-title">
          <span><MessageCircleHeart size={18} />私人对话</span>
          <h2 id="dialogue-log-index-title">对话日志</h2>
          <p>一天一张卡，留下当时真正说过的话。</p>
        </div>
        <div className="collaboration-index-actions">
          <span className="collaboration-index-count"><CalendarDays size={16} />{logs.length} 天</span>
        </div>
      </header>

      {loading ? <Empty>正在取出对话日志。</Empty> : null}
      {error ? <div className="dialogue-log-error" role="alert">{error}</div> : null}
      {!loading && !error && !logs.length ? <Empty>还没有保存过对话日志。</Empty> : null}
      {logs.length ? (
        <div className="dialogue-day-grid collaboration-record-grid">
          {logs.map((log) => (
            <DialogueDayCard
              key={log.date}
              log={log}
              secretaryAvatarSrc={secretaryAvatarSrc}
              onOpen={() => navigate(dialogueHref(log.date))}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
