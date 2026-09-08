/** 开源版已排除展示模式。导出恒为关闭，且不隐藏仍公开的内容。启用入口与解锁已删除。 */
export const DISPLAY_MODE_STORAGE_KEY = "infans-display-mode-removed";
export function readDisplayMode() { return false; }
export function writeDisplayMode(_enabled?: boolean) {}
export function isDisplayModeHiddenVideoPath(_value: string) { return false; }
export function isDisplayModeHiddenVideoEntry(_entry: { path?: string; folder?: string; available?: boolean }) { return false; }
export function isDisplayModeHiddenSecretaryChat(_chat: object) { return false; }
export function isDisplayModeHiddenLibraryKind(_value: string) { return false; }
export function isDisplayModeSensitiveProjectText(_value: string) { return false; }
export function isDisplayModeHiddenProductFeature(_feature: { id: string }) { return false; }
export function isDisplayModeHiddenProjectTask(_task: object) { return false; }
export function filterDisplayModeProductModules<T>(modules: T) { return modules; }
