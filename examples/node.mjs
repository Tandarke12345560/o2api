// opencode2api — Node example (native fetch, no dependencies)
//   node examples/node.mjs

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787/v1";
const KEY = process.env.BRIDGE_API_KEY;

const headers = { "content-type": "application/json" };
if (KEY) headers.authorization = `Bearer ${KEY}`;

const models = await fetch(`${BASE}/models`, { headers }).then((r) => r.json());
const model = models.data[0].id;
console.log("model:", model, "\n");

const res = await fetch(`${BASE}/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Write a haiku about terminals." }],
  }),
}).then((r) => r.json());

console.log(res.choices[0].message.content);
