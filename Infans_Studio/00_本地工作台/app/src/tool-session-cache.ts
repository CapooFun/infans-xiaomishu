type LoadOptions = { force?: boolean; maxAgeMs?: number };

type CacheRecord<T> = {
  data: T;
  updatedAt: number;
};

const clearCallbacks = new Set<() => void>();

export function invalidateAllToolSessionCaches() {
  for (const clear of clearCallbacks) clear();
}

export function createToolSessionCache<K, T>(fetcher: (key: K, options: LoadOptions) => Promise<T>) {
  const records = new Map<K, CacheRecord<T>>();
  const pending = new Map<K, Promise<T>>();
  let generation = 0;

  const get = (key: K) => records.get(key)?.data ?? null;

  const set = (key: K, data: T) => {
    records.set(key, { data, updatedAt: Date.now() });
    return data;
  };

  const clear = () => {
    generation += 1;
    records.clear();
    pending.clear();
  };
  clearCallbacks.add(clear);

  const load = (key: K, options: LoadOptions = {}) => {
    const cached = records.get(key);
    const fresh = cached && (options.maxAgeMs == null || Date.now() - cached.updatedAt < options.maxAgeMs);
    if (fresh && !options.force) return Promise.resolve(cached.data);
    const existing = pending.get(key);
    if (existing) return existing;
    const requestGeneration = generation;
    const request = Promise.resolve(fetcher(key, options))
      .then((data) => requestGeneration === generation ? set(key, data) : data)
      .finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
    pending.set(key, request);
    return request;
  };

  return { clear, get, load, set };
}
