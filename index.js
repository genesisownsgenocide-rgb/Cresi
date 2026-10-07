"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const { login } = require("ws3-fca");

/*
 * ============================================================
 * EXISTING HUMAN / BANAT SYSTEM
 * HUWAG GALAWIN ANG MGA FILE NA ITO.
 * ============================================================
 */
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

/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_USER = process.env.DASHBOARD_USER || "admin";
const ADMIN_PASS = process.env.DASHBOARD_PASS || "halimaw123";

const DEFAULT_ON =
  /^(1|true|yes|on)$/i.test(
    process.env.BANAT_DEFAULT_ON || "false"
  );

const GLOBAL_SEND_LIMIT = Math.max(
  1,
  Number(process.env.BANAT_GLOBAL_SEND_LIMIT || 2)
);

const THREAD_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.BANAT_THREAD_COOLDOWN_MS || 12000)
);

const RETRY_DELAYS = [1500, 4000, 8000];

/*
 * Official Admin UID
 */
const ADMIN_UID = "61595204307407";

/*
 * ============================================================
 * BOT STATE
 * ============================================================
 */

let botApi = null;
let botUserID = "";
let botName = "";
let botStatus = "OFFLINE";
let botError = "";
let botLoginAt = null;
let botConnecting = false;

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();

let globalActive = 0;

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function uptimeText() {
  const sec = Math.floor(process.uptime());

  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

/*
 * ============================================================
 * SESSION / APPSTATE
 * ============================================================
 */

function normalizeSession(value) {
  if (typeof value === "string") {
    const cookie = value.trim();

    if (!cookie) {
      throw new Error("Empty Facebook session.");
    }

    return cookie;
  }

  const entries =
    Array.isArray(value)
      ? value
      : Array.isArray(value?.appState)
        ? value.appState
        : Array.isArray(value?.cookies)
          ? value.cookies
          : null;

  if (!entries) {
    throw new Error(
      "AppState must be a JSON array or an object containing appState/cookies."
    );
  }

  const parts = entries
    .map(cookie => {
      const key = cookie?.key ?? cookie?.name;
      const val = cookie?.value;

      if (key == null || val == null) {
        return null;
      }

      return `${String(key).trim()}=${String(val)}`;
    })
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("No valid cookies found in AppState.");
  }

  return parts.join("; ");
}

function parseSessionInput(input) {
  const text = String(input || "").trim();

  if (!text) {
    throw new Error("Ilagay muna ang AppState/C3C.");
  }

  /*
   * JSON AppState
   */
  if (
    text.startsWith("[") ||
    text.startsWith("{")
  ) {
    try {
      return normalizeSession(JSON.parse(text));
    } catch (error) {
      /*
       * Kung valid cookie string na mukhang JSON-like,
       * fallback below.
       */
    }
  }

  /*
   * Cookie string
   */
  return normalizeSession(text);
}

function getSavedSession() {
  const envSession =
    process.env.FB_APPSTATE ||
    process.env.FB_COOKIES;

  if (envSession) {
    try {
      return parseSessionInput(envSession);
    } catch (_) {}
  }

  const appStatePath = path.join(
    process.cwd(),
    "appstate.json"
  );

  if (fs.existsSync(appStatePath)) {
    const raw = fs.readFileSync(
      appStatePath,
      "utf8"
    );

    return parseSessionInput(raw);
  }

  return null;
}

function saveSession(rawInput) {
  /*
   * HINDI ipinapakita sa dashboard pagkatapos ma-save.
   */
  const parsed = JSON.parse(rawInput);

  /*
   * Validate first.
   */
  normalizeSession(parsed);

  const filePath = path.join(
    process.cwd(),
    "appstate.json"
  );

  fs.writeFileSync(
    filePath,
    JSON.stringify(parsed, null, 2),
    "utf8"
  );
}

/*
 * ============================================================
 * BOT ACCOUNT INFORMATION
 * ============================================================
 */

async function getBotAccountInfo(api) {
  let uid = "";

  try {
    uid = String(
      api.getCurrentUserID?.() || ""
    );
  } catch (_) {}

  botUserID = uid;

  if (!uid) {
    botName = "Unknown";
    return;
  }

  /*
   * ws3-fca normally exposes getUserInfo.
   */
  try {
    const info = await new Promise(resolve => {
      if (
        !api.getUserInfo ||
        typeof api.getUserInfo !== "function"
      ) {
        resolve(null);
        return;
      }

      api.getUserInfo(
        uid,
        (error, result) => {
          if (error) {
            resolve(null);
            return;
          }

          resolve(result);
        }
      );
    });

    if (info && info[uid]) {
      botName =
        info[uid].name ||
        info[uid].firstName ||
        "Unknown";
    } else {
      botName = "Unknown";
    }
  } catch (_) {
    botName = "Unknown";
  }
}

/*
 * ============================================================
 * BANAT TRAFFIC SYSTEM
 * EXISTING LOGIC PRESERVED
 * ============================================================
 */

function enqueue(threadID, job) {
  const key = String(threadID);

  const current =
    threadQueues.get(key) ||
    Promise.resolve();

  const next = current
    .catch(() => {})
    .then(job)
    .finally(() => {
      if (threadQueues.get(key) === next) {
        threadQueues.delete(key);
      }
    });

  threadQueues.set(key, next);

  return next;
}

async function acquireGlobalSlot() {
  while (
    globalActive >= GLOBAL_SEND_LIMIT
  ) {
    await sleep(150);
  }

  globalActive++;
}

function releaseGlobalSlot() {
  globalActive = Math.max(
    0,
    globalActive - 1
  );
}

function is1545012(error) {
  const text = JSON.stringify(
    error || ""
  );

  return /1545012|temporarily unavailable|message could not be sent/i.test(
    text
  );
}

function trafficSendMessage(
  api,
  message,
  threadID,
  callback,
  replyToMessageID = null
) {
  const key = String(threadID);

  return enqueue(key, async () => {
    const now = Date.now();

    const cooldownUntil = Number(
      threadCooldown.get(key) || 0
    );

    if (cooldownUntil > now) {
      callback(
        new Error(
          `thread cooldown active for ${
            cooldownUntil - now
          }ms`
        )
      );

      return;
    }

    const sinceLast =
      now -
      Number(
        threadLastSent.get(key) || 0
      );

    if (
      sinceLast <
      THREAD_COOLDOWN_MS
    ) {
      await sleep(
        THREAD_COOLDOWN_MS -
          sinceLast
      );
    }

    await acquireGlobalSlot();

    try {
      let lastError = null;

      for (
        let attempt = 0;
        attempt <= RETRY_DELAYS.length;
        attempt++
      ) {
        try {
          const result =
            await new Promise(
              (resolve, reject) => {
                let settled = false;

                const done = (
                  err,
                  info
                ) => {
                  if (settled) return;

                  settled = true;

                  if (err) {
                    reject(err);
                  } else {
                    resolve(info);
                  }
                };

                try {
                  let returned;

                  if (
                    replyToMessageID
                  ) {
                    returned =
                      api.sendMessage(
                        message,
                        threadID,
                        done,
                        replyToMessageID
                      );
                  } else {
                    returned =
                      api.sendMessage(
                        message,
                        threadID,
                        done
                      );
                  }

                  if (
                    returned &&
                    typeof returned.then ===
                      "function"
                  ) {
                    returned
                      .then(info =>
                        done(null, info)
                      )
                      .catch(done);
                  }
                } catch (error) {
                  reject(error);
                }
              }
            );

          threadLastSent.set(
            key,
            Date.now()
          );

          callback(null, result);
          return;
        } catch (error) {
          lastError = error;

          if (
            !is1545012(error) ||
            attempt >=
              RETRY_DELAYS.length
          ) {
            break;
          }

          threadCooldown.set(
            key,
            Date.now() +
              Math.min(
                15000,
                RETRY_DELAYS[attempt]
              )
          );

          await sleep(
            RETRY_DELAYS[attempt]
          );

          threadCooldown.delete(
            key
          );
        }
      }

      if (is1545012(lastError)) {
        threadCooldown.set(
          key,
          Date.now() +
            5 * 60 * 1000
        );
      }

      callback(lastError);
    } finally {
      releaseGlobalSlot();
    }
  });
}

function isBanatCommand(body) {
  return /^!(?:banat|troll)(?:\s|$)/i.test(
    String(body || "").trim()
  );
}

function commandSendMessage(
  api,
  message,
  threadID,
  replyToMessageID = null
) {
  return new Promise(
    (resolve, reject) => {
      let settled = false;

      const done = (
        err,
        info
      ) => {
        if (settled) return;

        settled = true;

        if (err) {
          reject(err);
        } else {
          resolve(info);
        }
      };

      try {
        const returned =
          replyToMessageID
            ? api.sendMessage(
                message,
                threadID,
                done,
                replyToMessageID
              )
            : api.sendMessage(
                message,
                threadID,
                done
              );

        if (
          returned &&
          typeof returned.then ===
            "function"
        ) {
          returned
            .then(info =>
              done(null, info)
            )
            .catch(done);
        }
      } catch (error) {
        done(error);
      }
    }
  );
}

function sendCommandReply(
  api,
  event,
  message
) {
  const threadID = String(
    event.threadID
  );

  commandSendMessage(
    api,
    message,
    threadID,
    event.messageID || null
  )
    .then(() =>
      console.log(
        `[BANAT] command reply sent: ${message}`
      )
    )
    .catch(error =>
      console.error(
        "[BANAT] command reply failed:",
        error?.message || error
      )
    );
}

function handleBanatCommand(
  api,
  event,
  body
) {
  const threadID = String(
    event.threadID
  );

  const senderID = String(
    event.senderID || ""
  );

  const parts = String(body)
    .trim()
    .split(/\s+/);

  const cmd = (
    parts[0] || ""
  ).toLowerCase();

  const sub = (
    parts[1] || "status"
  ).toLowerCase();

  if (cmd === "!troll") {
    if (
      senderID !== ADMIN_UID
    ) {
      sendCommandReply(
        api,
        event,
        "❌ Hoy, hindi ka admin! Tigil-tigilan mo yan."
      );

      return true;
    }

    const targetUID =
      parts[1] || "wala";

    sendCommandReply(
      api,
      event,
      `👑 Admin access granted. Na-troll ang target ID: ${targetUID}`
    );

    return true;
  }

  if (
    sub === "on" ||
    sub === "enable" ||
    sub === "start"
  ) {
    setBanatConversationMode(
      threadID,
      true,
      event.senderID
    );

    activeThreads.add(
      threadID
    );

    console.log(
      `[BANAT] activated thread ${threadID} by ${
        event.senderID || "unknown"
      }`
    );

    sendCommandReply(
      api,
      event,
      "banat is on. say whatever u want 😭"
    );

    return true;
  }

  if (
    sub === "off" ||
    sub === "disable" ||
    sub === "stop"
  ) {
    setBanatConversationMode(
      threadID,
      false
    );

    activeThreads.delete(
      threadID
    );

    console.log(
      `[BANAT] deactivated thread ${threadID}`
    );

    sendCommandReply(
      api,
      event,
      "banat off. peace 😭"
    );

    return true;
  }

  if (sub === "toggle") {
    const next =
      !isBanatConversationModeActive(
        threadID
      );

    setBanatConversationMode(
      threadID,
      next,
      event.senderID
    );

    if (next) {
      activeThreads.add(
        threadID
      );
    } else {
      activeThreads.delete(
        threadID
      );
    }

    sendCommandReply(
      api,
      event,
      next
        ? "banat is on 😭"
        : "banat is off"
    );

    return true;
  }

  if (sub === "status") {
    const on =
      activeThreads.has(
        threadID
      ) ||
      isBanatConversationModeActive(
        threadID
      );

    sendCommandReply(
      api,
      event,
      on
        ? "banat: ON 🟢"
        : "banat: OFF 🔴"
    );

    return true;
  }

  if (sub === "help") {
    sendCommandReply(
      api,
      event,
      "!banat on · !banat off · !banat toggle · !banat status · !troll [uid]"
    );

    return true;
  }

  sendCommandReply(
    api,
    event,
    "unknown banat command. use !banat help"
  );

  return true;
}

async function sendBanat(
  api,
  event,
  text
) {
  return sendBanatReplyWithTyping(
    api,
    text,
    String(event.threadID),
    event.messageID || null,
    {
      trafficSendMessage,
      incomingText:
        event.body || ""
    }
  );
}

function onMessage(
  api,
  event
) {
  if (!event) return;

  if (
    event.type &&
    event.type !== "message"
  ) {
    return;
  }

  if (
    event.senderID &&
    botUserID &&
    String(event.senderID) ===
      String(botUserID)
  ) {
    return;
  }

  const body = String(
    event.body || ""
  ).trim();

  if (!body) return;

  if (
    isBanatCommand(body)
  ) {
    handleBanatCommand(
      api,
      event,
      body
    );

    return;
  }

  const threadID = String(
    event.threadID
  );

  const active =
    activeThreads.has(
      threadID
    ) ||
    isBanatConversationModeActive(
      threadID
    );

  const target =
    classifyBanatTarget({
      event,
      body,
      botID: botUserID
    });

  if (active) {
    const reply =
      getTriggerReply(
        body,
        threadID
      ) ||
      getBanatConversationReply(
        body,
        threadID
      );

    if (reply) {
      sendBanat(
        api,
        event,
        reply
      ).catch(error =>
        console.error(
          "[BANAT] reply error:",
          error
        )
      );
    }

    return;
  }

  if (
    target.shouldRespond
  ) {
    const reply =
      getTriggerReply(
        body,
        threadID
      ) ||
      getBanatConversationReply(
        body,
        threadID
      );

    if (reply) {
      sendBanat(
        api,
        event,
        reply
      ).catch(error =>
        console.error(
          "[BANAT]",
          error
        )
      );
    }
  }
}

/*
 * ============================================================
 * START BOT LISTENER
 * ============================================================
 */

function start(api) {
  botApi = api;
  botStatus = "ONLINE";
  botError = "";
  botLoginAt = Date.now();

  try {
    botUserID = String(
      api.getCurrentUserID?.() ||
        ""
    );
  } catch (_) {
    botUserID = "";
  }

  if (DEFAULT_ON) {
    console.log(
      "[BANAT] BANAT_DEFAULT_ON enabled."
    );
  }

  api.listenMqtt(
    (error, event) => {
      if (error) {
        console.error(
          "[BANAT] listener error:",
          error
        );

        botError =
          error?.message ||
          String(error);

        /*
         * Do not instantly kill Railway process.
         */
        return;
      }

      try {
        if (
          DEFAULT_ON &&
          event?.threadID &&
          event?.senderID &&
          String(
            event.senderID
          ) !== botUserID
        ) {
          const key =
            String(
              event.threadID
            );

          if (
            !activeThreads.has(
              key
            )
          ) {
            activeThreads.add(
              key
            );

            setBanatConversationMode(
              key,
              true,
              event.senderID
            );
          }
        }

        onMessage(
          api,
          event
        );
      } catch (error) {
        console.error(
          "[BANAT] message handler error:",
          error
        );
      }
    }
  );

  console.log(
    `[BANAT] online${
      botUserID
        ? ` as ${botUserID}`
        : ""
    }`
  );
}

/*
 * ============================================================
 * BOT LOGIN
 * ============================================================
 */

async function loginBot(
  sessionValue
) {
  if (botConnecting) {
    throw new Error(
      "Bot login is already in progress."
    );
  }

  botConnecting = true;
  botStatus = "CONNECTING";
  botError = "";
  botName = "";
  botUserID = "";

  try {
    const cookie =
      normalizeSession(
        sessionValue
      );

    console.log(
      "[BOT LOGIN] Validating Facebook session..."
    );

    const api =
      await new Promise(
        (resolve, reject) => {
          login(
            cookie,
            (error, api) => {
              if (error) {
                reject(error);
                return;
              }

              resolve(api);
            }
          );
        }
      );

    /*
     * Get account information BEFORE
     * marking dashboard as fully online.
     */
    await getBotAccountInfo(
      api
    );

    if (!botUserID) {
      throw new Error(
        "Login succeeded but bot UID could not be detected."
      );
    }

    botApi = api;

    start(api);

    botStatus = "ONLINE";

    console.log(
      `[BOT LOGIN] SUCCESS: ${botName || "Unknown"} (${botUserID})`
    );

    return {
      name:
        botName || "Unknown",
      uid: botUserID,
      status: "ONLINE"
    };
  } catch (error) {
    botApi = null;
    botUserID = "";
    botName = "";
    botStatus = "OFFLINE";

    botError =
      error?.message ||
      String(error);

    console.error(
      "[BOT LOGIN] FAILED:",
      error
    );

    throw error;
  } finally {
    botConnecting = false;
  }
}

/*
 * ============================================================
 * EXPRESS DASHBOARD
 * ============================================================
 */

const app = express();

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      "change-this-dashboard-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure:
        process.env.NODE_ENV ===
        "production"
    }
  })
);

function requireAuth(
  req,
  res,
  next
) {
  if (
    req.session &&
    req.session.isAdmin
  ) {
    return next();
  }

  res.redirect("/login");
}

/*
 * ============================================================
 * LOGIN PAGE
 * ============================================================
 */

app.get(
  "/",
  (req, res) => {
    if (
      req.session &&
      req.session.isAdmin
    ) {
      return res.redirect(
        "/dashboard"
      );
    }

    res.redirect("/login");
  }
);

app.get(
  "/login",
  (req, res) => {
    res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Dashboard Login</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#080b10;
  color:#fff;
  font-family:Arial,sans-serif;
}
.card{
  width:92%;
  max-width:380px;
  background:#111722;
  border:1px solid #263142;
  border-radius:18px;
  padding:28px;
  box-shadow:0 20px 60px #000;
}
h1{
  margin:0 0 8px;
  font-size:25px;
}
p{
  color:#94a3b8;
  font-size:14px;
}
input{
  width:100%;
  padding:13px;
  margin:7px 0;
  border-radius:10px;
  border:1px solid #334155;
  background:#090d14;
  color:#fff;
  outline:none;
}
button{
  width:100%;
  padding:13px;
  margin-top:10px;
  border:0;
  border-radius:10px;
  background:#2563eb;
  color:#fff;
  font-weight:bold;
  cursor:pointer;
}
button:hover{opacity:.9}
</style>
</head>
<body>
<div class="card">
  <h1>Bot Control Panel</h1>
  <p>Admin login para ma-access ang bot dashboard.</p>

  <form method="POST" action="/login">
    <input
      name="username"
      placeholder="Dashboard username"
      required
    >

    <input
      type="password"
      name="password"
      placeholder="Dashboard password"
      required
    >

    <button type="submit">
      Login
    </button>
  </form>
</div>
</body>
</html>
`);
  }
);

app.post(
  "/login",
  (req, res) => {
    const {
      username,
      password
    } = req.body;

    if (
      username === ADMIN_USER &&
      password === ADMIN_PASS
    ) {
      req.session.isAdmin =
        true;

      return res.redirect(
        "/dashboard"
      );
    }

    res.status(401).send(`
<script>
alert("Wrong dashboard username or password.");
location.href="/login";
</script>
`);
  }
);

/*
 * ============================================================
 * DASHBOARD
 * ============================================================
 */

app.get(
  "/dashboard",
  requireAuth,
  (req, res) => {
    const online =
      botStatus === "ONLINE";

    const statusColor =
      online
        ? "#22c55e"
        : botStatus ===
          "CONNECTING"
          ? "#f59e0b"
          : "#ef4444";

    res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Bot Dashboard</title>

<style>
*{box-sizing:border-box}

body{
  margin:0;
  background:#070a0f;
  color:#f8fafc;
  font-family:Arial,sans-serif;
}

.container{
  width:94%;
  max-width:850px;
  margin:25px auto;
}

.header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
  margin-bottom:20px;
}

h1{
  margin:0;
  font-size:25px;
}

.card{
  background:#101722;
  border:1px solid #263244;
  border-radius:16px;
  padding:20px;
  margin-bottom:16px;
}

.title{
  font-weight:bold;
  font-size:17px;
  margin-bottom:15px;
}

.status{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:7px 11px;
  border-radius:999px;
  background:#0b111b;
  border:1px solid #263244;
  font-size:13px;
}

.dot{
  width:9px;
  height:9px;
  border-radius:50%;
  background:${statusColor};
}

.account{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:12px;
}

.info{
  background:#0a0f17;
  border:1px solid #1e293b;
  border-radius:12px;
  padding:14px;
}

.label{
  color:#64748b;
  font-size:12px;
  margin-bottom:5px;
}

.value{
  font-weight:bold;
  word-break:break-word;
}

textarea{
  width:100%;
  height:190px;
  resize:vertical;
  padding:13px;
  background:#080c13;
  color:#dbeafe;
  border:1px solid #334155;
  border-radius:11px;
  font-family:monospace;
  font-size:12px;
  outline:none;
}

button{
  border:0;
  border-radius:10px;
  padding:12px 17px;
  margin-top:10px;
  color:#fff;
  background:#2563eb;
  font-weight:bold;
  cursor:pointer;
}

button:hover{
  opacity:.9;
}

.logout{
  background:#dc2626;
}

.note{
  color:#94a3b8;
  font-size:13px;
  line-height:1.5;
}

.warning{
  padding:12px;
  border-radius:10px;
  background:#291a08;
  border:1px solid #854d0e;
  color:#fbbf24;
  font-size:13px;
  margin-top:12px;
}

.error{
  padding:12px;
  border-radius:10px;
  background:#2a0b0b;
  border:1px solid #7f1d1d;
  color:#fca5a5;
  font-size:13px;
  margin-top:12px;
}

@media(max-width:600px){
  .account{
    grid-template-columns:1fr;
  }
}
</style>
</head>

<body>
<div class="container">

<div class="header">
  <div>
    <h1>Bot Control Panel</h1>
    <div class="note">
      Messenger Bot Management
    </div>
  </div>

  <a href="/logout">
    <button class="logout">
      Logout
    </button>
  </a>
</div>

<div class="card">
  <div class="title">
    Messenger Status
  </div>

  <div class="status">
    <span class="dot"></span>
    ${escapeHtml(botStatus)}
  </div>
</div>

<div class="card">
  <div class="title">
    Bot Account
  </div>

  <div class="account">

    <div class="info">
      <div class="label">
        ACCOUNT NAME
      </div>

      <div class="value">
        ${
          online
            ? escapeHtml(
                botName ||
                "Loading..."
              )
            : "Not logged in"
        }
      </div>
    </div>

    <div class="info">
      <div class="label">
        BOT UID
      </div>

      <div class="value">
        ${
          online
            ? escapeHtml(
                botUserID
              )
            : "—"
        }
      </div>
    </div>

    <div class="info">
      <div class="label">
        MESSENGER
      </div>

      <div class="value">
        ${
          online
            ? "🟢 Logged In"
            : botStatus ===
              "CONNECTING"
              ? "🟡 Connecting..."
              : "🔴 Logged Out"
        }
      </div>
    </div>

    <div class="info">
      <div class="label">
        PROCESS UPTIME
      </div>

      <div class="value">
        ${uptimeText()}
      </div>
    </div>

  </div>

  ${
    botError
      ? `
      <div class="error">
        ${escapeHtml(
          botError
        )}
      </div>
      `
      : ""
  }
</div>

<div class="card">
  <div class="title">
    Login Bot
  </div>

  <p class="note">
    I-paste dito ang Facebook AppState/C3C
    session JSON. Kapag valid, automatic na
    ita-try i-login ang bot at ipapakita ang
    account name at UID.
  </p>

  <form
    method="POST"
    action="/bot-login"
  >

    <textarea
      name="appstate"
      placeholder='[{"key":"c_user","value":"..."},{"key":"xs","value":"..."}]'
      required
    ></textarea>

    <button type="submit">
      🔐 Login Bot
    </button>

  </form>

  <div class="warning">
    Huwag mag-paste ng Facebook password.
    AppState/C3C session lamang ang ilagay.
    Huwag ding i-share ang session sa ibang tao.
  </div>
</div>

<div class="card">
  <div class="title">
    Bot Controls
  </div>

  <form
    method="POST"
    action="/bot-logout"
  >
    <button
      type="submit"
      style="background:#dc2626"
    >
      Logout Bot
    </button>
  </form>
</div>

<div class="card">
  <div class="title">
    System
  </div>

  <div class="account">

    <div class="info">
      <div class="label">
        NODE
      </div>

      <div class="value">
        ${escapeHtml(
          process.version
        )}
      </div>
    </div>

    <div class="info">
      <div class="label">
        PLATFORM
      </div>

      <div class="value">
        ${escapeHtml(
          process.platform
        )}
      </div>
    </div>

    <div class="info">
      <div class="label">
        ARCHITECTURE
      </div>

      <div class="value">
        ${escapeHtml(
          process.arch
        )}
      </div>
    </div>

    <div class="info">
      <div class="label">
        ACTIVE THREADS
      </div>

      <div class="value">
        ${activeThreads.size}
      </div>
    </div>

  </div>
</div>

</div>
</body>
</html>
`);
  }
);

/*
 * ============================================================
 * BOT LOGIN ROUTE
 * ============================================================
 */

app.post(
  "/bot-login",
  requireAuth,
  async (req, res) => {
    try {
      const raw =
        String(
          req.body.appstate ||
          ""
        ).trim();

      if (!raw) {
        throw new Error(
          "Walang AppState/C3C na inilagay."
        );
      }

      /*
       * Validate + save.
       */
      saveSession(raw);

      /*
       * Login immediately.
       */
      const parsed =
        JSON.parse(raw);

      const result =
        await loginBot(
          parsed
        );

      res.send(`
<script>
alert(
  "Messenger Logged In!\\n\\nAccount: ${escapeHtml(
    result.name
  )}\\nUID: ${escapeHtml(
    result.uid
  )}"
);
location.href="/dashboard";
</script>
`);
    } catch (error) {
      res.status(400).send(`
<script>
alert("Bot login failed: ${escapeHtml(
        error?.message ||
        String(error)
      )}");
location.href="/dashboard";
</script>
`);
    }
  }
);

/*
 * ============================================================
 * BOT LOGOUT
 * ============================================================
 */

app.post(
  "/bot-logout",
  requireAuth,
  async (req, res) => {
    try {
      if (
        botApi &&
        typeof botApi.logout ===
          "function"
      ) {
        await new Promise(resolve => {
          try {
            botApi.logout(() => {
              resolve();
            });
          } catch (_) {
            resolve();
          }
        });
      }
    } catch (_) {}

    botApi = null;
    botUserID = "";
    botName = "";
    botStatus = "OFFLINE";
    botError = "";

    res.redirect(
      "/dashboard"
    );
  }
);

/*
 * ============================================================
 * API STATUS
 * ============================================================
 */

app.get(
  "/api/status",
  requireAuth,
  (req, res) => {
    res.json({
      bot: {
        status: botStatus,
        loggedIn:
          botStatus ===
          "ONLINE",
        name:
          botName || null,
        uid:
          botUserID || null,
        messenger:
          botStatus ===
          "ONLINE"
            ? "Logged In"
            : "Logged Out",
        loginAt:
          botLoginAt
            ? new Date(
                botLoginAt
              ).toISOString()
            : null
      },

      system: {
        uptime:
          process.uptime(),
        node:
          process.version,
        platform:
          process.platform,
        arch:
          process.arch,
        memory:
          process.memoryUsage()
      },

      banat: {
        activeThreads:
          activeThreads.size,
        queuedThreads:
          threadQueues.size,
        globalActive
      }
    });
  }
);

/*
 * ============================================================
 * LOGOUT DASHBOARD ADMIN
 * ============================================================
 */

app.get(
  "/logout",
  (req, res) => {
    req.session.destroy(
      () => {
        res.redirect(
          "/login"
        );
      }
    );
  }
);

/*
 * ============================================================
 * HEALTH SERVER + DASHBOARD
 * ============================================================
 *
 * ONE PORT ONLY.
 * Railway can use this service directly.
 * ============================================================
 */

const server =
  http.createServer(
    app
  );

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `[DASHBOARD] running on port ${PORT}`
    );

    console.log(
      `[DASHBOARD] Admin username: ${ADMIN_USER}`
    );

    /*
     * Optional automatic login from
     * Railway environment variable
     * or existing appstate.json.
     */
    try {
      const saved =
        getSavedSession();

      if (saved) {
        console.log(
          "[BOT] Saved session found. Attempting automatic login..."
        );

        loginBot(saved).catch(
          error => {
            console.error(
              "[BOT] Automatic login failed:",
              error?.message ||
                error
            );
          }
        );
      } else {
        console.log(
          "[BOT] No saved session. Login from dashboard."
        );
      }
    } catch (error) {
      console.error(
        "[BOT] Saved session error:",
        error?.message ||
          error
      );
    }
  }
);

/*
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
  trafficSendMessage,
  onMessage,
  handleBanatCommand,
  loginBot
};
