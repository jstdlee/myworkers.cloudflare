# Cloudflare Workers Suite (`myworkers.cloudflare`)

Unified Cloudflare Workers repository featuring **Worker Board + Free-Tier Quota Guard (`uptime.worker.js`)**, **Telco Downdetector (`downdetector.worker.js`)**, **SOS Relay (`sos.worker.js`)**, and **Chat Tutor (`chatofs.worker.js`)**.

---

## 1. `uptime.worker.js` — Unified Worker Board & Free-Tier Quota Circuit-Breaker

Single-page, HTTP Basic Auth-protected dashboard combining:

1. **Free-Tier Daily Quota Progress & 80% Auto Circuit-Breaker (Stateless, 0 KV writes)**:
   - Tracks 6 Cloudflare Free-Tier categories in real time via GraphQL Analytics:
     - **Workers AI**: `10,000 Neurons/day` free (`trip @ 8,000` -> auto-locks AI Gateways to `$0.001` & `1 req/24h`)
     - **D1 Database**: `5,000,000 rows read/day` (`trip @ 4M`) & `100,000 rows written/day` (`trip @ 80k` -> auto-disables non-critical high-D1 Workers)
     - **R2 Storage**: `33,000 Class A/day` (`trip @ 25k`) & `250,000 Class B/day` (`trip @ 200k` -> auto-disables non-critical R2 Workers)
     - **Queues**: `33,000 ops/day` (`trip @ 25k`)
     - **KV & Durable Objects**: `100,000 KV reads/day` (`trip @ 80k`), `1,000 KV writes/day` (`trip @ 800`), `100,000 DO reqs/day` (`trip @ 80k`)
     - **Workers & Mail**: `100,000 Worker reqs/day` (`trip @ 80k`), `100 outbound mails/day` (`trip @ 80`)
   - **Hourly Auto-Trigger**: Called at minute `:00` via Service Binding (`POST /api/quota/check` with `X-Guard-Secret` header), keeping `sos2me`, `sgbus`, and `uptime` protected while automatically tripping non-critical runaway Workers at 80%.

2. **All-Workers Status, Traffic, LLM & Auth Audit Dashboard**:
   - Lists every Worker in the account(s) with live HTTP probe status (`up`, `down`, `disabled`).
   - Audits authentication & exposure (`Password`, `Token`, `Cloudflare Access`, `Public`, `Weak auth`, `No URL`).
   - Scans Worker bundles and bindings for **LLM usage** (`Workers AI`, `AI Gateway`, OpenAI/Anthropic/etc.), **data stores** (`D1`, `R2`, `KV`, `DO`), and **auth primitives** (`Basic`, `Bearer`, `timingSafeEqual`, `Cf-Access-Jwt-Assertion`, `/api/auth`, `HttpOnly`, `X-Guard-Secret`).
   - Computes a heuristic **Privacy & Quota Risk** rating (`low`, `medium`, `high`, `critical`) with actionable explanations.

### Required Bindings / Secrets for `uptime`
- `CF_API_TOKEN` (`secret_text`): Cloudflare API Token (Account Analytics Read, Workers Scripts Edit, AI Gateway Edit)
- `DASH_PASSWORD` (`secret_text`): HTTP Basic Auth password for browser login
- `GUARD_SECRET` (`secret_text`): Shared secret for internal hourly Service Binding trigger (`X-Guard-Secret`) and fallback Basic Auth login
- `TOKEN_KEY` (`secret_text`, optional): Encryption key for multi-account saved tokens in `STORE`
- `STORE` (`kv_namespace`, optional): Used only if saving extra multi-account tokens via `/api/tokens` (Quota Guard itself is 100% stateless in memory)

---

## 2. Other Workers in This Repository

- **`chatofs.worker.js`**: Basic-authenticated interactive learning tutor interface (`CHAT_USERNAME`, `CHAT_PASSWORD`, `DIFY_CHATBOT_URL`).
- **`downdetector.worker.js`**: Lightweight telco uptime and outage status monitor.
- **`sos.worker.js`**: Minimal rate-limited message relay page.

---

## License

MIT License — see [LICENSE](LICENSE).
