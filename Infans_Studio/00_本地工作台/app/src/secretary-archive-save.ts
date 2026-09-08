import type { AiChatAttachment, AiSecretarySpeaker } from "./types";

export type ChatOriginalMetadata = {
  createdAt?: string;
  voiceSources?: Array<{ id: string; mime?: string; durationMs?: number; transcript?: string }>;
};

export function chatOriginalMetadata(message: ChatOriginalMetadata): ChatOriginalMetadata {
  const voiceSources = Array.isArray(message.voiceSources) ? message.voiceSources
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({
      id: item.id,
      ...(typeof item.mime === "string" ? { mime: item.mime } : {}),
      ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
      ...(typeof item.transcript === "string" ? { transcript: item.transcript } : {}),
    })) : [];
  return {
    ...(typeof message.createdAt === "string" ? { createdAt: message.createdAt } : {}),
    ...(voiceSources.length ? { voiceSources } : {}),
  };
}

function attachmentSnapshot(item: AiChatAttachment & { size?: number; sha256?: string; createdAt?: string }) {
  return {
    id: item.id, kind: item.kind, name: item.name, mime: item.mime,
    ...(typeof item.url === "string" ? { url: item.url } : {}),
    ...(typeof item.path === "string" ? { path: item.path } : {}),
    ...(typeof item.size === "number" ? { size: item.size } : {}),
    ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
    ...(typeof item.createdAt === "string" ? { createdAt: item.createdAt } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    ...(typeof item.transcript === "string" ? { transcript: item.transcript } : {}),
  };
}

export function archiveMessageSnapshot(message: ChatOriginalMetadata & {
  id: string; role: "user" | "assistant"; content: string;
  sources?: string[]; attachments?: AiChatAttachment[];
}, speaker?: AiSecretarySpeaker) {
  return {
    id: message.id, role: message.role, content: message.content,
    ...chatOriginalMetadata(message),
    ...(message.sources?.length ? { sources: message.sources } : {}),
    ...(message.role === "assistant" && speaker ? { speaker } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map(attachmentSnapshot) } : {}),
  };
}

export type ArchiveSnapshotIdentity = { id: string | null; version: string | null; epoch: number };

export function sameArchiveSnapshot(left: ArchiveSnapshotIdentity, right: ArchiveSnapshotIdentity) {
  return left.id === right.id && left.version === right.version && left.epoch === right.epoch;
}

/** A waiting closure may only write with the identity/version it originally captured. */
export async function saveCurrentArchiveSnapshot<T>(
  captured: ArchiveSnapshotIdentity,
  current: () => ArchiveSnapshotIdentity,
  previous: Promise<boolean> | null,
  write: () => Promise<T>,
): Promise<T | undefined> {
  if (previous && !(await previous)) return undefined;
  if (!sameArchiveSnapshot(captured, current())) return undefined;
  return write();
}
