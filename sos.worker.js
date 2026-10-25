var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var CONFIG = {
  DEFAULT_CHANNEL: "/qqq",
  MAX_REQUESTS_PER_MINUTE: 20,
  MESSAGE_HISTORY_LIMIT: 150,
  JSON_QUERY: "/json?poll=1&since=all",
  SSE_PATH: "/sse",
  AVATAR_EMOJIS: ["\u{1F680}", "\u{1F31F}", "\u{1F47D}", "\u{1F6F8}", "\u{1F319}", "\u2B50", "\u{1FA90}", "\u{1F30D}", "\u2604\uFE0F", "\u{1F52D}", "\u{1F47E}", "\u{1F916}", "\u{1F4AB}", "\u{1F30C}", "\u{1F6F0}\uFE0F"]
};
var ipRequests = /* @__PURE__ */ new Map();
var ipAvatars = /* @__PURE__ */ new Map();
var memMessages = [];
var KV_MESSAGES_KEY = "sos:messages:qqq";
var worker = {
  async fetch(request, env, _ctx) {
    const ip = request.headers.get("CF-Connecting-IP");
    if (isRateLimited(ip)) {
      return new Response("Rate limit exceeded. Please try again later.", { status: 429 });
    }
    try {
      return await routeRequest(request, env, ip);
    } catch (error) {
      console.error("Error handling request", error);
      return new Response("An error occurred. Please try again later.", { status: 500 });
    }
  }
};
function isRateLimited(ip) {
  const now = Date.now();
  const recentRequests = ipRequests.get(ip) || [];
  const recentRequestsInWindow = recentRequests.filter((time) => now - time < 6e4);
  if (recentRequestsInWindow.length >= CONFIG.MAX_REQUESTS_PER_MINUTE) {
    return true;
  }
  recentRequestsInWindow.push(now);
  ipRequests.set(ip, recentRequestsInWindow);
  return false;
}
__name(isRateLimited, "isRateLimited");
function getOrCreateAvatar(ip) {
  if (ipAvatars.has(ip)) {
    return ipAvatars.get(ip);
  }
  let hash = 0;
  const ipStr = ip || "anonymous";
  for (let i = 0; i < ipStr.length; i++) {
    hash = (hash << 5) - hash + ipStr.charCodeAt(i);
    hash = hash & hash;
  }
  const avatarIndex = Math.abs(hash) % CONFIG.AVATAR_EMOJIS.length;
  const avatar = CONFIG.AVATAR_EMOJIS[avatarIndex];
  ipAvatars.set(ip, avatar);
  return avatar;
}
__name(getOrCreateAvatar, "getOrCreateAvatar");
async function routeRequest(request, env, ip) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (request.method === "OPTIONS") {
    return handleOptions();
  }
  if (request.method === "GET" && pathname === "/") {
    const messages = await fetchMessages(env);
    return renderHomepage(messages);
  }
  if (request.method === "GET" && pathname === "/api/messages") {
    const messages = await fetchMessages(env);
    const avatar = getOrCreateAvatar(ip);
    return jsonResponse({ messages, avatar });
  }
  if (request.method === "POST" && pathname === "/api/messages") {
    const payload = await parseJsonBody(request);
    const message = sanitizeMessage(payload.message);
    if (!message) {
      return jsonResponse({ error: "Message content is required." }, 400);
    }
    const avatar = getOrCreateAvatar(ip);
    const messageWithAvatar = `${avatar} ${message}`;
    const messages = await saveAndBroadcastMessage(CONFIG.DEFAULT_CHANNEL, messageWithAvatar, env);
    return jsonResponse({ success: true, messages, avatar });
  }
  if (request.method === "DELETE" && pathname === "/api/messages") {
    const id = url.searchParams.get("id") || "";
    const messages = await deleteMessageById(id, env);
    return jsonResponse({ success: true, messages });
  }
  return new Response("Not found", { status: 404 });
}
__name(routeRequest, "routeRequest");
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
__name(handleOptions, "handleOptions");
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
__name(jsonResponse, "jsonResponse");
async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch (error) {
    console.error("Invalid JSON payload received", error);
    return {};
  }
}
__name(parseJsonBody, "parseJsonBody");
function sanitizeMessage(input) {
  if (typeof input !== "string") {
    return "";
  }
  return input.trim().slice(0, 500);
}
__name(sanitizeMessage, "sanitizeMessage");
function getNtfyBaseUrl(env) {
  const baseUrl = env?.NTFY_BASE_URL?.trim();
  if (baseUrl) {
    return baseUrl.replace(/\/$/, "");
  }
  return "https://ntfy.sh";
}
__name(getNtfyBaseUrl, "getNtfyBaseUrl");

async function loadStoredMessages(env) {
  let kvList = [];
  if (env?.STORE) {
    try {
      const raw = await env.STORE.get(KV_MESSAGES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) kvList = parsed;
      }
    } catch (e) {
      console.error("KV read error", e);
    }
  }
  const byId = new Map();
  for (const m of [...memMessages, ...kvList]) {
    if (m && typeof m.id === "string" && typeof m.message === "string" && m.message.trim()) {
      byId.set(m.id, m);
    }
  }
  const merged = Array.from(byId.values()).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, CONFIG.MESSAGE_HISTORY_LIMIT);
  memMessages = merged;
  return merged;
}
__name(loadStoredMessages, "loadStoredMessages");

async function saveAndBroadcastMessage(channel, message, env) {
  const nowSec = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 10);
  let entry = {
    id: `msg-${nowSec}-${rand}`,
    message,
    time: nowSec
  };

  // Best-effort forward to ntfy.sh (non-blocking if ntfy rate-limits CF IP with 429)
  try {
    const baseUrl = getNtfyBaseUrl(env);
    const cleanChannel = channel.startsWith("/") ? channel.slice(1) : channel;
    const ntfyUrl = `${baseUrl}/${cleanChannel}`;
    const response = await fetch(ntfyUrl, {
      method: "POST",
      body: message,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      signal: AbortSignal.timeout(4000)
    });
    if (response.ok) {
      const ntfyJson = await response.json().catch(() => null);
      if (ntfyJson && typeof ntfyJson.id === "string") {
        entry.id = ntfyJson.id;
        if (typeof ntfyJson.time === "number") entry.time = ntfyJson.time;
      }
    }
  } catch (e) {
    console.warn("ntfy forward skipped:", e.message);
  }

  const current = await loadStoredMessages(env);
  const updated = [entry, ...current.filter((m) => m.id !== entry.id)]
    .sort((a, b) => (b.time || 0) - (a.time || 0))
    .slice(0, CONFIG.MESSAGE_HISTORY_LIMIT);
  memMessages = updated;

  if (env?.STORE) {
    try {
      await env.STORE.put(KV_MESSAGES_KEY, JSON.stringify(updated));
    } catch (e) {
      console.error("KV write error", e);
    }
  }
  return updated;
}
__name(saveAndBroadcastMessage, "saveAndBroadcastMessage");

async function deleteMessageById(id, env) {
  const current = await loadStoredMessages(env);
  const updated = id ? current.filter((m) => m.id !== id) : current;
  memMessages = updated;
  if (env?.STORE && id) {
    try {
      await env.STORE.put(KV_MESSAGES_KEY, JSON.stringify(updated));
    } catch (e) {
      console.error("KV delete update error", e);
    }
  }
  return updated;
}
__name(deleteMessageById, "deleteMessageById");

async function fetchMessages(env) {
  const stored = await loadStoredMessages(env);
  let ntfyMessages = [];
  try {
    const baseUrl = getNtfyBaseUrl(env);
    const cleanChannel = CONFIG.DEFAULT_CHANNEL.startsWith("/") ? CONFIG.DEFAULT_CHANNEL.slice(1) : CONFIG.DEFAULT_CHANNEL;
    const ntfyUrl = `${baseUrl}/${cleanChannel}${CONFIG.JSON_QUERY}`;
    const response = await fetch(ntfyUrl, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(4000)
    });
    if (response.ok) {
      const payload = await response.text();
      ntfyMessages = payload.split("\n").filter((line) => line.trim().length > 0).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter((msg) => Boolean(msg && typeof msg === "object" && (!msg.event || msg.event === "message"))).map((msg, index) => {
        const time = typeof msg.time === "number" ? msg.time : 0;
        const id = typeof msg.id === "string" && msg.id.length > 0 ? msg.id : `${time}-${index}`;
        return {
          id,
          title: typeof msg.title === "string" ? msg.title : void 0,
          message: typeof msg.message === "string" ? msg.message : "",
          time
        };
      }).filter((entry) => entry.message.trim().length > 0);
    }
  } catch (e) {
    console.warn("ntfy poll skipped:", e.message);
  }

  const byId = new Map();
  for (const m of [...stored, ...ntfyMessages]) {
    if (m && m.id && m.message) {
      byId.set(m.id, m);
    }
  }
  const merged = Array.from(byId.values())
    .sort((a, b) => (b.time || 0) - (a.time || 0))
    .slice(0, CONFIG.MESSAGE_HISTORY_LIMIT);
  memMessages = merged;
  return merged;
}
__name(fetchMessages, "fetchMessages");
function renderHomepage(messages) {
  const initialData = JSON.stringify({ messages }).replace(/</g, "\\u003c");
  const html = `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Channel ${CONFIG.DEFAULT_CHANNEL} \xB7 Space Terminal</title>
      <style>
        :root {
          color-scheme: dark;
          --terminal-green: #7fff8c;
          --terminal-blue: #6ec1ff;
          --terminal-purple: #c792ea;
          --terminal-bg: radial-gradient(circle at top, rgba(20, 40, 60, 0.85), rgba(5, 8, 20, 0.95));
          --grid-color: rgba(110, 193, 255, 0.12);
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          min-height: 100vh;
          font-family: 'IBM Plex Mono', 'Fira Code', Menlo, Monaco, Consolas, 'Courier New', monospace;
          color: #d7ecff;
          background: #030712;
          position: relative;
          overflow-x: hidden;
        }

        body::before {
          content: '';
          position: fixed;
          inset: 0;
          background: var(--terminal-bg);
          z-index: -3;
        }

        body::after {
          content: '';
          position: fixed;
          inset: 0;
          background: linear-gradient(transparent, rgba(255, 255, 255, 0.03) 2px), linear-gradient(90deg, rgba(255, 255, 255, 0.03) 2px, transparent 0);
          background-size: 100% 4px, 8px 100%;
          opacity: 0.35;
          z-index: -2;
        }

        .scanlines {
          position: fixed;
          inset: 0;
          background: repeating-linear-gradient(180deg, rgba(0, 0, 0, 0) 0px, rgba(0, 0, 0, 0) 2px, rgba(0, 0, 0, 0.2) 3px);
          mix-blend-mode: screen;
          pointer-events: none;
          opacity: 0.4;
          z-index: -1;
        }

        main {
          max-width: 960px;
          margin: 0 auto;
          padding: 64px 24px 96px;
        }

        header {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 36px;
        }

        .channel-pill {
          padding: 6px 12px;
          border: 1px solid var(--terminal-blue);
          border-radius: 999px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          font-size: 0.74rem;
          color: var(--terminal-blue);
        }

        h1 {
          font-size: clamp(2.4rem, 3vw, 3.2rem);
          margin: 0;
          color: var(--terminal-green);
          text-shadow: 0 0 18px rgba(127, 255, 140, 0.35);
        }

        .subtitle {
          margin: 0;
          color: rgba(214, 236, 255, 0.76);
          max-width: 100%;
          line-height: 1.6;
        }

        .warning {
          margin: 24px 0 32px;
          padding: 16px 20px;
          border-left: 3px solid #ff7d7d;
          background: rgba(255, 125, 125, 0.08);
          color: #ffdede;
          font-size: 0.9rem;
        }

        form {
          width: 100%;
          display: grid;
          gap: 12px;
          background: rgba(3, 12, 28, 0.72);
          border: 1px solid rgba(110, 193, 255, 0.25);
          padding: 20px;
          border-radius: 14px;
          backdrop-filter: blur(6px);
          box-shadow: 0 0 30px rgba(110, 193, 255, 0.12);
        }

        label {
          font-size: 0.84rem;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: rgba(214, 236, 255, 0.75);
        }

        textarea {
          width: 100%;
          padding: 12px 14px;
          border-radius: 10px;
          border: 1px solid rgba(110, 193, 255, 0.4);
          background: rgba(9, 21, 42, 0.9);
          color: #eff6ff;
          font-size: 1rem;
          font-family: inherit;
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }

        textarea:focus {
          outline: none;
          border-color: var(--terminal-blue);
          box-shadow: 0 0 12px rgba(110, 193, 255, 0.35);
        }

        textarea {
          min-height: 120px;
          resize: vertical;
        }

        button {
          justify-self: flex-start;
          background: linear-gradient(135deg, rgba(110, 193, 255, 0.95), rgba(199, 146, 234, 0.95));
          color: #050b16;
          border: none;
          border-radius: 999px;
          padding: 10px 28px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }

        button:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 30px rgba(110, 193, 255, 0.25);
        }

        button:disabled {
          opacity: 0.5;
          cursor: wait;
          box-shadow: none;
        }

        .status-line {
          font-size: 0.85rem;
          color: rgba(214, 236, 255, 0.7);
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          align-items: center;
        }

        .status-line span {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }

        .messages {
          margin-top: 48px;
          border: 1px solid rgba(127, 255, 140, 0.35);
          border-radius: 16px;
          overflow: hidden;
          background: rgba(6, 14, 30, 0.92);
          box-shadow: 0 0 40px rgba(127, 255, 140, 0.1);
        }

        .messages-header {
          padding: 18px 20px;
          border-bottom: 1px solid rgba(127, 255, 140, 0.2);
          display: flex;
          justify-content: space-between;
          align-items: center;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 0.9rem;
          color: rgba(214, 236, 255, 0.75);
        }

        ul#message-list {
          list-style: none;
          margin: 0;
          padding: 0;
          max-height: 520px;
          overflow-y: auto;
          scroll-behavior: smooth;
        }

        ul#message-list li {
          padding: 18px 20px;
          border-bottom: 1px solid rgba(127, 255, 140, 0.15);
          display: flex;
          flex-direction: column;
          gap: 6px;
          transition: background 0.2s ease;
        }

        ul#message-list li:nth-child(even) {
          background: rgba(8, 20, 40, 0.35);
        }

        ul#message-list li:hover {
          background: rgba(110, 193, 255, 0.08);
        }

        .message-meta {
          font-size: 0.78rem;
          letter-spacing: 0.1em;
          color: rgba(199, 146, 234, 0.75);
          text-transform: uppercase;
        }

        .message-body {
          font-size: 1.05rem;
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .empty-state {
          padding: 32px;
          text-align: center;
          color: rgba(214, 236, 255, 0.6);
        }

        @media (max-width: 640px) {
          main {
            padding: 40px 18px 72px;
          }

          form {
            padding: 16px;
          }

          ul#message-list li {
            padding: 16px;
          }
        }
      </style>
    </head>
    <body>
      <div class="scanlines" aria-hidden="true"></div>
      <main>
        <header>
          <span class="channel-pill">Channel ${CONFIG.DEFAULT_CHANNEL}</span>
          <h1>Space Terminal Relay</h1>
          <p class="subtitle">Beam a transmission into the public ${CONFIG.DEFAULT_CHANNEL} feed. Messages are relayed through the cosmic ntfy network\u2014anything you type will be visible to all travellers tuned into this channel.</p>
        </header>

        <section class="warning">
          <strong>Heads up:</strong> this is an open frequency. Avoid sending secrets, personal data, or anything you wouldn\u2019t broadcast to the entire galaxy.
        </section>

        <form id="message-form" autocomplete="off">
          <label for="message-input">Message by: <span id="user-avatar" style="font-size: 1.4em; margin-left: 8px;"></span></label>
          <textarea id="message-input" name="message" maxlength="500" required placeholder="Compose your broadcast..."></textarea>
          <button type="submit">Send Transmission</button>
          <div class="status-line" aria-live="polite">
            <span id="form-status">Standing by.</span>
            <span id="refresh-status"></span>
          </div>
        </form>

        <section class="messages">
          <div class="messages-header">
            <span id="last-updated">Last sync: \u2014</span>
          </div>
          <ul id="message-list"></ul>
          <div id="empty-state" class="empty-state" hidden>No transmissions yet. Be the first to broadcast.</div>
        </section>
      </main>

      <script id="initial-state" type="application/json">${initialData}<\/script>
      <script>
        (function() {
          const POLL_INTERVAL = 10000;
          const stateEl = document.getElementById('initial-state');
          const initial = stateEl ? JSON.parse(stateEl.textContent || '{"messages":[]}') : { messages: [] };
          const form = document.getElementById('message-form');
          const messageInput = document.getElementById('message-input');
          const statusEl = document.getElementById('form-status');
          const refreshStatusEl = document.getElementById('refresh-status');
          const listEl = document.getElementById('message-list');
          const emptyStateEl = document.getElementById('empty-state');
          const lastUpdatedEl = document.getElementById('last-updated');
          const HISTORY_LIMIT = ${CONFIG.MESSAGE_HISTORY_LIMIT};
          const initialMessages = Array.isArray(initial.messages) ? initial.messages : [];
          const userAvatarEl = document.getElementById('user-avatar');
          let currentMessages = [];
          let userAvatar = '';

          let isSending = false;
          let lastKnownTime = 0;
          let pollTimer = null;
          let hydrated = false;

          if (window.location.search) {
            try {
              window.history.replaceState(null, '', window.location.pathname || '/');
            } catch (error) {
              console.warn('Failed to normalize URL path', error);
            }
          }

          function setStatus(message) {
            statusEl.textContent = message;
          }

          function setRefreshStatus(message) {
            refreshStatusEl.textContent = message || '';
          }

          function formatTimestamp(epochSeconds) {
            if (!epochSeconds) return 'Unknown';
            try {
              const date = new Date(epochSeconds * 1000);
              return date.toLocaleString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                year: 'numeric',
                month: 'short',
                day: '2-digit'
              });
            } catch (error) {
              console.error('Failed to format timestamp', error);
              return 'Unknown';
            }
          }

          function updateLastUpdated(timestamp) {
            if (!lastUpdatedEl) return;
            const text = timestamp ? formatTimestamp(timestamp) : '\u2014';
            lastUpdatedEl.textContent = 'Last sync: ' + text;
          }

          function coerceMessage(raw) {
            if (!raw || typeof raw !== 'object') {
              return null;
            }

            const messageText = typeof raw.message === 'string' ? raw.message.trim() : '';
            if (!messageText) {
              return null;
            }

            const time = typeof raw.time === 'number' ? raw.time : Math.floor(Date.now() / 1000);
            const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : undefined;
            const idSource = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : (time + '-' + Math.random().toString(16).slice(2));

            return {
              id: idSource,
              message: messageText,
              time,
              title
            };
          }

          function normalizeMessages(list) {
            const seen = new Set();
            const result = [];

            list.forEach(entry => {
              const message = coerceMessage(entry);
              if (!message) {
                return;
              }
              if (seen.has(message.id)) {
                return;
              }
              seen.add(message.id);
              result.push(message);
            });

            result.sort((a, b) => (b.time || 0) - (a.time || 0));
            return result.slice(0, HISTORY_LIMIT);
          }

          function renderMessages() {
            listEl.innerHTML = '';

            if (!currentMessages.length) {
              emptyStateEl.hidden = false;
              return;
            }

            emptyStateEl.hidden = true;

            currentMessages.forEach(msg => {
              const item = document.createElement('li');
              const meta = document.createElement('span');
              const body = document.createElement('span');

              meta.className = 'message-meta';
              const title = msg.title ? msg.title + ' \xB7 ' : '';
              meta.textContent = title + formatTimestamp(msg.time);

              body.className = 'message-body';
              body.textContent = msg.message;

              item.appendChild(meta);
              item.appendChild(body);

              listEl.appendChild(item);
            });
          }

          function setMessages(messages, { notify = false } = {}) {
            const normalized = normalizeMessages(messages);
            const previousTop = currentMessages[0]?.time || 0;
            currentMessages = normalized;
            renderMessages();

            const newest = currentMessages[0];
            if (newest?.time) {
              if (notify && newest.time > previousTop) {
                notifyNewMessage(newest);
              }
              lastKnownTime = Math.max(lastKnownTime, newest.time);
            }

            updateLastUpdated(Math.floor(Date.now() / 1000));
          }

          function appendMessage(message, { notify = true } = {}) {
            if (!message) {
              return;
            }
            setMessages([message, ...currentMessages], { notify });
          }

          function notifyNewMessage(message) {
            if (!('Notification' in window)) {
              return;
            }

            const body = message.title ? message.title + '\\n' + message.message : message.message;

            if (Notification.permission === 'granted') {
              new Notification('New transmission received', {
                body,
                tag: 'retro-terminal-new-message'
              });
            } else if (Notification.permission === 'default') {
              Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                  new Notification('New transmission received', {
                    body,
                    tag: 'retro-terminal-new-message'
                  });
                }
              }).catch(() => {});
            }
          }

          async function fetchMessages() {
            try {
              setRefreshStatus('Synchronizing\u2026');
              const response = await fetch('/api/messages', {
                headers: { 'cache-control': 'no-cache' }
              });

              if (!response.ok) {
                throw new Error('Failed to fetch messages');
              }

              const data = await response.json();
              const messages = Array.isArray(data.messages) ? data.messages : [];
              
              if (data.avatar && !userAvatar) {
                userAvatar = data.avatar;
                if (userAvatarEl) {
                  userAvatarEl.textContent = userAvatar;
                }
              }
              
              setMessages(messages, { notify: hydrated });
              hydrated = true;
              setRefreshStatus('Auto-sync every 10s');
            } catch (error) {
              console.error('Error fetching messages', error);
              setRefreshStatus('Sync failed. Retrying soon\u2026');
            }
          }

          async function submitMessage(event) {
            event.preventDefault();
            if (isSending) {
              return;
            }

            const message = (messageInput.value || '').trim();

            if (!message) {
              setStatus('Message required.');
              return;
            }

            isSending = true;
            setStatus('Transmitting\u2026');

            try {
              const response = await fetch('/api/messages', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json'
                },
                body: JSON.stringify({ message })
              });

              if (!response.ok) {
                throw new Error('Failed to send message');
              }

              const data = await response.json();
              
              if (data.avatar && !userAvatar) {
                userAvatar = data.avatar;
                if (userAvatarEl) {
                  userAvatarEl.textContent = userAvatar;
                }
              }
              
              if (Array.isArray(data.messages)) {
                setMessages(data.messages, { notify: false });
              }

              messageInput.value = '';
              setStatus('Transmission sent.');
            } catch (error) {
              console.error('Failed to send message', error);
              setStatus('Transmission failed. Check your signal.');
            } finally {
              isSending = false;
              setTimeout(() => setStatus('Standing by.'), 3500);
            }
          }

          function bootstrap() {
            setMessages(initialMessages, { notify: false });
            fetchMessages();
            pollTimer = setInterval(fetchMessages, POLL_INTERVAL);
          }

          form?.addEventListener('submit', submitMessage);
          bootstrap();

          window.addEventListener('beforeunload', () => {
            if (pollTimer) {
              clearInterval(pollTimer);
            }
          });
        })();
      <\/script>
    </body>
  </html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}
__name(renderHomepage, "renderHomepage");
async function safeReadText(response) {
  try {
    return await response.text();
  } catch (error) {
    console.error("Failed to read response text", error);
    return "";
  }
}
__name(safeReadText, "safeReadText");
var index_default = worker;
export {
  index_default as default
};