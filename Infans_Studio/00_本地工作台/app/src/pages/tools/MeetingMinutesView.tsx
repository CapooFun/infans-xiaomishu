import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { CalendarDays, ChevronRight, ScrollText } from "lucide-react";
import { PageTrail } from "../../shell/PageNavigation";
import { Empty, jsonFetch, navigate } from "../../page-shared";
import { createToolSessionCache } from "../../tool-session-cache";

type MeetingMinuteSummary = {
  id: string;
  date: string;
  dateLabel: string;
  title: string;
  description: string;
  headings: string[];
  sourcePath: string;
};

type MeetingMinuteList = { sourcePath: string; minutes: MeetingMinuteSummary[] };
type MeetingMinuteDetail = { summary: MeetingMinuteSummary; markdown: string };

const meetingListCache = createToolSessionCache<"list", MeetingMinuteList>(() => jsonFetch<MeetingMinuteList>("/api/tools/meeting-minutes"));
const meetingDetailCache = createToolSessionCache<string, MeetingMinuteDetail>((id) => jsonFetch<MeetingMinuteDetail>(`/api/tools/meeting-minutes?id=${encodeURIComponent(id)}`));
const MEETING_SESSION_MAX_AGE_MS = 60_000;

const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) => <a href={href} {...rest}>{children}</a>,
};

function selectedMinuteFromLocation() {
  if (window.location.pathname !== "/tools/collaboration-records") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") !== "meeting") return null;
  const minute = params.get("minute") || "";
  return /^20\d{2}-\d{2}-\d{2}_[\p{L}\p{N}_-]{1,120}$/u.test(minute) ? minute : null;
}

function minuteHref(id?: string) {
  const params = new URLSearchParams({ view: "meeting" });
  if (id) params.set("minute", id);
  return `/tools/collaboration-records?${params.toString()}`;
}

function minuteDateParts(date: string) {
  const [year, month, day] = date.split("-");
  return { year, month, day };
}

export default function MeetingMinutesView({ active }: { active: boolean }) {
  const [selectedMinute, setSelectedMinute] = useState<string | null>(() => selectedMinuteFromLocation());
  const [minutes, setMinutes] = useState<MeetingMinuteSummary[]>(() => meetingListCache.get("list")?.minutes || []);
  const [detail, setDetail] = useState<MeetingMinuteDetail | null>(() => {
    const id = selectedMinuteFromLocation();
    return id ? meetingDetailCache.get(id) : null;
  });
  const [loading, setLoading] = useState(() => {
    const id = selectedMinuteFromLocation();
    return id ? !meetingDetailCache.get(id) : !meetingListCache.get("list");
  });
  const [error, setError] = useState("");

  useEffect(() => {
    const sync = () => setSelectedMinute(selectedMinuteFromLocation());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const cached = selectedMinute ? meetingDetailCache.get(selectedMinute) : meetingListCache.get("list");
    setLoading(!cached);
    setError("");
    if (selectedMinute) {
      setDetail(meetingDetailCache.get(selectedMinute));
      meetingDetailCache.load(selectedMinute, { maxAgeMs: MEETING_SESSION_MAX_AGE_MS })
        .then((payload) => { if (!cancelled) setDetail(payload); })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "读不到这份会议纪要"); })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      setDetail(null);
      const list = meetingListCache.get("list");
      if (list) setMinutes(list.minutes);
      meetingListCache.load("list", { maxAgeMs: MEETING_SESSION_MAX_AGE_MS })
        .then((payload) => { if (!cancelled) setMinutes(payload.minutes); })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "读不到会议纪要"); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [active, selectedMinute]);

  if (selectedMinute) {
    return (
      <section className="meeting-minutes-reader" aria-labelledby="meeting-minute-reader-title">
        <PageTrail items={[{ label: "协作记录", href: "/tools/collaboration-records" }, { label: "会议纪要", href: minuteHref() }, { label: detail?.summary.title || "会议纪要" }]} />
        <header className="meeting-minute-reader-head collaboration-reader-head">
          <div>
            <small>制度记忆 · {detail?.summary.dateLabel || selectedMinute.slice(0, 10)}</small>
            <h2 id="meeting-minute-reader-title">{detail?.summary.title || "会议纪要"}</h2>
            {detail ? <p>{detail.summary.description}</p> : null}
          </div>
        </header>

        {loading ? <Empty>正在打开这份会议纪要。</Empty> : null}
        {error ? <div className="dialogue-log-error" role="alert">{error}</div> : null}
        {detail ? (
          <article className="meeting-minute-document">
            <div className="development-log-markdown meeting-minute-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={markdownComponents}>
                {detail.markdown}
              </ReactMarkdown>
            </div>
          </article>
        ) : null}
      </section>
    );
  }

  return (
    <section className="meeting-minutes-index" aria-labelledby="meeting-minutes-index-title">
      <header className="meeting-minutes-index-head collaboration-index-head">
        <div className="collaboration-index-title">
          <span><ScrollText size={18} />正式决议</span>
          <h2 id="meeting-minutes-index-title">会议纪要</h2>
          <p>收录已整理的正式讨论记录与决议。</p>
        </div>
        <div className="collaboration-index-actions">
          <span className="collaboration-index-count"><CalendarDays size={16} />{minutes.length} 份</span>
        </div>
      </header>

      {loading ? <Empty>正在取出会议纪要。</Empty> : null}
      {error ? <div className="dialogue-log-error" role="alert">{error}</div> : null}
      {!loading && !error && !minutes.length ? <Empty>会议纪要目录里还没有可读文件。</Empty> : null}
      {minutes.length ? (
        <div className="meeting-minutes-grid collaboration-record-grid">
          {minutes.map((minute) => {
            const { year, month, day } = minuteDateParts(minute.date);
            return (
              <button type="button" className="meeting-minute-card collaboration-record-card" key={minute.id} onClick={() => navigate(minuteHref(minute.id))}>
                <time className="collaboration-record-date" dateTime={minute.date} aria-label={minute.dateLabel}>
                  <strong>{day}</strong>
                  <small>{year}.{month}</small>
                </time>
                <span className="collaboration-record-copy">
                  <strong>{minute.title}</strong>
                  <span>{minute.description}</span>
                  <small>{minute.headings.slice(0, 3).join(" · ") || "查看完整纪要"}</small>
                </span>
                <ChevronRight size={19} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
