import { useEffect, useRef, useState, type ComponentType, type RefObject } from "react";
import { ArrowLeft, BookMarked, CalendarDays, ChevronRight, ExternalLink, Heart, Languages, MapPin, RefreshCw, Ticket } from "lucide-react";

import { Card, Empty, Kicker, fmtDateTime, jsonFetch } from "../../page-shared";
import type { JapanActivitiesSnapshot } from "../../types";
import GuideOfficialImage from "./GuideOfficialImage";

const FILTER_TAGS = ["全部", "ACG", "历史人文", "AI 新知"] as const;
type FilterTag = (typeof FILTER_TAGS)[number];

type ActivityGuideComponent = ComponentType<{ id: string; onBack: () => void; backLabel: string }>;
let activityGuidePromise: Promise<{ default: ActivityGuideComponent }> | null = null;

function preloadActivityGuide() {
  activityGuidePromise ||= import("./JapanActivityGuide");
  return activityGuidePromise;
}

function fmtUpdateDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "更新日待补";
  const [year, month, day] = value.split("-");
  return `${year}.${month}.${day}`;
}

function JapanPlaybookShelf({
  playbooks,
  onOpen,
  carouselRef,
}: {
  playbooks: JapanActivitiesSnapshot["playbooks"];
  onOpen: (id: string) => void;
  carouselRef: RefObject<HTMLOListElement | null>;
}) {
  return (
    <section id="japan-playbook-shelf" className="japan-playbook-shelf-shell" aria-labelledby="japan-playbook-shelf-title">
      <Card className="japan-playbook-shelf">
        <header>
          <div>
            <Kicker>出门前的行动册 · 最近更新在前</Kicker>
            <h3 id="japan-playbook-shelf-title">选择一份攻略</h3>
          </div>
          <div className="japan-playbook-shelf-meta">
            <strong>{playbooks.length} 份</strong>
            <small>向右滑动查看更多 <ChevronRight size={14} aria-hidden="true" /></small>
          </div>
        </header>
        {playbooks.length ? (
          <ol ref={carouselRef} className="japan-playbook-carousel" aria-label="按更新时间从新到旧排列的攻略">
            {playbooks.map((playbook, index) => (
              <li key={playbook.id}>
                <button
                  type="button"
                  className="japan-playbook-card"
                  onClick={() => onOpen(playbook.id)}
                  onPointerEnter={() => { void preloadActivityGuide(); }}
                  onFocus={() => { void preloadActivityGuide(); }}
                >
                  <span className="japan-playbook-card-meta">
                    <span>{index === 0 ? "最近更新" : "继续翻阅"}</span>
                    <time dateTime={playbook.updatedAt}>{fmtUpdateDay(playbook.updatedAt)}</time>
                  </span>
                  <GuideOfficialImage {...playbook} guideId={playbook.id} className="is-playbook-card" />
                  <h3>{playbook.name}</h3>
                  <p>{playbook.dateLabel}</p>
                  <span className="japan-playbook-card-status">{playbook.status}</span>
                  <span className="japan-playbook-card-action">打开完整攻略 <ChevronRight size={16} aria-hidden="true" /></span>
                </button>
              </li>
            ))}
          </ol>
        ) : <Empty>攻略集还是空的。</Empty>}
      </Card>
    </section>
  );
}

export default function JapanActivitiesView({ active, homeRequest = 0 }: { active: boolean; homeRequest?: number }) {
  const [data, setData] = useState<JapanActivitiesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [guideId, setGuideId] = useState<string | null>(null);
  const [guideOrigin, setGuideOrigin] = useState<"playbooks" | "activities" | "attended">("playbooks");
  const [GuideView, setGuideView] = useState<ActivityGuideComponent | null>(null);
  const [showPlaybooks, setShowPlaybooks] = useState(false);
  const [savingInterestId, setSavingInterestId] = useState<string | null>(null);
  const [filterTag, setFilterTag] = useState<FilterTag>("全部");
  const playbookCarouselRef = useRef<HTMLOListElement>(null);
  const playbookScrollLeftRef = useRef(0);
  const pageScrollYRef = useRef(0);

  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      setData(await jsonFetch<JapanActivitiesSnapshot>("/api/tools/japan-activities"));
    } catch (reason) {
      setLoadError(reason instanceof SyntaxError
        ? "暂时没有收到活动资料，请稍后重新读取。"
        : reason instanceof TypeError
          ? "连接没有成功，请确认 Mac 小秘书已打开、VPN 已连接后重试。"
          : reason instanceof Error ? reason.message : "活动资料暂时读不到，请重新读取。");
    } finally {
      setLoading(false);
    }
  };

  const setInterested = async (activityId: string, interested: boolean) => {
    setSavingInterestId(activityId);
    setError("");
    try {
      setData(await jsonFetch<JapanActivitiesSnapshot>("/api/tools/japan-activities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityId, interested }),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "没能保存感兴趣状态");
    } finally {
      setSavingInterestId(null);
    }
  };

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active]);

  useEffect(() => {
    if (guideId || !showPlaybooks) return;
    const frame = requestAnimationFrame(() => {
      if (playbookCarouselRef.current) playbookCarouselRef.current.scrollLeft = playbookScrollLeftRef.current;
    });
    return () => cancelAnimationFrame(frame);
  }, [guideId, showPlaybooks, data?.playbooks.length]);

  useEffect(() => {
    if (!guideId) return;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
    return () => cancelAnimationFrame(frame);
  }, [guideId]);

  useEffect(() => {
    if (!homeRequest) return;
    setGuideId(null);
    setShowPlaybooks(true);
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: pageScrollYRef.current, left: 0, behavior: "auto" })));
  }, [homeRequest]);

  const closeGuide = () => {
    setGuideId(null);
    setShowPlaybooks(true);
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: pageScrollYRef.current, left: 0, behavior: "auto" })));
  };

  const openPlaybook = (id: string, origin: "playbooks" | "activities" | "attended" = "playbooks") => {
    pageScrollYRef.current = window.scrollY;
    playbookScrollLeftRef.current = playbookCarouselRef.current?.scrollLeft ?? playbookScrollLeftRef.current;
    setGuideOrigin(origin);
    setGuideId(id);
    void preloadActivityGuide()
      .then((module) => setGuideView(() => module.default))
      .catch((reason) => {
        setGuideId(null);
        setError(reason instanceof Error ? reason.message : "攻略页打不开");
      });
  };

  if (guideId) {
    const backLabel = guideOrigin === "activities" ? "返回未过期活动" : guideOrigin === "attended" ? "返回日本活动" : "返回攻略集";
    return GuideView
      ? <GuideView id={guideId} onBack={closeGuide} backLabel={backLabel} />
      : <div className="activity-guide-detail"><button type="button" className="activity-guide-back" onClick={closeGuide}><ArrowLeft size={16} />{backLabel}</button><Empty>正在小秘书里打开完整攻略。</Empty></div>;
  }

  const visibleActivities = data?.activities.filter((activity) => filterTag === "全部" || activity.filterTag === filterTag) ?? [];
  const filterCount = (tag: FilterTag) => tag === "全部"
    ? (data?.activities.length ?? 0)
    : (data?.activities.filter((activity) => activity.filterTag === tag).length ?? 0);

  return (
    <section className="japan-activities" aria-labelledby="japan-activities-title">
      <Card className="japan-activities-hero">
        <div>
          <Kicker>隔周导览·官方来源</Kicker>
          <h2 id="japan-activities-title">日本活动</h2>
          <p>ACG、历史人文和 AI 新知。先翻介绍卡；真想去时，直接告诉 AI 把这张卡补成你的出门攻略。</p>
        </div>
        <div className="japan-activities-stamps">
          <div className="japan-activities-stamp">
            <span>{data?.activities.length ?? "—"}</span>
            <small>未过期的</small>
            <button type="button" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "spin" : ""} size={13} />
              刷新卡片
            </button>
          </div>
          <div className="japan-activities-stamp">
            <span>{data?.playbooks.length ?? "—"}</span>
            <small>攻略集</small>
            <button
              type="button"
              aria-expanded={showPlaybooks}
              aria-controls="japan-playbook-shelf"
              onClick={() => {
                if (showPlaybooks) playbookScrollLeftRef.current = playbookCarouselRef.current?.scrollLeft ?? playbookScrollLeftRef.current;
                setShowPlaybooks((visible) => !visible);
              }}
              disabled={!data?.playbooks.length}
            >
              <BookMarked size={13} />
              {showPlaybooks ? "收起攻略" : "展开攻略"}
            </button>
          </div>
          <div className="japan-activities-stamp">
            <span>{data?.attended.length ?? "—"}</span>
            <small>参加过的</small>
            <button type="button" onClick={() => {
              if (!data?.attended[0]) return;
              pageScrollYRef.current = window.scrollY;
              setShowPlaybooks(true);
              openPlaybook(data.attended[0].id, "attended");
            }} disabled={!data?.attended.length}>
              <Ticket size={13} />
              查看记录
            </button>
          </div>
        </div>
      </Card>

      {showPlaybooks && data ? (
        <JapanPlaybookShelf
          playbooks={data.playbooks}
          carouselRef={playbookCarouselRef}
          onOpen={(id) => openPlaybook(id, "playbooks")}
        />
      ) : null}

      {loadError ? (
        <div className="vpn-warning japan-activities-read-error" role="alert">
          <Ticket size={16} />
          <div><strong>暂时读不到活动卡</strong><span>{loadError}</span></div>
          <button type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} />重新读取
          </button>
        </div>
      ) : null}
      {error ? <div className="vpn-warning" role="alert"><Ticket size={16} /><div><strong>操作暂时未完成</strong><span>{error}</span></div></div> : null}
      {loading && !data ? <Empty>正在读取最新活动。</Empty> : null}

      {data ? (
        <>
          <div className="japan-activities-meta">
            <span>{data.scope}</span>
            <small>资料更新 {fmtDateTime(data.updatedAt)}</small>
          </div>
          <div className="japan-activity-filters" role="group" aria-label="按活动类别筛选">
            {FILTER_TAGS.map((tag) => (
              <button
                type="button"
                key={tag}
                aria-pressed={filterTag === tag}
                className={filterTag === tag ? "is-active" : ""}
                onClick={() => setFilterTag(tag)}
              >
                <span>{tag}</span>
                <small>{filterCount(tag)}</small>
              </button>
            ))}
          </div>
          <div className="japan-activity-grid">
            {visibleActivities.map((activity) => (
              <article className="japan-activity-ticket" key={activity.id}>
                <div className="japan-activity-date">
                  <CalendarDays size={17} aria-hidden="true" />
                  <span>{activity.dateLabel}</span>
                  <small>{activity.region}</small>
                </div>
                <div className="japan-activity-copy">
                  <header>
                    <div className="japan-activity-tags">
                      <span>{activity.category}</span>
                      <span className={`pressure-${activity.languagePressure}`}><Languages size={12} />语言压力 {activity.languagePressure}</span>
                      {activity.hasPlaybook ? <span className="is-guide-ready"><BookMarked size={12} />攻略已做</span> : null}
                    </div>
                    <button
                      type="button"
                      className={`japan-activity-interest${activity.interested ? " is-interested" : ""}`}
                      aria-label={activity.interested ? "取消感兴趣" : "标记感兴趣"}
                      title={activity.interested ? "取消感兴趣" : "标记感兴趣"}
                      aria-pressed={activity.interested}
                      disabled={savingInterestId === activity.id}
                      onClick={() => void setInterested(activity.id, !activity.interested)}
                    >
                      <Heart size={activity.interested ? 17 : 15} fill={activity.interested ? "currentColor" : "none"} />
                    </button>
                  </header>
                  <h3>{activity.name}</h3>
                  <p className="japan-activity-place"><MapPin size={14} />{activity.place}</p>
                  <dl>
                    <div><dt>费用／报名</dt><dd>{activity.cost}<br />{activity.registration}</dd></div>
                    <div><dt>语言／中文友好</dt><dd>{activity.language}<br />{activity.chineseFriendly}</dd></div>
                    <div><dt>为什么可能适合你</dt><dd>{activity.whyCapoo}</dd></div>
                  </dl>
                  <footer>
                    <div className="japan-activity-card-actions">
                      {activity.hasPlaybook ? (
                        <button type="button" onClick={() => openPlaybook(activity.id, "activities")}>
                          <BookMarked size={13} />打开攻略
                        </button>
                      ) : null}
                      <a href={activity.officialUrl} target="_blank" rel="noreferrer">
                        {activity.sourceLabel}<ExternalLink size={13} />
                      </a>
                    </div>
                    <small>核验于 {fmtDateTime(activity.verifiedAt)}</small>
                  </footer>
                </div>
              </article>
            ))}
          </div>
          {!visibleActivities.length ? <Empty>{filterTag === "全部" ? "近期暂无可参加的官方已核验活动。" : `这一轮还没有找到适合你的${filterTag}活动。`}</Empty> : null}
        </>
      ) : null}
    </section>
  );
}
