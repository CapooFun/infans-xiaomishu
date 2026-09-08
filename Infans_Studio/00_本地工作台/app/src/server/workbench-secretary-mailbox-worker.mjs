import crypto from "node:crypto";
import os from "node:os";

export const DEFAULT_SECRETARY_MAILBOX_URL = "";

function normalizedBaseURL(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url;
}

function defaultWorkerID() {
  const digest = crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
  return `mac-secretary-${digest}`;
}

function mailboxTurn(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const voiceTranscripts = attachments
    .filter((item) => item?.kind === "audio")
    .map((item) => String(item?.transcript || "").trim())
    .filter(Boolean);
  const text = [String(message?.text || "").trim(), ...voiceTranscripts].filter(Boolean).join("\n");
  const references = attachments.flatMap((item) => {
    if (item?.kind === "audio") return [];
    const id = String(item?.id || "").trim();
    const resourcePath = String(item?.resourcePath || "").trim();
    if (!id || !resourcePath || resourcePath.startsWith("local-draft:")) return [];
    const transcript = String(item?.transcript || "").trim();
    return [{ id, ...(transcript ? { transcript } : {}) }];
  });
  if (!text && references.length === 0) throw new Error("MAILBOX_MESSAGE_HAS_NO_MAC_INPUT");
  return {
    protocolVersion: 1,
    conversationId: String(message?.conversationId || ""),
    messageId: String(message?.messageId || ""),
    generationId: String(message?.generationId || ""),
    createdAt: String(message?.createdAt || ""),
    text,
    // NAS is the ordering authority while the Mac is absent. A cached device
    // version must not turn the FIFO mailbox into a permanent resync loop.
    expectedConversationVersion: "",
    attachments: references,
  };
}

function mailboxVoiceSources(message) {
  return (Array.isArray(message?.attachments) ? message.attachments : [])
    .filter((item) => item?.kind === "audio" && String(item?.id || "").trim())
    .map((item) => ({
      id: String(item.id).trim(),
      mime: String(item.mimeType || "audio/mp4").slice(0, 120),
      durationMs: Number(item.durationMs) > 0 ? Math.round(Number(item.durationMs)) : null,
      transcript: String(item.transcript || "").trim(),
    }));
}

export function createSecretaryMailboxWorker(options = {}) {
  const baseURL = normalizedBaseURL(options.mailboxBaseUrl);
  const token = String(options.token || "").trim();
  const secretaryMobile = options.secretaryMobile;
  const yingningInbox = options.yingningInbox;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const intervalMs = Math.max(250, Number(options.intervalMs) || 1_000);
  const workerId = String(options.workerId || defaultWorkerID());
  const logger = typeof options.logger === "function" ? options.logger : () => undefined;
  const configured = Boolean(baseURL && token && secretaryMobile && typeof fetchImpl === "function");
  let timer = null;
  let stopped = true;
  let running = null;
  let activeMessage = null;

  function endpoint(pathname) {
    const next = new URL(baseURL);
    next.pathname = `${next.pathname.replace(/\/$/u, "")}${pathname}`;
    next.search = "";
    next.hash = "";
    return next;
  }

  async function request(pathname, body) {
    const response = await fetchImpl(endpoint(pathname), {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response?.ok) throw new Error(`MAILBOX_HTTP_${Number(response?.status) || 0}`);
    return response.json();
  }

  async function get(pathname, search = {}) {
    const url = endpoint(pathname);
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
    const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${token}` } });
    if (!response?.ok) throw new Error(`MAILBOX_HTTP_${Number(response?.status) || 0}`);
    return response;
  }

  async function syncIntakes() {
    if (!yingningInbox || typeof yingningInbox.accept !== "function") return 0;
    const snapshot = await (await get("/api/secretary-mobile/mailbox/intakes")).json();
    let delivered = 0;
    for (const item of snapshot?.intakes || []) {
      const attachments = [];
      for (const attachment of item.attachments || []) {
        const response = await get("/api/secretary-mobile/mailbox/intakes/attachment", {
          intakeId: item.intakeId,
          attachmentId: attachment.attachmentId,
        });
        attachments.push({ ...attachment, data: Buffer.from(await response.arrayBuffer()).toString("base64") });
      }
      const receipt = await yingningInbox.accept({ ...item, attachments });
      if (receipt?.deliveryBoundary !== "mac_persisted") throw new Error("INTAKE_MAC_RECEIPT_INCOMPLETE");
      // Relay content dedupe may have acknowledged several device IDs. Land
      // each identity at Mac before expiring the relay receipt, so a late retry
      // remains idempotent even beyond Mac's content-dedupe window.
      for (const intakeId of item.aliasIntakeIds || []) {
        const aliasReceipt = await yingningInbox.accept({ ...item, intakeId, attachments });
        if (aliasReceipt?.deliveryBoundary !== "mac_persisted") throw new Error("INTAKE_MAC_RECEIPT_INCOMPLETE");
      }
      await request("/api/secretary-mobile/mailbox/intakes/ack", { intakeId: item.intakeId, canonicalItemId: receipt.canonicalItemId });
      delivered += 1;
      logger({ stage: "intake_persisted", intakeId: item.intakeId });
    }
    return delivered;
  }

  async function release(message, error) {
    if (!message?.generationId) return;
    await request("/api/secretary-mobile/mailbox/release", {
      generationId: message.generationId,
      failureKind: error?.message === "MAILBOX_MESSAGE_HAS_NO_MAC_INPUT" ? "permanent" : "transient",
      errorCode: String(error?.message || "MAILBOX_WORKER_RELEASED").slice(0, 120),
    }).catch(() => undefined);
  }

  async function processOne() {
    if (!configured) return { configured: false, claimed: false };
    await syncIntakes().catch((error) => logger({ stage: "intake_retry", code: String(error?.message || "INTAKE_SYNC_FAILED").slice(0, 120) }));
    const claim = await request("/api/secretary-mobile/mailbox/claim", { workerId });
    if (!claim?.claimed || !claim.message) return { configured: true, claimed: false };
    const message = claim.message;
    activeMessage = message;
    try {
      const turn = mailboxTurn(message);
      const voiceSources = mailboxVoiceSources(message);
      let completed = null;
      const result = await secretaryMobile.streamTurn(turn, (event) => {
        if (event?.type === "completed") completed = event;
      }, { voiceSources });
      const replies = (Array.isArray(completed?.messages) ? completed.messages : [])
        .filter((item) => item?.role === "assistant");
      if (!result?.ok || replies.length < 1) {
        throw new Error("MAILBOX_GENERATION_NOT_SINGLE_REPLY");
      }
      const reply = replies.find((item) => String(item?.text || item?.fallbackText || "").trim()) || replies[0];
      const replyText = String(reply?.text || reply?.fallbackText || "").trim();
      if (!replyText) throw new Error("MAILBOX_GENERATION_EMPTY_REPLY");
      await request("/api/secretary-mobile/mailbox/complete", {
        messageId: message.messageId,
        generationId: message.generationId,
        reply: {
          messageId: reply.id,
          text: replyText,
          speakerId: reply.sender?.id || "yinyue",
          createdAt: reply.createdAt,
        },
      });
      logger({ stage: "completed", messageId: message.messageId, generationId: message.generationId });
      return { configured: true, claimed: true, completed: true };
    } catch (error) {
      await release(message, error);
      logger({
        stage: "released",
        messageId: message.messageId,
        generationId: message.generationId,
        code: String(error?.message || "MAILBOX_WORKER_FAILED").slice(0, 120),
      });
      return { configured: true, claimed: true, completed: false };
    } finally {
      activeMessage = null;
    }
  }

  function runOnce() {
    if (running) return running;
    running = processOne().finally(() => { running = null; });
    return running;
  }

  function schedule() {
    if (stopped || !configured) return;
    timer = setTimeout(async () => {
      timer = null;
      await runOnce().catch(() => undefined);
      schedule();
    }, intervalMs);
    timer.unref?.();
  }

  function start() {
    if (!stopped || !configured) return false;
    stopped = false;
    void runOnce().catch(() => undefined).finally(schedule);
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    const message = activeMessage;
    if (message) {
      secretaryMobile.cancel?.({
        conversationId: message.conversationId,
        generationId: message.generationId,
      });
      void release(message);
    }
  }

  return { configured, runOnce, start, stop, syncIntakes };
}

export { mailboxTurn as secretaryMailboxTurn };
