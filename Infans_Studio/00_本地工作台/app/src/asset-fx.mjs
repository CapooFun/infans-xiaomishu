export const DEFAULT_STABLE_JPY_TO_CNY = 0.047;

export function resolveJpyToCny(mode, stableJpyToCny, liveJpyToCny) {
  const stable = Number(stableJpyToCny);
  const live = Number(liveJpyToCny);
  const fallback = Number.isFinite(stable) && stable > 0 ? stable : DEFAULT_STABLE_JPY_TO_CNY;
  return mode === "live" && Number.isFinite(live) && live > 0 ? live : fallback;
}

export function convertAmountToCny(amount, currency, jpyToCny) {
  const value = Number(amount) || 0;
  return currency === "JPY" ? value * resolveJpyToCny("stable", jpyToCny, null) : value;
}
