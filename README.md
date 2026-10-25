# Cloudflare Workers Suite (`myworkers.cloudflare`)

Unified Cloudflare Workers repository featuring **Worker Board + Free-Tier Quota Guard (`uptime.worker.js`)**, **Telco Downdetector (`downdetector.worker.js`)**, **SOS Relay (`sos.worker.js`)**, and **Chat Tutor (`chatofs.worker.js`)**.

---

## 1. `uptime.worker.js` — Unified Worker Board & Free-Tier Quota Circuit-Breaker

Single-page, HTTP Basic Auth-protected, mobile-first dashboard combining:

1. **Free-Tier Daily Quota Progress & 80% Auto Circuit-Breaker (Stateless, 0 KV writes)**:
   - Tracks 6 Cloudflare Free-Tier categories in real time via GraphQL Analytics:
     - **Workers AI**: `10,000 Neurons/day` free (`trip @ 8,000` -> auto-locks AI Gateways to `$0.001` & `1 req/24h`)
     - **D1 Database**: `5,000,000 rows read/day` (`trip @ 4M`) & `100,000 rows written/day` (`trip @ 80k` -> auto-disables non-critical high-D1 Workers)
     - **R2 Storage**: `33,000 Class A/day` (`trip @ 25k`) & `250,000 Class B/day` (`trip @ 200k` -> auto-disables non-critical R2 Workers)
     - **Queues**: `33,000 ops/day` (`trip @ 25k`)
     - **KV & Durable Objects**: `100,000 KV reads/day` (`trip @ 80k`), `1,000 KV writes/day` (`trip @ 800`), `100,000 DO reqs/day` (`trip @ 80k`)
     - **Workers & Mail**: `100,000 Worker reqs/day` (`trip @ 80k`), `100 outbound mails/day` (`trip @ 80`)
   - **Hourly Auto-Trigger**: Called at minute `:00` via Service Binding (`POST /api/quota/check` with `X-Guard-Secret` header), keeping `sos2me`, `sgbus`, and `uptime` protected while automatically tripping non-critical runaway Workers at 80%.

2. **Mobile-First Worker Board with Short Names, Quick Link (`↗`) & Detail Drawer**:
   - **Compact 4-Column Main Table** (`table-layout: fixed`, zero horizontal scroll on phones):
     1. **Worker**: Displays only the short Worker name, a compact `↗` external link button to open the live endpoint directly, and an `AI` indicator badge when LLM usage is detected.
     2. **Status**: Live HTTP status pill (`UP`, `OFF`, `DOWN`).
     3. **Auth Posture**: Multi-layer authentication posture pill (`🔒 Root Auth`, `🛡️ Landing+Auth`, `🌐 Public`, `⛔ Off`, `⚠️ Weak`).
     4. **Info**: Risk badge (`low`, `med`, `high`, `crit`) + `›` chevron.
   - **Click-to-Open Detail Modal / Bottom-Sheet**: Clicking any Worker row opens its full detail sheet with clickable custom domain & `workers.dev` URLs, **Authentication & Protection Verification** (Root `GET /` behavior vs. Protected Content/API probe results, code auth primitives, and secret bindings), **Traffic & Bindings** (1d/7d/30d requests & errors, D1/R2/KV/DO/AI bindings, LLM models), and risk analysis.

3. **Multi-Layer Protected-Endpoint Auth Probing (`probe()` & `probeProtectedRoutes()`)**:
   - Distinguishes Workers that require auth directly on `GET /` (`🔒 Root Auth`: `401/403`, `302` to login, or root login gate) from Workers that serve a public `200 OK` SPA landing shell or status badge on `/` while enforcing authentication (`401/403` or `302` login redirect, verified against spoofed Bearer tokens) on their actual data/content/API routes (`🛡️ Landing+Auth`: `/api/messages`, `/api/chat`, `/api/bookmarks`, `/api/images`, `/api/users`, `/api/clef/spar`, `/api/config`, `/api/settings`, `/poll`, `/app`).

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
