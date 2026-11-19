import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

class InvalidInput extends Error {}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInput("body too large");
    chunks.push(chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidInput("broken JSON");
  }

  const text = body !== null && typeof body === "object" ? body.text : undefined;
  if (typeof text !== "string" || text.trim() === "") throw new InvalidInput("text is missing or empty");
  return text;
}

// Calls the model with a hard time limit. Resolves to the raw model output or rejects.
async function callModel(classifyFn, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classifyFn(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// The model's answer is trusted only after this check. Anything else goes to manual review.
export function parseModelOutput(raw) {
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    return null;
  }
  if (result === null || typeof result !== "object") return null;
  if (!TOPICS.has(result.topic)) return null;
  if (typeof result.draft !== "string" || result.draft.trim() === "") return null;
  return { topic: result.topic, draft: result.draft };
}

export async function triage(text, { classifyFn = classify, timeoutMs = MODEL_TIMEOUT_MS } = {}) {
  let raw;
  try {
    raw = await callModel(classifyFn, text, timeoutMs);
  } catch (error) {
    console.warn(`triage: model call failed: ${error.message}`);
    return MANUAL_REVIEW;
  }
  const result = parseModelOutput(raw);
  if (!result) {
    console.warn("triage: unusable model output, sent to manual review");
    return MANUAL_REVIEW;
  }
  return { status: "ready", ...result };
}

export function createApp(options = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      const text = await readText(request);
      json(response, 200, await triage(text, options));
    } catch (error) {
      if (error instanceof InvalidInput) return json(response, 400, { status: "invalid_input" });
      console.error(error);
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}`));
}
