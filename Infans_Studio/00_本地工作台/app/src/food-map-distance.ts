export type GeoPoint = { latitude: number; longitude: number };

/** 只在浏览器内计算两点直线距离，不产生或持久化位置记录。 */
export function straightLineDistanceKm(from: GeoPoint, to: GeoPoint) {
  const earthKm = 6371;
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(to.latitude - from.latitude);
  const dLon = radians(to.longitude - from.longitude);
  const lat1 = radians(from.latitude);
  const lat2 = radians(to.latitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
