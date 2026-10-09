"use strict";

/*
 * BANAT-ONLY MESSENGER BOT + EMBEDDED DASHBOARD (CRESI FRAMEWORK)
 * -------------------------------------------------------------
 *
 * DASHBOARD LOGIN:
 *   Username: Admin
 *   Password: sinzuontop
 *
 * MESSENGER COMMANDS (Admin Only):
 *   .                  (Banat ON + ❤️ reaction)
 *   ..                 (Banat OFF + 💤 reaction)
 *   .setallnick <name> (Set all nicknames + ❤️ reaction)
 *   ..restoreallnick   (Restore nicknames + 💤 reaction)
 *   .nickprotect       (Check nickname protection status)
 *   .lockgcname <name> (Lock GC name + ❤️ reaction)
 *   .lockgcname        (Unlock GC name kung walang pangalan + 💤 reaction)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const { login } = require("ws3-fca");

const {
  getTriggerReply,
  getBanatConversationReply
} = require("./triggers");

const {
  sendBanatReplyWithTyping
} = require("./banat-human");

const {
  classifyBanatTarget,
  setBanatConversationMode,
  isBanatConversationModeActive
} = require("./banat-targeting");

// Pag-import ng mga protection modules
const {
  handleCommand: handleNickCommand,
  protectNickname
} = require("./nickname-protection");

const {
  handleCommand: handleGCNameCommand,
  protectGCName
} = require("./gcname-protection");


/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const DASHBOARD_USERNAME = "Admin";
const DASHBOARD_PASSWORD = "sinzuontop";

/*
 * ADMIN RESTRICTION CONFIG (Ikaw lang ang pwedeng mag-command)
 */
const ADMIN_IDS = [
  "61595204307407"
];


/* BANAT SETTINGS */

const DEFAULT_ON =
  /^(1|true|yes|on)$/i.test(
    process.env.BANAT_DEFAULT_ON || "false"
  );

const GLOBAL_SEND_LIMIT = Math.max(
  1,
  Number(
    process.env.BANAT_GLOBAL_SEND_LIMIT || 2
  )
);

const THREAD_COOLDOWN_MS = Math.max(
  0,
  Number(
    process.env.BANAT_THREAD_COOLDOWN_MS ||
    12000
  )
);

const RETRY_DELAYS = [
  1500,
  4000,
  8000
];


/* =========================================================
   BOT STATE
========================================================= */

let api = null;
let botUserID = "";
let botConnectedAt = 0;
let botConnecting = false;

let messageCount = 0;
let commandCount = 0;

const activeThreads = new Set();

const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();

let globalActive = 0;


/* =========================================================
   DASHBOARD SESSION STATE
========================================================= */

const dashboardSessions = new Map();

const SESSION_MAX_AGE =
  24 * 60 * 60 * 1000;


/* =========================================================
   DASHBOARD LOG BUFFER
========================================================= */

const dashboardLogs = [];

const MAX_LOGS = 150;


const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;


console.log = (...args) => {
  const message = args
    .map(value => {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    })
    .join(" ");

  dashboardLogs.push(`[${new Date().toISOString()}] ${message}`);
  if (dashboardLogs.length > MAX_LOGS) dashboardLogs.shift();
  originalConsoleLog(...args);
};


console.error = (...args) => {
  const message = args
    .map(value => {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    })
    .join(" ");

  dashboardLogs.push(`[${new Date().toISOString()}] ERROR ${message}`);
  if (dashboardLogs.length > MAX_LOGS) dashboardLogs.shift();
  originalConsoleError(...args);
};


console.warn = (...args) => {
  const message = args
    .map(value => {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    })
    .join(" ");

  dashboardLogs.push(`[${new Date().toISOString()}] WARN ${message}`);
  if (dashboardLogs.length > MAX_LOGS) dashboardLogs.shift();
  originalConsoleWarn(...args);
};


/* =========================================================
   UTILS
========================================================= */

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


/* =========================================================
   SESSION READER
========================================================= */

function readSession() {
  const raw = process.env.FB_COOKIES || process.env.FB_APPSTATE;
  if (raw) {
    const trimmed = String(raw).trim();
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return trimmed;
    }
  }

  for (const file of ["appstate.json", "cookies.json"]) {
    const filePath = path.join(process.cwd(), file);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  }

  throw new Error("No Facebook session found.");
}


/* =========================================================
   NORMALIZE SESSION
========================================================= */

function normalizeSession(value) {
  if (!value) throw new Error("C3C session data is empty.");
  let sessionData = value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("C3C session string is empty.");
    try {
      sessionData = JSON.parse(trimmed);
    } catch (error) {
      throw new Error("Invalid C3C format.");
    }
  }
  return sessionData;
}


/* =========================================================
   QUEUE & TRAFFIC SEND
========================================================= */

function enqueue(threadID, job) {
  const key = String(threadID);
  const current = threadQueues.get(key) || Promise.resolve();
  const next = current.catch(() => {}).then(job).finally(() => {
    if (threadQueues.get(key) === next) threadQueues.delete(key);
  });
  threadQueues.set(key, next);
  return next;
}

async function acquireGlobalSlot() {
  while (globalActive >= GLOBAL_SEND_LIMIT) {
    await sleep(150);
  }
  globalActive++;
}

function releaseGlobalSlot() {
  globalActive = Math.max(0, globalActive - 1);
}

function is1545012(error) {
  return /1545012|temporarily unavailable|message could not be sent/i.test(JSON.stringify(error || ""));
}

function trafficSendMessage(apiInstance, message, threadID, callback, replyToMessageID = null) {
  const key = String(threadID);
  return enqueue(key, async () => {
    const now = Date.now();
    const cooldownUntil = Number(threadCooldown.get(key) || 0);
    if (cooldownUntil > now) {
      callback(new Error(`thread cooldown active`));
      return;
    }

    const sinceLast = now - Number(threadLastSent.get(key) || 0);
    if (sinceLast < THREAD_COOLDOWN_MS) {
      await sleep(THREAD_COOLDOWN_MS - sinceLast);
    }

    await acquireGlobalSlot();

    try {
      let lastError = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const result = await new Promise((resolve, reject) => {
            let settled = false;
            const done = (err, info) => {
              if (settled) return;
              settled = true;
              if (err) reject(err); else resolve(info);
            };

            try {
              let returned = replyToMessageID
                ? apiInstance.sendMessage(message, threadID, done, replyToMessageID)
                : apiInstance.sendMessage(message, threadID, done);

              if (returned && typeof returned.then === "function") {
                returned.then(info => done(null, info)).catch(done);
              }
            } catch (error) {
              reject(error);
            }
          });

          threadLastSent.set(key, Date.now());
          callback(null, result);
          return;
        } catch (error) {
          lastError = error;
          if (!is1545012(error) || attempt >= RETRY_DELAYS.length) break;
          await sleep(RETRY_DELAYS[attempt]);
        }
      }
      callback(lastError);
    } finally {
      releaseGlobalSlot();
    }
  });
}


/* =========================================================
   BANAT COMMAND CHECK (".", "..")
========================================================= */

function isBanatCommand(body) {
  const clean = String(body || "").trim();
  return clean === "." || clean === "..";
}

function commandSendMessage(apiInstance, message, threadID, replyToMessageID = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(info);
    };

    try {
      const returned = replyToMessageID
        ? apiInstance.sendMessage(message, threadID, done, replyToMessageID)
        : apiInstance.sendMessage(message, threadID, done);

      if (returned && typeof returned.then === "function") {
        returned.then(info => done(null, info)).catch(done);
      }
    } catch (error) {
      done(error);
    }
  });
}

function sendCommandReply(apiInstance, event, message, reactionEmoji = null) {
  const threadID = String(event.threadID);
  const messageID = event.messageID || null;

  if (reactionEmoji && messageID && typeof apiInstance.setMessageReaction === "function") {
    apiInstance.setMessageReaction(reactionEmoji, messageID, () => {}, true);
  }

  commandSendMessage(apiInstance, message, threadID, messageID)
    .catch(error => console.error("[BANAT] command reply failed:", error));
}

function handleBanatCommand(apiInstance, event, body) {
  const threadID = String(event.threadID);
  const clean = String(body).trim();

  if (clean === ".") {
    setBanatConversationMode(threadID, true, event.senderID);
    activeThreads.add(threadID);
    sendCommandReply(apiInstance, event, "banat is on. say whatever u want 😭", "❤️");
    return true;
  }

  if (clean === "..") {
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    sendCommandReply(apiInstance, event, "banat off. peace 😭", "💤");
    return true;
  }

  return false;
}

async function sendBanat(apiInstance, event, text) {
  return sendBanatReplyWithTyping(
    apiInstance,
    text,
    String(event.threadID),
    event.messageID || null,
    { trafficSendMessage, incomingText: event.body || "" }
  );
}


/* =========================================================
   MESSAGE HANDLER
========================================================= */

function onMessage(apiInstance, event) {
  try {
    if (!event) return;
    if (event.type && event.type !== "message") return;
    if (event.senderID && botUserID && String(event.senderID) === String(botUserID)) return;

    const body = String(event.body || "").trim();
    if (!body) return;

    const senderID = String(event.senderID || "");
    messageCount++;

    // 1. Suriin kung Nickname Protection Command
    if (handleNickCommand(apiInstance, event, body)) {
      if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(senderID)) return;
      return;
    }

    // 2. Suriin kung GC Name Protection Command (.lockgcname)
    if (handleGCNameCommand(apiInstance, event, body)) {
      if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(senderID)) return;
      return;
    }

    // 3. Banat On/Off Commands
    if (isBanatCommand(body)) {
      if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(senderID)) return;
      commandCount++;
      handleBanatCommand(apiInstance, event, body);
      return;
    }

    const threadID = String(event.threadID);
    const active = activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
    const target = classifyBanatTarget({ event, body, botID: botUserID });

    if (active || (target && target.shouldRespond)) {
      const reply =
        (typeof getTriggerReply === "function" ? getTriggerReply(body, threadID) : null) ||
        (typeof getBanatConversationReply === "function" ? getBanatConversationReply(body, threadID) : null);

      if (reply) {
        sendBanat(apiInstance, event, reply).catch(error => {
          console.error("[BANAT] reply error:", error?.message || error);
        });
      }
    }
  } catch (err) {
    console.error("[CRITICAL MESSAGE HANDLER ERROR]:", err?.message || err);
  }
}


/* =========================================================
   BOT START & LISTEN
========================================================= */

function start(apiInstance) {
  api = apiInstance;
  try {
    botUserID = String(apiInstance.getCurrentUserID?.() || "");
  } catch (_) {
    botUserID = "";
  }

  botConnectedAt = Date.now();
  botConnecting = false;

  apiInstance.listenMqtt((error, event) => {
    if (error) {
      console.error("[BANAT] listener error:", error);
      return;
    }

    try {
      // Saluhin ang mga pagbabago sa GC para sa protections
      if (event?.logMessageType === "log:user-nickname") {
        protectNickname(apiInstance, event);
      }
      if (event?.logMessageType === "log:thread-name") {
        protectGCName(apiInstance, event);
      }

      onMessage(apiInstance, event);
    } catch (error) {
      console.error("[BANAT] outer listener error:", error);
    }
  });

  console.log(`[BANAT] online${botUserID ? ` as ${botUserID}` : ""}`);
}


/* =========================================================
   CONNECT / DISCONNECT
========================================================= */

function connectBotWithSession(session) {
  if (botConnecting) return Promise.reject(new Error("Bot is already connecting."));
  botConnecting = true;

  let appStateData;
  try {
    appStateData = normalizeSession(session);
  } catch (error) {
    botConnecting = false;
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    function finishError(error) {
      if (finished) return;
      finished = true;
      botConnecting = false;
      reject(error);
    }

    try {
      login(appStateData, (error, loggedApi) => {
        if (error) { finishError(error); return; }
        if (!loggedApi) { finishError(new Error("No API object.")); return; }

        try {
          start(loggedApi);
          finished = true;
          botConnecting = false;
          resolve({ ok: true });
        } catch (error) {
          finishError(error);
        }
      });
    } catch (error) {
      finishError(error);
    }
  });
}

function disconnectBot() {
  if (!api) return false;
  try { if (typeof api.logout === "function") api.logout(() => {}); } catch (_) {}
  api = null;
  botUserID = "";
  botConnectedAt = 0;
  botConnecting = false;
  console.log("[BANAT] disconnected.");
  return true;
}


/* =========================================================
   DASHBOARD AUTH & UTILS
========================================================= */

function createDashboardSession() {
  cleanupDashboardSessions();
  const token = crypto.randomBytes(48).toString("hex");
  dashboardSessions.set(token, { createdAt: Date.now() });
  return token;
}

function cleanupDashboardSessions() {
  const now = Date.now();
  for (const [token, session] of dashboardSessions) {
    const createdAt = typeof session === "object" ? session.createdAt : session;
    if (!createdAt || now - createdAt > SESSION_MAX_AGE) dashboardSessions.delete(token);
  }
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const cookies = header.split(";").map(v => v.trim());
  for (const item of cookies) {
    const index = item.indexOf("=");
    if (index === -1) continue;
    if (item.slice(0, index) === name) {
      try { return decodeURIComponent(item.slice(index + 1)); } catch (_) { return item.slice(index + 1); }
    }
  }
  return null;
}

function isDashboardAuthenticated(req) {
  cleanupDashboardSessions();
  const token = getCookie(req, "dashboard_session");
  if (!token) return false;
  const session = dashboardSessions.get(token);
  if (!session) return false;
  const createdAt = typeof session === "object" ? session.createdAt : session;
  if (!createdAt || Date.now() - createdAt > SESSION_MAX_AGE) {
    dashboardSessions.delete(token);
    return false;
  }
  return true;
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Pragma": "no-cache"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) { reject(new Error("Too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function startWatchdog() {
  setInterval(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`, { cache: "no-store" });
      const data = await response.json();
      console.log(`[WATCHDOG] Self-ping success: status ${response.status}, bot: ${data.bot}`);
    } catch (error) {
      console.error("[WATCHDOG] Ping failed:", error?.message || error);
    }
  }, 4 * 60 * 1000);
}


/* =========================================================
   DASHBOARD HTML & INTERFACE (Updated with all commands)
========================================================= */

function dashboardLoginHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sinzu • Login</title><style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#080a0d; color:#fff; font-family:Arial,sans-serif; }
  .login-box { width:min(420px,92%); padding:30px; border:1px solid #30363d; border-radius:18px; background:rgba(15,18,13,.96); }
  input { width:100%; padding:13px; border-radius:10px; border:1px solid #30363d; background:#0d1117; color:white; margin:10px 0; }
  button { width:100%; padding:13px; border:0; border-radius:10px; background:#fff; color:#080a0d; font-weight:bold; cursor:pointer; margin-top:15px; }
  </style></head><body>
  <div class="login-box"><h2>SINZU ADMIN LOGIN</h2>
  <form id="loginForm"><label>Username</label><input id="username" required><label>Password</label><input id="password" type="password" required><button type="submit">LOGIN</button></form></div>
  <script>
  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value }) });
    if(res.ok) window.location.replace('/'); else alert('Invalid credentials');
  });</script></body></html>`;
}

function dashboardHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sinzu • Dashboard</title><style>
  body { margin:0; background:#090b0f; color:#f0f6fc; font-family:Arial,sans-serif; }
  header { padding:20px; background:#0d1117; border-bottom:1px solid #21262d; display:flex; justify-content:space-between; align-items:center; }
  .container { width:min(1100px,94%); margin:25px auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:15px; margin-bottom:20px; }
  .card { background:#0d1117; border:1px solid #21262d; border-radius:14px; padding:18px; }
  .stat { font-size:22px; font-weight:bold; margin-top:5px; }
  textarea { width:100%; min-height:140px; background:#080b0f; color:#fff; border:1px solid #30363d; border-radius:10px; padding:12px; }
  button { padding:10px 15px; border:0; border-radius:8px; font-weight:bold; cursor:pointer; }
  .connect { background:#238636; color:#fff; } .disconnect { background:#da3633; color:#fff; }
  .logs { background:#05070a; border:1px solid #21262d; padding:10px; height:250px; overflow:auto; font-family:monospace; font-size:11px; color:#8b949e; white-space:pre-wrap; }
  </style></head><body>
  <header><h2>SINZU COMMAND CENTER</h2><button onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.replace('/'))">LOGOUT</button></header>
  <div class="container">
    <div class="grid">
      <div class="card"><div>Status</div><div id="status" class="stat" style="color:#f85149">OFFLINE</div></div>
      <div class="card"><div>Bot UID</div><div id="uid" class="stat">-</div></div>
      <div class="card"><div>Uptime</div><div id="uptime" class="stat">0s</div></div>
      <div class="card"><div>Messages</div><div id="messages" class="stat">0</div></div>
    </div>
    <div class="card"><h2>C3C AppState Session</h2><textarea id="session" placeholder="Paste session JSON here..."></textarea>
    <div style="margin-top:10px"><button class="connect" onclick="connectBot()">CONNECT</button> <button class="disconnect" onclick="disconnectBot()">DISCONNECT</button></div></div>
    <div class="card"><h2>Messenger Commands</h2><pre style="color:#c9d1d9; font-size:12px;">
.                  (Banat ON + ❤️)
..                 (Banat OFF + 💤)
.setallnick <name> (Set All Nickname + ❤️)
..restoreallnick   (Restore Nickname + 💤)
.nickprotect       (Check Nickname Status)
.lockgcname <name> (Lock GC Name + ❤️)
.lockgcname        (Unlock GC Name + 💤)
    </pre></div>
    <div class="card"><h2>Live Logs</h2><div id="logs" class="logs">Loading logs...</div></div>
  </div>
  <script>
  async function refresh() {
    const res = await fetch('/api/status');
    if(res.status === 401) { location.replace('/'); return; }
    const data = await res.json();
    document.getElementById('status').textContent = data.connected ? 'ONLINE' : 'OFFLINE';
    document.getElementById('status').style.color = data.connected ? '#3fb950' : '#f85149';
    document.getElementById('uid').textContent = data.userID || '-';
    document.getElementById('uptime').textContent = Math.floor(data.uptime / 60) + 'm ' + (data.uptime % 60) + 's';
    document.getElementById('messages').textContent = data.messageCount;
    const l = document.getElementById('logs');
    l.textContent = (data.logs || []).join('\\n');
    l.scrollTop = l.scrollHeight;
  }
  async function connectBot() {
    const session = document.getElementById('session').value.trim();
    if(!session) { alert('Paste appstate first'); return; }
    const res = await fetch('/api/connect', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({session}) });
    const d = await res.json(); alert(d.ok ? 'Connected!' : d.error);
    refresh();
  }
  async function disconnectBot() {
    await fetch('/api/disconnect', { method:'POST' });
    alert('Disconnected'); refresh();
  }
  setInterval(refresh, 3000); refresh();
  </script></body></html>`;
}


/* =========================================================
   HTTP SERVER
========================================================= */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/api/login" && req.method === "POST") {
      const raw = await readBody(req);
      const body = JSON.parse(raw || "{}");
      if (body.username !== DASHBOARD_USERNAME || body.password !== DASHBOARD_PASSWORD) {
        sendJSON(res, 401, { ok: false, error: "Invalid credentials" });
        return;
      }
      const token = createDashboardSession();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `dashboard_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      const token = getCookie(req, "dashboard_session");
      if (token) dashboardSessions.delete(token);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "dashboard_session=; Path=/; HttpOnly; Max-Age=0"
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/" || pathname === "/dashboard") {
      if (!isDashboardAuthenticated(req)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(dashboardLoginHTML());
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboardHTML());
      return;
    }

    if (pathname.startsWith("/api/") && !isDashboardAuthenticated(req)) {
      sendJSON(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (pathname === "/api/status" && req.method === "GET") {
      sendJSON(res, 200, {
        ok: true,
        connected: !!api,
        connecting: botConnecting,
        userID: botUserID || "",
        uptime: api && botConnectedAt ? Math.floor((Date.now() - botConnectedAt) / 1000) : 0,
        messageCount,
        commandCount,
        activeThreads: activeThreads.size,
        logs: dashboardLogs.slice(-80)
      });
      return;
    }

    if (pathname === "/api/connect" && req.method === "POST") {
      if (api) { sendJSON(res, 400, { ok: false, error: "Already connected" }); return; }
      const raw = await readBody(req);
      const body = JSON.parse(raw || "{}");
      await connectBotWithSession(body.session);
      sendJSON(res, 200, { ok: true, userID: botUserID });
      return;
    }

    if (pathname === "/api/disconnect" && req.method === "POST") {
      const disconnected = disconnectBot();
      sendJSON(res, 200, { ok: true, disconnected });
      return;
    }

    if (pathname === "/health") {
      const memoryUsage = process.memoryUsage();
      sendJSON(res, 200, {
        ok: true,
        bot: !!api ? "connected" : "disconnected",
        uptime: Math.floor(process.uptime()),
        memory: { rssMB: Math.round(memoryUsage.rss / 1024 / 1024) },
        timestamp: new Date().toISOString()
      });
      return;
    }

    sendJSON(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: error?.message || "Internal error" });
  }
});


/* =========================================================
   SERVER START
========================================================= */

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[DASHBOARD] running on port ${PORT}`);
  startWatchdog();
});

const hasSavedSession =
  !!(process.env.FB_COOKIES || process.env.FB_APPSTATE) ||
  fs.existsSync(path.join(process.cwd(), "appstate.json")) ||
  fs.existsSync(path.join(process.cwd(), "cookies.json"));

if (hasSavedSession) {
  try {
    connectBotWithSession(readSession())
      .then(() => console.log("[BANAT] automatic login successful."))
      .catch(error => console.error("[BANAT] auto login failed:", error?.message));
  } catch (error) {
    console.error("[BANAT] saved session error:", error?.message);
  }
}

module.exports = {
  trafficSendMessage,
  onMessage,
  handleBanatCommand
};
