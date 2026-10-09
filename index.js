"use strict";

/*
 * SINZU - BANAT COMMAND CENTER & MESSENGER BOT
 * --------------------------------------------
 * No AI. No games. No economy. No RPG. No music. No database.
 * Features: Connect/Disconnect/Clear UI, C3C login, Admin ID security, Watchdog, & Auto-Ping.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { login } = require("ws3-fca");
const { getTriggerReply, getBanatConversationReply } = require("./triggers");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");

const PORT = Number(process.env.PORT || 10000);
const DEFAULT_ON = /^(1|true|yes|on)$/i.test(process.env.BANAT_DEFAULT_ON || "false");
const GLOBAL_SEND_LIMIT = Math.max(1, Number(process.env.BANAT_GLOBAL_SEND_LIMIT || 2));
const THREAD_COOLDOWN_MS = Math.max(0, Number(process.env.BANAT_THREAD_COOLDOWN_MS || 12000));
const RETRY_DELAYS = [1500, 4000, 8000];

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();
let globalActive = 0;
let botUserID = "";
let currentApi = null;
let isLoggingIn = false;
let stopListening = null;

// Statistics Counters
let messageCount = 0;
let commandCount = 0;
const startTime = Date.now();

// Logs array para sa Logs section
let botLogs = [];
function addLog(text) {
  const time = new Date().toISOString();
  const logEntry = `[${time}] ${text}`;
  botLogs.unshift(logEntry);
  if (botLogs.length > 50) botLogs.pop(); // Limit to 50 logs
}

// Admin ID & Dashboard credentials configuration
let ADMIN_ID = process.env.ADMIN_ID || "";
const DASHBOARD_USER = process.env.DASHBOARD_USER || "Admin";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "admin123";

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function getUptime() {
  const diff = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

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
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  return null;
}

function normalizeSession(value) {
  if (typeof value === "string") {
    const cookie = value.trim();
    if (!cookie) throw new Error("Facebook cookie session is empty.");
    return cookie;
  }

  const entries =
    Array.isArray(value) ? value :
    Array.isArray(value?.appState) ? value.appState :
    Array.isArray(value?.cookies) ? value.cookies :
    null;

  if (!entries) {
    throw new Error("Facebook session must be a cookie string or a JSON array.");
  }

  const parts = entries
    .map(cookie => {
      const key = cookie?.key ?? cookie?.name;
      const val = cookie?.value;
      if (key == null || val == null) return null;
      return String(key).trim() + "=" + String(val);
    })
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("Facebook session contains no valid cookie entries.");
  }

  return parts.join("; ");
}

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
  while (globalActive >= GLOBAL_SEND_LIMIT) await sleep(150);
  globalActive++;
}

function releaseGlobalSlot() { globalActive = Math.max(0, globalActive - 1); }

function is1545012(error) {
  const text = JSON.stringify(error || "");
  return /1545012|temporarily unavailable|message could not be sent/i.test(text);
}

function trafficSendMessage(api, message, threadID, callback, replyToMessageID = null) {
  const key = String(threadID);
  return enqueue(key, async () => {
    const now = Date.now();
    const cooldownUntil = Number(threadCooldown.get(key) || 0);
    if (cooldownUntil > now) {
      callback(new Error(`thread cooldown active for ${cooldownUntil - now}ms`));
      return;
    }

    const sinceLast = now - Number(threadLastSent.get(key) || 0);
    if (sinceLast < THREAD_COOLDOWN_MS) await sleep(THREAD_COOLDOWN_MS - sinceLast);

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
              err ? reject(err) : resolve(info);
            };
            try {
              let returned;
              if (replyToMessageID) returned = api.sendMessage(message, threadID, done, replyToMessageID);
              else returned = api.sendMessage(message, threadID, done);
              if (returned && typeof returned.then === "function") returned.then(info => done(null, info)).catch(done);
            } catch (e) { reject(e); }
          });
          threadLastSent.set(key, Date.now());
          callback(null, result);
          return;
        } catch (error) {
          lastError = error;
          if (!is1545012(error) || attempt >= RETRY_DELAYS.length) break;
          threadCooldown.set(key, Date.now() + Math.min(15000, RETRY_DELAYS[attempt]));
          await sleep(RETRY_DELAYS[attempt]);
          threadCooldown.delete(key);
        }
      }
      if (is1545012(lastError)) threadCooldown.set(key, Date.now() + 5 * 60 * 1000);
      callback(lastError);
    } finally {
      releaseGlobalSlot();
    }
  });
}

function isBanatCommand(body) {
  return /^!banat(?:\s|$)/i.test(String(body || "").trim());
}

function commandSendMessage(api, message, threadID, replyToMessageID = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(info);
    };

    try {
      const returned = replyToMessageID
        ? api.sendMessage(message, threadID, done, replyToMessageID)
        : api.sendMessage(message, threadID, done);

      if (returned && typeof returned.then === "function") {
        returned.then(info => done(null, info)).catch(done);
      }
    } catch (error) {
      done(error);
    }
  });
}

function sendCommandReply(api, event, message) {
  const threadID = String(event.threadID);
  commandSendMessage(api, message, threadID, event.messageID || null)
    .catch(error => {
      addLog(`ERROR command reply failed: ${error?.message || error}`);
    });
}

function handleBanatCommand(api, event, body) {
  const threadID = String(event.threadID);
  const senderID = String(event.senderID || "");

  if (ADMIN_ID && senderID !== ADMIN_ID) {
    sendCommandReply(api, event, "❌ Sulit para sa Admin lang ang command na ito!");
    return true;
  }

  commandCount++;
  const parts = String(body).trim().split(/\s+/);
  const sub = (parts[1] || "status").toLowerCase();

  if (sub === "on" || sub === "enable" || sub === "start") {
    setBanatConversationMode(threadID, true, senderID);
    activeThreads.add(threadID);
    sendCommandReply(api, event, "banat is on. say whatever u want 😭");
    return true;
  }

  if (sub === "off" || sub === "disable" || sub === "stop") {
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    sendCommandReply(api, event, "banat off. peace 😭");
    return true;
  }

  if (sub === "toggle") {
    const next = !isBanatConversationModeActive(threadID);
    setBanatConversationMode(threadID, next, senderID);
    if (next) activeThreads.add(threadID);
    else activeThreads.delete(threadID);
    sendCommandReply(api, event, next ? "banat is on 😭" : "banat is off");
    return true;
  }

  if (sub === "status") {
    const on = activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
    sendCommandReply(api, event, on ? "banat: ON 🟢" : "banat: OFF 🔴");
    return true;
  }

  if (sub === "help") {
    sendCommandReply(api, event, "!banat on · !banat off · !banat toggle · !banat status");
    return true;
  }

  sendCommandReply(api, event, "unknown banat command. use !banat help");
  return true;
}

async function sendBanat(api, event, text) {
  return sendBanatReplyWithTyping(api, text, String(event.threadID), event.messageID || null, {
    trafficSendMessage,
    incomingText: event.body || ""
  });
}

function onMessage(api, event) {
  if (!event) return;
  if (event.type && event.type !== "message") return;
  if (event.senderID && botUserID && String(event.senderID) === String(botUserID)) return;

  const body = String(event.body || "").trim();
  if (!body) return;
  
  messageCount++;
  if (isBanatCommand(body)) { handleBanatCommand(api, event, body); return; }

  const threadID = String(event.threadID);
  const active = activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
  const target = classifyBanatTarget({ event, body, botID: botUserID });

  if (active) {
    const reply = getTriggerReply(body, threadID) || getBanatConversationReply(body, threadID);
    if (reply) {
      sendBanat(api, event, reply).catch(error => addLog(`ERROR reply error: ${error}`));
    }
    return;
  }

  if (target.shouldRespond) {
    const reply = getTriggerReply(body, threadID) || getBanatConversationReply(body, threadID);
    if (reply) sendBanat(api, event, reply).catch(error => addLog(`ERROR target reply: ${error}`));
  }
}

function startBot(apiInstance) {
  currentApi = apiInstance;
  try { botUserID = String(apiInstance.getCurrentUserID?.() || ""); } catch (_) {}

  addLog(`Bot online as ${botUserID}`);
  if (DEFAULT_ON) addLog("BANAT_DEFAULT_ON enabled.");

  stopListening = apiInstance.listenMqtt((error, event) => {
    if (error) {
      addLog(`ERROR listener error / disconnected: ${JSON.stringify(error)}`);
      setTimeout(() => {
        const session = readSession();
        if (session && !isLoggingIn) {
          loginBot(session);
        }
      }, 5000);
      return;
    }
    try {
      if (DEFAULT_ON && event?.threadID && event?.senderID && String(event.senderID) !== botUserID) {
        const key = String(event.threadID);
        if (!activeThreads.has(key)) {
          activeThreads.add(key);
          setBanatConversationMode(key, true, event.senderID);
        }
      }
      onMessage(apiInstance, event);
    } catch (e) {
      addLog(`ERROR message handler error: ${e?.message || e}`);
    }
  });
}

function disconnectBot() {
  if (stopListening && typeof stopListening === "function") {
    try { stopListening(); } catch (e) {}
  }
  stopListening = null;
  currentApi = null;
  botUserID = "";
  addLog("Bot disconnected manually.");
}

function loginBot(sessionData) {
  if (isLoggingIn) return;
  isLoggingIn = true;
  try {
    const cookie = normalizeSession(sessionData);
    addLog("Logging in with session...");
    login(cookie, (error, api) => {
      isLoggingIn = false;
      if (error) {
        addLog(`ERROR login failed: ${error?.message || error}`);
        setTimeout(() => {
          const session = readSession();
          if (session) loginBot(session);
        }, 10000);
        return;
      }
      startBot(api);
    });
  } catch (err) {
    isLoggingIn = false;
    addLog(`ERROR session error: ${err.message}`);
  }
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  rc && rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
}

// SINZU COMMAND CENTER DASHBOARD UI & SERVER
try {
  http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const cookies = parseCookies(req);
      const isAuthed = cookies.auth === "true";

      const urlParts = req.url.split('?');
      const pathname = urlParts[0];

      if (pathname === "/login" && req.method === "POST") {
        const params = new URLSearchParams(body);
        const user = params.get("username");
        const pass = params.get("password");

        if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) {
          res.writeHead(302, {
            "Set-Cookie": "auth=true; HttpOnly; Path=/",
            "Location": "/"
          });
          res.end();
        } else {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(`<h3>Mali ang Username o Password! <a href='/'>Bumalik</a></h3>`);
        }
        return;
      }

      if (pathname === "/logout") {
        res.writeHead(302, {
          "Set-Cookie": "auth=; Max-Age=0; Path=/",
          "Location": "/"
        });
        res.end();
        return;
      }

      if (pathname === "/action" && req.method === "POST" && isAuthed) {
        const params = new URLSearchParams(body);
        const action = params.get("action");
        const appStateInput = params.get("appstate");
        const adminIdInput = params.get("adminid");

        if (adminIdInput) {
          ADMIN_ID = adminIdInput.trim();
        }

        if (action === "connect") {
          if (appStateInput && appStateInput.trim().length > 5) {
            try {
              let parsedState = JSON.parse(appStateInput);
              fs.writeFileSync(path.join(process.cwd(), "appstate.json"), JSON.stringify(parsedState, null, 2));
              disconnectBot();
              loginBot(parsedState);
            } catch (e) {
              addLog(`ERROR parsing appstate: ${e.message}`);
            }
          } else {
            const session = readSession();
            if (session) {
              disconnectBot();
              loginBot(session);
            }
          }
        } else if (action === "disconnect") {
          disconnectBot();
        } else if (action === "clear") {
          botLogs = [];
        }

        res.writeHead(302, { "Location": "/" });
        res.end();
        return;
      }

      // LOGIN SCREEN
      if (!isAuthed && !botUserID) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>SINZU - Login</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { font-family: Arial, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
              .container { width: 100%; max-width: 420px; background: #131b2e; padding: 35px; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.7); border: 1px solid #1e293b; }
              h2 { color: #ffffff; text-align: center; margin-bottom: 5px; font-size: 26px; letter-spacing: 1px; }
              .subtitle { text-align: center; color: #64748b; font-size: 11px; text-transform: uppercase; margin-bottom: 25px; letter-spacing: 2px; }
              label { display: block; margin-top: 15px; font-size: 12px; color: #94a3b8; font-weight: bold; text-transform: uppercase; }
              input { width: 100%; padding: 12px; margin-top: 6px; background: #0b0f19; border: 1px solid #23324a; color: #fff; border-radius: 8px; box-sizing: border-box; font-size: 14px; }
              button { width: 100%; margin-top: 25px; padding: 14px; background: #111827; border: 1px solid #374151; color: white; font-weight: bold; border-radius: 8px; cursor: pointer; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; transition: 0.2s; }
              button:hover { background: #1f2937; border-color: #4b5563; }
              .footer-text { text-align: center; margin-top: 20px; font-size: 11px; color: #475569; }
            </style>
          </head>
          <body>
            <div class="container">
              <h2>SINZU</h2>
              <div class="subtitle">Banat Command Center</div>
              <form method="POST" action="/login">
                <label>Username</label>
                <input type="text" name="username" placeholder="Admin" required>
                <label>Password</label>
                <input type="password" name="password" placeholder="••••••••" required>
                <button type="submit">Login</button>
              </form>
              <div class="footer-text">Authorized dashboard only</div>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // MAIN COMMAND CENTER DASHBOARD WITH CONNECT / DISCONNECT / CLEAR BUTTONS
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>SINZU - Command Center</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; padding: 20px; margin: 0; }
            .container { max-width: 480px; margin: auto; background: #131b2e; padding: 20px; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.6); border: 1px solid #1e293b; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #1e293b; padding-bottom: 15px; }
            h2 { color: #ffffff; margin: 0; font-size: 22px; letter-spacing: 1px; }
            .subtitle { color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 3px; }
            .logout-btn { background: #1a233a; border: 1px solid #2a3754; color: #f8fafc; padding: 6px 14px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; text-decoration: none; text-transform: uppercase; }
            .logout-btn:hover { background: #24304f; }
            
            /* Action Buttons Container sa Taas */
            .action-bar { display: flex; gap: 8px; margin-bottom: 15px; }
            .action-btn { flex: 1; padding: 12px 0; border: none; font-weight: bold; font-size: 12px; border-radius: 8px; cursor: pointer; text-transform: uppercase; color: white; text-align: center; }
            .btn-connect { background: #16a34a; }
            .btn-connect:hover { background: #15803d; }
            .btn-disconnect { background: #dc2626; }
            .btn-disconnect:hover { background: #b91c1c; }
            .btn-clear { background: #374151; }
            .btn-clear:hover { background: #4b5563; }

            .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
            .card-label { font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: bold; letter-spacing: 1px; margin-bottom: 4px; }
            .card-value { font-size: 18px; font-weight: bold; color: #f8fafc; font-family: monospace; }
            .status-online { color: #22c55e; }
            .status-offline { color: #ef4444; }

            .config-section { margin-top: 20px; border-top: 1px solid #1e293b; padding-top: 15px; }
            label { display: block; font-size: 11px; color: #94a3b8; font-weight: bold; margin-bottom: 5px; text-transform: uppercase; }
            textarea, input[type="text"] { width: 100%; padding: 10px; background: #0b0f19; border: 1px solid #23324a; color: #fff; border-radius: 6px; box-sizing: border-box; font-family: monospace; font-size: 12px; }
            textarea { height: 80px; }
            .logs-box { background: #080c14; border: 1px solid #1e293b; border-radius: 8px; padding: 10px; height: 120px; overflow-y: auto; font-family: monospace; font-size: 11px; color: #38bdf8; margin-top: 5px; white-space: pre-wrap; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div>
                <h2>SINZU</h2>
                <div class="subtitle">Banat Command Center</div>
              </div>
              <a href="/logout" class="logout-btn">Logout</a>
            </div>

            <!-- CONNECT, DISCONNECT, CLEAR BUTTONS SA ITAAS -->
            <form method="POST" action="/action">
              <div class="action-bar">
                <button type="submit" name="action" value="connect" class="action-btn btn-connect">Connect</button>
                <button type="submit" name="action" value="disconnect" class="action-btn btn-disconnect">Disconnect</button>
                <button type="submit" name="action" value="clear" class="action-btn btn-clear">Clear</button>
              </div>

              <div class="card" style="margin-bottom: 12px;">
                <div class="card-label">Admin Facebook ID & AppState (C3C)</div>
                <input type="text" name="adminid" value="${ADMIN_ID}" placeholder="Admin Facebook ID" style="margin-bottom: 8px;">
                <textarea name="appstate" placeholder="I-paste ang C3C appState dito kung magpapalit ng account..."></textarea>
              </div>
            </form>

            <div class="card">
              <div class="card-label">Bot Status</div>
              <div class="card-value ${botUserID ? 'status-online' : 'status-offline'}">
                ${botUserID ? 'ONLINE' : 'OFFLINE'}
              </div>
            </div>

            <div class="card">
              <div class="card-label">Bot UID</div>
              <div class="card-value">${botUserID || 'Not Connected'}</div>
            </div>

            <div class="card">
              <div class="card-label">Uptime</div>
              <div class="card-value">${getUptime()}</div>
            </div>

            <div class="card">
              <div class="card-label">Messages</div>
              <div class="card-value">${messageCount}</div>
            </div>

            <div class="card">
              <div class="card-label">Commands</div>
              <div class="card-value">${commandCount}</div>
            </div>

            <div class="card">
              <div class="card-label">Active Threads</div>
              <div class="card-value">${activeThreads.size}</div>
            </div>

            <div class="config-section">
              <label>Messenger Commands</label>
              <div style="font-size: 12px; color: #cbd5e1; font-family: monospace; line-height: 1.6; margin-bottom: 10px;">
                !banat on<br>
                !banat off<br>
                !banat toggle<br>
                !banat status<br>
                !banat help
              </div>

              <label>Logs</label>
              <div class="logs-box">${botLogs.join('\n') || 'No logs yet...'}</div>
            </div>
          </div>
        </body>
        </html>
      `);
    });
  }).listen(PORT, () => {
    addLog(`Dashboard server running on port :${PORT}`);

    // AUTO HEALTH CHECK / SELF-PING WATCHDOG
    const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.BOT_URL || `http://localhost:${PORT}`;
    setInterval(() => {
      const client = selfUrl.startsWith("https") ? https : http;
      client.get(selfUrl, (res) => {
        // Ping success
      }).on("err", (err) => {
        // Ping error ignored
      });
    }, 4 * 60 * 1000);
  });
} catch (error) {
  console.error("[SINZU] dashboard server failed:", error);
}

// Auto-login sa simula kung may session na
const initialSession = readSession();
if (initialSession) {
  loginBot(initialSession);
} else {
  addLog("Walang nakitang session. I-paste ang C3C appState sa dashboard at i-click ang Connect.");
}

module.exports = { trafficSendMessage, onMessage, handleBanatCommand };
