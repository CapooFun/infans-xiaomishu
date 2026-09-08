import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { Archive, Ban, CakeSlice, ExternalLink, Heart, LocateFixed, MapPin, Navigation, Star, UtensilsCrossed, X } from "lucide-react";
import { Empty, ExternalSourceDisclosure, jsonFetch } from "../../page-shared";
import { straightLineDistanceKm, type GeoPoint } from "../../food-map-distance";
import "./food-map.css";

type FoodListState = "explore" | "favorite" | "blacklist" | "archived";
type FoodCategory = "meal" | "snack" | "dessert" | "night";

type FoodMenuHighlight = {
  name: string;
  price: string | null;
  note: string | null;
};

type FoodPlace = {
  id: string;
  name: string;
  area: string;
  station: string;
  category: FoodCategory;
  tags: string[];
  latitude: number;
  longitude: number;
  address: string;
  profileMatch: "high" | "likely" | "interest" | "neutral";
  reason: string;
  imageUrl: string;
  imageAlt: string;
  imageKind: "official" | "venue-photo" | "reference";
  imageSourceLabel: string;
  imageSourceUrl: string;
  menuHighlights: FoodMenuHighlight[];
  menuSourceLabel: string;
  menuUrl: string;
  sourceType: "google-saved-food" | "official-research";
  sourceLabel: string;
  sourceUrl: string;
  verifiedAt: string | null;
  closed: boolean;
  listState: FoodListState;
  followed: boolean;
  note: string | null;
  stateUpdatedAt: string | null;
  mapUrl: string;
  navigationUrl: string;
};

type FoodMapSnapshot = {
  updatedAt: string | null;
  stateUpdatedAt: string | null;
  tasteProfile: { sweetness: string; favorites: string[]; currentInterests: string[] };
  categories: Array<{ id: "all" | FoodCategory; label: string }>;
  places: FoodPlace[];
};

type VisibleTab = Exclude<FoodListState, "archived">;

const TAB_LABELS: Record<VisibleTab, string> = { explore: "探索", favorite: "收藏", blacklist: "黑榜" };
const CATEGORY_LABELS: Record<FoodCategory, string> = { meal: "正餐", snack: "小吃·面食", dessert: "咖啡·甜点", night: "酒吧·夜食" };
const MATCH_LABELS = { high: "很合口味", likely: "口味候选", interest: "近期兴趣", neutral: "" } as const;
const IMAGE_KIND_LABELS = { official: "店家图片", "venue-photo": "店铺实拍", reference: "同品牌参考" } as const;

function formatDistance(distance: number | null) {
  if (distance === null) return "距离待定位";
  if (distance < 1) return `${Math.max(50, Math.round(distance * 1000 / 50) * 50)} m`;
  if (distance < 10) return `${distance.toFixed(1)} km`;
  return `${Math.round(distance)} km`;
}

function sourceShort(place: FoodPlace) {
  return place.sourceType === "google-saved-food" ? "我的收藏" : "新探索";
}

function markImageFallback(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.parentElement?.classList.add("is-fallback");
}

function FoodPlaceCard({ place, distance, saving, onOpen, onFollow }: {
  place: FoodPlace;
  distance: number | null;
  saving: boolean;
  onOpen: () => void;
  onFollow: () => void;
}) {
  const CategoryIcon = place.category === "dessert" ? CakeSlice : UtensilsCrossed;
  return (
    <article className={`food-place-card cat-${place.category} ${place.followed ? "is-followed" : ""}`}>
      <header>
        <span className="food-place-origin">{sourceShort(place)}</span>
        <button
          type="button"
          className="food-follow-button"
          onClick={onFollow}
          aria-label={place.followed ? `取消关注 ${place.name}` : `关注 ${place.name}`}
          aria-pressed={place.followed}
          disabled={saving}
        >
          <Star size={19} fill={place.followed ? "currentColor" : "none"} />
        </button>
      </header>

      <button type="button" className={`food-card-image ${place.imageUrl ? "" : "is-fallback"}`} onClick={onOpen} aria-label={`查看 ${place.name} 的图片和菜单`}>
        {place.imageUrl ? <img src={place.imageUrl} alt={place.imageAlt} loading="lazy" decoding="async" onError={markImageFallback} /> : null}
        <span className="food-card-image-fallback" aria-hidden="true"><CategoryIcon size={30} /></span>
        <small>{IMAGE_KIND_LABELS[place.imageKind]}</small>
      </button>

      <button type="button" className="food-place-main" onClick={onOpen} aria-label={`查看 ${place.name}`}>
        <span className="food-place-title-row">
          <span className="food-category-glyph" aria-hidden="true"><CategoryIcon size={18} /></span>
          <span>
            <strong>{place.name}</strong>
            <small><MapPin size={12} />{place.area} · {place.station}</small>
          </span>
        </span>
        <span className="food-place-distance" data-ready={distance !== null ? "true" : "false"}>{formatDistance(distance)}</span>
        <span className="food-place-reason">{place.reason}</span>
        {place.menuHighlights.length ? (
          <span className="food-menu-peek"><b>先看</b>{place.menuHighlights.slice(0, 2).map((item) => item.name).join(" · ")}</span>
        ) : null}
        <span className="food-place-tags">
          <em>{CATEGORY_LABELS[place.category]}</em>
          {MATCH_LABELS[place.profileMatch] ? <em className={`match-${place.profileMatch}`}>{MATCH_LABELS[place.profileMatch]}</em> : null}
          {place.tags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}
        </span>
      </button>

      <footer>
        <button type="button" className="food-detail-button" onClick={onOpen}>看详情</button>
        <a href={place.navigationUrl} target="_blank" rel="noreferrer" className="food-navigation-button">
          <Navigation size={15} />导航
        </a>
      </footer>
    </article>
  );
}

export default function FoodMapView({ active }: { active: boolean }) {
  const [data, setData] = useState<FoodMapSnapshot | null>(null);
  const [tab, setTab] = useState<VisibleTab>("explore");
  const [category, setCategory] = useState<"all" | FoodCategory>("all");
  const [position, setPosition] = useState<GeoPoint | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    setError("");
    void jsonFetch<FoodMapSnapshot>("/api/tools/food-map")
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "读不到美食地图"));
  }, [active]);

  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  const distances = useMemo(() => {
    const result = new Map<string, number>();
    if (!position || !data) return result;
    for (const place of data.places) {
      result.set(place.id, straightLineDistanceKm(position, { latitude: place.latitude, longitude: place.longitude }));
    }
    return result;
  }, [data, position]);

  const visiblePlaces = useMemo(() => {
    if (!data) return [];
    return data.places
      .filter((place) => place.listState === tab && (category === "all" || place.category === category))
      .map((place, index) => ({ place, index, distance: distances.get(place.id) ?? null }))
      .sort((a, b) => {
        if (a.place.followed !== b.place.followed) return a.place.followed ? -1 : 1;
        if (a.distance !== null && b.distance !== null && a.distance !== b.distance) return a.distance - b.distance;
        if (a.distance !== null) return -1;
        if (b.distance !== null) return 1;
        return a.index - b.index;
      });
  }, [category, data, distances, tab]);

  const selected = data?.places.find((place) => place.id === selectedId) || null;

  const countForTab = (value: VisibleTab) => data?.places.filter((place) => place.listState === value).length || 0;
  const countForCategory = (value: "all" | FoodCategory) => data?.places.filter((place) => place.listState === tab && (value === "all" || place.category === value)).length || 0;

  const locate = () => {
    setLocationError("");
    if (!navigator.geolocation) {
      setLocationError("这台设备不支持浏览器定位，导航仍然可以正常使用。");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setPosition({ latitude: coords.latitude, longitude: coords.longitude });
        setLocating(false);
      },
      (reason) => {
        setLocating(false);
        setLocationError(reason.code === reason.PERMISSION_DENIED ? "没有获得定位权限；当前位置不会保存，导航仍可使用。" : "暂时取不到当前位置，请稍后再试。");
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 300_000 },
    );
  };

  const updatePlace = async (id: string, patch: Partial<Pick<FoodPlace, "listState" | "followed" | "note">>, closeAfter = false) => {
    setSavingId(id);
    setError("");
    try {
      const next = await jsonFetch<FoodMapSnapshot>("/api/tools/food-map", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      setData(next);
      if (closeAfter) setSelectedId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "美食状态没有保存下来");
    } finally {
      setSavingId(null);
    }
  };

  const archiveSelected = () => {
    if (!selected || !window.confirm(`暂时收起「${selected.name}」？它会进入可恢复归档，不会硬删除。`)) return;
    void updatePlace(selected.id, { listState: "archived", followed: false }, true);
  };

  if (!data && !error) return <Empty>正在铺开东京美食卡片。</Empty>;

  return (
    <div className="food-map-view">
      <section className="food-map-intro" aria-labelledby="food-map-title">
        <div>
          <span className="food-map-eyebrow">TOKYO FOOD NOTES · 当前位置只在本机计算</span>
          <h2 id="food-map-title">东京，下一口往哪走</h2>
          <p>按分类和距离扫卡片。星标是近期关注，收藏与黑榜是吃过以后留下的判断。</p>
        </div>
        <button type="button" className={`food-locate-button ${position ? "is-ready" : ""}`} onClick={locate} disabled={locating}>
          <LocateFixed size={18} />
          <span><strong>{position ? "已按当前位置排序" : locating ? "正在定位" : "看看我附近"}</strong><small>{position ? "直线距离 · 不保存" : "允许后才计算"}</small></span>
        </button>
      </section>

      <div className="food-flavor-thread" aria-label="当前口味线索">
        <span><CakeSlice size={14} />低甜 · 巴斯克 · 芝士 · 奶油</span>
        <i aria-hidden="true" />
        <span><UtensilsCrossed size={14} />近期探索 · 美式烤肉</span>
      </div>

      {locationError ? <p className="food-map-feedback">{locationError}</p> : null}
      {error ? <p className="food-map-feedback is-error">{error}</p> : null}

      <nav className="food-map-tabs" aria-label="美食记录页">
        {(Object.keys(TAB_LABELS) as VisibleTab[]).map((value) => (
          <button type="button" key={value} className={tab === value ? "is-active" : ""} onClick={() => { setTab(value); setCategory("all"); }}>
            {TAB_LABELS[value]}<small>{countForTab(value)}</small>
          </button>
        ))}
      </nav>

      <nav className="food-map-categories" aria-label="美食分类">
        {(data?.categories || []).map((item) => (
          <button type="button" key={item.id} className={category === item.id ? "is-active" : ""} onClick={() => setCategory(item.id)}>
            {item.label}<small>{countForCategory(item.id)}</small>
          </button>
        ))}
      </nav>

      {visiblePlaces.length ? (
        <section className="food-card-grid" aria-label={`${TAB_LABELS[tab]}美食卡片`}>
          {visiblePlaces.map(({ place, distance }) => (
            <FoodPlaceCard
              key={place.id}
              place={place}
              distance={distance}
              saving={savingId === place.id}
              onOpen={() => setSelectedId(place.id)}
              onFollow={() => void updatePlace(place.id, { followed: !place.followed })}
            />
          ))}
        </section>
      ) : (
        <Empty>{tab === "favorite" ? "还没有收藏。吃到喜欢的，就从详情里放进来。" : tab === "blacklist" ? "黑榜现在是空的，这挺好。" : "这个分类暂时没有卡片。"}</Empty>
      )}

      {selected ? (
        <div className="food-detail-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelectedId(null); }}>
          <section className={`food-detail-sheet cat-${selected.category}`} role="dialog" aria-modal="true" aria-labelledby="food-detail-title">
            <header>
              <span>{sourceShort(selected)} · {CATEGORY_LABELS[selected.category]}</span>
              <button type="button" onClick={() => setSelectedId(null)} aria-label="关闭美食详情"><X size={19} /></button>
            </header>
            <figure className={`food-detail-image ${selected.imageUrl ? "" : "is-fallback"}`}>
              {selected.imageUrl ? <img src={selected.imageUrl} alt={selected.imageAlt} decoding="async" onError={markImageFallback} /> : null}
              <span className="food-card-image-fallback" aria-hidden="true">{selected.category === "dessert" ? <CakeSlice size={34} /> : <UtensilsCrossed size={34} />}</span>
              <figcaption><ExternalSourceDisclosure label="图片来源" sources={[{ label: selected.imageSourceLabel || IMAGE_KIND_LABELS[selected.imageKind], url: selected.imageSourceUrl || selected.sourceUrl }]} /></figcaption>
            </figure>
            <div className="food-detail-heading">
              <div>
                <h2 id="food-detail-title">{selected.name}</h2>
                <p><MapPin size={14} />{selected.area} · {selected.station}</p>
              </div>
              <strong>{formatDistance(distances.get(selected.id) ?? null)}</strong>
            </div>
            <p className="food-detail-reason">{selected.reason}</p>
            {selected.menuHighlights.length ? (
              <section className="food-detail-menu" aria-labelledby="food-detail-menu-title">
                <div>
                  <span>MENU NOTES</span>
                  <h3 id="food-detail-menu-title">先看这几样</h3>
                </div>
                <ul>
                  {selected.menuHighlights.map((item) => (
                    <li key={`${item.name}-${item.price || ""}`}>
                      <span><strong>{item.name}</strong>{item.note ? <small>{item.note}</small> : null}</span>
                      {item.price ? <b>{item.price}</b> : null}
                    </li>
                  ))}
                </ul>
                {selected.menuUrl ? <a href={selected.menuUrl} target="_blank" rel="noreferrer">打开{selected.menuSourceLabel || "菜单来源"}<ExternalLink size={13} /></a> : null}
              </section>
            ) : null}
            <div className="food-detail-tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <div className="food-detail-links">
              <a href={selected.navigationUrl} target="_blank" rel="noreferrer"><Navigation size={16} />直接导航</a>
              <a href={selected.mapUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />地图详情</a>
            </div>
            <div className="food-detail-actions" aria-label="美食状态操作">
              <button type="button" className={`food-attention-action${selected.followed ? " is-active" : ""}`} onClick={() => void updatePlace(selected.id, { followed: !selected.followed })} disabled={savingId === selected.id || selected.listState === "blacklist"}>
                <Star size={16} fill={selected.followed ? "currentColor" : "none"} />{selected.followed ? "已关注" : "关注"}
              </button>
              <button type="button" className={selected.listState === "favorite" ? "is-active" : ""} onClick={() => void updatePlace(selected.id, { listState: selected.listState === "favorite" ? "explore" : "favorite" }, true)} disabled={savingId === selected.id}>
                <Heart size={16} />{selected.listState === "favorite" ? "移回探索" : "收藏"}
              </button>
              <button type="button" className={selected.listState === "blacklist" ? "is-danger" : ""} onClick={() => void updatePlace(selected.id, { listState: selected.listState === "blacklist" ? "explore" : "blacklist", followed: false }, true)} disabled={savingId === selected.id}>
                <Ban size={16} />{selected.listState === "blacklist" ? "移回探索" : "加入黑榜"}
              </button>
              {selected.listState !== "blacklist" ? <button type="button" onClick={archiveSelected} disabled={savingId === selected.id}><Archive size={16} />暂时收起</button> : null}
            </div>
            <footer>
              <span>{selected.sourceLabel}{selected.verifiedAt ? ` · ${selected.verifiedAt} 核对` : ""}</span>
              <small>当前位置不会发送给小秘书；导航后由 Google 地图读取起点。</small>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
