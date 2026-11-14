#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 o2api contributors
/**
 * Smoke tests for o2api.
 *
 * Spins up a tiny mock of the OpenCode HTTP API, launches real bridge
 * instances against it (one open, one with a bearer key), and exercises the
 * HTTP surface end to end. No network access or credentials required.
 *
 * Run: npm test   (node --test test/)
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

const BASE = 10000 + Math.floor(Math.random() * 20000);
const PORT_MOCK = BASE + 1;
const PORT_OPEN = BASE + 2;
const PORT_KEY = BASE + 3;
const MOCK_URL = `http://127.0.0.1:${PORT_MOCK}`;
const OPEN_URL = `http://127.0.0.1:${PORT_OPEN}`;
const KEY_URL = `http://127.0.0.1:${PORT_KEY}`;
const KEY = "test-key-123";

// ------------------------------------------------------------- mock OpenCode

/** shape mirrors what the bridge reads from the real API */
const MODEL = {
  providerID: "mock",
  modelID: "mock-1",
  type: "chat",
  name: "Mock One",
  limit: { context: 100000, output: 1000 },
};

const sessions = new Map(); // id -> { messages: [] }
let sessionSeq = 0;
let deletedSessionIds = [];

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** build the reply the fake agent produces for a prompt */
function reply(prompt) {
  if (prompt.includes("TRIGGER_ERROR")) return { error: { message: "boom upstream", status: 500 } };
  if (prompt.includes("LONG_REPLY")) return { text: "word ".repeat(60) };
  const tail = prompt.slice(-24).replace(/\s+/g, " ").trim();
  return { text: `echo:${tail}` };
}

function handle(req, res) {
  const url = new URL(req.url, "http://mock");
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/info") return json(res, 200, { version: "mock-9.9" });
  if (req.method === "GET" && p === "/api/model") return json(res, 200, { data: [MODEL] });

  if (req.method === "POST" && p === "/api/session") {
    const id = `ses_${++sessionSeq}`;
    sessions.set(id, { messages: [] });
    return json(res, 200, { data: { id } });
  }

  let m = p.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const rest = m[2] ?? "";
    const session = sessions.get(id);

    if (req.method === "DELETE" && !rest) {
      sessions.delete(id);
      deletedSessionIds.push(id);
      return json(res, 200, {});
    }
    if (!session) return json(res, 404, { message: "session not found" });
    if (req.method === "POST" && (rest === "/model" || rest === "/agent" || rest === "/interrupt")) {
      return json(res, 200, {});
    }
    if (req.method === "POST" && rest === "/prompt") {
      return readBody(req).then((body) => {
        const r = reply(String(body.text ?? ""));
        if (r.error) {
          session.messages.push({ id: `idle_${session.messages.length}`, type: "idle", outcome: "failed", error: r.error });
        } else {
          session.messages.push({
            id: `asst_${session.messages.length}`,
            type: "assistant",
            content: [{ type: "text", text: r.text }],
            tokens: { input: 100, output: 20, cache: { read: 0 }, reasoning: 0 },
            finish: "stop",
          });
          session.messages.push({ id: `idle_${session.messages.length}`, type: "idle", outcome: "success" });
        }
        return json(res, 200, {});
      });
    }
    if (req.method === "GET" && rest === "/message") {
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const desc = session.messages.slice(-limit).reverse(); // newest first
      return json(res, 200, { data: desc });
    }
  }

  if (req.method === "POST" && p.startsWith("/api/experimental/session/")) {
    return json(res, 200, {});
  }

  json(res, 404, { message: "no such endpoint" });
}

// ------------------------------------------------------------------ plumbing

const children = [];
let mockServer;

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  server.unref();
}

async function spawnBridge(port, args) {
  const child = spawn(process.execPath, [SERVER, "--port", String(port), "--url", MOCK_URL, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr.on("data", (c) => process.stderr.write(`[bridge :${port}] ${c}`));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`bridge on :${port} did not become healthy`);
}

const api = (port, pathname, opts = {}) =>
  fetch(`http://127.0.0.1:${port}${pathname}`, opts);

function sseEvents(raw) {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      return line ? line.slice(6) : "";
    });
}

// ------------------------------------------------------------------ lifecycle

test.before(async () => {
  mockServer = http.createServer(handle);
  await listen(mockServer, PORT_MOCK);
  await spawnBridge(PORT_OPEN, []);
  await spawnBridge(PORT_KEY, ["--key", KEY]);
});

test.after(() => {
  for (const c of children) c.kill("SIGTERM");
  mockServer?.close();
});

// --------------------------------------------------------------------- tests

test("GET /health reports upstream version", async () => {
  const r = await api(PORT_OPEN, "/health");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.opencode, "mock-9.9");
});

test("GET /v1/models exposes model with limits", async () => {
  const r = await api(PORT_OPEN, "/v1/models");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, "list");
  const model = body.data.find((m) => m.id === "mock-1");
  assert.ok(model, "mock-1 should be listed");
  assert.equal(model.context_length, 100000);
  assert.equal(model.max_output_tokens, 1000);
  assert.equal(model.owned_by, "mock");
});

test("non-stream chat completion returns content, usage, session id", async () => {
  const r = await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: "hello world" }] }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.match(body.choices[0].message.content, /^echo:/);
  assert.equal(body.usage.prompt_tokens, 100);
  assert.equal(body.usage.completion_tokens, 20);
  assert.match(body.opencode.session_id, /^ses_/);
  assert.equal(body.opencode.reused, false);
});

test("stream chat completion emits deltas, usage and [DONE]", async () => {
  const r = await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-1", stream: true, messages: [{ role: "user", content: "streaming please" }] }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const events = sseEvents(await r.text());
  assert.equal(events[events.length - 1], "[DONE]");
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
  const withContent = chunks.filter((c) => c.choices[0]?.delta?.content);
  assert.ok(withContent.length > 0, "at least one content delta");
  const usageChunk = chunks.find((c) => c.usage);
  assert.ok(usageChunk, "usage chunk present");
  assert.equal(usageChunk.usage.completion_tokens, 20);
  const finish = chunks.find((c) => c.choices[0]?.finish_reason);
  assert.equal(finish.choices[0].finish_reason, "stop");
});

test("max_tokens truncates output and sets finish_reason=length", async () => {
  const r = await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock-1",
      max_tokens: 5,
      messages: [{ role: "user", content: "LONG_REPLY" }],
    }),
  });
  const body = await r.json();
  assert.equal(body.choices[0].finish_reason, "length");
  assert.ok(body.choices[0].message.content.length < 60, "content should be cut short");
});

test("unknown model -> 404 model_not_found", async () => {
  const r = await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.error.code, "model_not_found");
});

test("invalid JSON body -> 400", async () => {
  const r = await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{nope",
  });
  assert.equal(r.status, 400);
});

test("missing messages -> 400", async () => {
  const r = await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-1" }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "messages_required");
});

test("upstream agent error -> OpenAI-style error response", async () => {
  const r = await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: "TRIGGER_ERROR" }] }),
  });
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.equal(body.error.message, "boom upstream");
});

test("x-session-id reuses the OpenCode session and forwards only the new turn", async () => {
  const headers = { "content-type": "application/json", "x-session-id": "reuse-case" };
  const first = await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: "first unique question" }] }),
  });
  const sid = (await first.json()).opencode.session_id;

  const second = await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: "second unique question" }] }),
  });
  const body = await second.json();
  assert.equal(body.opencode.reused, true);
  assert.equal(body.opencode.session_id, sid);
  // the mock echoes the prompt tail: on reuse only the newest message is sent
  assert.match(body.choices[0].message.content, /second unique question/);
  assert.doesNotMatch(body.choices[0].message.content, /first unique question/);
});

test("stateless calls delete their OpenCode session (no leak)", async () => {
  deletedSessionIds.length = 0;
  await api(PORT_OPEN, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: "bye" }] }),
  });
  // cleanup happens asynchronously after the response
  const deadline = Date.now() + 3000;
  while (!deletedSessionIds.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(deletedSessionIds.length, 1, "session should be deleted after stateless call");
});

test("auth: missing key -> 401, wrong key -> 401, right key -> 200", async () => {
  const missing = await api(PORT_KEY, "/v1/models");
  assert.equal(missing.status, 401);

  const wrong = await api(PORT_KEY, "/v1/models", { headers: { authorization: "Bearer wrong" } });
  assert.equal(wrong.status, 401);

  const right = await api(PORT_KEY, "/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(right.status, 200);
});

test("auth: wrong-length keys are rejected without crashing", async () => {
  for (const key of ["x", "a".repeat(200)]) {
    const r = await api(PORT_KEY, "/v1/models", { headers: { authorization: `Bearer ${key}` } });
    assert.equal(r.status, 401);
  }
});

test("foreign Host header -> 403", async () => {
  // fetch (undici) refuses to spoof Host, so use a raw socket-level request
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT_OPEN, path: "/v1/models", headers: { host: "evil.example.com" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("disallowed Origin -> 403", async () => {
  const r = await api(PORT_OPEN, "/v1/models", { headers: { origin: "https://evil.example.com" } });
  assert.equal(r.status, 403);
});

test("unknown path -> 404", async () => {
  const r = await api(PORT_OPEN, "/definitely-not-here");
  assert.equal(r.status, 404);
});
