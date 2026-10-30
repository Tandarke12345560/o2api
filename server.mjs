#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 o2api contributors
/**
 * o2api — OpenAI-compatible API in front of a real OpenCode server.
 *
 * It does NOT impersonate OpenCode: it drives the actual OpenCode HTTP API
 * (sessions, prompts, messages), so every request genuinely originates from
 * the OpenCode client running on this machine.
 *
 * Endpoints:
 *   POST /v1/chat/completions   (stream + non-stream)
 *   GET  /v1/models
 *   GET  /health
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "1.0.0";
const PID_FILE = path.join(os.tmpdir(), "o2api.pid");

const HELP = `
  o2api ${VERSION} — use OpenCode as an OpenAI-compatible API.

  Usage:
    o2api [options]

  Options:
    -p, --port <n>         Port to listen on            (default: 8787)
    -H, --host <addr>      Bind address                 (default: 127.0.0.1)
    -k, --key <token>      Require Authorization: Bearer <token>
    -m, --model <id>       Default model id             (default: first available)
    -a, --agent <name>     Default agent: build | plan  (default: build)
    -d, --workdir <dir>    Directory the agent works in (default: cwd)
    -u, --url <url>        OpenCode server URL          (default: http://127.0.0.1:49374)
        --password <pw>    OpenCode service password    (default: service.json)
        --cors <origins>   Comma-separated allowed browser origins (default: none)
        --allowed-host <h> Extra Host header values to accept (comma-separated)
    -v, --version          Print version
        --help             Print this help

  Examples:
    o2api
    o2api --port 8080 --key sk-local
    o2api --host 0.0.0.0 --key sk-local --workdir ~/code/my-app
    o2api --host 0.0.0.0 --key sk-local --cors https://app.example.com

  Then:
    curl http://127.0.0.1:8787/v1/chat/completions \\
      -H 'content-type: application/json' \\
      -d '{"model":"<model>","messages":[{"role":"user","content":"hi"}]}'

  Not affiliated with OpenCode or any model provider.
  Provided "as is" (Apache-2.0). You are responsible for complying with their terms.
  Full disclaimer: DISCLAIMER.md
`;

function parseArgs(argv) {
  const out = {};
  const alias = {
    p: "port",
    H: "host",
    k: "key",
    m: "model",
    a: "agent",
    d: "workdir",
    u: "url",
    v: "version",
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("-")) continue;
    let name;
    let value;

    if (raw.startsWith("--")) {
      const body = raw.slice(2);
      const eq = body.indexOf("=");
      name = eq === -1 ? body : body.slice(0, eq);
      if (eq !== -1) value = body.slice(eq + 1);
    } else {
      name = alias[raw.slice(1)] ?? raw.slice(1);
    }

    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    out[name] = value;
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help) {
  console.log(HELP);
  process.exit(0);
}
if (ARGS.version) {
  console.log(VERSION);
  process.exit(0);
}

const OPENCODE_URL = ARGS.url || process.env.OPENCODE_URL || "http://127.0.0.1:49374";
const PORT = Number(ARGS.port ?? process.env.PORT ?? 8787);
const HOST = ARGS.host || process.env.HOST || "127.0.0.1";
const DEFAULT_MODEL = ARGS.model || process.env.DEFAULT_MODEL || null;
const DEFAULT_AGENT = ARGS.agent || process.env.DEFAULT_AGENT || "build";
const WORKDIR = ARGS.workdir || process.env.WORKDIR || process.cwd();
const BRIDGE_API_KEY = ARGS.key || process.env.BRIDGE_API_KEY || null;
const CLI_PASSWORD = ARGS.password || process.env.OPENCODE_PASSWORD || null;

const splitList = (value) =>
  String(value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const CORS_ORIGINS = splitList(
  ARGS.cors !== undefined ? (ARGS.cors === true ? "" : ARGS.cors) : process.env.CORS_ORIGINS,
);

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const isLoopback = LOOPBACK.has(HOST.toLowerCase());

if (!isLoopback && !BRIDGE_API_KEY) {
  console.error(`
  \x1b[31merror:\x1b[0m refusing to bind ${HOST} without an API key.

  Exposing the bridge beyond localhost lets anyone who can reach the port
  drive your OpenCode agent (including file and shell tools).

  Use one of:
    o2api --host ${HOST} --key "$(openssl rand -hex 24)"
    o2api --host ${HOST} --key sk-local --cors https://your.app
  Or keep the default: --host 127.0.0.1
`);
  process.exit(1);
}

// Host header allowlist. Loopback is always accepted; the machine's own
// interface addresses are added when the platform lets us enumerate them.
// `os.networkInterfaces()` can throw in restricted containers/sandboxes, so
// treat it as best-effort and never fail startup because of it.
const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
try {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) allowedHosts.add(addr.address.toLowerCase());
  }
} catch {}
if (!["0.0.0.0", "::"].includes(HOST)) allowedHosts.add(HOST.toLowerCase());
for (const h of splitList(ARGS["allowed-host"] ?? process.env.ALLOWED_HOSTS)) {
  allowedHosts.add(h);
}


function readPassword() {
  if (CLI_PASSWORD) return CLI_PASSWORD;
  const candidates = [
    path.join(os.homedir(), ".config/opencode/service.json"),
    process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode/service.json")
      : null,
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.password) return data.password;
    } catch {}
  }
  return null;
}

const PASSWORD = readPassword();
const AUTH = "Basic " + Buffer.from(`opencode:${PASSWORD ?? ""}`).toString("base64");

// ---------------------------------------------------------------- upstream API

async function oc(method, endpoint, body) {
  const res = await fetch(`${OPENCODE_URL}${endpoint}`, {
    method,
    headers: {
      authorization: AUTH,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      `OpenCode ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 500)}`,
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

const createSession = (opts = {}) =>
  oc("POST", "/api/session", {
    title: opts.title ?? "bridge session",
    agent: opts.agent ?? DEFAULT_AGENT,
    location: { directory: opts.directory ?? WORKDIR },
    ...(opts.model ? { model: opts.model } : {}),
  }).then((r) => r.data);

const sendPrompt = (sessionID, text) =>
  oc("POST", `/api/session/${sessionID}/prompt`, { text });

const waitIdle = (sessionID) =>
  oc("POST", `/api/experimental/session/${sessionID}/wait`);

const listMessages = async (sessionID) => {
  const r = await oc("GET", `/api/session/${sessionID}/message?order=asc&limit=200`);
  return r.data ?? [];
};

const deleteSession = (sessionID) =>
  oc("DELETE", `/api/session/${sessionID}`).catch(() => {});

// ------------------------------------------------------------------ utilities

let modelCache = { at: 0, list: [] };

async function models() {
  if (Date.now() - modelCache.at < 60_000 && modelCache.list.length) return modelCache.list;
  const r = await oc("GET", "/api/model");
  modelCache = { at: Date.now(), list: r.data ?? [] };
  return modelCache.list;
}

async function resolveModel(requested) {
  const list = await models();
  const wanted = requested || DEFAULT_MODEL;
  if (!wanted) {
    const first = list.find((m) => m.type === "chat" && m.enabled !== false);
    return first ? { id: first.modelID ?? first.id, providerID: first.providerID } : null;
  }
  const match =
    list.find((m) => (m.modelID ?? m.id) === wanted) ||
    list.find((m) => m.id === wanted) ||
    list.find((m) => (m.modelID ?? m.id).startsWith(wanted));
  if (!match) return null;
  return { id: match.modelID ?? match.id, providerID: match.providerID };
}

function assistantText(message) {
  if (!message || message.type !== "assistant") return "";
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function lastAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "assistant") return messages[i];
  }
  return null;
}

function isIdle(messages) {
  const last = messages[messages.length - 1];
  return last?.type === "idle";
}

function flatten(messages) {
  const lines = [];
  for (const m of messages) {
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (typeof p === "string" ? p : p.text ?? "")).join("")
          : "";
    if (!content.trim()) continue;
    const role = m.role === "system" ? "System" : m.role === "assistant" ? "Assistant" : "User";
    lines.push(`${role}: ${content}`);
  }
  return lines.join("\n\n");
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (typeof p === "string" ? p : p.text ?? "")).join("")
          : "";
    if (content.trim()) return content;
  }
  return "";
}

function usageOf(message) {
  const t = message?.tokens ?? {};
  const cacheRead = t.cache?.read ?? 0;
  const prompt = (t.input ?? 0) + cacheRead;
  const completion = t.output ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

// session reuse: key -> { id, created }
const sessions = new Map();

async function sessionFor(key, opts) {
  if (key && sessions.has(key)) return { id: sessions.get(key).id, reused: true };
  const s = await createSession(opts);
  if (key) sessions.set(key, { id: s.id, created: Date.now() });
  return { id: s.id, reused: false };
}

// ----------------------------------------------------------------- HTTP layer

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

/**
 * Reject requests whose Host header is not one of ours (DNS rebinding) and
 * browser requests from origins we were not told to trust (CSRF).
 * Requests without Origin (curl, server-side SDKs) are allowed.
 */
function rejectUntrusted(req, res) {
  const hostHeader = String(req.headers.host ?? "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (hostHeader && !allowedHosts.has(hostHeader)) {
    json(res, 403, {
      error: {
        message: `host '${hostHeader}' not allowed`,
        hint: "pass --allowed-host to accept this Host header",
      },
    });
    return true;
  }

  const origin = req.headers.origin;
  if (origin && !CORS_ORIGINS.includes(origin.toLowerCase())) {
    json(res, 403, {
      error: {
        message: `origin '${origin}' not allowed`,
        hint: "pass --cors <origin> to allow browser clients",
      },
    });
    return true;
  }

  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "authorization,content-type,x-session-id");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("vary", "Origin");
  }
  return false;
}

function authorized(req) {
  if (!BRIDGE_API_KEY) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${BRIDGE_API_KEY}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleChat(req, res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json(res, 400, { error: { message: "messages required" } });

  const model = await resolveModel(body.model);
  if (!model) {
    return json(res, 404, {
      error: { message: `unknown model: ${body.model}. Use GET /v1/models.` },
    });
  }

  const key = req.headers["x-session-id"] || body.session_id || null;
  const hist = body.history === false ? false : true;

  let sessionID;
  let reused = false;
  try {
    const created = await sessionFor(key, {
      model,
      agent: body.agent || DEFAULT_AGENT,
      directory: body.directory || WORKDIR,
      title: body.title || "bridge session",
    });
    sessionID = created.id;
    reused = created.reused;

    const prompt = created.reused && hist ? lastUserMessage(messages) : flatten(messages);
    if (!prompt.trim()) return json(res, 400, { error: { message: "empty prompt" } });

    await sendPrompt(sessionID, prompt);

    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const id = `chatcmpl_${Date.now()}`;
      const created_ = Math.floor(Date.now() / 1000);
      const sendChunk = (delta, finish = null) =>
        sse(
          res,
          null,
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: created_,
            model: model.id,
            choices: [{ index: 0, delta, finish_reason: finish }],
          }),
        );

      sendChunk({ role: "assistant", content: "" });

      let sentText = "";
      let finalMessage = null;
      let done = false;
      const waiter = waitIdle(sessionID).then(() => {
        done = true;
      });

      while (true) {
        const list = await listMessages(sessionID);
        const msg = lastAssistant(list);
        if (msg) {
          finalMessage = msg;
          const text = assistantText(msg);
          if (text.length > sentText.length) {
            const delta = text.slice(sentText.length);
            sentText = text;
            sendChunk({ content: delta });
          }
        }
        if (done || isIdle(list)) break;
        await sleep(300);
      }
      await waiter.catch(() => {});

      // final sweep for anything that arrived after the loop
      const finalList = await listMessages(sessionID);
      const msg = lastAssistant(finalList);
      if (msg) {
        finalMessage = msg;
        const text = assistantText(msg);
        if (text.length > sentText.length) {
          const delta = text.slice(sentText.length);
          sendChunk({ content: delta });
        }
      }

      sendChunk({}, "stop");
      sse(res, null, JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: created_,
        model: model.id,
        choices: [],
        usage: usageOf(finalMessage),
      }));
      sse(res, null, "[DONE]");
      res.end();
      return;
    }

    await waitIdle(sessionID).catch(() => {});
    const list = await listMessages(sessionID);
    const msg = lastAssistant(list);
    const text = assistantText(msg);

    if (!key) deleteSession(sessionID);

    json(res, 200, {
      id: `chatcmpl_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: usageOf(msg),
      opencode: { session_id: sessionID, reused: reused },
    });
  } catch (err) {
    if (!res.headersSent) {
      json(res, 502, { error: { message: err.message } });
    } else {
      try {
        sse(res, null, JSON.stringify({ error: { message: err.message } }));
        sse(res, null, "[DONE]");
      } catch {}
      res.end();
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (rejectUntrusted(req, res)) return;

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === "/health") {
    try {
      const info = await oc("GET", "/api/info");
      return json(res, 200, { ok: true, opencode: info.version, upstream: OPENCODE_URL });
    } catch (err) {
      return json(res, 503, { ok: false, error: err.message });
    }
  }

  if (!authorized(req)) {
    return json(res, 401, { error: { message: "invalid bridge api key" } });
  }

  if (url.pathname === "/v1/models" && req.method === "GET") {
    try {
      const list = await models();
      return json(res, 200, {
        object: "list",
        data: list
          .filter((m) => m.type === "chat" && m.enabled !== false)
          .map((m) => ({
            id: m.modelID ?? m.id,
            object: "model",
            created: Math.floor((m.time?.released ?? Date.now()) / 1000),
            owned_by: m.providerID,
            name: m.name,
            context: m.limit?.context ?? null,
          })),
      });
    } catch (err) {
      return json(res, 502, { error: { message: err.message } });
    }
  }

  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    try {
      const body = await readBody(req);
      return await handleChat(req, res, body);
    } catch (err) {
      return json(res, 400, { error: { message: err.message } });
    }
  }

  json(res, 404, { error: { message: "not found" } });
});

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function banner() {
  const shown = HOST === "0.0.0.0" ? "0.0.0.0 (all interfaces)" : HOST;
  const lines = [
    "",
    `  ${c.magenta}${c.bold}o2api${c.reset} ${c.dim}v${VERSION}${c.reset}`,
    `  ${c.dim}OpenCode → OpenAI-compatible API${c.reset}`,
    "",
    `  ${c.green}➜${c.reset} Local     ${c.cyan}http://${HOST}:${PORT}/v1${c.reset}`,
    `  ${c.green}➜${c.reset} Bind      ${shown}`,
    `  ${c.green}➜${c.reset} Upstream  ${OPENCODE_URL}`,
    `  ${c.green}➜${c.reset} Workdir   ${WORKDIR}`,
    `  ${c.green}➜${c.reset} Auth      ${BRIDGE_API_KEY ? c.green + "bearer key required" : c.yellow + "open (localhost only)"}${c.reset}`,
    `  ${c.green}➜${c.reset} CORS      ${CORS_ORIGINS.length ? CORS_ORIGINS.join(", ") : c.dim + "browser origins blocked" + c.reset}`,
    "",
    `  ${c.dim}Models:  curl http://${HOST}:${PORT}/v1/models${c.reset}`,
    `  ${c.dim}Chat:    curl http://${HOST}:${PORT}/v1/chat/completions${c.reset}`,
    "",
  ];
  console.log(lines.join("\n"));
}

server.listen(PORT, HOST, () => {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {}
  banner();
  if (!PASSWORD) {
    console.warn(`  ${c.red}warning:${c.reset} no OpenCode password found. Is OpenCode running?`);
    console.warn(`  ${c.dim}set --password or OPENCODE_PASSWORD if needed${c.reset}\n`);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  ${c.red}error:${c.reset} port ${PORT} is already in use.`);
    console.error(`  ${c.dim}try: o2api --port ${PORT + 1}${c.reset}\n`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      fs.rmSync(PID_FILE, { force: true });
    } catch {}
    console.log(`\n  ${c.dim}shutting down${c.reset}`);
    process.exit(0);
  });
}
