export const PRIVATE_SESSION_DEFAULT_INTENSITY = "normal";
export const PRIVATE_SESSION_DEFAULT_INDEX_POLICY = "index";
export const PRIVATE_SESSION_DEFAULTS = Object.freeze({
  sessionActive: false,
  overlayLoaded: false,
  paused: true,
  sceneMemory: "",
  intensityLevel: PRIVATE_SESSION_DEFAULT_INTENSITY,
});
export function canLoadPrivateOverlay() { return false; }
export function normalizePrivateOverlayState() { return { ...PRIVATE_SESSION_DEFAULTS }; }
export function restorePrivateSessionState() { return { ...PRIVATE_SESSION_DEFAULTS }; }
export function clearPrivateOverlayState() { return { ...PRIVATE_SESSION_DEFAULTS }; }
export function privateSessionTransition() { return { ...PRIVATE_SESSION_DEFAULTS }; }
export function privateStateWriteBoundary() { return "forbidden"; }
export function mayPromotePrivateStateToOrdinaryMemory() { return false; }
export function mayUsePrivateStateForProactiveInteraction() { return false; }
