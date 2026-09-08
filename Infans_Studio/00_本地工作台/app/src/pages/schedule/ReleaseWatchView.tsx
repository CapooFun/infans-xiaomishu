import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CalendarCheck2, CircleHelp, ExternalLink, Gamepad2, RefreshCw, Timer } from "lucide-react";

import { Card, Empty, Kicker, fmtDateTime, jsonFetch, tokyoDateKey } from "../../page-shared";
import type { ReleaseWatchItem, ReleaseWatchSnapshot } from "../../types";

const RELEASE_FILTERS = [
  { id: "all", label: "全部" },
  { id: "confirmed", label: "确定日期" },
  { id: "window", label: "时间范围" },
  { id: "tbd", label: "等待定档" },
] as const;

type ReleaseFilter = (typeof RELEASE_FILTERS)[number]["id"];
type ReleaseWatchCacheState = { data: ReleaseWatchSnapshot | null; loading: boolean; error: string };

let releaseWatchCacheState: ReleaseWatchCacheState = { data: null, loading: false, error: "" };
let releaseWatchRequest: Promise<ReleaseWatchSnapshot> | null = null;
const releaseWatchListeners = new Set<() => void>();

function publishReleaseWatch(next: ReleaseWatchCacheState) {
  releaseWatchCacheState = next;
  for (const listener of releaseWatchListeners) listener();
}

function subscribeReleaseWatch(listener: () => void) {
  releaseWatchListeners.add(listener);
  return () => releaseWatchListeners.delete(listener);
}

function loadReleaseWatch(force = false) {
  if (releaseWatchCacheState.data && !force) return Promise.resolve(releaseWatchCacheState.data);
  if (releaseWatchRequest) return releaseWatchRequest;
  publishReleaseWatch({ ...releaseWatchCacheState, loading: true, error: "" });
  const pending = jsonFetch<ReleaseWatchSnapshot>(`/api/schedule/releases${force ? "?force=1" : ""}`)
    .then((data) => {
      publishReleaseWatch({ data, loading: false, error: "" });
      return data;
    })
    .catch((reason) => {
      publishReleaseWatch({
        ...releaseWatchCacheState,
        loading: false,
        error: reason instanceof Error ? reason.message : "暂时读不到 Steam 愿望单",
      });
      throw reason;
    })
    .finally(() => {
      if (releaseWatchRequest === pending) releaseWatchRequest = null;
    });
  releaseWatchRequest = pending;
  return pending;
}

const WISHLIST_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "Asia/Tokyo",
});

function releaseKindLabel(kind: ReleaseWatchItem["release"]["kind"]) {
  if (kind === "confirmed") return "确定日期";
  if (kind === "window") return "时间范围";
  return "等待定档";
}

function releaseKindIcon(kind: ReleaseWatchItem["release"]["kind"]) {
  if (kind === "confirmed") return CalendarCheck2;
  if (kind === "window") return Timer;
  return CircleHelp;
}

function releaseCountdown(item: ReleaseWatchItem, todayKey = tokyoDateKey(new Date())) {
  if (!item.release.date) return null;
  const [todayYear, todayMonth, todayDay] = todayKey.split("-").map(Number);
  const [year, month, day] = item.release.date.split("-").map(Number);
  const days = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(todayYear, todayMonth - 1, todayDay)) / 86_400_000);
  if (days === 0) return "今天发售";
  if (days === 1) return "明天发售";
  if (days > 1) return `还有 ${days} 天`;
  return "已到发售日";
}

function platformLabel(platform: string) {
  if (platform === "windows") return "Windows";
  if (platform === "mac") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function wishlistAddedLabel(addedAt: string | null) {
  if (!addedAt) return "加入时间待核对";
  const date = new Date(addedAt);
  if (!Number.isFinite(date.getTime())) return "加入时间待核对";
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  const duration = days >= 365 ? `已关注 ${Math.floor(days / 365)} 年` : `已关注 ${Math.max(days, 1)} 天`;
  return `${WISHLIST_DATE_FORMATTER.format(date)}加入 · ${duration}`;
}

function releaseTimelineLabel(item: ReleaseWatchItem) {
  if (item.release.kind === "confirmed" && item.release.date) {
    const [year, month, day] = item.release.date.split("-");
    return { eyebrow: `${year} 年`, primary: `${month}.${day}`, note: releaseCountdown(item) || "确定日期" };
  }
  if (item.release.kind === "window") {
    return { eyebrow: "发售窗口", primary: item.release.label, note: "等待具体日期" };
  }
  return { eyebrow: "尚未定档", primary: "待定", note: "等待官方公布" };
}

function ReleaseCard({ item }: { item: ReleaseWatchItem }) {
  const Icon = releaseKindIcon(item.release.kind);
  const timeline = releaseTimelineLabel(item);
  return (
    <li className={`release-watch-entry is-${item.release.kind}`}>
      <div className="release-watch-time" aria-label={`${item.release.label}，${timeline.note}`}>
        <small>{timeline.eyebrow}</small>
        <strong>{timeline.primary}</strong>
        <em>{timeline.note}</em>
      </div>
      <article className="release-watch-card">
        <div className="release-watch-media">
          <a className="release-watch-cover" href={item.storeUrl} target="_blank" rel="noopener noreferrer" aria-label={`打开 ${item.title} Steam 商店页`}>
            {item.imageUrl ? <img src={item.imageUrl} alt="" width="460" height="215" loading="lazy" decoding="async" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
            <span className="release-watch-cover-fallback"><Gamepad2 size={29} aria-hidden="true" /></span>
          </a>
          <footer className="release-watch-card-foot">
            <span>{item.sourceLabel} · 只读同步</span>
            <a className="release-watch-store-link" href={item.storeUrl} target="_blank" rel="noopener noreferrer">
              Steam 商店 <ExternalLink size={13} aria-hidden="true" />
            </a>
          </footer>
        </div>
        <div className="release-watch-copy">
          <div className="release-watch-card-meta">
            <span><Icon size={13} aria-hidden="true" />{releaseKindLabel(item.release.kind)}</span>
            <small>{item.category} · {item.region}</small>
          </div>
          <h3>{item.title}</h3>
          <dl className="release-watch-details">
            <div>
              <dt>发售安排</dt>
              <dd>{item.release.label}</dd>
            </div>
            <div>
              <dt>支持平台</dt>
              <dd className="release-watch-platforms">
                {item.platforms.length ? item.platforms.map((platform) => <span key={platform}>{platformLabel(platform)}</span>) : <span>待核对</span>}
              </dd>
            </div>
            <div>
              <dt>期待多久</dt>
              <dd>{wishlistAddedLabel(item.addedAt)}</dd>
            </div>
          </dl>
        </div>
      </article>
    </li>
  );
}

export default function ReleaseWatchView({ active }: { active: boolean }) {
  const { data, loading, error } = useSyncExternalStore(
    subscribeReleaseWatch,
    () => releaseWatchCacheState,
    () => releaseWatchCacheState,
  );
  const [filter, setFilter] = useState<ReleaseFilter>("all");

  useEffect(() => {
    if (!active || data || loading || error) return;
    void loadReleaseWatch().catch(() => {});
  }, [active, data, error, loading]);

  const visibleItems = useMemo(
    () => data?.items.filter((item) => filter === "all" || item.release.kind === filter) ?? [],
    [data?.items, filter],
  );
  const countFor = (id: ReleaseFilter) => id === "all"
    ? (data?.items.length ?? 0)
    : (data?.items.filter((item) => item.release.kind === id).length ?? 0);

  return (
    <section className="release-watch" aria-labelledby="release-watch-title">
      <Card className="release-watch-hero">
        <div>
          <Kicker>Steam 愿望单 · 日本商店</Kicker>
          <h2 id="release-watch-title">新品发售</h2>
          <p>先收好期待，不把它们变成待办。有确定日期的靠前，只有季度或“即将推出”的保留原话。</p>
        </div>
        <div className="release-watch-ledger" aria-label="Steam 愿望单发售概况">
          <div><strong>{data?.upcomingCount ?? "—"}</strong><span>正在等</span></div>
          <div><strong>{data?.items.filter((item) => item.release.kind === "confirmed").length ?? "—"}</strong><span>已定日</span></div>
          <div><strong>{data?.totalWishlistCount ?? "—"}</strong><span>愿望单</span></div>
          <button type="button" onClick={() => void loadReleaseWatch(true).catch(() => {})} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} size={14} aria-hidden="true" />
            {loading ? "核对中" : "重新核对"}
          </button>
        </div>
      </Card>

      {error || data?.available === false ? (
        <div className="release-watch-warning" role="alert">
          <CircleHelp size={17} aria-hidden="true" />
          <div><strong>愿望单这次没有连上</strong><span>{error || data?.message}</span></div>
        </div>
      ) : null}

      {data?.available ? (
        <>
          <div className="release-watch-toolbar">
            <div className="release-watch-filters" role="group" aria-label="按发售日确定程度筛选">
              {RELEASE_FILTERS.map((item) => (
                <button key={item.id} type="button" className={filter === item.id ? "is-active" : ""} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
                  <span>{item.label}</span><small>{countFor(item.id)}</small>
                </button>
              ))}
            </div>
            <p>{data.releasedCount ? `${data.releasedCount} 款已发售老愿望已收起` : "当前都是未发售项"}{data.unresolvedCount ? ` · ${data.unresolvedCount} 款待核对` : ""}</p>
          </div>

          {visibleItems.length ? (
            <ol className="release-watch-timeline" aria-label="按发售时间排列的新品">
              {visibleItems.map((item) => <ReleaseCard key={item.id} item={item} />)}
            </ol>
          ) : <Empty>当前分类暂无关注的发售计划。</Empty>}

          <footer className="release-watch-foot">
            <span>只读 · Steam 愿望单与日本商店资料</span>
            <small>最后核对 {fmtDateTime(data.refreshedAt)}</small>
          </footer>
        </>
      ) : null}

      {loading && !data ? <Empty>正在核对 Steam 愿望单与发售时间。</Empty> : null}
    </section>
  );
}
