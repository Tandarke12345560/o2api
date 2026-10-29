# Using the bridge from other agents

The bridge speaks **OpenAI Chat Completions**. Any tool that accepts a custom
OpenAI base URL works.

## Claude Code

Claude Code talks the **Anthropic Messages** API (`/v1/messages`), which the
bridge does not implement yet (see the roadmap). Options today:

1. **Run Claude Code through a translation gateway** that exposes
   `/v1/messages` and forwards OpenAI-format requests.
2. **Add `/v1/messages` to the bridge** (welcome PR): map `system` + `messages`
   to the same prompt flow and wrap the reply in an Anthropic `message` object.
3. If your goal is *Claude Code models inside OpenCode*, use OpenCode's own
   `/connect` instead — no bridge needed.

## Codex / Continue / Cursor / n8n / LangChain

Point the OpenAI base URL at the bridge:

```text
Base URL : http://127.0.0.1:8787/v1
API key  : not-needed          (or the value of --key)
Model    : any id from GET /v1/models
```

## OpenAI SDKs

```python
OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
```

```ts
new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "not-needed" });
```

## Tools that need a reachable host

If the tool runs in Docker or on another machine:

```bash
o2api --host 0.0.0.0 --key "$(openssl rand -hex 24)"
```

Then use `http://<your-lan-ip>:8787/v1` and send the key as a bearer token.
Do not expose the port to the public internet.
