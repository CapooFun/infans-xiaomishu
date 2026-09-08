export const SECRETARY_SPEECH_RATE_PRESETS = Object.freeze({
  slow: Object.freeze({ label: "慢", multiplier: 0.7 }),
  normal: Object.freeze({ label: "正常", multiplier: 1 }),
  fast: Object.freeze({ label: "快", multiplier: 1.5 }),
  veryfast: Object.freeze({ label: "很快", multiplier: 2 }),
});

export function normalizeSecretarySpeechRatePreset(raw = "normal") {
  const value = String(raw || "").trim().toLowerCase();
  return Object.hasOwn(SECRETARY_SPEECH_RATE_PRESETS, value) ? value : "normal";
}

export function secretarySpeechRateMultiplier(raw = "normal") {
  const preset = normalizeSecretarySpeechRatePreset(raw);
  return SECRETARY_SPEECH_RATE_PRESETS[preset].multiplier;
}

export function adjustSecretaryWebSpeechRate(baseRate = 1, preset = "normal") {
  const base = Number.isFinite(Number(baseRate)) ? Number(baseRate) : 1;
  return Math.min(2, Math.max(0.5, base * secretarySpeechRateMultiplier(preset)));
}

export function adjustSecretaryEdgeSpeechRate(baseRate = "+0%", preset = "normal") {
  const match = String(baseRate || "").trim().match(/^([+-]?\d+(?:\.\d+)?)%$/);
  const baseMultiplier = match ? 1 + Number(match[1]) / 100 : 1;
  const adjustedPercent = (baseMultiplier * secretarySpeechRateMultiplier(preset) - 1) * 100;
  const rounded = Math.round(adjustedPercent * 10) / 10;
  const value = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${rounded >= 0 ? "+" : ""}${value}%`;
}
