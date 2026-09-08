export type DisplayModePasskeyStatus = { available: boolean; enrolled: boolean; reason?: string };
export async function displayModePasskeyCapability() {
  return { available: false, reason: "开源版不含展示模式" };
}
export async function readDisplayModePasskeyStatus(): Promise<DisplayModePasskeyStatus> {
  return { available: false, enrolled: false, reason: "开源版不含展示模式" };
}
export async function registerDisplayModePasskey(_password?: string) { throw new Error("开源版不含展示模式"); }
export async function authenticateDisplayModePasskey() { throw new Error("开源版不含展示模式"); }
export function displayModePasskeyErrorMessage(_error: unknown) { return "开源版不含展示模式"; }
