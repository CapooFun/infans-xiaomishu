export function atmosphereResolution(width: number, height: number, coarse: boolean) {
  const pixelBudget = coarse ? 280_000 : 720_000;
  const scale = Math.min(1, Math.sqrt(pixelBudget / Math.max(1, width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
