<div align="center">

<img src="assets/banner.svg" alt="o2api" width="100%" />

<h1>o2api</h1>

<p><strong>OpenCode'u OpenAI-uyumlu bir API'ye çevir.</strong><br/>
Tek komut. Sıfır bağımlılık. Mevcut araçların olduğu gibi çalışır.</p>

</div>

> 🇬🇧 English: [README.md](README.md)

---

## ✨ Nedir?

Çalışan bir **OpenCode sunucusunun** önüne temiz bir OpenAI-uyumlu HTTP API koyar.
Taklit yok: OpenCode'un kendi API'sini (session, prompt, message) kullanır.

```text
 uygulaman / SDK / agent
          │  POST /v1/chat/completions
          ▼
   ┌─────────────────┐
   │  o2api   │  ← tek dosya, bağımlılık yok
   └────────┬────────┘
            │  OpenCode HTTP API (Basic auth)
            ▼
   ┌─────────────────┐
   │  OpenCode       │  oturum · prompt · araçlar · modeller
   └────────┬────────┘
            ▼
   istediğin sağlayıcı: free · Go · BYOK · yerel
```

---

## 🚀 Hızlı başlangıç

**Gereksinim:** OpenCode v2 çalışıyor + Node.js ≥ 22

```bash
npx o2api
# ➜ http://127.0.0.1:8787/v1
```

veya:

```bash
git clone https://github.com/Tandarke12345560/o2api.git
cd o2api && node server.mjs
```

İlk istek:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"flint-40b-free","messages":[{"role":"user","content":"Merhaba"}]}'
```

Python SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
print(client.chat.completions.create(
    model="flint-40b-free",
    messages=[{"role": "user", "content": "Merhaba"}],
).choices[0].message.content)
```

---

## 🧞 Tek komut (alias)

```bash
./install.sh                                    # /usr/local/bin/o2api
npm i -g .                                      # global npm
echo "alias o2api='node $PWD/server.mjs'" >> ~/.bashrc   # alias
```

Sonrası:

```bash
o2api --port 8080 --key sk-local
```

---

## 🔌 Uçlar

| Metot | Yol | Açıklama |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (stream + normal) |
| `GET` | `/v1/models` | OpenCode'daki modeller |
| `GET` | `/health` | Upstream durumu + sürüm |

---

## ⚙️ Ayarlar

| Bayrak | Env | Varsayılan | Açıklama |
|---|---|---|---|
| `-p, --port` | `PORT` | `8787` | Port |
| `-H, --host` | `HOST` | `127.0.0.1` | Bind adresi (`0.0.0.0` = LAN) |
| `-k, --key` | `BRIDGE_API_KEY` | — | `Authorization: Bearer …` zorunlu |
| `-m, --model` | `DEFAULT_MODEL` | ilk model | Varsayılan model |
| `-a, --agent` | `DEFAULT_AGENT` | `build` | `build` veya `plan` |
| `-d, --workdir` | `WORKDIR` | cwd | Ajanın çalışma dizini |
| `-u, --url` | `OPENCODE_URL` | `http://127.0.0.1:49374` | OpenCode adresi |
| `--password` | `OPENCODE_PASSWORD` | `service.json` | Servis şifresi |
| `--cors` | `CORS_ORIGINS` | — | API'yi çağırabilecek tarayıcı origin'leri (virgüllü) |
| `--allowed-host` | `ALLOWED_HOSTS` | loopback + yerel IP'ler | Kabul edilecek ek `Host` başlıkları |
| `--max-prompt-tokens` | `MAX_PROMPT_TOKENS` | `0` (model bağlamı) | Gönderilen prompt için üst token sınırı |
| `--context-overhead` | `CONTEXT_OVERHEAD_TOKENS` | `8192` | OpenCode sistem prompt'u/araçları için ayrılan token |
| `--timeout` | `REQUEST_TIMEOUT` | `600` | İstek zaman aşımı (saniye) |
| `--session-ttl` | `SESSION_TTL` | `3600` | `x-session-id` oturumlarının boşta kalma ömrü (saniye) |

```bash
o2api --help
```

---

## 🔁 Çok turlu konuşma

Varsayılan olarak her istek bağımsızdır. Oturumu sürdürmek için:

```bash
curl ... -H 'x-session-id: sohbet-1' ...
```

Aynı anahtarla gelen sonraki istekte sadece yeni mesaj gönderilir; geçmiş OpenCode'ta kalır.
Boşta kalan oturumlar varsayılan olarak 1 saat sonra silinir (`--session-ttl`). Aynı oturumda
`model` veya `agent` değiştirirsen köprü OpenCode oturumunu yerinde günceller.

---

## 🧮 Token limitleri

Köprü, her modelin gerçek `limit.context` / `limit.output` değerlerini OpenCode'dan okur ve
`GET /v1/models` üzerinden yayınlar:

```json
{
  "id": "flint-40b-free",
  "context": 262144,
  "max_output_tokens": 65536,
  "limit": { "context": 262144, "output": 65536 }
}
```

İstekler şöyle sınır içinde tutulur:

- **`max_tokens` / `max_completion_tokens` uygulanır.** Normal yanıtlar kesilir ve
  `finish_reason: "length"` döner; stream ise sınıra gelince OpenCode turunu durdurur, böylece
  kalan üretim için kota harcanmaz.
- **Uzun prompt'lar reddedilmez, kırpılır.** Önce eski mesajlar atılır, en yeni kullanıcı mesajı
  korunur ve kaç mesajın atıldığını söyleyen küçük bir `[o2api]` sistem notu eklenir.
- **OpenCode'un kendi prompt'u için pay ayrılır.** `--context-overhead` (varsayılan `8192`
  token) ajan sistem prompt'u ve araç tanımları için ayrılır. `--max-prompt-tokens` ile modelden
  bağımsız sert bir sınır koyabilirsin.
- **Upstream hataları görünür olur.** OpenCode'tan gelen model/bağlam hatası boş bir `200` yerine
  OpenAI biçiminde `{ "error": { ... } }` olarak döner.

Köprüyü başka bir OpenCode örneğinde sağlayıcı olarak kullanacaksan, o sağlayıcının model
ayarına gerçek `limit.context` ve `limit.output` değerlerini kopyala. Aksi hâlde OpenCode
200k/32k varsayılanını kullanır ve alttaki modelin kabul edemeyeceği istekler gönderebilir.

---

## 🔐 Güvenlik

- Varsayılan olarak **sadece localhost**.
- `--host 0.0.0.0` kullanacaksan **mutlaka `--key`** ver; anahtar yoksa sunucu açılmayı reddeder.
- İnternete açma; gerekiyorsa reverse proxy + TLS + rate limit.
- Şifre `~/.config/opencode/service.json`'dan okunur, dışarı çıkmaz.

---

## ⚠️ Sınırlar

- **Ajan API'si, saf chat değil** — araç çağrıları istemciye aktarılmaz.
- **~5k token taban** — her istek OpenCode sistem prompt'unu taşır. Geçmiş kırpılırken 8k token
  ayrılır; ajanların büyük talimatları varsa `--context-overhead` değerini artır.
- **`max_tokens` köprü tarafında uygulanır.** OpenCode prompt API'sinde istek başına çıktı sınırı
  yoktur; köprü metni keser ve turu durdurur. Sağlayıcı, durdurmadan önce üretilen token'ları
  (özellikle reasoning) yine de faturalandırabilir.
- **Streaming 300 ms** dilimlerle (polling).
- **İzinler** OpenCode yapılandırmasına tabi; `ask` kuralı isteği bekletir (veya `--timeout` devreye girer).
- **Sağlayıcı limitleri** aynen geçerli.

---

## ⚖️ Sorumluluk reddi

> **o2api'yi kullanmadan önce oku.** Tam metin: [DISCLAIMER.md](DISCLAIMER.md)

- OpenCode, Anomaly, Alibaba, Qwen, OpenAI, Anthropic, Google veya herhangi bir model sağlayıcısıyla
  **bağlantılı değildir**. Tüm markalar sahiplerine aittir.
- **Köprü, kaçış yolu değil.** o2api, **senin** çalıştırdığın OpenCode sunucusunun resmî HTTP API'sini
  çağırır. Faturalandırmayı, kotayı, hız limitini veya erişim kontrolünü **atlatmaz**; istemci taklidi
  yapmaz, hesap paylaşmaz.
- **Uyum sorumluluğu sende:** OpenCode kullanım şartları, bağladığın sağlayıcıların şartları ve
  yürürlükteki mevzuat (KVKK/GDPR) — modele veri gönderirken bunlara uymak senin sorumluluğunda.
- **Kurulumu güvene al.** Varsayılan localhost; ağa açmadan önce `--key` kullan; internete TLS,
  kimlik doğrulama ve hız limiti olmadan açma.
- **Garanti yok.** [Apache 2.0 Lisansı](LICENSE) kapsamında "olduğu gibi" sunulur. Yazarlar; hesap kapanması,
  kota tükenmesi, model çıktısı, veri kaybı veya yanlış yapılandırmadan doğan güvenlik olaylarından
  sorumlu değildir.

---

## 📄 Lisans

[Apache License 2.0](LICENSE) © katkıda bulunanlar — ayrıca [NOTICE](NOTICE).

MIT yerine bilinçli olarak Apache 2.0 seçildi: **açık patent lisansı** ve **patent misilleme maddesi**
içerir. Şirketlerin projeyi içeride kullanabilmesi için genelde aradığı koruma budur.

OpenCode ayrı bir projedir; kendi lisansı ve kullanım şartları geçerlidir.
