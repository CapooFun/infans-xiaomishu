export type RequestCacheSnapshot<T> = { data: T | null; error: string; loading: boolean };

export function createRequestCache<K extends string, T>(fetcher: (key: K) => Promise<T>): {
  invalidate(key: K): void;
  load(key: K, force?: boolean): Promise<T>;
  snapshot(key: K): RequestCacheSnapshot<T>;
  subscribe(key: K, listener: () => void): () => void;
};
