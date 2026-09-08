import fs from "node:fs/promises";
import http from "node:http";
import { createSecretaryMailboxService } from "./workbench-secretary-mailbox.mjs";

const port = Number(process.env.PORT || 8789);
const tokenFile = process.env.SECRETARY_MAILBOX_TOKEN_FILE || "/run/secrets/secretary_mailbox_token";
const token = (await fs.readFile(tokenFile, "utf8")).trim();
if (!token) throw new Error("mailbox token is empty");
const mailbox = createSecretaryMailboxService("/", { directory: process.env.DATA_DIR || "/data" });

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendBinary(response, status, value) {
  response.writeHead(status, { "content-type": value.contentType, "content-length": value.data.length, "cache-control": "private, no-store" });
  response.end(value.data);
}

async function body(request, limit = 96_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { ok: true, service: "secretary-mailbox" });
    if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "unauthorized" });
    if (request.method === "POST" && url.pathname === "/api/secretary-mobile/mailbox/messages") return send(response, 202, await mailbox.accept(await body(request)));
    if (request.method === "POST" && url.pathname === "/api/secretary-mobile/mailbox/claim") return send(response, 200, await mailbox.claim(await body(request, 4_000)));
    if (request.method === "POST" && url.pathname === "/api/secretary-mobile/mailbox/complete") return send(response, 200, await mailbox.complete(await body(request, 48_000)));
    if (request.method === "POST" && url.pathname === "/api/secretary-mobile/mailbox/release") return send(response, 200, await mailbox.release(await body(request, 4_000)));
    if (request.method === "GET" && url.pathname === "/api/secretary-mobile/mailbox/sync") return send(response, 200, await mailbox.sync({ conversationId: url.searchParams.get("conversationId") || undefined, afterRevision: Number(url.searchParams.get("afterRevision") || 0) }));
    if (request.method === "POST" && url.pathname === "/api/secretary-mobile/mailbox/intakes") return send(response, 201, await mailbox.acceptIntake(await body(request, 48 * 1024 * 1024)));
    if (request.method === "GET" && url.pathname === "/api/secretary-mobile/mailbox/intakes") return send(response, 200, await mailbox.syncIntakes());
    if (request.method === "GET" && url.pathname === "/api/secretary-mobile/mailbox/intakes/attachment") {
      const file = await mailbox.readIntakeAttachment(url.searchParams.get("intakeId"), url.searchParams.get("attachmentId"));
      return sendBinary(response, 200, { data: file.data, contentType: file.attachment.contentType });
    }
    if (request.method === "POST" && url.pathname === "/api/secretary-mobile/mailbox/intakes/ack") return send(response, 200, await mailbox.acknowledgeIntake(await body(request, 4_000)));
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    return send(response, Number(error?.status || 500), { error: error?.code || "MAILBOX_ERROR", message: error?.message || "mailbox failed" });
  }
}).listen(port, "0.0.0.0");
