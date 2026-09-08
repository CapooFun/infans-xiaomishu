export function worldNewsFavoriteKey(lane: string, asOf: string, eventId: string) {
  return `${lane}:${asOf}:${eventId}`;
}
