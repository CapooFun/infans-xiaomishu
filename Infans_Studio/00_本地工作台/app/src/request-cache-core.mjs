export function createRequestCache(fetcher) {
  const records = new Map();

  function record(key) {
    let current = records.get(key);
    if (!current) {
      current = { data: null, error: "", loading: false, promise: null, listeners: new Set(), generation: 0 };
      records.set(key, current);
    }
    return current;
  }

  function emit(key) {
    for (const listener of record(key).listeners) listener();
  }

  function load(key, force = false) {
    const current = record(key);
    if (current.data !== null && !force) return Promise.resolve(current.data);
    if (current.promise) return current.promise;
    const generation = current.generation;
    current.loading = true;
    current.error = "";
    emit(key);
    const pending = Promise.resolve(fetcher(key))
      .then((data) => {
        if (current.generation === generation) {
          current.data = data;
          current.error = "";
        }
        return data;
      })
      .catch((reason) => {
        if (current.generation === generation) {
          current.error = reason instanceof Error ? reason.message : "页面数据读取失败";
        }
        throw reason;
      })
      .finally(() => {
        if (current.promise === pending) {
          current.loading = false;
          current.promise = null;
        }
        emit(key);
      });
    current.promise = pending;
    return pending;
  }

  function invalidate(key) {
    const current = record(key);
    current.generation += 1;
    current.data = null;
    current.error = "";
    current.loading = false;
    current.promise = null;
    emit(key);
  }

  function subscribe(key, listener) {
    const current = record(key);
    current.listeners.add(listener);
    return () => current.listeners.delete(listener);
  }

  function snapshot(key) {
    const { data, error, loading } = record(key);
    return { data, error, loading };
  }

  return { invalidate, load, snapshot, subscribe };
}
