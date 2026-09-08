import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { HeartCrack, LoaderCircle } from "lucide-react";
import type { WorldNewsFavoriteLane, WorldNewsFavoritesSnapshot, WorldNewsReaction } from "./types";
import { jsonFetch } from "./page-shared";
import { worldNewsFavoriteKey } from "./world-news-favorite-key";

type FavoriteTarget = {
  lane: WorldNewsFavoriteLane;
  asOf: string;
  eventId: string;
  title?: string;
  category?: string;
};

const WorldNewsFavoritesContext = createContext<{
  likes: Set<string>;
  dislikes: Set<string>;
  busyKey: string;
  busyReaction: WorldNewsReaction | "";
  toggle: (target: FavoriteTarget, reaction: WorldNewsReaction) => Promise<void>;
} | null>(null);

function snapshotSets(snapshot: WorldNewsFavoritesSnapshot) {
  const likes = new Set<string>();
  const dislikes = new Set<string>();
  for (const item of snapshot.items || []) {
    if (item.signal === "dislike") dislikes.add(item.key);
    else likes.add(item.key);
  }
  return { likes, dislikes };
}

export function WorldNewsFavoritesProvider({ children }: { children: ReactNode }) {
  const [likes, setLikes] = useState<Set<string>>(new Set());
  const [dislikes, setDislikes] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState("");
  const [busyReaction, setBusyReaction] = useState<WorldNewsReaction | "">("");

  useEffect(() => {
    let cancelled = false;
    jsonFetch<WorldNewsFavoritesSnapshot>("/api/markets/favorites")
      .then((snapshot) => {
        if (cancelled) return;
        const next = snapshotSets(snapshot);
        setLikes(next.likes);
        setDislikes(next.dislikes);
      })
      .catch(() => {
        if (cancelled) return;
        setLikes(new Set());
        setDislikes(new Set());
      });
    return () => { cancelled = true; };
  }, []);

  const toggle = useCallback(async (target: FavoriteTarget, reaction: WorldNewsReaction) => {
    const key = worldNewsFavoriteKey(target.lane, target.asOf, target.eventId);
    if (!key || busyKey) return;
    const active = reaction === "dislike" ? dislikes.has(key) : likes.has(key);
    setBusyKey(key);
    setBusyReaction(reaction);
    try {
      const next = await jsonFetch<WorldNewsFavoritesSnapshot>("/api/markets/favorites", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target, signal: reaction, saved: !active }),
      });
      const sets = snapshotSets(next);
      setLikes(sets.likes);
      setDislikes(sets.dislikes);
    } finally {
      setBusyKey("");
      setBusyReaction("");
    }
  }, [busyKey, dislikes, likes]);

  const value = useMemo(() => ({ likes, dislikes, busyKey, busyReaction, toggle }), [busyKey, busyReaction, dislikes, likes, toggle]);
  return <WorldNewsFavoritesContext.Provider value={value}>{children}</WorldNewsFavoritesContext.Provider>;
}

export function WorldNewsReactionButtons({
  lane,
  asOf,
  eventId,
  title,
  category,
}: FavoriteTarget) {
  const context = useContext(WorldNewsFavoritesContext);
  if (!context || !asOf || !eventId) return null;
  const key = worldNewsFavoriteKey(lane, asOf, eventId);
  const liked = context.likes.has(key);
  const disliked = context.dislikes.has(key);
  const busy = context.busyKey === key;
  const likeLabel = liked ? "取消收藏" : "收藏这条新闻";
  const dislikeLabel = disliked ? "取消不喜欢" : "不喜欢这类新闻";
  return <>
    <button
      type="button"
      className={`world-news-favorite${liked ? " is-saved" : ""}`}
      aria-label={`${likeLabel}：${title || eventId}`}
      aria-pressed={liked}
      title={likeLabel}
      disabled={busy}
      onClick={() => void context.toggle({ lane, asOf, eventId, title, category }, "like")}
    >
      {busy && context.busyReaction === "like" ? <LoaderCircle className="is-spinning" size={15} aria-hidden /> : liked ? "★" : "☆"}
    </button>
    <button
      type="button"
      className={`world-news-dislike${disliked ? " is-saved" : ""}`}
      aria-label={`${dislikeLabel}：${title || eventId}`}
      aria-pressed={disliked}
      title={dislikeLabel}
      disabled={busy}
      onClick={() => void context.toggle({ lane, asOf, eventId, title, category }, "dislike")}
    >
      {busy && context.busyReaction === "dislike" ? <LoaderCircle className="is-spinning" size={15} aria-hidden /> : <HeartCrack size={16} strokeWidth={1.75} aria-hidden />}
    </button>
  </>;
}
