import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { CalendarDays, ChevronRight, Lightbulb } from "lucide-react";
import { PageTrail } from "../../shell/PageNavigation";
import { Empty, jsonFetch, navigate } from "../../page-shared";
import { createToolSessionCache } from "../../tool-session-cache";

type TechnicalPlanSummary = {
  id: string;
  date: string;
  dateLabel: string;
  title: string;
  description: string;
  headings: string[];
  topics: string[];
  sourcePath: string;
};

type TechnicalPlanList = { sourcePath: string; discussions: TechnicalPlanSummary[] };
type TechnicalPlanDetail = { summary: TechnicalPlanSummary; markdown: string };

const planListCache = createToolSessionCache<"list", TechnicalPlanList>(() => jsonFetch<TechnicalPlanList>("/api/tools/technical-discussions"));
const planDetailCache = createToolSessionCache<string, TechnicalPlanDetail>((id) => jsonFetch<TechnicalPlanDetail>(`/api/tools/technical-discussions?id=${encodeURIComponent(id)}`));
const TECHNICAL_PLAN_SESSION_MAX_AGE_MS = 60_000;

const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) => <a href={href} target="_blank" rel="noreferrer" {...rest}>{children}</a>,
};

function selectedPlanFromLocation() {
  if (window.location.pathname !== "/tools/collaboration-records") return null;
  const params = new URLSearchParams(window.location.search);
  if (!["discussion", "technical"].includes(params.get("view") || "")) return null;
  const plan = params.get("discussion") || params.get("plan") || "";
  return plan && plan.length <= 180 && !/[/\\\0]/u.test(plan) ? plan : null;
}

function planHref(id?: string) {
  const params = new URLSearchParams({ view: "discussion" });
  if (id) params.set("discussion", id);
  return `/tools/collaboration-records?${params.toString()}`;
}

function dateParts(date: string) {
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(date)) return { year: "参考", month: "方案", day: "·" };
  const [year, month, day] = date.split("-");
  return { year, month, day };
}

export default function TechnicalDiscussionsView({ active }: { active: boolean }) {
  const [selectedPlan, setSelectedPlan] = useState<string | null>(() => selectedPlanFromLocation());
  const [plans, setPlans] = useState<TechnicalPlanSummary[]>(() => planListCache.get("list")?.discussions || []);
  const [detail, setDetail] = useState<TechnicalPlanDetail | null>(() => {
    const id = selectedPlanFromLocation();
    return id ? planDetailCache.get(id) : null;
  });
  const [loading, setLoading] = useState(() => {
    const id = selectedPlanFromLocation();
    return id ? !planDetailCache.get(id) : !planListCache.get("list");
  });
  const [error, setError] = useState("");

  useEffect(() => {
    const sync = () => setSelectedPlan(selectedPlanFromLocation());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const cached = selectedPlan ? planDetailCache.get(selectedPlan) : planListCache.get("list");
    setLoading(!cached);
    setError("");
    if (selectedPlan) {
      setDetail(planDetailCache.get(selectedPlan));
      planDetailCache.load(selectedPlan, { maxAgeMs: TECHNICAL_PLAN_SESSION_MAX_AGE_MS })
        .then((payload) => { if (!cancelled) setDetail(payload); })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "读不到这份技术讨论"); })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      setDetail(null);
      const list = planListCache.get("list");
      if (list) setPlans(list.discussions);
      planListCache.load("list", { maxAgeMs: TECHNICAL_PLAN_SESSION_MAX_AGE_MS })
        .then((payload) => { if (!cancelled) setPlans(payload.discussions); })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "读不到技术讨论"); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [active, selectedPlan]);

  if (selectedPlan) {
    return (
      <section className="meeting-minutes-reader technical-plan-reader" aria-labelledby="technical-plan-reader-title">
        <PageTrail items={[{ label: "协作记录", href: "/tools/collaboration-records" }, { label: "技术讨论", href: planHref() }, { label: detail?.summary.title || "技术讨论" }]} />
        <header className="meeting-minute-reader-head collaboration-reader-head">
          <div>
            <small>讨论与说明 · {detail?.summary.dateLabel || "日期未记录"}</small>
            <h2 id="technical-plan-reader-title">{detail?.summary.title || "技术讨论"}</h2>
            {detail ? <p>{detail.summary.description}</p> : null}
          </div>
        </header>

        {loading ? <Empty>正在打开这份技术讨论。</Empty> : null}
        {error ? <div className="dialogue-log-error" role="alert">{error}</div> : null}
        {detail ? (
          <article className="meeting-minute-document technical-plan-document">
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
    <section className="meeting-minutes-index technical-plans-index" aria-labelledby="technical-plans-index-title">
      <header className="meeting-minutes-index-head collaboration-index-head">
        <div className="collaboration-index-title">
          <span><Lightbulb size={18} />讨论与说明</span>
          <h2 id="technical-plans-index-title">技术讨论</h2>
          <p>收讨论稿与面向人的说明，不替代项目权威原件。</p>
        </div>
        <div className="collaboration-index-actions">
          <span className="collaboration-index-count"><CalendarDays size={16} />{plans.length} 份</span>
        </div>
      </header>

      {loading ? <Empty>正在取出技术讨论。</Empty> : null}
      {error ? <div className="dialogue-log-error" role="alert">{error}</div> : null}
      {!loading && !error && !plans.length ? <Empty>还没有标记为讨论稿或面向人说明的技术文档。</Empty> : null}
      {plans.length ? (
        <div className="meeting-minutes-grid collaboration-record-grid technical-plans-grid">
          {plans.map((plan) => {
            const { year, month, day } = dateParts(plan.date);
            return (
              <button type="button" className="meeting-minute-card collaboration-record-card technical-plan-card" key={plan.id} onClick={() => navigate(planHref(plan.id))}>
                <time className="collaboration-record-date" dateTime={plan.date} aria-label={plan.dateLabel}>
                  <strong>{day}</strong>
                  <small>{year}.{month}</small>
                </time>
                <span className="collaboration-record-copy">
                  <strong>{plan.title}</strong>
                  <span>{plan.description}</span>
                  <small>{plan.topics.join(" · ") || plan.headings.slice(0, 3).join(" · ") || "查看完整内容"}</small>
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
