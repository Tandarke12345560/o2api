# Disclaimer / Sorumluluk Reddi

> **Read this before using o2api. / o2api'yi kullanmadan önce okuyun.**

## English

### 1. No affiliation

`o2api` is an independent, community project. It is **not affiliated with, endorsed by, or
sponsored by** OpenCode, Anomaly, Alibaba, Qwen, OpenAI, Anthropic, Google, or any other model
provider. All product names, logos, and trademarks are the property of their respective owners
and are used only for identification purposes.

### 2. What this software does — and does not do

`o2api` is a local adapter. It calls the **official HTTP API of an OpenCode server that you
already run and control**, and re-exposes the result in the OpenAI Chat Completions format.

It **does not**:

- bypass billing, quotas, rate limits, or access controls;
- impersonate a client, spoof credentials, or share accounts;
- unlock any feature you are not already entitled to.

If your OpenCode instance has no access to a model, `o2api` does not give you access to it. Using
this project to evade a provider's terms, quotas, or restrictions is **not** an intended use and
is **not** supported.

### 3. Your responsibility

You are solely responsible for:

- complying with the **OpenCode license and terms of service**, and with the terms of every model
  provider you connect through OpenCode;
- complying with applicable laws, including data protection law (e.g. GDPR, KVKK) when sending
  personal data through a model;
- securing your installation: bind to localhost by default, set an API key when exposing the
  service on a network, and never publish it to the public internet without TLS, authentication,
  and rate limiting;
- reviewing the output of any AI system before relying on it.

### 4. No warranty

The software is provided **"as is"**, without warranty of any kind, express or implied, including
but not limited to the warranties of merchantability, fitness for a particular purpose, and
non-infringement. See the [Apache License 2.0](LICENSE).

### 5. Limitation of liability

To the maximum extent permitted by law, the authors and contributors are **not liable** for any
direct, indirect, incidental, special, consequential, or punitive damages, or for any loss of
data, profits, revenue, accounts, or access, arising from the use of or inability to use this
software — including account suspension, quota exhaustion, model output, or security incidents
resulting from misconfiguration.

### 6. Privacy

`o2api` itself has **no telemetry** and stores nothing beyond temporary session identifiers in
memory. Your prompts and their responses pass through your local OpenCode server and on to
whichever model provider you have configured — their retention and training policies apply. The
OpenCode service password is read from your local configuration and is only sent to your own
OpenCode server.

---

## Türkçe

### 1. Bağlantı yok

`o2api` bağımsız bir topluluk projesidir. OpenCode, Anomaly, Alibaba, Qwen, OpenAI, Anthropic,
Google veya herhangi bir model sağlayıcısıyla **bağlantılı, onlar tarafından desteklenen veya
sponsorlu değildir**. Tüm ürün adları, logolar ve markalar ilgili sahiplerine aittir; yalnızca
tanımlama amacıyla kullanılmıştır.

### 2. Ne yapar, ne yapmaz

`o2api` yerel bir adaptördür. **Hâlihazırda çalıştırdığın ve kontrol ettiğin bir OpenCode
sunucusunun resmî HTTP API'sini** çağırır ve sonucu OpenAI Chat Completions formatında sunar.

**Yapmaz:**

- faturalandırmayı, kotayı, hız limitini veya erişim kontrolünü atlatmaz;
- istemci taklidi yapmaz, kimlik bilgisi sahtelemaz, hesap paylaşmaz;
- hakkın olmayan bir özelliği açmaz.

OpenCode örneğinde bir modele erişim yoksa `o2api` sana o erişimi vermez. Bu projeyi sağlayıcı
şartlarını, kotaları veya kısıtları aşmak için kullanmak **amaçlanan kullanım değildir** ve
**desteklenmez**.

### 3. Sorumluluk sende

Aşağıdakilerden tek başına sen sorumlusun:

- **OpenCode lisansı ve kullanım şartlarına** ve OpenCode üzerinden bağladığın her model
  sağlayıcısının şartlarına uymak;
- modele kişisel veri gönderirken yürürlükteki mevzuata (KVKK, GDPR vb.) uymak;
- kurulumu güvenli tutmak: varsayılan olarak localhost'a bağlı bırakmak, ağa açarken API anahtarı
  koymak ve internete TLS + kimlik doğrulama + hız limiti olmadan açmamak;
- bir yapay zekâ sisteminin çıktısına güvenmeden önce onu gözden geçirmek.

### 4. Garanti yok

Yazılım **"olduğu gibi"** sunulur; satılabilirlik, belirli bir amaca uygunluk ve ihlal etmeme
dahil olmak üzere açık veya zımni hiçbir garanti verilmez. Bkz. [Apache 2.0 Lisansı](LICENSE).

### 5. Sorumluluğun sınırlandırılması

Yasaların izin verdiği azami ölçüde, yazarlar ve katkıda bulunanlar; bu yazılımın kullanımından
veya kullanılamamasından doğan doğrudan, dolaylı, arızi, özel, sonuçsal veya cezai zararlardan ya
da veri, kâr, gelir, hesap veya erişim kaybından — **hesap askıya alınması, kota tükenmesi, model
çıktısı veya yanlış yapılandırmadan kaynaklanan güvenlik olayları dahil** — **sorumlu değildir**.

### 6. Gizlilik

`o2api`'nin **telemetrisi yoktur** ve bellekteki geçici oturum kimlikleri dışında hiçbir şey
saklamaz. Prompt'lar ve yanıtlar yerel OpenCode sunucundan geçip yapılandırdığın model
sağlayıcısına gider — o sağlayıcının saklama ve eğitim politikaları geçerlidir. OpenCode servis
şifresi yerel yapılandırmandan okunur ve yalnızca kendi OpenCode sunucuna gönderilir.
