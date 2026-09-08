export type CompanionPresenceInteraction = {
  interactionId: string;
  roleId: string;
  plannedAt: string;
  expiresAt: string;
  state: string;
};

const PRESENT_STATES = new Set(["queued", "delivered_to_phone", "delivered_to_watch", "opened"]);

export function latestDueCompanionPresence(
  items: CompanionPresenceInteraction[],
  roleId: string,
  now = Date.now(),
) {
  return items
    .filter((item) => item.roleId === roleId
      && PRESENT_STATES.has(item.state)
      && new Date(item.plannedAt).getTime() <= now
      && new Date(item.expiresAt).getTime() > now)
    .sort((left, right) => new Date(left.plannedAt).getTime() - new Date(right.plannedAt).getTime())
    .at(-1) ?? null;
}

export function postCompanionPresenceToNative(
  host: unknown,
  interaction: CompanionPresenceInteraction,
) {
  try {
    const bridgeHost = host as { webkit?: { messageHandlers?: { secretaryPet?: { postMessage: (payload: unknown) => void } } } };
    const handlers = bridgeHost.webkit?.messageHandlers;
    const bridge = handlers?.secretaryPet;
    if (!bridge) return false;
    bridge.postMessage({
      type: "companion-presence",
      interactionId: interaction.interactionId,
      roleId: interaction.roleId,
    });
    return true;
  } catch {
    return false;
  }
}
