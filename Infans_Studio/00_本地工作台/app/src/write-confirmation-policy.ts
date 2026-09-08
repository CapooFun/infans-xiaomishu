import type { AiProposedAction, WriteAction } from "./types";
import {
  aiWriteNeedsConfirmation as sharedAiWriteNeedsConfirmation,
  directWriteSuccessMessage as sharedDirectWriteSuccessMessage,
  skipsAiWriteConfirmation as sharedSkipsAiWriteConfirmation,
  skipsWorkbenchWriteConfirmation as sharedSkipsWorkbenchWriteConfirmation,
} from "./write-confirmation-policy.mjs";

/** 高频、可明确预期的日常动作直接写入，不再打断一次让人重复确认。 */
export function skipsWorkbenchWriteConfirmation(action: WriteAction) {
  return sharedSkipsWorkbenchWriteConfirmation(action);
}

/** 梅凝对话里只有项目新增与今日日志属于已确认的直写范围。 */
export function skipsAiWriteConfirmation(action: AiProposedAction) {
  return sharedSkipsAiWriteConfirmation(action);
}

export function aiWriteNeedsConfirmation(action: AiProposedAction, preview: { requiresConfirm?: boolean }, codePath = false) {
  return sharedAiWriteNeedsConfirmation(action, preview, codePath);
}

export function directWriteSuccessMessage(action: WriteAction) {
  return sharedDirectWriteSuccessMessage(action);
}
