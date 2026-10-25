var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// uptime.worker.js
var API = "https://api.cloudflare.com/client/v4";
var UA = "cfboard/1.0 (+https://github.com/jstdlee/myworkers.cloudflare)";
var NAME_RE = /^[A-Za-z0-9_.-]{1,63}$/;
var DAY_CHOICES = [1, 7, 30];

// ---------- Free-Tier Quota Guard & 80% Auto Circuit-Breaker (Stateless) ----------
var QUOTA_LIMITS = {
  aiNeuronsDaily:       { free: 10000,    trip: 8000 },
  d1RowsReadDaily:      { free: 5000000,  trip: 4000000 },
  d1RowsWrittenDaily:   { free: 100000,   trip: 80000 },
  r2ClassADaily:        { free: 33000,    trip: 25000 },
  r2ClassBDaily:        { free: 250000,   trip: 200000 },
  queuesOpsDaily:       { free: 33000,    trip: 25000 },
  kvReadsDaily:         { free: 100000,   trip: 80000 },
  kvWritesDaily:        { free: 1000,     trip: 800 },
  doRequestsDaily:      { free: 100000,   trip: 80000 },
  mailOutboundDaily:    { free: 100,      trip: 80 },
  workersRequestsDaily: { free: 100000,   trip: 80000 }
};

var GATEWAY_NORMAL_CONFIGS = {
  "sgbus-free-cap": { spend24h: 0.06, spend30d: 1.00, rate24h: 120 },
  "default":        { spend24h: 0.01, spend30d: 0.25, rate24h: 30 },
  "sim4options":    { spend24h: 0.01, spend30d: 0.25, rate24h: 25 },
  "sim4director":   { spend24h: 0.01, spend30d: 0.25, rate24h: 25 },
  "5dollar":        { spend24h: 0.01, spend30d: 0.25, rate24h: 25 }
};

var R2_CLASS_A_ACTIONS = new Set([
  "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
  "UploadPart", "UploadPartCopy", "ListBuckets", "ListObjects", "ListMultipartUploads",
  "ListParts", "PutBucket", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration"
]);

var R2_CLASS_B_ACTIONS = new Set([
  "GetObject", "HeadObject", "HeadBucket", "UsageSummary", "GetBucketEncryption",
  "GetBucketCors", "GetBucketLocation", "GetBucketLifecycleConfiguration"
]);

var R2_BUCKET_TO_WORKERS = {
  "clawshare": ["clawshare"],
  "not-safe": ["cfshare"],
  "raindropbookmarks": ["yayabookmarks"]
};

var PROTECTED_CRITICAL_WORKERS = new Set(["sos2me", "sgbus", "uptime"]);

var __memQuota = null;
var __memQuotaTs = 0;
var QUOTA_CACHE_TTL_MS = 10 * 60 * 1000;

function pct(val, limit) {
  if (!limit || limit <= 0) return 0;
  return Number(Math.min(100, (val / limit) * 100).toFixed(1));
}

async function cfApiJson(token, path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(15e3)
  });
  return res.json().catch(() => ({ success: false }));
}

async function syncAiGateways(token, accountId, lockdown = false) {
  const results = [];
  for (const [id, cfg] of Object.entries(GATEWAY_NORMAL_CONFIGS)) {
    const body = {
      cache_invalidate_on_update: true,
      cache_ttl: 3600,
      collect_logs: true,
      rate_limiting_interval: 86400,
      rate_limiting_limit: lockdown ? 1 : cfg.rate24h,
      rate_limiting_technique: "sliding",
      spend_limits: {
        enabled: true,
        rules: [
          {
            id: "daily-free-cap",
            enabled: true,
            limitType: "cost",
            limit: lockdown ? 0.001 : cfg.spend24h,
            window: 86400,
            technique: "sliding"
          },
          {
            id: "monthly-cap",
            enabled: true,
            limitType: "cost",
            limit: lockdown ? 0.001 : cfg.spend30d,
            window: 2592000,
            technique: "sliding"
          }
        ]
      }
    };
    const r = await cfApiJson(token, "/accounts/" + accountId + "/ai-gateway/gateways/" + id, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    results.push({ id, success: Boolean(r.success) });
  }
  return results;
}

async function disableWorkerSubdomain(token, accountId, workerName) {
  if (PROTECTED_CRITICAL_WORKERS.has(workerName)) return { worker: workerName, skipped: true };
  const r = await cfApiJson(token, "/accounts/" + accountId + "/workers/scripts/" + encodeURIComponent(workerName) + "/subdomain", {
    method: "POST",
    body: JSON.stringify({ enabled: false, previews_enabled: false })
  });
  return { worker: workerName, disabled: Boolean(r.success) };
}

async function resolvePrimaryAccount(env) {
  if (env.CF_API_TOKEN) {
    const list = await envAccounts(env);
    if (list.length) return { id: list[0].id, token: env.CF_API_TOKEN };
  }
  const cfg = configAccounts(env);
  if (cfg.length) return { id: cfg[0].id, token: cfg[0].token };
  throw httpError(400, "No Cloudflare API token configured");
}

async function evaluateAndTripQuota(env, options = {}) {
  const { id: accountId, token } = await resolvePrimaryAccount(env);
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const dayStartIso = todayUtc + "T00:00:00Z";
  const nowIso = now.toISOString();

  const query = `
    query($a: String!, $d: Date!, $dt0: Time!, $dt1: Time!) {
      viewer {
        accounts(filter: { accountTag: $a }) {
          ai: aiInferenceAdaptiveGroups(limit: 100, filter: { date_geq: $d, date_leq: $d }) {
            sum { totalNeurons }
          }
          d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: { date_geq: $d, date_leq: $d }) {
            sum { rowsRead rowsWritten }
            dimensions { databaseId }
          }
          r2OpsToday: r2OperationsAdaptiveGroups(limit: 500, filter: { datetime_geq: $dt0, datetime_leq: $dt1 }) {
            sum { requests }
            dimensions { actionType bucketName }
          }
          queues: queueMessageOperationsAdaptiveGroups(limit: 100, filter: { date_geq: $d, date_leq: $d }) {
            count
          }
          kvOps: kvOperationsAdaptiveGroups(limit: 100, filter: { date_geq: $d, date_leq: $d }) {
            sum { requests }
            dimensions { actionType }
          }
          doInv: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { date_geq: $d, date_leq: $d }) {
            sum { requests }
          }
          workers: workersInvocationsAdaptive(limit: 300, filter: { datetime_geq: $dt0, datetime_leq: $dt1 }) {
            sum { requests }
            dimensions { scriptName }
          }
        }
      }
    }
  `;

  const gqlRes = await cfApiJson(token, "/graphql", {
    method: "POST",
    body: JSON.stringify({
      query,
      variables: { a: accountId, d: todayUtc, dt0: dayStartIso, dt1: nowIso }
    })
  });

  const acct = (gqlRes && gqlRes.data && gqlRes.data.viewer && gqlRes.data.viewer.accounts && gqlRes.data.viewer.accounts[0]) || {};

  let aiNeuronsToday = 0;
  for (const row of acct.ai || []) aiNeuronsToday += Number((row.sum && row.sum.totalNeurons) || 0);

  let d1RowsReadToday = 0, d1RowsWrittenToday = 0;
  for (const row of acct.d1 || []) {
    d1RowsReadToday += Number((row.sum && row.sum.rowsRead) || 0);
    d1RowsWrittenToday += Number((row.sum && row.sum.rowsWritten) || 0);
  }

  let r2ClassAToday = 0, r2ClassBToday = 0;
  const r2TodayByBucket = {};
  for (const row of acct.r2OpsToday || []) {
    const reqs = Number((row.sum && row.sum.requests) || 0);
    const act = (row.dimensions && row.dimensions.actionType) || "";
    const bkt = (row.dimensions && row.dimensions.bucketName) || "default";
    if (!r2TodayByBucket[bkt]) r2TodayByBucket[bkt] = { classA: 0, classB: 0 };
    if (R2_CLASS_A_ACTIONS.has(act)) {
      r2ClassAToday += reqs;
      r2TodayByBucket[bkt].classA += reqs;
    } else if (R2_CLASS_B_ACTIONS.has(act)) {
      r2ClassBToday += reqs;
      r2TodayByBucket[bkt].classB += reqs;
    }
  }

  let queuesOpsToday = 0;
  for (const row of acct.queues || []) queuesOpsToday += Number(row.count || 0);

  let kvReadsToday = 0, kvWritesToday = 0;
  for (const row of acct.kvOps || []) {
    const reqs = Number((row.sum && row.sum.requests) || 0);
    const act = String((row.dimensions && row.dimensions.actionType) || "").toLowerCase();
    if (act.includes("read") || act.includes("get")) kvReadsToday += reqs;
    else kvWritesToday += reqs;
  }

  let doRequestsToday = 0;
  for (const row of acct.doInv || []) doRequestsToday += Number((row.sum && row.sum.requests) || 0);

  let workersRequestsToday = 0;
  const workersByScript = {};
  for (const row of acct.workers || []) {
    const reqs = Number((row.sum && row.sum.requests) || 0);
    const s = (row.dimensions && row.dimensions.scriptName) || "unknown";
    workersRequestsToday += reqs;
    workersByScript[s] = (workersByScript[s] || 0) + reqs;
  }
  const mailRelayRequestsToday = workersByScript["sos"] || 0;

  const actionsTaken = [];
  if (options.enforce) {
    if (options.forceLock || (!options.forceUnlock && aiNeuronsToday >= QUOTA_LIMITS.aiNeuronsDaily.trip)) {
      actionsTaken.push({ type: "lock_ai_gateways", results: await syncAiGateways(token, accountId, true) });
    } else if (options.forceUnlock) {
      actionsTaken.push({ type: "unlock_ai_gateways", results: await syncAiGateways(token, accountId, false) });
    }

    if (d1RowsReadToday >= QUOTA_LIMITS.d1RowsReadDaily.trip || d1RowsWrittenToday >= QUOTA_LIMITS.d1RowsWrittenDaily.trip) {
      for (const w of ["sim4director", "sim4options"]) {
        if ((workersByScript[w] || 0) > 0) actionsTaken.push(await disableWorkerSubdomain(token, accountId, w));
      }
    }

    if (r2ClassBToday >= QUOTA_LIMITS.r2ClassBDaily.trip || r2ClassAToday >= QUOTA_LIMITS.r2ClassADaily.trip) {
      for (const [bkt, counts] of Object.entries(r2TodayByBucket)) {
        if (counts.classB >= 100000 || counts.classA >= 15000) {
          for (const w of R2_BUCKET_TO_WORKERS[bkt] || []) {
            actionsTaken.push(await disableWorkerSubdomain(token, accountId, w));
          }
        }
      }
    }

    if (mailRelayRequestsToday >= QUOTA_LIMITS.mailOutboundDaily.trip * 10) {
      actionsTaken.push(await disableWorkerSubdomain(token, accountId, "sos"));
    }

    if (workersRequestsToday >= QUOTA_LIMITS.workersRequestsDaily.trip) {
      for (const [w, reqs] of Object.entries(workersByScript)) {
        if (!PROTECTED_CRITICAL_WORKERS.has(w) && reqs >= 15000) {
          actionsTaken.push(await disableWorkerSubdomain(token, accountId, w));
        }
      }
    }
  }

  const aiPct = pct(aiNeuronsToday, QUOTA_LIMITS.aiNeuronsDaily.free);
  const d1Pct = Math.max(pct(d1RowsReadToday, QUOTA_LIMITS.d1RowsReadDaily.free), pct(d1RowsWrittenToday, QUOTA_LIMITS.d1RowsWrittenDaily.free));
  const r2Pct = Math.max(pct(r2ClassBToday, QUOTA_LIMITS.r2ClassBDaily.free), pct(r2ClassAToday, QUOTA_LIMITS.r2ClassADaily.free));
  const qPct  = pct(queuesOpsToday, QUOTA_LIMITS.queuesOpsDaily.free);
  const kvDoPct = Math.max(
    pct(kvReadsToday, QUOTA_LIMITS.kvReadsDaily.free),
    pct(kvWritesToday, QUOTA_LIMITS.kvWritesDaily.free),
    pct(doRequestsToday, QUOTA_LIMITS.doRequestsDaily.free)
  );
  const wkMailPct = Math.max(
    pct(workersRequestsToday, QUOTA_LIMITS.workersRequestsDaily.free),
    pct(mailRelayRequestsToday, QUOTA_LIMITS.mailOutboundDaily.free * 10)
  );

  const items = [
    {
      label: "Workers AI",
      pct: aiPct,
      detail: Math.round(aiNeuronsToday).toLocaleString() + " / 10,000 Neurons (trip @ 8k · 5 Gateways capped $0.10/24h)"
    },
    {
      label: "D1 Database",
      pct: d1Pct,
      detail: "Read " + d1RowsReadToday.toLocaleString() + " / 5M · Write " + d1RowsWrittenToday.toLocaleString() + " / 100k"
    },
    {
      label: "R2 Storage",
      pct: r2Pct,
      detail: "Class A " + r2ClassAToday.toLocaleString() + " / 33k · Class B " + r2ClassBToday.toLocaleString() + " / 250k"
    },
    {
      label: "Queues",
      pct: qPct,
      detail: queuesOpsToday.toLocaleString() + " / 33,000 ops (trip @ 25k)"
    },
    {
      label: "KV & Durable Objects",
      pct: kvDoPct,
      detail: "KV R " + kvReadsToday.toLocaleString() + "/100k · W " + kvWritesToday.toLocaleString() + "/1k · DO " + doRequestsToday.toLocaleString() + "/100k"
    },
    {
      label: "Workers & Mail",
      pct: wkMailPct,
      detail: "Req " + workersRequestsToday.toLocaleString() + " / 100k · Relay " + mailRelayRequestsToday.toLocaleString() + " / 1k"
    }
  ];

  const anyTripped = Boolean(options.forceLock) || (!options.forceUnlock && items.some((i) => i.pct >= 80));
  __memQuota = {
    ok: true,
    updatedAtSgt: new Date(now.getTime() + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19) + " SGT",
    tripped: anyTripped,
    items,
    actionsTaken
  };
  __memQuotaTs = Date.now();
  return __memQuota;
}

async function getQuotaSnapshot(env, forceRefresh = false) {
  if (forceRefresh || !__memQuota || Date.now() - __memQuotaTs > QUOTA_CACHE_TTL_MS) {
    await evaluateAndTripQuota(env, { enforce: true });
  }
  return __memQuota;
}

var uptime_worker_default = {
  async fetch(request, env) {
    const denied = await authorize(request, env);
    if (denied) return denied;
    const lite = !env.DASH_PASSWORD;
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/tokens") return await tokenApi(request, env, url, lite);
      if (url.pathname === "/api/check" || url.pathname === "/api/quota/check") {
        const forceLock = url.searchParams.get("lock") === "1";
        const forceUnlock = url.searchParams.get("unlock") === "1";
        return json(await evaluateAndTripQuota(env, { enforce: true, forceLock, forceUnlock }));
      }
      if (url.pathname === "/api/quota") {
        const force = url.searchParams.get("refresh") === "1";
        return json(await getQuotaSnapshot(env, force));
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method not allowed" }, 405);
      }
      switch (url.pathname) {
        case "/":
          return new Response(page(), { headers: htmlHeaders() });
        case "/api/config": {
          const { accounts: list, warnings } = await boardAccounts(env, lite);
          return json({
            accounts: list.map((a) => ({ key: a.key, name: a.name })),
            days: defaultDays(env),
            lite,
            manage: lite ? null : { store: !!env.STORE },
            warnings
          });
        }
        case "/api/inventory":
          return json(await inventory(await pickAccount(env, url, lite), env, lite));
        case "/api/worker": {
          const acc = await pickAccount(env, url, lite);
          return json(await workerDetail(acc, scriptName(url), env, lite));
        }
        case "/api/usage":
          if (lite) return json({ error: "not found" }, 404);
          return json(await usage(await pickAccount(env, url, lite), Number(url.searchParams.get("days"))));
        case "/api/scan": {
          if (lite) return json({ error: "not found" }, 404);
          const acc = await pickAccount(env, url, lite);
          return json(await scan(acc, scriptName(url), url.searchParams.get("v") || "", env));
        }
        case "/api/probe": {
          const target = url.searchParams.get("url") || "";
          const want = await sign(env, target);
          if (!await safeEqual(url.searchParams.get("sig") || "", want)) throw httpError(403, "url not on the board");
          return json(await probe(target));
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json({ error: e.message || "error" }, e.status || 500);
    }
  }
};
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
__name(httpError, "httpError");
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
__name(json, "json");
function htmlHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"
  };
}
__name(htmlHeaders, "htmlHeaders");
async function authorize(request, env) {
  if (!env.DASH_PASSWORD && !env.GUARD_SECRET) return null;
  const guardHdr = request.headers.get("X-Guard-Secret") || "";
  if (env.GUARD_SECRET && guardHdr && await safeEqual(guardHdr, env.GUARD_SECRET)) return null;
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    let pass = "";
    try {
      const decoded = atob(header.slice(6));
      pass = decoded.slice(decoded.indexOf(":") + 1);
    } catch {
    }
    if (env.DASH_PASSWORD && await safeEqual(pass, env.DASH_PASSWORD)) return null;
    if (env.GUARD_SECRET && await safeEqual(pass, env.GUARD_SECRET)) return null;
  }
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Worker Board", charset="UTF-8"', "Cache-Control": "no-store" }
  });
}
__name(authorize, "authorize");
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}
__name(safeEqual, "safeEqual");
async function sign(env, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode("probe:" + signSecret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sign, "sign");
function signSecret(env) {
  return env.TOKEN_KEY || env.DASH_PASSWORD || env.CF_API_TOKEN || env.ACCOUNTS || "";
}
__name(signSecret, "signSecret");
var ID32 = /^[a-f0-9]{32}$/;
var MAX_TOKENS = 20;
var MAX_ACCOUNTS_PER_TOKEN = 5;
function configAccounts(env) {
  if (!env.ACCOUNTS) return [];
  let list;
  try {
    list = JSON.parse(env.ACCOUNTS);
  } catch {
    throw httpError(500, "ACCOUNTS is not valid JSON");
  }
  if (!Array.isArray(list)) throw httpError(500, "ACCOUNTS must be a JSON list");
  return list.map((a, i) => {
    if (!a || !ID32.test(String(a.id)) || !a.token) throw httpError(500, "ACCOUNTS[" + i + "] needs a 32-character id and a token");
    return { name: String(a.name || String(a.id).slice(0, 6)), id: String(a.id), token: String(a.token) };
  });
}
__name(configAccounts, "configAccounts");
async function discoverAccounts(token) {
  const r = await cfGet({ token }, "/accounts?per_page=50");
  return (r.result || []).filter((a) => ID32.test(String(a.id))).map((a) => ({ id: a.id, name: String(a.name || a.id.slice(0, 6)) }));
}
__name(discoverAccounts, "discoverAccounts");
var envMemo = null;
async function envAccounts(env) {
  if (!env.CF_API_TOKEN) return [];
  if (env.CF_ACCOUNT_ID) return [{ id: String(env.CF_ACCOUNT_ID), name: "main" }];
  if (envMemo && Date.now() - envMemo.at < 3e5) return envMemo.list;
  const list = await discoverAccounts(env.CF_API_TOKEN);
  envMemo = { at: Date.now(), list };
  return list;
}
__name(envAccounts, "envAccounts");
function shown(name, id, lite) {
  return lite && name.includes("@") ? "account " + id.slice(0, 6) : name;
}
__name(shown, "shown");
async function storedTokens(env) {
  if (!env.STORE) return [];
  const out = [];
  let cursor;
  do {
    const r = await env.STORE.list({ prefix: "tok:", cursor });
    for (const k of r.keys) out.push({ id: k.name.slice(4), ...k.metadata || {} });
    cursor = r.list_complete ? void 0 : r.cursor;
  } while (cursor);
  return out;
}
__name(storedTokens, "storedTokens");
async function boardAccounts(env, lite) {
  const out = [];
  const warnings = [];
  const seen = /* @__PURE__ */ new Set();
  const push = /* @__PURE__ */ __name((key, id, name) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ key, name: shown(name, id, lite) });
  }, "push");
  for (const a of configAccounts(env)) push("cfg:" + a.id, a.id, a.name);
  try {
    for (const a of await envAccounts(env)) push("env:" + a.id, a.id, a.name);
  } catch (e) {
    warnings.push("app token: " + e.message);
  }
  try {
    for (const t of await storedTokens(env)) for (const a of t.accounts || []) push("t" + t.id + ":" + a.id, a.id, a.name);
  } catch (e) {
    warnings.push("saved tokens: " + e.message);
  }
  return { accounts: out, warnings: lite && warnings.length ? ["some accounts could not be read"] : warnings };
}
__name(boardAccounts, "boardAccounts");
async function pickAccount(env, url, lite) {
  const m = /^(cfg|env|t[a-f0-9]{16}):([a-f0-9]{32})$/.exec(url.searchParams.get("account") || "");
  if (!m) throw httpError(400, "bad account");
  const [, src, id] = m;
  if (src === "cfg") {
    const a = configAccounts(env).find((x) => x.id === id);
    if (!a) throw httpError(400, "bad account");
    return { ...a, shown: shown(a.name, id, lite) };
  }
  if (src === "env") {
    if (!env.CF_API_TOKEN) throw httpError(400, "bad account");
    const f2 = (await envAccounts(env).catch(() => [])).find((x) => x.id === id);
    const name = f2 ? f2.name : id.slice(0, 6);
    return { id, name, shown: shown(name, id, lite), token: env.CF_API_TOKEN };
  }
  if (!env.STORE) throw httpError(400, "bad account");
  const tid = src.slice(1);
  const rec = await env.STORE.get("tok:" + tid, "json");
  if (!rec) throw httpError(404, "that token was removed");
  const f = (rec.accounts || []).find((x) => x.id === id);
  if (!f) throw httpError(400, "bad account");
  return { id, name: f.name, shown: shown(f.name, id, lite), token: await unseal(env, tid, rec) };
}
__name(pickAccount, "pickAccount");
var keyMemo = /* @__PURE__ */ new Map();
function cipherSecret(env) {
  const s = env.TOKEN_KEY || env.DASH_PASSWORD;
  if (!s) throw httpError(403, "set DASH_PASSWORD or TOKEN_KEY to save tokens");
  return s;
}
__name(cipherSecret, "cipherSecret");
function aesKey(secret) {
  if (!keyMemo.has(secret)) {
    const enc = new TextEncoder();
    keyMemo.set(
      secret,
      crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]).then(
        (base) => crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: enc.encode("cfboard-tokens-v1"), iterations: 1e5, hash: "SHA-256" },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        )
      )
    );
  }
  return keyMemo.get(secret);
}
__name(aesKey, "aesKey");
var b64 = /* @__PURE__ */ __name((u8) => btoa(String.fromCharCode(...u8)), "b64");
var unb64 = /* @__PURE__ */ __name((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)), "unb64");
async function seal(env, id, token) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(cipherSecret(env));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(id) }, key, enc.encode(token)));
  return { iv: b64(iv), ct: b64(ct) };
}
__name(seal, "seal");
async function unseal(env, id, rec) {
  const key = await aesKey(cipherSecret(env));
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(rec.iv), additionalData: new TextEncoder().encode(id) },
      key,
      unb64(rec.ct)
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw httpError(500, "saved token cannot be decrypted (TOKEN_KEY or DASH_PASSWORD changed?)");
  }
}
__name(unseal, "unseal");
async function tokenApi(request, env, url, lite) {
  if (lite) return json({ error: "not found" }, 404);
  const method = request.method;
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (request.headers.get("X-Board") !== "1" || origin && origin !== url.origin) throw httpError(403, "blocked");
  }
  if (method === "GET") {
    const deploy = [];
    const cfg = configAccounts(env);
    if (cfg.length) deploy.push({ via: "ACCOUNTS secret", accounts: cfg.map((a) => a.name) });
    if (env.CF_API_TOKEN) {
      let error = "";
      const list = await envAccounts(env).catch((e) => (error = e.message, []));
      deploy.push({ via: "CF_API_TOKEN secret (this app)", accounts: list.map((a) => a.name), error });
    }
    return json({ store: !!env.STORE, max: MAX_TOKENS, deploy, tokens: await storedTokens(env) });
  }
  if (!env.STORE) throw httpError(400, "bind a KV namespace named STORE to save tokens");
  if (method === "POST") {
    const raw = await request.text();
    if (raw.length > 4096) throw httpError(413, "body too large");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw httpError(400, "bad JSON");
    }
    return json(await addToken(env, body || {}));
  }
  if (method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!/^[a-f0-9]{16}$/.test(id)) throw httpError(400, "bad id");
    await env.STORE.delete("tok:" + id);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}
__name(tokenApi, "tokenApi");
async function addToken(env, body) {
  const label = String(body.label || "").trim().slice(0, 40) || "token";
  const token = String(body.token || "").trim();
  const hint = String(body.accountId || "").trim().toLowerCase();
  if (!/^[A-Za-z0-9._~+/=-]{20,300}$/.test(token)) throw httpError(400, "that does not look like an API token");
  if (hint && !ID32.test(hint)) throw httpError(400, "account ID must be 32 hex characters");
  if ((await storedTokens(env)).length >= MAX_TOKENS) throw httpError(400, "token limit reached (" + MAX_TOKENS + ")");
  let accs;
  if (hint) {
    accs = [{ id: hint, name: label }];
  } else {
    accs = await discoverAccounts(token).catch((e) => {
      throw httpError(400, "token check failed: " + e.message);
    });
    if (!accs.length) throw httpError(400, "this token cannot list accounts. Enter the account ID too.");
  }
  const note = [];
  if (accs.length > MAX_ACCOUNTS_PER_TOKEN) {
    note.push("only the first " + MAX_ACCOUNTS_PER_TOKEN + " accounts of this token are saved");
    accs = accs.slice(0, MAX_ACCOUNTS_PER_TOKEN);
  }
  accs = accs.map((a) => ({ id: a.id, name: a.name.slice(0, 30) }));
  for (const a of accs) {
    await cfGet({ token }, "/accounts/" + a.id + "/workers/scripts?per_page=1").catch((e) => {
      if (hint) throw httpError(400, "token cannot read Workers of that account: " + e.message);
      note.push(a.name + ": cannot read Workers (" + e.message + ")");
    });
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  const meta = { label, last4: token.slice(-4), added: (/* @__PURE__ */ new Date()).toISOString(), accounts: accs };
  await env.STORE.put("tok:" + id, JSON.stringify({ ...meta, ...await seal(env, id, token) }), { metadata: meta });
  return { ok: true, id, accounts: accs.map((a) => a.name), notes: note };
}
__name(addToken, "addToken");
function scriptName(url) {
  const name = url.searchParams.get("name") || "";
  if (!NAME_RE.test(name)) throw httpError(400, "bad worker name");
  return name;
}
__name(scriptName, "scriptName");
function defaultDays(env) {
  const d = Number(env.DAYS);
  return DAY_CHOICES.includes(d) ? d : 7;
}
__name(defaultDays, "defaultDays");
function registryFor(env, acc, name) {
  try {
    const reg = JSON.parse(env.REGISTRY || "{}");
    return reg[acc.name + "/" + name] || reg[name] || {};
  } catch {
    return {};
  }
}
__name(registryFor, "registryFor");
async function cfGet(acc, path) {
  const res = await fetch(API + path, {
    headers: { Authorization: "Bearer " + acc.token },
    signal: AbortSignal.timeout(15e3)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success === false) {
    const first = body && body.errors && body.errors[0];
    throw httpError(res.status || 502, first ? first.message : "Cloudflare API " + res.status);
  }
  return body;
}
__name(cfGet, "cfGet");
var sleep = /* @__PURE__ */ __name((ms) => new Promise((r) => setTimeout(r, ms)), "sleep");
function routeUrl(pattern) {
  const p = String(pattern).replace(/^https?:\/\//, "");
  const slash = p.indexOf("/");
  const host = slash === -1 ? p : p.slice(0, slash);
  const path = slash === -1 ? "/" : p.slice(slash);
  if (host.includes("*")) return { url: null, label: pattern, kind: "route" };
  const star = path.indexOf("*");
  const clean = star === -1 ? path : path.slice(0, star) || "/";
  return { url: "https://" + host + (clean.startsWith("/") ? clean : "/" + clean), label: pattern, kind: "route" };
}
__name(routeUrl, "routeUrl");
async function inventory(acc, env, lite) {
  const warnings = [];
  const soft = /* @__PURE__ */ __name((what) => (e) => {
    warnings.push(what + ": " + e.message);
    return null;
  }, "soft");
  const [scripts, sub, domains, zones] = await Promise.all([
    cfGet(acc, "/accounts/" + acc.id + "/workers/scripts"),
    cfGet(acc, "/accounts/" + acc.id + "/workers/subdomain").catch(soft("workers.dev subdomain")),
    cfGet(acc, "/accounts/" + acc.id + "/workers/domains").catch(soft("custom domains")),
    cfGet(acc, "/zones?account.id=" + acc.id + "&per_page=50").catch(soft("zones"))
  ]);
  const zoneList = (zones && zones.result || []).slice(0, 40);
  if (zones && zones.result_info && zones.result_info.total_count > zoneList.length) {
    warnings.push("only the first " + zoneList.length + " zones were checked for routes");
  }
  const routes = [];
  await Promise.all(
    zoneList.map(
      (z) => cfGet(acc, "/zones/" + z.id + "/workers/routes").then((r) => {
        for (const x of r.result || []) if (x.script) routes.push(x);
      }).catch(soft("routes of " + z.name))
    )
  );
  const byName = /* @__PURE__ */ new Map();
  const add = /* @__PURE__ */ __name((name, entry) => {
    if (!name) return;
    const list = byName.get(name) || [];
    if (!list.some((u) => u.label === entry.label)) list.push(entry);
    byName.set(name, list);
  }, "add");
  for (const d of domains && domains.result || []) {
    add(d.service, { url: "https://" + d.hostname + "/", label: d.hostname, kind: "domain" });
  }
  for (const r of routes) add(r.script, routeUrl(r.pattern));
  const subdomain = sub && sub.result && sub.result.subdomain || null;
  const workers = await Promise.all(
    (scripts && scripts.result || []).map(async (s) => {
      const urls = await Promise.all(
        (byName.get(s.id) || []).map(async (u) => u.url ? { ...u, sig: await sign(env, u.url) } : u)
      );
      const devUrl = subdomain ? "https://" + s.id + "." + subdomain + ".workers.dev/" : null;
      return {
        name: s.id,
        modified_on: s.modified_on,
        created_on: s.created_on,
        handlers: lite ? [] : s.handlers || [],
        urls,
        dev: devUrl ? { url: devUrl, label: s.id + "." + subdomain + ".workers.dev", kind: "workers.dev", sig: await sign(env, devUrl) } : null
      };
    })
  );
  return { account: acc.shown || acc.name, subdomain, workers, warnings: lite && warnings.length ? ["some data could not be read"] : warnings };
}
__name(inventory, "inventory");
async function workerDetail(acc, name, env, lite) {
  const base = "/accounts/" + acc.id + "/workers/scripts/" + encodeURIComponent(name);
  const reg = registryFor(env, acc, name);
  const errors = [];
  const [settings, sub, gh] = await Promise.all([
    lite ? null : cfGet(acc, base + "/settings").catch((e) => (errors.push("settings: " + e.message), null)),
    cfGet(acc, base + "/subdomain").catch((e) => (errors.push(lite ? "subdomain" : "subdomain: " + e.message), null)),
    lite ? null : github(env, reg.repo || name).catch(() => null)
  ]);
  const raw = settings && settings.result || {};
  const bindings = (raw.bindings || []).map((b) => ({ name: b.name, type: b.type }));
  return {
    bindings,
    secrets: bindings.filter((b) => b.type === "secret_text").map((b) => b.name),
    tags: raw.tags || [],
    compatibility_date: raw.compatibility_date || null,
    workersDev: sub && sub.result ? { enabled: !!sub.result.enabled, previews: !!sub.result.previews_enabled } : null,
    github: gh,
    override: {
      description: reg.description || "",
      public: !lite && reg.public === true,
      llm: !lite && typeof reg.llm === "boolean" ? reg.llm : null
    },
    errors
  };
}
__name(workerDetail, "workerDetail");
async function github(env, repo) {
  const full = repo.includes("/") ? repo : env.GITHUB_OWNER ? env.GITHUB_OWNER + "/" + repo : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return null;
  const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.Authorization = "Bearer " + env.GITHUB_TOKEN;
  const res = await fetch("https://api.github.com/repos/" + full, { headers, signal: AbortSignal.timeout(8e3) });
  if (!res.ok) return null;
  const j = await res.json();
  return { repo: j.full_name, description: j.description || "", url: j.html_url, private: !!j.private };
}
__name(github, "github");
async function usage(acc, days) {
  if (!DAY_CHOICES.includes(days)) days = 7;
  const to = /* @__PURE__ */ new Date();
  const from = new Date(to.getTime() - days * 864e5);
  const query = "query($a:String!,$f:Time!,$t:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$f,datetime_leq:$t}){sum{requests errors} dimensions{scriptName}}}}}";
  let data;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(API + "/graphql", {
      method: "POST",
      headers: { Authorization: "Bearer " + acc.token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { a: acc.id, f: from.toISOString(), t: to.toISOString() } }),
      signal: AbortSignal.timeout(2e4)
    });
    const j = await res.json().catch(() => null);
    if (j && j.errors && j.errors.length) {
      if (attempt === 0 && /10429|rate limit/i.test(JSON.stringify(j.errors))) {
        await sleep(1500);
        continue;
      }
      throw httpError(502, j.errors[0].message || "GraphQL error");
    }
    if (!res.ok || !j || !j.data) throw httpError(502, "GraphQL HTTP " + res.status);
    data = j.data;
    break;
  }
  const rows = data.viewer.accounts[0] && data.viewer.accounts[0].workersInvocationsAdaptive || [];
  const byScript = {};
  for (const r of rows) {
    const n = r.dimensions.scriptName;
    if (!n || n === "__unknown__") continue;
    const o = byScript[n] = byScript[n] || { requests: 0, errors: 0 };
    o.requests += r.sum.requests || 0;
    o.errors += r.sum.errors || 0;
  }
  return { days, scripts: byScript };
}
__name(usage, "usage");
var LLM_MARKS = [
  ["OpenAI", "api.openai.com"],
  ["Anthropic", "api.anthropic.com"],
  ["Google AI", "generativelanguage.googleapis.com"],
  ["OpenRouter", "openrouter.ai"],
  ["Groq", "api.groq.com"],
  ["xAI", "api.x.ai"],
  ["Mistral", "api.mistral.ai"],
  ["DeepSeek", "api.deepseek.com"],
  ["Together", "api.together.xyz"],
  ["Cohere", "api.cohere."],
  ["Fireworks", "api.fireworks.ai"],
  ["Perplexity", "api.perplexity.ai"],
  ["Replicate", "api.replicate.com"],
  ["Hugging Face", "api-inference.huggingface.co"],
  ["Workers AI REST", "/ai/run"],
  ["AI Gateway", "gateway.ai.cloudflare.com"],
  ["AI Gateway (capped)", "sgbus-free-cap"],
  ["OpenAI-compatible API", "/chat/completions"]
];
var AUTH_MARKS = [
  ["Bearer token", "Bearer "],
  ["Authorization header", "Authorization"],
  ["Basic auth", "WWW-Authenticate"],
  ["constant-time compare", "timingSafeEqual"],
  ["Cloudflare Access JWT", "Cf-Access-Jwt-Assertion"],
  ["Cloudflare Access JWT", "cf-access-jwt-assertion"],
  ["Passcode / Auth endpoint", "/api/auth"],
  ["Session cookie", "HttpOnly"],
  ["Guard secret header", "X-Guard-Secret"]
];
async function scan(acc, name, version, env) {
  if (env.SCAN === "off") return { skipped: true, llm: [], auth: [] };
  const key = "scan:" + acc.id + ":" + name + ":" + version;
  if (env.CACHE && version) {
    const hit = await env.CACHE.get(key, "json").catch(() => null);
    if (hit) return { ...hit, cached: true };
  }
  const res = await fetch(API + "/accounts/" + acc.id + "/workers/scripts/" + encodeURIComponent(name), {
    headers: { Authorization: "Bearer " + acc.token },
    signal: AbortSignal.timeout(2e4)
  });
  if (!res.ok || !res.body) throw httpError(res.status || 502, "script download " + res.status);
  const max = Number(env.SCAN_MAX_BYTES) || 2e6;
  const marks = [
    ...LLM_MARKS.map(([label, m]) => ["llm", label, m]),
    ...AUTH_MARKS.map(([label, m]) => ["auth", label, m])
  ];
  const found = { llm: /* @__PURE__ */ new Set(), auth: /* @__PURE__ */ new Set() };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let bytes = 0;
  let truncated = false;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    const text = tail + decoder.decode(value, { stream: true });
    for (const [kind, label, m] of marks) {
      if (!found[kind].has(label) && text.indexOf(m) !== -1) found[kind].add(label);
    }
    tail = text.slice(-40);
    if (bytes >= max) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const result = { bytes, truncated, llm: [...found.llm], auth: [...found.auth] };
  if (env.CACHE && version) {
    await env.CACHE.put(key, JSON.stringify(result), { expirationTtl: 2592e3 }).catch(() => {
    });
  }
  return result;
}
__name(scan, "scan");
async function readCapped(res, max) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      out += decoder.decode(value, { stream: true });
      if (bytes >= max) {
        await reader.cancel();
        break;
      }
    }
  } catch {
  }
  return out;
}
__name(readCapped, "readCapped");
function loginGate(body, low, type) {
  if (/html/i.test(type) || /<html|<form|<input/.test(low)) {
    if (/<input\b[^>]*\btype\s*=\s*["']?password/.test(low) || /<input\b[^>]*\bautocomplete\s*=\s*["']?(current|new)-password/.test(low)) {
      return "password or token prompt on /";
    }
    const title = (/<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(body) || [, ""])[1];
    const words = /(log\s?in|sign\s?in|password|passcode|access code|authenticat|unlock|verify|登录|登入|密码|口令|访问验证|验证|认证|ログイン|パスワード|로그인|비밀번호)/i;
    const hasForm = /<form\b|<input\b|<button\b/.test(low);
    const authCall = /fetch\(\s*["'`]\/(?:api\/)?(?:auth|login|signin|session|unlock|verify)/.test(low);
    if (words.test(title) && (hasForm || authCall)) return "login page (title: " + title.trim().slice(0, 40) + ")";
    if (authCall && /(password|passcode|token|密码)/.test(low)) return "login script posts to an auth endpoint";
  }
  if (/json/i.test(type) && /"(error|message)"\s*:\s*"[^"]*(unauthori[sz]ed|forbidden|not authenticated|login required|invalid token|missing token|authentication required)/.test(low)) {
    return "JSON body says unauthorized";
  }
  return "";
}
__name(loginGate, "loginGate");
async function probe(target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    throw httpError(400, "bad url");
  }
  if (u.protocol !== "https:") throw httpError(400, "only https is probed");
  const started = Date.now();
  let res;
  try {
    res = await fetch(u.toString(), {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
      signal: AbortSignal.timeout(8e3)
    });
  } catch (e) {
    return { status: 0, ms: Date.now() - started, exposure: "unknown", error: e.name === "TimeoutError" ? "timeout" : "no response" };
  }
  const ms = Date.now() - started;
  const status = res.status;
  const location = res.headers.get("location") || "";
  const www = res.headers.get("www-authenticate") || "";
  const type = res.headers.get("content-type") || "";
  const body = await readCapped(res, 65536);
  const low = body.toLowerCase();
  let exposure = "unknown";
  let hint = "";
  if (status >= 300 && status < 400) {
    if (/cloudflareaccess\.com/i.test(location)) {
      exposure = "access";
      hint = "redirects to Cloudflare Access";
    } else if (/login|signin|sign-in|oauth|sso|auth/i.test(location)) {
      exposure = "password";
      hint = "redirects to a login page";
    } else {
      exposure = "public";
      hint = "redirects to " + (location.length > 80 ? location.slice(0, 80) + "\u2026" : location);
    }
  } else if (status === 401 || status === 403) {
    if (/cloudflareaccess|cf-access/.test(low)) {
      exposure = "access";
      hint = "Cloudflare Access page";
    } else if (/^basic/i.test(www)) {
      exposure = "password";
      hint = "HTTP Basic";
    } else {
      exposure = "token";
      hint = www ? "WWW-Authenticate: " + www.split(" ")[0] : "denies anonymous request";
    }
    try {
      const fake = await fetch(u.toString(), {
        redirect: "manual",
        headers: { "User-Agent": UA, Authorization: "Bearer cfboard-invalid-probe-token" },
        signal: AbortSignal.timeout(8e3)
      });
      if (fake.status >= 200 && fake.status < 300) {
        exposure = "weak";
        hint = "a fake bearer token was accepted";
      }
      await fake.body?.cancel();
    } catch {
    }
  } else if (status >= 200 && status < 300) {
    const gate = loginGate(body, low, type);
    if (gate) {
      exposure = "password";
      hint = gate;
    } else {
      exposure = "public";
    }
  } else if (status === 404 && /error code:\s*1042/i.test(low)) {
    hint = "blocked by Cloudflare (error 1042): same-account Workers URL, cannot probe";
  } else {
    hint = "HTTP " + status + " on /";
  }
  let title = "";
  let metaDescription = "";
  if (status >= 200 && status < 300 && /html/i.test(type)) {
    const t = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(body);
    if (t) title = t[1].replace(/\s+/g, " ").trim();
    const m = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})["']/i.exec(body) || /<meta[^>]+content=["']([^"']{0,300})["'][^>]+name=["']description["']/i.exec(body);
    if (m) metaDescription = m[1].trim();
  }
  return { status, ms, exposure, hint, title, metaDescription };
}
__name(probe, "probe");
function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Worker Board</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="top">
    <div>
      <h1>Worker Board</h1>
      <p class="sub" id="status">Loading\u2026</p>
    </div>
    <div class="ctl">
      <label class="full">Usage window
        <select id="days"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select>
      </label>
      <button id="tokbtn" class="full" type="button" hidden>API tokens</button>
      <button id="reload" type="button">Reload</button>
    </div>
  </div>
  <section id="tok" class="panel" hidden>
    <h2>API tokens</h2>
    <p class="small">Each token loads all Workers of the accounts it can read. Tokens stay on the server, encrypted. The page never gets them back.</p>
    <div id="tok-list"></div>
    <form id="tok-form" autocomplete="off">
      <input id="tok-label" type="text" maxlength="40" placeholder="Label (for example: client A)" aria-label="Label">
      <input id="tok-value" type="password" placeholder="API token" aria-label="API token" autocomplete="new-password" spellcheck="false">
      <input id="tok-acct" type="text" maxlength="32" placeholder="Account ID (only if the token cannot list accounts)" aria-label="Account ID" spellcheck="false">
      <button id="tok-add" type="submit">Add token</button>
    </form>
    <p id="tok-msg" class="small" role="status"></p>
  </section>
  <div id="warn" class="warn" hidden></div>
  <div class="tiles" id="tiles"></div>
  <section id="quota-panel" class="qpanel">
    <div class="qhead">
      <div class="qtitle-wrap">
        <h2>Free-Tier Daily Quota &amp; 80% Auto Circuit-Breaker</h2>
        <span id="qbadge" class="b">Checking…</span>
      </div>
      <div class="qmeta">
        <span id="qtime" class="small">Stateless (0 KV) · Hourly via sos2me</span>
        <button id="qrefresh" type="button" class="qbtn">Check Quota</button>
      </div>
    </div>
    <div id="qgrid" class="qgrid"></div>
  </section>
  <div class="filters">
    <input id="q" type="search" placeholder="Search name, URL, description" aria-label="Search">
    <select id="f-account" aria-label="Account"><option value="">All accounts</option></select>
    <select id="f-expo" aria-label="Exposure">
      <option value="">Any exposure</option>
      <option value="exposed">Exposed (public, weak, reachable)</option>
      <option value="public">Public</option>
      <option value="protected">Protected</option>
      <option value="weak">Weak auth</option>
      <option value="none">No URL</option>
    </select>
    <select id="f-risk" class="full" aria-label="Privacy risk">
      <option value="">Any risk</option>
      <option value="2">High or critical</option>
      <option value="3">Critical</option>
    </select>
    <label class="chk full"><input type="checkbox" id="f-llm"> LLM</label>
    <label class="chk"><input type="checkbox" id="f-down"> Down</label>
    <label class="chk full"><input type="checkbox" id="f-unused"> Unused</label>
  </div>
</header>
<main>
  <div class="scroll">
    <table id="tbl">
      <thead><tr>
        <th data-k="name">Worker</th>
        <th data-k="url">URL</th>
        <th data-k="http">Status</th>
        <th data-k="expo">Protection</th>
        <th data-k="risk" class="full">Privacy risk</th>
        <th data-k="llm" class="full">LLM</th>
        <th data-k="req" class="num full">Requests</th>
        <th data-k="dep">Deployed</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <p class="foot" id="foot">Probes send one anonymous GET to <code>/</code> of each URL. Risk is a heuristic: check the reasons before you act.</p>
</main>
<noscript>This page needs JavaScript.</noscript>
<script>${CLIENT_JS}<\/script>
</body>
</html>`;
}
__name(page, "page");
var CSS = `
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#d2d2d7;--acc:#0071e3;
--ok:#1a7f37;--okbg:#e6f4ea;--warn:#8a5a00;--warnbg:#fff4d6;--bad:#b42318;--badbg:#fde8e6;--mutbg:#ececf0;--infobg:#e5f0ff}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f5f5f7;--mut:#98989d;--line:#38383a;--acc:#2997ff;
--ok:#5ee08a;--okbg:#12301c;--warn:#ffd25e;--warnbg:#3a2e0a;--bad:#ff8a80;--badbg:#3d1512;--mutbg:#2c2c2e;--infobg:#0f2a47}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header,main{max-width:1300px;margin:0 auto;padding:0 16px}
header{padding-top:20px}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:26px;letter-spacing:-.02em}
.sub{margin:2px 0 0;color:var(--mut)}
.ctl{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ctl label{color:var(--mut);display:flex;gap:6px;align-items:center}
select,input[type=search],button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
button{cursor:pointer}button:hover{border-color:var(--acc)}
input[type=search]{min-width:220px;flex:1}
.warn{margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--warnbg);color:var(--warn)}
.warn ul{margin:4px 0 0 18px;padding:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.tile b{display:block;font-size:22px;letter-spacing:-.02em}
.tile span{color:var(--mut);font-size:12px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.chk{display:flex;gap:4px;align-items:center;color:var(--mut)}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}
table{width:100%;border-collapse:collapse;min-width:980px}
th,td{padding:9px 10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--mut);font-weight:600;cursor:pointer;user-select:none;white-space:nowrap;position:sticky;top:0;background:var(--card)}
th.sorted::after{content:attr(data-arrow);margin-left:4px}
.num{text-align:right}
tr.row{cursor:pointer}tr.row:hover td{background:color-mix(in srgb,var(--acc) 6%,transparent)}
tr.detail td{background:var(--bg);cursor:default}
tr:last-child td{border-bottom:0}
.name{font-weight:600}
.acct{color:var(--mut);font-size:12px;margin-left:6px;font-weight:400}
.desc{color:var(--mut);font-size:12px;margin-top:2px;max-width:340px}
.desc.none{font-style:italic}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.url{word-break:break-all;font-size:13px}
.b{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;background:var(--mutbg);color:var(--mut)}
.b.ok{background:var(--okbg);color:var(--ok)}.b.warn{background:var(--warnbg);color:var(--warn)}
.b.bad{background:var(--badbg);color:var(--bad)}.b.info{background:var(--infobg);color:var(--acc)}
.small{font-size:12px;color:var(--mut)}
.pv{font-size:12px;margin-top:3px;color:var(--bad);font-weight:600}
.kv{display:grid;grid-template-columns:140px 1fr;gap:4px 12px;font-size:13px}
.kv dt{color:var(--mut)}.kv dd{margin:0;word-break:break-word}
.kv ul{margin:0;padding-left:18px}
code{background:var(--mutbg);padding:0 4px;border-radius:4px}
.foot{color:var(--mut);font-size:12px;margin:12px 0 28px}
body.lite .full{display:none}
.panel{margin-top:14px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.panel h2{margin:0 0 4px;font-size:16px}
.panel form{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.panel input[type=text],.panel input[type=password]{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;flex:1;min-width:160px}
.trow{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)}
.trow:last-child{border-bottom:0}
.trow button{color:var(--bad)}
#tok-msg.err{color:var(--bad)}
.empty{padding:28px;text-align:center;color:var(--mut)}
.qpanel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 14px}
.qhead{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.qtitle-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qtitle-wrap h2{margin:0;font-size:15px;letter-spacing:-.01em}
.qmeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qbtn{padding:4px 10px;font-size:12px}
.qgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px 14px}
.qitem{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:8px 10px}
.qtop{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;font-weight:600;margin-bottom:4px}
.qtrack{position:relative;height:8px;background:var(--mutbg);border-radius:999px;overflow:hidden}
.qfill{height:100%;border-radius:999px;transition:width .25s ease}
.qlimit{position:absolute;left:80%;top:0;bottom:0;width:2px;background:var(--bad);opacity:.75;z-index:2}
.qsub{font-size:11px;color:var(--mut);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:640px){h1{font-size:22px}.kv{grid-template-columns:1fr}}
`;
var CLIENT_JS = String.raw`
(function () {
"use strict";
var $ = function (s) { return document.querySelector(s); };
var state = {
  rows: [], accounts: [], manage: null, lite: false, days: 7, warnings: [], loading: 0, total: 0, finished: 0, fatal: "",
  sort: { k: "risk", dir: -1 }, open: {},
  f: { q: "", account: "", expo: "", risk: "", llm: false, down: false, unused: false }
};
var RISK = ["low", "medium", "high", "critical"];
var EXPO_LABEL = { weak: "Weak auth", "public": "Public", unknown: "Reachable", token: "Token", password: "Password", access: "Access", none: "No URL", pending: "…" };
var EXPO_CLASS = { weak: "bad", "public": "warn", unknown: "warn", token: "ok", password: "ok", access: "ok", none: "", pending: "" };
var EXPO_RANK = { weak: 0, "public": 1, unknown: 2, token: 3, password: 3, access: 4, none: 5, pending: 6 };
var STORE_TYPES = { d1: "D1", kv_namespace: "KV", r2_bucket: "R2", durable_object_namespace: "Durable Object", vectorize: "Vectorize", hyperdrive: "Hyperdrive" };
var PERSONAL = /diary|family|health|wealth|medical|patient|dental|child|kid|student|homework|invoice|finance|bank|tax|journal|personal|photo|location|sos|contact|crm|bookmark|chat|message|mail|login|password/i;
var SECRET_NAME = /key|token|secret|pass/i;

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

function api(path) {
  return fetch(path, { credentials: "same-origin", cache: "no-store" }).then(function (r) {
    return r.json().catch(function () { return { error: "HTTP " + r.status }; }).then(function (j) {
      if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ("HTTP " + r.status));
      return j;
    });
  });
}

function send(method, path, body) {
  return fetch(path, {
    method: method, credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Board": "1" },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().catch(function () { return { error: "HTTP " + r.status }; }).then(function (j) {
      if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ("HTTP " + r.status));
      return j;
    });
  });
}

function pool(items, n, fn) {
  var i = 0;
  function next() {
    if (i >= items.length) return Promise.resolve();
    var it = items[i++];
    return Promise.resolve().then(function () { return fn(it); }).catch(function () {}).then(next);
  }
  var ps = [];
  for (var k = 0; k < n; k++) ps.push(next());
  return Promise.all(ps);
}

function ago(iso) {
  if (!iso) return "";
  var s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  if (s < 86400 * 60) return Math.round(s / 86400) + " d ago";
  return Math.round(s / 86400 / 30) + " mo ago";
}

function hostOf(u) { try { return new URL(u).host + (new URL(u).pathname === "/" ? "" : new URL(u).pathname); } catch (e) { return u; } }

// ---------- derived fields ----------

function llmList(r) {
  var out = [];
  if (r.override && r.override.llm === false) return out;
  (r.bindings || []).forEach(function (b) { if (b.type === "ai") out.push("Workers AI binding"); });
  if (r.scan && r.scan.llm) r.scan.llm.forEach(function (x) { out.push(x); });
  if (r.override && r.override.llm === true && !out.length) out.push("marked in REGISTRY");
  return out;
}

function exposureOf(r) {
  if (r.state === "new" || r.state === "detail") return "pending";
  if (!r.url) return "none";
  if (!r.probe) return "pending";
  return r.probe.exposure || "unknown";
}

function descOf(r) {
  if (r.override && r.override.description) return { text: r.override.description, src: "registry" };
  if (r.github && r.github.description) return { text: r.github.description, src: "github" };
  if (r.probe && r.probe.metaDescription) return { text: r.probe.metaDescription, src: "page" };
  if (r.probe && r.probe.title) return { text: r.probe.title, src: "page title" };
  return { text: "", src: "" };
}

function compute(r) {
  var reasons = [], s = 0;
  var b = r.bindings || [];
  var stores = [];
  b.forEach(function (x) { if (STORE_TYPES[x.type] && stores.indexOf(STORE_TYPES[x.type]) < 0) stores.push(STORE_TYPES[x.type]); });
  if (stores.length) { s += 2; reasons.push("Stores data (" + stores.join(", ") + ")"); }
  var d = descOf(r);
  var text = [r.name, d.text, (r.probe && r.probe.title) || ""].concat(b.map(function (x) { return x.name; })).join(" ");
  var m = PERSONAL.exec(text);
  if (m) { s += 2; reasons.push('Name or text suggests personal data ("' + m[0] + '")'); }
  if ((r.secrets || []).some(function (n) { return SECRET_NAME.test(n); })) { s += 1; reasons.push("Holds credential secrets"); }
  var llm = llmList(r);
  if (llm.length) { s += 2; reasons.push("Uses an LLM (" + llm.join(", ") + ")"); }

  var expo = exposureOf(r);
  var exposed = expo === "public" || expo === "unknown" || expo === "weak";
  var lvl = 0;
  if (expo === "pending") lvl = -1;
  else if (exposed) {
    lvl = s >= 4 ? 3 : s >= 2 ? 2 : s >= 1 ? 1 : 0;
    if (expo === "weak") { lvl = Math.min(3, Math.max(lvl, 2) + (s >= 2 ? 1 : 0)); reasons.unshift("Auth looks broken: a fake token was accepted"); }
    if (llm.length) { lvl = Math.max(lvl, 2); reasons.push("Exposed LLM: anyone can spend your quota and probe your prompt"); }
    if (stores.length) reasons.push("Exposed and stores data");
    if (!reasons.length) reasons.push("Exposed, but no sensitive signal found");
  } else if (expo === "none") {
    reasons.push("No public URL");
  } else {
    lvl = s >= 4 ? 1 : 0;
    reasons.push("Protected (" + EXPO_LABEL[expo].toLowerCase() + ")");
  }
  var authCode = r.scan && r.scan.auth && r.scan.auth.length;
  var hasCred = (r.secrets || []).some(function (n) { return /pass|token|secret|key/i.test(n); });
  if (exposed && authCode && hasCred) { lvl = Math.min(lvl, 2); reasons.push("Auth code and a credential secret exist: / is open, API paths may be protected. Verify by hand."); }
  var intended = r.override && r.override.public;
  if (exposed && intended) { lvl = Math.min(lvl, 1); reasons.push("Marked as intentionally public in REGISTRY"); }
  r.risk = { level: lvl, reasons: reasons, score: s, makePrivate: exposed && lvl >= 2 && !intended };
  r.expo = expo;
  r.llm = llm;
  r.desc = d;
  r.isDown = !!(r.probe && (r.probe.status === 0 || r.probe.status >= 500));
  var u = r.usage;
  r.req = u ? u.requests : null;
  r.unused = r.usageLoaded && (!u || u.requests === 0);
}

// ---------- loading ----------

function recompute(r) { compute(r); scheduleRender(); }

function colspan() { return state.lite ? 5 : 8; }

function detail(r) {
  r.state = "detail";
  return api("/api/worker?account=" + encodeURIComponent(r.ai) + "&name=" + encodeURIComponent(r.name)).then(function (d) {
    r.bindings = d.bindings; r.secrets = d.secrets; r.tags = d.tags; r.workersDev = d.workersDev;
    r.github = d.github; r.override = d.override; r.errors = d.errors || [];
    var urls = r.urls.slice();
    if (r.dev && !(r.workersDev && r.workersDev.enabled === false)) urls.push(r.dev);
    r.allUrls = urls;
    var first = urls.filter(function (x) { return x.url; })[0];
    r.url = first ? first.url : null;
    r.sig = first ? first.sig : null;
    r.state = "probing";
    recompute(r);
    var jobs = [];
    if (r.url) {
      jobs.push(api("/api/probe?url=" + encodeURIComponent(r.url) + "&sig=" + encodeURIComponent(r.sig || "")).then(function (p) { r.probe = p; }, function (e) { r.probe = { status: 0, exposure: "unknown", error: e.message }; }));
    }
    if (!state.lite) jobs.push(api("/api/scan?account=" + encodeURIComponent(r.ai) + "&name=" + encodeURIComponent(r.name) + "&v=" + encodeURIComponent(r.modified || "")).then(function (x) { r.scan = x; }, function (e) { r.scan = { error: e.message, llm: [], auth: [] }; }));
    return Promise.all(jobs);
  }).then(function () { r.state = "done"; state.finished++; recompute(r); }, function (e) {
    r.state = "error"; r.errors = [e.message]; state.finished++; recompute(r);
  });
}

function accName(ai) {
  for (var i = 0; i < state.accounts.length; i++) if (state.accounts[i].key === ai) return state.accounts[i].name;
  return ai;
}

function loadUsage(ai) {
  return api("/api/usage?account=" + encodeURIComponent(ai) + "&days=" + state.days).then(function (u) {
    state.rows.forEach(function (r) {
      if (r.ai !== ai) return;
      r.usage = u.scripts[r.name] || null;
      r.usageLoaded = true;
      compute(r);
    });
    scheduleRender();
  }, function (e) {
    state.warnings.push(accName(ai) + " usage: " + e.message);
    scheduleRender();
  });
}

function loadAccount(ai) {
  return api("/api/inventory?account=" + encodeURIComponent(ai)).then(function (inv) {
    inv.warnings.forEach(function (w) { state.warnings.push(inv.account + ": " + w); });
    var rows = inv.workers.map(function (w) {
      return { key: ai + "/" + w.name, ai: ai, account: inv.account, name: w.name, modified: w.modified_on, handlers: w.handlers,
        urls: w.urls, dev: w.dev, subdomain: inv.subdomain, url: null, state: "new", usage: null, usageLoaded: false, errors: [] };
    });
    rows.forEach(function (r) { compute(r); state.rows.push(r); });
    state.total += rows.length;
    scheduleRender();
    var u = state.lite ? Promise.resolve() : loadUsage(ai);
    return Promise.all([u, pool(rows, 5, detail)]);
  }, function (e) {
    state.warnings.push(accName(ai) + ": " + e.message);
    scheduleRender();
  });
}


function loadQuota(force) {
  var qb = $("#qbadge"), qt = $("#qtime"), qg = $("#qgrid"), btn = $("#qrefresh");
  if (!qb || !qg) return Promise.resolve();
  if (force) { qb.textContent = "Refreshing…"; qb.className = "b"; if (btn) btn.disabled = true; }
  return api("/api/quota" + (force ? "?refresh=1" : "")).then(function (q) {
    if (btn) btn.disabled = false;
    qb.textContent = q.tripped ? "TRIPPED (≥80%)" : "NORMAL (<80%)";
    qb.className = "b " + (q.tripped ? "bad" : "ok");
    qt.textContent = "Stateless (0 KV) · Hourly via sos2me · " + (q.updatedAtSgt || "");
    qg.innerHTML = (q.items || []).map(function (it) {
      var p = Number(it.pct || 0);
      var col = p >= 80 ? "var(--bad)" : p >= 50 ? "var(--warn)" : "var(--ok)";
      return '<div class="qitem">' +
        '<div class="qtop"><span>' + esc(it.label) + '</span><span style="color:' + col + '">' + p.toFixed(1) + '%</span></div>' +
        '<div class="qtrack"><div class="qlimit" title="80% Auto Circuit-Breaker"></div><div class="qfill" style="width:' + Math.min(100, p) + '%;background:' + col + '"></div></div>' +
        '<div class="qsub" title="' + esc(it.detail || "") + '">' + esc(it.detail || "") + '</div>' +
      '</div>';
    }).join("");
  }).catch(function (e) {
    if (btn) btn.disabled = false;
    qb.textContent = "Quota Error";
    qb.className = "b warn";
    qt.textContent = e.message;
  });
}

function boot() {
  state.rows = []; state.warnings = []; state.total = 0; state.finished = 0; state.fatal = ""; state.pendingAcc = 1;
  render();
  loadQuota(false);
  return api("/api/config").then(function (cfg) {
    state.accounts = cfg.accounts;
    state.lite = !!cfg.lite;
    state.manage = cfg.manage || null;
    state.configured = true;
    (cfg.warnings || []).forEach(function (w) { state.warnings.push(w); });
    document.body.className = state.lite ? "lite" : "";
    $("#tokbtn").hidden = !state.manage;
    if (state.manage && !cfg.accounts.length) { $("#tok").hidden = false; loadTokens(); }
    if (state.lite) {
      $("#foot").textContent = "Public view. Status comes from one anonymous GET to / of each URL. Protection shows what a visitor meets before any login.";
      state.sort = { k: "http", dir: 1 };
    }
    if (!state.daysSet) { state.days = cfg.days; state.daysSet = true; }
    $("#days").value = String(state.days);
    var sel = $("#f-account");
    sel.innerHTML = '<option value="">All accounts</option>' + cfg.accounts.map(function (a) { return '<option value="' + esc(a.key) + '">' + esc(a.name) + "</option>"; }).join("");
    state.pendingAcc = cfg.accounts.length;
    return Promise.all(cfg.accounts.map(function (a) { return loadAccount(a.key).then(function () { state.pendingAcc--; scheduleRender(); }); }));
  }).catch(function (e) { state.fatal = e.message; scheduleRender(); });
}

// ---------- rendering ----------

var pendingRender = false;
function scheduleRender() { if (pendingRender) return; pendingRender = true; setTimeout(function () { pendingRender = false; render(); }, 80); }

function sortVal(r, k) {
  switch (k) {
    case "name": return r.name.toLowerCase();
    case "url": return (r.url || "~").toLowerCase();
    case "expo": return EXPO_RANK[r.expo];
    case "risk": return r.risk.level;
    case "llm": return r.llm.length ? 1 : 0;
    case "http": return r.probe ? (r.isDown ? 0 : 1) : 2;
    case "req": return r.req == null ? -1 : r.req;
    case "dep": return r.modified ? new Date(r.modified).getTime() : 0;
  }
  return 0;
}

function visible() {
  var f = state.f, q = f.q.toLowerCase();
  var rows = state.rows.filter(function (r) {
    if (f.account !== "" && String(r.ai) !== f.account) return false;
    if (q && (r.name + " " + (r.url || "") + " " + r.desc.text + " " + r.account).toLowerCase().indexOf(q) < 0) return false;
    if (f.expo === "exposed" && !(r.expo === "public" || r.expo === "unknown" || r.expo === "weak")) return false;
    if (f.expo === "public" && r.expo !== "public") return false;
    if (f.expo === "protected" && !(r.expo === "token" || r.expo === "password" || r.expo === "access")) return false;
    if (f.expo === "weak" && r.expo !== "weak") return false;
    if (f.expo === "none" && r.expo !== "none") return false;
    if (f.risk && r.risk.level < Number(f.risk)) return false;
    if (f.llm && !r.llm.length) return false;
    if (f.down && !r.isDown) return false;
    if (f.unused && !r.unused) return false;
    return true;
  });
  var k = state.sort.k, dir = state.sort.dir;
  rows.sort(function (a, b) {
    var x = sortVal(a, k), y = sortVal(b, k);
    if (x < y) return -dir; if (x > y) return dir;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return rows;
}

function badge(text, cls, title) { return '<span class="b ' + (cls || "") + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + esc(text) + "</span>"; }

function httpCell(r) {
  if (!r.url) {
    if (r.workersDev && r.workersDev.enabled === false) return badge("disabled", "", "workers.dev disabled & no custom route");
    return '<span class="small">—</span>';
  }
  if (!r.probe) return '<span class="small">checking…</span>';
  var p = r.probe;
  if (p.status === 0) return badge("down", "bad", p.error || "no response") + ' <span class="small">' + esc(p.error || "") + "</span>";
  if (p.status >= 500) return badge("down", "bad", p.hint || "") + ' <span class="small">HTTP ' + p.status + "</span>";
  return badge("up", "ok", p.hint || "") + ' <span class="small">HTTP ' + p.status + " · " + p.ms + " ms</span>";
}

function row(r) {
  var open = !!state.open[r.key];
  var d = r.desc;
  var h = '<tr class="row" data-key="' + esc(r.key) + '">';
  h += '<td><span class="name">' + esc(r.name) + '</span><span class="acct">' + esc(r.account) + "</span>";
  h += d.text ? '<div class="desc" title="source: ' + esc(d.src) + '">' + esc(d.text) + "</div>" : (r.state === "done" ? '<div class="desc none">no description</div>' : "");
  h += "</td>";
  var link = r.allUrls && r.allUrls.filter(function (x) { return x.url; })[0];
  var more = r.allUrls ? r.allUrls.length - 1 : 0;
  h += '<td class="url">' + (r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">' + esc(hostOf(r.url)) + "</a>" : (r.state === "done" || r.state === "error" ? '<span class="small">none</span>' : '<span class="small">…</span>')) + (more > 0 ? ' <span class="small">+' + more + "</span>" : "") + "</td>";
  h += "<td>" + httpCell(r) + "</td>";
  h += "<td>" + badge(EXPO_LABEL[r.expo], EXPO_CLASS[r.expo], r.probe && r.probe.hint) + "</td>";
  if (!state.lite) {
    var lv = r.risk.level;
    h += "<td>" + (lv < 0 ? '<span class="small">…</span>' : badge(RISK[lv], lv >= 2 ? "bad" : lv === 1 ? "warn" : "ok", r.risk.reasons.join("; "))) + (r.risk.makePrivate ? '<div class="pv">make private</div>' : "") + "</td>";
    h += "<td>" + (r.llm.length ? badge("LLM", "info", r.llm.join(", ")) : r.scan || r.state === "error" ? '<span class="small">—</span>' : '<span class="small">…</span>') + "</td>";
    var reqText = !r.usageLoaded ? "…" : r.req == null ? "0" : r.req.toLocaleString();
    h += '<td class="num">' + esc(reqText) + (r.usage && r.usage.errors ? '<div class="small" style="color:var(--bad)">' + r.usage.errors.toLocaleString() + " errors</div>" : "") + (r.unused ? '<div class="small">unused</div>' : "") + "</td>";
  }
  h += '<td class="small" title="' + esc(r.modified || "") + '">' + esc(ago(r.modified)) + "</td></tr>";
  if (open) h += detailRow(r);
  return h;
}

function list(items) { return items.length ? "<ul>" + items.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ul>" : '<span class="small">none</span>'; }

function detailRow(r) {
  var h = '<tr class="detail"><td colspan="' + colspan() + '"><dl class="kv">';
  if (!state.lite) h += "<dt>Risk reasons</dt><dd>" + list(r.risk.reasons.map(esc)) + "</dd>";
  h += "<dt>URLs</dt><dd>" + list((r.allUrls || r.urls || []).map(function (u) { return (u.url ? '<a href="' + esc(u.url) + '" target="_blank" rel="noopener noreferrer">' + esc(u.label || u.url) + "</a>" : esc(u.label)) + ' <span class="small">' + esc(u.kind) + "</span>"; })) + "</dd>";
  if (r.probe) h += "<dt>Probe</dt><dd>HTTP " + esc(r.probe.status) + (r.probe.hint ? " · " + esc(r.probe.hint) : "") + (r.probe.error ? " · " + esc(r.probe.error) : "") + "</dd>";
  h += "<dt>Description</dt><dd>" + (r.desc.text ? esc(r.desc.text) + ' <span class="small">(' + esc(r.desc.src) + ")</span>" : '<span class="small">none. Add one in REGISTRY or a GitHub repo description.</span>') + "</dd>";
  if (r.github) h += '<dt>Repo</dt><dd><a href="' + esc(r.github.url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.github.repo) + "</a>" + (r.github.private ? ' <span class="small">private</span>' : "") + "</dd>";
  if (state.lite) return h + "</dl></td></tr>";
  var groups = {};
  (r.bindings || []).forEach(function (b) { if (b.type !== "secret_text") (groups[b.type] = groups[b.type] || []).push(b.name); });
  var bl = Object.keys(groups).map(function (t) { return esc(t) + ": <code>" + groups[t].map(esc).join("</code> <code>") + "</code>"; });
  h += "<dt>Bindings</dt><dd>" + list(bl) + "</dd>";
  h += "<dt>Secrets</dt><dd>" + (r.secrets && r.secrets.length ? "<code>" + r.secrets.map(esc).join("</code> <code>") + "</code>" : '<span class="small">none</span>') + "</dd>";
  if (r.scan) h += "<dt>Source scan</dt><dd>" + (r.scan.error ? '<span class="small">failed: ' + esc(r.scan.error) + "</span>" : r.scan.skipped ? '<span class="small">off</span>' : "LLM: " + esc(r.scan.llm.join(", ") || "none") + " · auth code: " + esc(r.scan.auth.join(", ") || "none") + ' <span class="small">(' + Math.round(r.scan.bytes / 1024) + " KB" + (r.scan.truncated ? ", truncated" : "") + (r.scan.cached ? ", cached" : "") + ")</span>") + "</dd>";
  h += "<dt>Triggers</dt><dd>" + esc((r.handlers || []).join(", ") || "—") + "</dd>";
  if (r.errors && r.errors.length) h += '<dt>API errors</dt><dd style="color:var(--bad)">' + r.errors.map(esc).join("<br>") + "</dd>";
  return h + "</dl></td></tr>";
}

function tiles() {
  var rs = state.rows, n = rs.length;
  var exposed = rs.filter(function (r) { return r.expo === "public" || r.expo === "unknown" || r.expo === "weak"; }).length;
  var high = rs.filter(function (r) { return r.risk.level >= 2; }).length;
  var llm = rs.filter(function (r) { return r.llm.length; }).length;
  var down = rs.filter(function (r) { return r.isDown; }).length;
  var unused = rs.filter(function (r) { return r.unused; }).length;
  function t(v, l) { return '<div class="tile"><b>' + v + "</b><span>" + l + "</span></div>"; }
  if (state.lite) {
    var prot = rs.filter(function (r) { return r.expo === "token" || r.expo === "password" || r.expo === "access"; }).length;
    var open = rs.filter(function (r) { return r.expo === "public" || r.expo === "unknown" || r.expo === "weak"; }).length;
    var up = rs.filter(function (r) { return r.probe && !r.isDown; }).length;
    return t(n, "Workers") + t(up, "Up") + t(down, "Down") + t(prot, "Protected") + t(open, "Open");
  }
  return t(n, "Workers") + t(exposed, "Exposed") + t(high, "High or critical risk") + t(llm, "Use an LLM") + t(down, "Down") + t(unused, "Unused in " + state.days + " d");
}

function render() {
  var rows = visible();
  var st = state.fatal ? "Error: " + state.fatal : state.configured && !state.accounts.length ? "No API token yet." : state.pendingAcc > 0 && state.finished >= state.total ? "Loading accounts…" :
    state.finished < state.total ? "Checking " + state.finished + " / " + state.total + " Workers…" :
    state.total + " Workers in " + state.accounts.length + " account" + (state.accounts.length === 1 ? "" : "s") + ". Snapshot taken " + new Date().toLocaleTimeString() + ".";
  $("#status").textContent = st;
  var w = $("#warn");
  if (state.warnings.length || state.fatal) {
    w.hidden = false;
    w.innerHTML = state.fatal ? esc(state.fatal) : "Some data is missing:" + list(state.warnings.map(esc));
  } else w.hidden = true;
  $("#tiles").innerHTML = tiles();
  var body = rows.map(row).join("");
  $("#rows").innerHTML = body || '<tr><td colspan="' + colspan() + '" class="empty">' + (state.rows.length ? "No Worker matches the filters." : state.fatal ? "" : state.configured && !state.accounts.length ? (state.manage ? "Add an API token above." : "No API token is set. Set the CF_API_TOKEN secret.") : "Loading…") + "</td></tr>";
  var ths = document.querySelectorAll("th");
  for (var i = 0; i < ths.length; i++) {
    var on = ths[i].getAttribute("data-k") === state.sort.k;
    ths[i].className = (ths[i].className.replace(/\bsorted\b/, "").trim() + (on ? " sorted" : "")).trim();
    ths[i].setAttribute("data-arrow", on ? (state.sort.dir > 0 ? "▲" : "▼") : "");
  }
}

// ---------- API token panel ----------

function tokMsg(text, err) { var m = $("#tok-msg"); m.textContent = text; m.className = "small" + (err ? " err" : ""); }

function loadTokens() {
  return api("/api/tokens").then(function (t) {
    var h = "";
    t.deploy.forEach(function (d) {
      h += '<div class="trow"><span><b>' + esc(d.via) + '</b> <span class="small">' + esc(d.error ? "error: " + d.error : d.accounts.join(", ") || "no account found") + '</span></span><span class="small">set at deploy</span></div>';
    });
    t.tokens.forEach(function (x) {
      var names = (x.accounts || []).map(function (a) { return a.name; }).join(", ");
      h += '<div class="trow"><span><b>' + esc(x.label) + '</b> <span class="small">…' + esc(x.last4) + " · " + esc(names) + " · added " + esc(ago(x.added)) + '</span></span><button type="button" data-del="' + esc(x.id) + '">Delete</button></div>';
    });
    if (!h) h = '<p class="small">No token yet.</p>';
    if (!t.store) h += '<p class="small err">Saving tokens is off. Bind a KV namespace named STORE and deploy again.</p>';
    $("#tok-list").innerHTML = h;
    $("#tok-add").disabled = !t.store;
  }, function (e) { $("#tok-list").textContent = "Cannot load tokens: " + e.message; });
}

$("#tokbtn").addEventListener("click", function () {
  var p = $("#tok");
  p.hidden = !p.hidden;
  if (!p.hidden) { tokMsg(""); loadTokens(); }
});

$("#tok-form").addEventListener("submit", function (e) {
  e.preventDefault();
  var btn = $("#tok-add");
  btn.disabled = true;
  tokMsg("Checking the token…");
  send("POST", "/api/tokens", { label: $("#tok-label").value, token: $("#tok-value").value, accountId: $("#tok-acct").value }).then(function (r) {
    $("#tok-value").value = ""; $("#tok-label").value = ""; $("#tok-acct").value = "";
    tokMsg("Added. Accounts: " + r.accounts.join(", ") + "." + (r.notes.length ? " " + r.notes.join("; ") + "." : ""));
    return loadTokens().then(boot);
  }, function (err) { tokMsg(err.message, true); }).then(function () { btn.disabled = false; });
});

// ---------- events ----------

document.addEventListener("click", function (e) {
  var del = e.target.closest && e.target.closest("button[data-del]");
  if (del) {
    if (!window.confirm("Delete this token? Its Workers leave the board.")) return;
    send("DELETE", "/api/tokens?id=" + encodeURIComponent(del.getAttribute("data-del"))).then(function () {
      tokMsg("Deleted.");
      return loadTokens().then(boot);
    }, function (err) { tokMsg(err.message, true); });
    return;
  }
  var th = e.target.closest && e.target.closest("th");
  if (th) {
    var k = th.getAttribute("data-k");
    state.sort = state.sort.k === k ? { k: k, dir: -state.sort.dir } : { k: k, dir: (k === "name" || k === "url" || k === "expo") ? 1 : -1 };
    return render();
  }
  var tr = e.target.closest && e.target.closest("tr.row");
  if (tr) {
    var key = tr.getAttribute("data-key");
    state.open[key] = !state.open[key];
    render();
  }
});
$("#q").addEventListener("input", function (e) { state.f.q = e.target.value; render(); });
$("#f-account").addEventListener("change", function (e) { state.f.account = e.target.value; render(); });
$("#f-expo").addEventListener("change", function (e) { state.f.expo = e.target.value; render(); });
$("#f-risk").addEventListener("change", function (e) { state.f.risk = e.target.value; render(); });
$("#f-llm").addEventListener("change", function (e) { state.f.llm = e.target.checked; render(); });
$("#f-down").addEventListener("change", function (e) { state.f.down = e.target.checked; render(); });
$("#f-unused").addEventListener("change", function (e) { state.f.unused = e.target.checked; render(); });
$("#reload").addEventListener("click", function () { boot(); });
$("#qrefresh").addEventListener("click", function () { loadQuota(true); });
$("#days").addEventListener("change", function (e) {
  state.days = Number(e.target.value);
  state.rows.forEach(function (r) { r.usageLoaded = false; r.usage = null; compute(r); });
  render();
  state.accounts.forEach(function (a) { loadUsage(a.key); });
});

boot();
})();
`;
export {
  uptime_worker_default as default
};
