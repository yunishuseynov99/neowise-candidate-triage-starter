import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";

let server;
let baseUrl;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function post(body) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

test("valid request returns topic and draft", async () => {
  const reply = await post({ text: "Когда будет доставка?" });
  assert.equal(reply.status, 200);
  const body = await reply.json();
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.ok(body.draft.trim().length > 0);
});

for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`model failure ${marker} goes to manual review`, async () => {
    const started = Date.now();
    const reply = await post({ text: `Вопрос по цене ${marker}` });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), MANUAL_REVIEW);
    assert.ok(Date.now() - started < 1000, "must not wait for the slow model");
  });
}

for (const [name, body] of [
  ["broken JSON", "{not json"],
  ["missing text", {}],
  ["empty text", { text: "" }],
  ["whitespace text", { text: "   " }],
  ["non-string text", { text: 42 }],
  ["null body", "null"],
]) {
  test(`invalid input: ${name}`, async () => {
    const reply = await post(body);
    assert.equal(reply.status, 400);
    assert.deepEqual(await reply.json(), { status: "invalid_input" });
  });
}
