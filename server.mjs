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
import crypto from "node:crypto";

const VERSION = "1.1.1";
const PID_FILE = path.join(os.tmpdir(), "o2api.pid");

const HELP = `
  o2api ${VERSION} — use OpenCode as an OpenAI-compatible API.

  Usage:
    o2api [options]

  Options:
    -p, --port <n>              Port to listen on                  (default: 8787)
    -H, --host <addr>           Bind address                       (default: 127.0.0.1)
    -k, --key <token>           Require Authorization: Bearer <token>
    -m, --model <id>            Default model id                   (default: first available)
    -a, --agent <name>          Default agent: build | plan        (default: build)
    -d, --workdir <dir>         Directory the agent works in       (default: cwd)
    -u, --url <url>             OpenCode server URL                (default: http://127.0.0.1:49374)
        --password <pw>         OpenCode service password          (default: service.json)
        --cors <origins>        Comma-separated allowed browser origins (default: none)
        --allowed-host <h>      Extra Host header values to accept (comma-separated)
        --max-prompt-tokens <n> Hard cap for prompt tokens          (default: 0 = model context)
        --context-overhead <n>  Tokens reserved for OpenCode's own system prompt (default: 8192)
        --timeout <seconds>     Per-request timeout                 (default: 600)
        --session-ttl <seconds> Idle lifetime of x-session-id sessions (default: 3600)
    -v, --version               Print version
        --help                  Print this help

  Examples:
    o2api
    o2api --port 8080 --key sk-local
    o2api --host 0.0.0.0 --key sk-local --workdir ~/code/my-app
    o2api --host 0.0.0.0 --key sk-local --cors https://app.example.com
    o2api --max-prompt-tokens 120000

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

function positiveNumber(value, fallback, { allowZero = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) return fallback;
  return n;
}

// 0 means "derive the budget from the model's context window".
const MAX_PROMPT_TOKENS = positiveNumber(
  ARGS["max-prompt-tokens"] ?? process.env.MAX_PROMPT_TOKENS,
  0,
  { allowZero: true },
);
// OpenCode injects its own system prompt and tool descriptions (~5-8k tokens).
const CONTEXT_OVERHEAD_TOKENS = positiveNumber(
  ARGS["context-overhead"] ?? process.env.CONTEXT_OVERHEAD_TOKENS,
  8192,
  { allowZero: true },
);
const REQUEST_TIMEOUT_MS =
  positiveNumber(ARGS.timeout ?? process.env.REQUEST_TIMEOUT, 600) * 1000;
const SESSION_TTL_MS =
  positiveNumber(ARGS["session-ttl"] ?? process.env.SESSION_TTL, 3600) * 1000;

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

function httpError(status, message, type = "invalid_request_error", code = null) {
  const err = new Error(message);
  err.status = status;
  err.type = type;
  err.code = code;
  return err;
}

// ---------------------------------------------------------------- upstream API

async function oc(method, endpoint, body, opts = {}) {
  const init = {
    method,
    headers: {
      authorization: AUTH,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (opts.timeoutMs) init.signal = AbortSignal.timeout(opts.timeoutMs);

  let res;
  try {
    res = await fetch(`${OPENCODE_URL}${endpoint}`, init);
  } catch (err) {
    if (opts.timeoutMs && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw httpError(
        504,
        `OpenCode ${method} ${endpoint} timed out after ${Math.round(opts.timeoutMs / 1000)}s`,
        "upstream_timeout",
      );
    }
    throw err;
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const upstream =
      data?.error?.message ?? data?.message ?? data?.raw ?? text.slice(0, 500);
    const err = new Error(
      `OpenCode ${method} ${endpoint} -> ${res.status}: ${String(upstream).slice(0, 500)}`,
    );
    err.status = res.status;
    err.type = data?.error?.type ?? data?.type ?? "upstream_error";
    err.code = data?.error?.code ?? null;
    err.body = data;
    throw err;
  }
  return data;
}

const modelId = (m) => m?.modelID ?? m?.id ?? "";
const modelKey = (m) => (m ? `${m.providerID}/${modelId(m)}` : "");
const modelRef = (m) => ({ id: modelId(m), providerID: m.providerID });
const enc = (value) => encodeURIComponent(String(value));

const createSession = (opts = {}) =>
  oc("POST", "/api/session", {
    title: opts.title ?? "bridge session",
    agent: opts.agent ?? DEFAULT_AGENT,
    location: { directory: opts.directory ?? WORKDIR },
    ...(opts.model ? { model: modelRef(opts.model) } : {}),
  }).then((r) => r.data);

const setSessionModel = (sessionID, model) =>
  oc("POST", `/api/session/${enc(sessionID)}/model`, { model: modelRef(model) });

const setSessionAgent = (sessionID, agent) =>
  oc("POST", `/api/session/${enc(sessionID)}/agent`, { agent });

const sendPrompt = (sessionID, text) =>
  oc("POST", `/api/session/${enc(sessionID)}/prompt`, { text });

const waitIdle = (sessionID, timeoutMs = REQUEST_TIMEOUT_MS) =>
  oc(
    "POST",
    `/api/experimental/session/${enc(sessionID)}/wait`,
    undefined,
    { timeoutMs },
  );

const interruptSession = (sessionID) =>
  oc(
    "POST",
    `/api/session/${enc(sessionID)}/interrupt`,
    undefined,
    { timeoutMs: 10_000 },
  ).catch(() => {});

/**
 * Return the newest messages in ascending order.
 *
 * `order=asc&limit=200` used to return the *oldest* 200 messages, so long
 * sessions silently lost the current assistant message. Asking for the newest
 * page keeps the current turn visible regardless of session length.
 */
const listMessages = async (sessionID, limit = 200) => {
  const r = await oc(
    "GET",
    `/api/session/${enc(sessionID)}/message?order=desc&limit=${limit}`,
  );
  return (r.data ?? []).slice().reverse();
};

const deleteSession = (sessionID) =>
  oc("DELETE", `/api/session/${enc(sessionID)}`).catch(() => {});

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
  const chat = list.filter((m) => m.type === "chat" && m.enabled !== false);
  const wanted = String(requested ?? DEFAULT_MODEL ?? "").trim();

  if (!wanted) return chat[0] ?? null;

  const lower = wanted.toLowerCase();
  return (
    chat.find(
      (m) =>
        modelId(m) === wanted ||
        m.id === wanted ||
        modelKey(m) === wanted,
    ) ??
    chat.find(
      (m) =>
        modelId(m).toLowerCase() === lower ||
        modelKey(m).toLowerCase() === lower,
    ) ??
    chat.find(
      (m) =>
        modelId(m).toLowerCase().startsWith(lower) ||
        modelKey(m).toLowerCase().endsWith(`/${lower}`),
    ) ??
    null
  );
}

function contentText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" || part?.type === "input_text") return part.text ?? "";
      return part?.text ?? "";
    })
    .join("");
}

function assistantText(message) {
  if (!message || message.type !== "assistant") return "";
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function turnAssistants(messages, baselineIds) {
  return messages.filter(
    (m) => m.type === "assistant" && !baselineIds.has(m.id),
  );
}

function lastTurnAssistant(messages, baselineIds) {
  const assistants = turnAssistants(messages, baselineIds);
  return assistants.length ? assistants[assistants.length - 1] : null;
}

/**
 * Concatenate every assistant text part produced during this turn. A single
 * turn can contain multiple assistant messages (one before/after a tool call);
 * joining them keeps streaming deltas monotonic and avoids dropping text.
 */
function turnText(messages, baselineIds) {
  return turnAssistants(messages, baselineIds)
    .map(assistantText)
    .filter(Boolean)
    .join("\n\n");
}

function turnIdleMessage(messages, baselineIds) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (baselineIds.has(m.id)) continue;
    return m.type === "idle" ? m : null;
  }
  return null;
}

function isTurnIdle(messages, baselineIds) {
  const idle = turnIdleMessage(messages, baselineIds);
  return Boolean(idle);
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const content = contentText(m);
    if (content.trim()) return content;
  }
  return "";
}

function structuredErrorMessage(err) {
  if (!err) return "";
  const body = err.response?.body ? String(err.response.body).slice(0, 500) : "";
  return err.message || err.type || body || "the agent finished with an error";
}

function assistantError(messages, baselineIds) {
  const idle = turnIdleMessage(messages, baselineIds);
  if (idle?.outcome === "failed" && idle.error) return idle.error;

  const last = lastTurnAssistant(messages, baselineIds);
  if (last?.error) return last.error;
  if (last?.finish === "error" && !assistantText(last)) {
    return { message: "the agent finished with an error", type: "upstream_error" };
  }
  return null;
}

function throwAssistantError(upstream) {
  const status = Number(upstream?.status);
  throw httpError(
    Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
    structuredErrorMessage(upstream),
    upstream?.type ?? "upstream_error",
    upstream?.type ?? null,
  );
}

// --------------------------------------------------------- token accounting

/**
 * Fast, dependency-free token estimate. ASCII is assumed to be ~4 chars/token,
 * non-ASCII UTF-8 bytes ~2.5 bytes/token. It intentionally errs on the high
 * side so context trimming happens before the provider rejects the request.
 */
function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  let ascii = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 128) ascii++;
  }
  const bytes = Buffer.byteLength(s, "utf8");
  return Math.ceil(ascii / 4 + (bytes - ascii) / 2.5);
}

function avoidSplit(text, cut) {
  if (cut <= 0) return 0;
  if (
    cut < text.length &&
    text.charCodeAt(cut) >= 0xdc00 &&
    text.charCodeAt(cut) <= 0xdfff &&
    text.charCodeAt(cut - 1) >= 0xd800 &&
    text.charCodeAt(cut - 1) <= 0xdbff
  ) {
    cut--;
  }
  const from = Math.max(0, cut - 80);
  const window = text.slice(from, cut);
  const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
  if (space > 0) cut = from + space;
  return cut;
}

function truncateHeadToTokens(text, maxTokens) {
  const s = String(text ?? "");
  if (!s || estimateTokens(s) <= maxTokens) return { text: s, truncated: false };
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return { text: s.slice(0, avoidSplit(s, lo)).trimEnd(), truncated: true };
}

function truncateTailToTokens(text, maxTokens) {
  const s = String(text ?? "");
  if (!s || estimateTokens(s) <= maxTokens) return { text: s, truncated: false };
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateTokens(s.slice(mid)) <= maxTokens) hi = mid;
    else lo = mid + 1;
  }
  let start = lo;
  if (
    start < s.length &&
    s.charCodeAt(start) >= 0xdc00 &&
    s.charCodeAt(start) <= 0xdfff
  ) {
    start++;
  }
  const newline = s.indexOf("\n", start);
  if (newline !== -1 && newline - start < 80) start = newline + 1;
  return { text: s.slice(start).trimStart(), truncated: true };
}

function truncateMiddleToTokens(text, maxTokens) {
  const s = String(text ?? "");
  if (!s || estimateTokens(s) <= maxTokens) return { text: s, truncated: false };

  const marker = "\n\n[... content truncated to fit the model context window ...]\n\n";
  const markerTokens = estimateTokens(marker);
  if (maxTokens <= markerTokens + 4) {
    return truncateHeadToTokens(s, maxTokens);
  }
  const usable = Math.max(16, maxTokens - markerTokens);
  const headBudget = Math.max(8, Math.floor(usable * 0.65));
  const head = truncateHeadToTokens(s, headBudget).text;
  const tailBudget = Math.max(8, usable - estimateTokens(head));
  const tail = truncateTailToTokens(s, tailBudget).text;
  return { text: `${head}${marker}${tail}`, truncated: true };
}

function normalizeRole(role) {
  if (role === "system" || role === "developer") return "system";
  if (role === "assistant") return "assistant";
  if (role === "tool" || role === "function") return "tool";
  return "user";
}

function roleLabel(role) {
  return role === "system"
    ? "System"
    : role === "assistant"
      ? "Assistant"
      : role === "tool"
        ? "Tool"
        : "User";
}

function messageTokens(message) {
  return estimateTokens(roleLabel(message.role)) + estimateTokens(message.content) + 6;
}

/**
 * Flatten OpenAI-style messages into one OpenCode prompt while respecting the
 * model's context window. System/developer messages are kept, and the newest
 * conversation messages win; older turns are dropped before the provider can
 * reject the request with a context-length error.
 */
function buildPrompt(messages, budgetTokens) {
  const systems = [];
  const conversation = [];

  for (const raw of messages) {
    const content = contentText(raw);
    if (!content.trim()) continue;
    const item = { role: normalizeRole(raw.role), content };
    if (item.role === "system") systems.push(item);
    else conversation.push(item);
  }

  const limited = Number.isFinite(budgetTokens) && budgetTokens > 0;
  const limit = limited ? budgetTokens : Infinity;

  let used = systems.reduce((total, m) => total + messageTokens(m), 0);

  // A system prompt larger than the whole budget cannot be forwarded. Trim it
  // rather than failing with an opaque upstream context error.
  if (limited && used > limit) {
    const available = Math.max(16, Math.floor(limit * 0.7));
    const kept = [];
    let keptTokens = 0;
    for (const system of systems) {
      const cost = messageTokens(system);
      if (keptTokens + cost <= available) {
        kept.push(system);
        keptTokens += cost;
        continue;
      }
      const remaining = available - keptTokens - 8;
      if (remaining >= 16) {
        const cut = truncateMiddleToTokens(system.content, remaining);
        kept.push({ ...system, content: cut.text });
        keptTokens += messageTokens(kept[kept.length - 1]);
      }
      break;
    }
    systems.length = 0;
    systems.push(...kept);
    used = keptTokens;
  }

  const kept = [];
  for (let i = conversation.length - 1; i >= 0; i--) {
    const item = conversation[i];
    const cost = messageTokens(item);
    if (used + cost <= limit - 24) {
      kept.unshift(item);
      used += cost;
      continue;
    }
    if (kept.length === 0) {
      const remaining = Math.max(0, limit - used - 40);
      if (remaining < 16) break;
      const cut = truncateMiddleToTokens(item.content, remaining);
      if (cut.text) {
        kept.unshift({ ...item, content: cut.text });
        used += messageTokens(kept[0]);
      }
    }
    break;
  }

  const dropped = conversation.length - kept.length;
  if (dropped > 0) {
    systems.push({
      role: "system",
      content: `[o2api] ${dropped} older message(s) were omitted to fit the model context window.`,
    });
  }

  if (!kept.length && conversation.length) {
    throw httpError(
      400,
      "context_length_exceeded: the request does not fit in the model's context window",
      "invalid_request_error",
      "context_length_exceeded",
    );
  }

  const prompt = [...systems, ...kept]
    .map((m) => `${roleLabel(m.role)}: ${m.content}`)
    .join("\n\n");

  return { prompt, dropped, tokens: estimateTokens(prompt) };
}

function fitSinglePrompt(text, budgetTokens) {
  const s = String(text ?? "");
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return s;
  if (estimateTokens(s) <= budgetTokens) return s;
  return truncateMiddleToTokens(s, budgetTokens).text;
}

function outputLimit(body, model) {
  const raw = body.max_completion_tokens ?? body.max_tokens;
  if (raw === undefined || raw === null) return null;

  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw httpError(
      400,
      "max_tokens must be a positive integer",
      "invalid_request_error",
      "invalid_max_tokens",
    );
  }

  const hard = Number(model?.limit?.output);
  const cap = Number.isFinite(hard) && hard > 0 ? hard : Infinity;
  return Math.floor(Math.min(n, cap));
}

function promptBudget(model, maxOut) {
  const context = Number(model?.limit?.context);
  let budget = Infinity;

  if (Number.isFinite(context) && context > 0) {
    const modelOutput = Number(model?.limit?.output);
    const required =
      Number.isFinite(modelOutput) && modelOutput > 0 ? modelOutput : 4096;
    // Even a tiny client-side max_tokens needs some headroom upstream: OpenCode
    // may emit reasoning/tool text before the visible answer is truncated.
    const reserve =
      maxOut !== null ? Math.max(maxOut, Math.min(required, 4096)) : required;
    budget = context - reserve - CONTEXT_OVERHEAD_TOKENS;
  }

  if (MAX_PROMPT_TOKENS > 0) budget = Math.min(budget, MAX_PROMPT_TOKENS);
  if (!Number.isFinite(budget)) return Infinity;
  return Math.max(1, Math.floor(budget));
}

function finishReason(message, truncated) {
  if (truncated) return "length";
  switch (message?.finish) {
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function usageOfTurn(messages, baselineIds) {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let reasoning = 0;

  for (const message of turnAssistants(messages, baselineIds)) {
    const t = message.tokens ?? {};
    const cacheRead = t.cache?.read ?? 0;
    prompt += (t.input ?? 0) + cacheRead;
    completion += t.output ?? 0;
    cached += cacheRead;
    reasoning += t.reasoning ?? 0;
  }

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

// session reuse: key -> { id, model, agent, directory, lastUsed }
const sessions = new Map();

async function sessionFor(key, opts) {
  const now = Date.now();

  if (key) {
    const entry = sessions.get(key);
    if (entry && now - entry.lastUsed < SESSION_TTL_MS) {
      if (entry.directory === opts.directory) {
        try {
          if (modelKey(entry.model) !== modelKey(opts.model)) {
            await setSessionModel(entry.id, opts.model);
            entry.model = opts.model;
          }
          if (entry.agent !== opts.agent) {
            await setSessionAgent(entry.id, opts.agent);
            entry.agent = opts.agent;
          }
          entry.lastUsed = now;
          return {
            id: entry.id,
            reused: true,
            model: entry.model,
            agent: entry.agent,
            directory: entry.directory,
          };
        } catch (err) {
          if (err.status !== 404) throw err;
          sessions.delete(key);
        }
      } else {
        sessions.delete(key);
        deleteSession(entry.id);
      }
    } else if (entry) {
      sessions.delete(key);
      deleteSession(entry.id);
    }
  }

  const session = await createSession(opts);
  if (key) {
    sessions.set(key, {
      id: session.id,
      model: opts.model,
      agent: opts.agent,
      directory: opts.directory,
      lastUsed: now,
    });
  }
  return {
    id: session.id,
    reused: false,
    model: opts.model,
    agent: opts.agent,
    directory: opts.directory,
  };
}

const sessionCleanup = setInterval(() => {
  if (!(SESSION_TTL_MS > 0)) return;
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsed <= SESSION_TTL_MS) continue;
    sessions.delete(key);
    deleteSession(entry.id);
  }
}, 60_000);
sessionCleanup.unref?.();

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
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function sendError(res, err) {
  const status =
    Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
      ? err.status
      : 502;
  json(res, status, {
    error: {
      message: err?.message || "internal error",
      type: err?.type || "upstream_error",
      param: null,
      code: err?.code ?? null,
    },
  });
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
  const expected = Buffer.from(`Bearer ${BRIDGE_API_KEY}`);
  const given = Buffer.from(header);
  if (given.length !== expected.length) {
    // Burn a comparison anyway so wrong-length keys are not distinguishable
    // from wrong-value keys by response timing.
    crypto.timingSafeEqual(expected, expected);
    return false;
  }
  return crypto.timingSafeEqual(expected, given);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleChat(req, res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    throw httpError(400, "messages required", "invalid_request_error", "messages_required");
  }

  const model = await resolveModel(body.model);
  if (!model) {
    throw httpError(
      404,
      `unknown model: ${body.model}. Use GET /v1/models.`,
      "invalid_request_error",
      "model_not_found",
    );
  }

  const maxOut = outputLimit(body, model);
  const budget = promptBudget(model, maxOut);
  const key = req.headers["x-session-id"] || body.session_id || null;
  const hist = body.history === false ? false : true;
  const directory = body.directory || WORKDIR;
  const agent = body.agent || DEFAULT_AGENT;
  const title = body.title || "bridge session";

  let sessionID = null;
  let reused = false;
  let baselineIds = new Set();
  let clientClosed = false;

  const onClose = () => {
    if (res.writableEnded || res.destroyed) return;
    clientClosed = true;
    if (sessionID) interruptSession(sessionID);
  };
  res.on("close", onClose);

  try {
    const created = await sessionFor(key, { model, agent, directory, title });
    sessionID = created.id;
    reused = created.reused;

    let prompt;
    if (reused && hist) {
      const latest = lastUserMessage(messages);
      prompt = fitSinglePrompt(latest, budget);
    } else {
      prompt = buildPrompt(messages, budget).prompt;
    }
    if (!prompt.trim()) {
      throw httpError(400, "empty prompt", "invalid_request_error", "empty_prompt");
    }

    // Establish a turn boundary before prompting. Without this, a reused
    // session would replay the previous assistant answer while waiting for the
    // new one, and an old idle message would end the stream too early.
    try {
      if (reused) {
        baselineIds = new Set((await listMessages(sessionID)).map((m) => m.id));
      }
      await sendPrompt(sessionID, prompt);
    } catch (err) {
      // OpenCode may have restarted and lost the session. Recreate it once.
      if (err.status !== 404) throw err;
      sessions.delete(key);
      const fresh = await createSession({ model, agent, directory, title });
      sessionID = fresh.id;
      reused = false;
      baselineIds = new Set();
      if (key) {
        sessions.set(key, {
          id: fresh.id,
          model,
          agent,
          directory,
          lastUsed: Date.now(),
        });
      }
      if (hist) prompt = buildPrompt(messages, budget).prompt;
      await sendPrompt(sessionID, prompt);
    }

    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const id = `chatcmpl_${Date.now()}`;
      const created_ = Math.floor(Date.now() / 1000);
      const sendChunk = (delta, finish = null, extra = {}) =>
        sse(
          res,
          null,
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: created_,
            model: modelId(model),
            choices: finish
              ? [{ index: 0, delta, finish_reason: finish }]
              : [{ index: 0, delta, finish_reason: null }],
            ...extra,
          }),
        );

      sendChunk({ role: "assistant", content: "" });

      let sentText = "";
      let finalList = [];
      let truncated = false;
      let waitError = null;
      let done = false;
      let doneAt = 0;

      const waiter = waitIdle(sessionID).then(
        () => {
          done = true;
        },
        (err) => {
          waitError = err;
          done = true;
        },
      );

      const deadline = Date.now() + REQUEST_TIMEOUT_MS;

      while (true) {
        if (clientClosed) {
          await interruptSession(sessionID);
          break;
        }

        const list = await listMessages(sessionID);
        finalList = list;

        let text = turnText(list, baselineIds);
        if (maxOut !== null) {
          const cut = truncateHeadToTokens(text, maxOut);
          text = cut.text;
          truncated = cut.truncated;
        }
        if (text.length > sentText.length) {
          const delta = text.slice(sentText.length);
          sentText = text;
          sendChunk({ content: delta });
        }

        if (truncated) {
          await interruptSession(sessionID);
          break;
        }
        if (done) {
          if (!doneAt) doneAt = Date.now();
          // waitIdle can occasionally resolve before the first assistant
          // message is persisted. Give it a short grace period.
          if (
            turnAssistants(list, baselineIds).length ||
            isTurnIdle(list, baselineIds) ||
            Date.now() - doneAt > 5000
          ) {
            break;
          }
        }
        if (isTurnIdle(list, baselineIds)) break;
        if (Date.now() > deadline) {
          waitError = httpError(504, "request timed out while waiting for OpenCode", "upstream_timeout");
          await interruptSession(sessionID);
          break;
        }
        await sleep(300);
      }

      if (!clientClosed) await waiter;

      // Final sweep for anything that arrived after the loop's last poll. Do
      // this even after truncation, so usage reflects the upstream turn.
      if (!clientClosed) {
        const list = await listMessages(sessionID);
        finalList = list;
        if (!truncated) {
          let text = turnText(list, baselineIds);
          if (maxOut !== null) {
            const cut = truncateHeadToTokens(text, maxOut);
            text = cut.text;
            truncated = cut.truncated;
          }
          if (text.length > sentText.length) {
            const delta = text.slice(sentText.length);
            sentText = text;
            sendChunk({ content: delta });
          }
        }
      }

      const upstreamError = assistantError(finalList, baselineIds);
      if (upstreamError && !sentText) {
        const message = structuredErrorMessage(upstreamError);
        sse(res, null, JSON.stringify({ error: { message, type: "upstream_error" } }));
        sse(res, null, "[DONE]");
        if (!res.writableEnded) res.end();
        return;
      }

      if (waitError && !sentText) {
        const message = waitError.message || "OpenCode request failed";
        sse(res, null, JSON.stringify({ error: { message, type: waitError.type ?? "upstream_error" } }));
        sse(res, null, "[DONE]");
        if (!res.writableEnded) res.end();
        return;
      }

      const last = lastTurnAssistant(finalList, baselineIds);
      sendChunk({}, finishReason(last, truncated));

      sse(
        res,
        null,
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: created_,
          model: modelId(model),
          choices: [],
          usage: usageOfTurn(finalList, baselineIds),
        }),
      );
      sse(res, null, "[DONE]");
      if (!res.writableEnded) res.end();
      return;
    }

    try {
      await waitIdle(sessionID);
    } catch (err) {
      await interruptSession(sessionID);
      throw err;
    }

    const list = await listMessages(sessionID);
    const upstreamError = assistantError(list, baselineIds);
    if (upstreamError) throwAssistantError(upstreamError);

    let text = turnText(list, baselineIds);
    let truncated = false;
    if (maxOut !== null) {
      const cut = truncateHeadToTokens(text, maxOut);
      text = cut.text;
      truncated = cut.truncated;
      if (truncated) await interruptSession(sessionID);
    }

    const last = lastTurnAssistant(list, baselineIds);

    json(res, 200, {
      id: `chatcmpl_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId(model),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: finishReason(last, truncated),
        },
      ],
      usage: usageOfTurn(list, baselineIds),
      opencode: {
        session_id: sessionID,
        reused,
        model: modelKey(model),
        prompt_tokens_estimate: estimateTokens(prompt),
        prompt_tokens_budget: Number.isFinite(budget) ? budget : null,
      },
    });
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, err);
    } else {
      if (!res.writableEnded) {
        try {
          sse(res, null, JSON.stringify({ error: { message: err.message } }));
          sse(res, null, "[DONE]");
        } catch {}
        res.end();
      }
    }
  } finally {
    res.off("close", onClose);
    // Stateless calls (and streaming calls, which used to leak) are cleaned up.
    if (!key && sessionID) deleteSession(sessionID);
  }
}

const server = http.createServer(async (req, res) => {
  try {
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
            .map((m) => {
              const context = m.limit?.context ?? null;
              const output = m.limit?.output ?? null;
              return {
                id: modelId(m),
                object: "model",
                created: Math.floor((m.time?.released ?? Date.now()) / 1000),
                owned_by: m.providerID,
                name: m.name,
                // Keep the old field for compatibility, and expose the full
                // limit object used by OpenCode/OpenAI-compatible clients.
                context,
                context_length: context,
                max_output_tokens: output,
                limit:
                  context || output
                    ? {
                        ...(Number.isFinite(m.limit?.input) ? { input: m.limit.input } : {}),
                        context,
                        output,
                      }
                    : undefined,
                capabilities: m.capabilities,
                variants: Array.isArray(m.variants)
                  ? m.variants.map((variant) => variant.id)
                  : undefined,
              };
            }),
        });
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        throw httpError(400, err.message, "invalid_request_error");
      }
      return await handleChat(req, res, body);
    }

    json(res, 404, { error: { message: "not found" } });
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
    else if (!res.writableEnded) res.end();
  }
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
    `  ${c.green}➜${c.reset} Context   ${MAX_PROMPT_TOKENS > 0 ? `${MAX_PROMPT_TOKENS} tokens max` : `model limit − ${CONTEXT_OVERHEAD_TOKENS} overhead`}`,
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
