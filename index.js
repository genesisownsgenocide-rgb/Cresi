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
 * NICKNAME / GC NAME PROTECTION
 * ============================================================
 */

const {
  handleCommand: handleNicknameCommand,
  protectNickname
} = require("./setallnick");

const {
  handleCommand: handleGCNameCommand,
  protectGCName
} = require("./gcname-lock");

/*
 * ============================================================
 * EXPRESS
 * ============================================================
 */

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 10000);

/*
 * Render / Railway reverse proxy support
 */
app.set("trust proxy", 1);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

/*
 * ============================================================
 * DASHBOARD LOGIN
 * ============================================================
 */

const ADMIN_USER = "admin";
const ADMIN_PASS = "halimaw123";

app.use(
  session({
    secret: "sinzu-dashboard-session-secret-change-this",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

/*
 * ============================================================
 * CONFIG
 * ============================================================
 */

const DEFAULT_ON =
  String(process.env.BANAT_DEFAULT_ON || "true").toLowerCase() === "true";

const GLOBAL_SEND_LIMIT = Math.max(
  1,
  Number(process.env.GLOBAL_SEND_LIMIT || 2)
);

const THREAD_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.THREAD_COOLDOWN_MS || 12000)
);

const RETRY_DELAYS = [1500, 4000, 8000];

const ADMIN_UID = "61595204307407";

/*
 * ============================================================
 * BOT STATE
 * ============================================================
 */

let botApi = null;
let botUserID = null;
let botName = "Not logged in";
let botStatus = "offline";
let botError = null;
let botLoginAt = null;
let botConnecting = false;

/*
 * ============================================================
 * BANAT STATE
 * ============================================================
 */

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
  if (!botLoginAt) return "0s";

  const seconds = Math.floor(
    (Date.now() - botLoginAt) / 1000
  );

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(" ");
}

/*
 * ============================================================
 * SESSION / APPSTATE
 * ============================================================
 */

function normalizeSession(input) {
  if (!input) return null;

  if (typeof input === "object") {
    return input;
  }

  const value = String(input).trim();

  if (!value) return null;

  try {
    const parsed = JSON.parse(value);

    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (_) {
    // Not JSON. Continue as cookie string.
  }

  return value;
}

function parseSessionInput(input) {
  return normalizeSession(input);
}

function getSavedSession() {
  const candidates = [
    process.env.FB_APPSTATE,
    process.env.FB_COOKIES
  ];

  for (const candidate of candidates) {
    if (candidate) {
      const parsed = parseSessionInput(candidate);

      if (parsed) {
        return parsed;
      }
    }
  }

  const file = path.join(__dirname, "appstate.json");

  try {
    if (!fs.existsSync(file)) {
      return null;
    }

    const raw = fs.readFileSync(file, "utf8").trim();

    if (!raw) {
      return null;
    }

    return parseSessionInput(raw);
  } catch (error) {
    console.error(
      "[APPSTATE] Failed reading saved session:",
      error.message
    );

    return null;
  }
}

function saveSession(sessionValue) {
  try {
    const file = path.join(__dirname, "appstate.json");

    fs.writeFileSync(
      file,
      JSON.stringify(sessionValue, null, 2),
      "utf8"
    );

    console.log("[APPSTATE] Session saved.");
    return true;
  } catch (error) {
    console.error(
      "[APPSTATE] Failed saving session:",
      error.message
    );

    return false;
  }
}

/*
 * ============================================================
 * ACCOUNT INFO
 * ============================================================
 */

function getBotAccountInfo(api) {
  return new Promise(resolve => {
    if (!api || typeof api.getCurrentUserID !== "function") {
      resolve({
        uid: null,
        name: "Unknown"
      });

      return;
    }

    let uid = null;

    try {
      uid = api.getCurrentUserID();
    } catch (_) {}

    if (!uid) {
      resolve({
        uid: null,
        name: "Unknown"
      });

      return;
    }

    if (typeof api.getUserInfo !== "function") {
      resolve({
        uid: String(uid),
        name: "Messenger Bot"
      });

      return;
    }

    api.getUserInfo(
      [uid],
      (error, info) => {
        if (error || !info || !info[uid]) {
          resolve({
            uid: String(uid),
            name: "Messenger Bot"
          });

          return;
        }

        resolve({
          uid: String(uid),
          name:
            info[uid].name ||
            info[uid].firstName ||
            "Messenger Bot"
        });
      }
    );
  });
}

/*
 * ============================================================
 * MESSAGE TRAFFIC
 * ============================================================
 */

function enqueue(threadID, task) {
  const key = String(threadID);

  if (!threadQueues.has(key)) {
    threadQueues.set(key, []);
  }

  const queue = threadQueues.get(key);

  return new Promise((resolve, reject) => {
    queue.push({
      task,
      resolve,
      reject
    });

    processQueue(key);
  });
}

async function processQueue(threadID) {
  const key = String(threadID);
  const queue = threadQueues.get(key);

  if (!queue || !queue.length) {
    return;
  }

  if (queue.running) {
    return;
  }

  queue.running = true;

  while (queue.length) {
    const item = queue.shift();

    try {
      const result = await item.task();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    }
  }

  queue.running = false;
}

async function acquireGlobalSlot() {
  while (globalActive >= GLOBAL_SEND_LIMIT) {
    await sleep(100);
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
  const text = String(
    error?.errorDescription ||
    error?.message ||
    error ||
    ""
  );

  return text.includes("1545012");
}

async function trafficSendMessage(api, message, threadID) {
  if (!api || typeof api.sendMessage !== "function") {
    throw new Error("Messenger API unavailable.");
  }

  const key = String(threadID);

  return enqueue(key, async () => {
    const lastSent = threadLastSent.get(key) || 0;
    const wait =
      THREAD_COOLDOWN_MS -
      (Date.now() - lastSent);

    if (wait > 0) {
      await sleep(wait);
    }

    await acquireGlobalSlot();

    try {
      let lastError = null;

      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const result = await new Promise(
            (resolve, reject) => {
              api.sendMessage(
                message,
                threadID,
                (error, info) => {
                  if (error) {
                    reject(error);
                    return;
                  }

                  resolve(info);
                }
              );
            }
          );

          threadLastSent.set(
            key,
            Date.now()
          );

          return result;
        } catch (error) {
          lastError = error;

          if (
            attempt >= RETRY_DELAYS.length ||
            !is1545012(error)
          ) {
            throw error;
          }

          await sleep(
            RETRY_DELAYS[attempt]
          );
        }
      }

      throw lastError;
    } finally {
      releaseGlobalSlot();
    }
  });
}

/*
 * ============================================================
 * BANAT COMMAND SYSTEM
 * ============================================================
 */

function isBanatCommand(body) {
  const text = String(body || "")
    .trim()
    .toLowerCase();

  return (
    text === "/banat" ||
    text.startsWith("/banat ")
  );
}

function commandSendMessage(api, message, threadID) {
  return trafficSendMessage(
    api,
    message,
    threadID
  );
}

async function sendCommandReply(
  api,
  event,
  message
) {
  if (!message) return;

  return commandSendMessage(
    api,
    message,
    event.threadID
  );
}

async function handleBanatCommand(
  api,
  event,
  body
) {
  const parts = String(body || "")
    .trim()
    .split(/\s+/);

  const command = (
    parts[0] || ""
  ).toLowerCase();

  if (command !== "/banat") {
    return false;
  }

  const action = (
    parts[1] || ""
  ).toLowerCase();

  const threadID = String(
    event.threadID
  );

  if (
    event.senderID &&
    String(event.senderID) ===
      String(ADMIN_UID)
  ) {
    if (action === "on") {
      activeThreads.add(threadID);

      setBanatConversationMode(
        threadID,
        true,
        event.senderID
      );

      await sendCommandReply(
        api,
        event,
        "Banat mode: ON."
      );

      return true;
    }

    if (action === "off") {
      activeThreads.delete(threadID);

      setBanatConversationMode(
        threadID,
        false,
        event.senderID
      );

      await sendCommandReply(
        api,
        event,
        "Banat mode: OFF."
      );

      return true;
    }

    if (action === "status") {
      const status =
        activeThreads.has(threadID);

      await sendCommandReply(
        api,
        event,
        `Banat mode: ${
          status ? "ON" : "OFF"
        }`
      );

      return true;
    }
  }

  return false;
}

/*
 * ============================================================
 * BANAT MESSAGE HANDLER
 * ============================================================
 */

async function sendBanat(
  api,
  event,
  reply
) {
  if (!reply) return;

  if (
    typeof sendBanatReplyWithTyping ===
    "function"
  ) {
    try {
      return await sendBanatReplyWithTyping(
        api,
        event,
        reply,
        trafficSendMessage
      );
    } catch (error) {
      console.error(
        "[BANAT HUMAN]",
        error.message
      );
    }
  }

  return trafficSendMessage(
    api,
    reply,
    event.threadID
  );
}

function onMessage(api, event) {
  if (!event) return;

  /*
   * Ignore bot's own messages
   */
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

  /*
   * ==========================================================
   * NICKNAME / GC NAME COMMANDS
   * ==========================================================
   *
   * These are checked before normal message processing.
   */

  if (body) {
    try {
      if (
        handleNicknameCommand(
          api,
          event,
          body
        )
      ) {
        return;
      }
    } catch (error) {
      console.error(
        "[NICKNAME COMMAND]",
        error.message
      );
    }

    try {
      if (
        handleGCNameCommand(
          api,
          event,
          body
        )
      ) {
        return;
      }
    } catch (error) {
      console.error(
        "[GC NAME COMMAND]",
        error.message
      );
    }
  }

  /*
   * Existing message filter
   */
  if (
    event.type &&
    event.type !== "message"
  ) {
    return;
  }

  if (!body) return;

  /*
   * ==========================================================
   * EXISTING BANAT COMMANDS
   * ==========================================================
   */

  if (isBanatCommand(body)) {
    handleBanatCommand(
      api,
      event,
      body
    ).catch(error => {
      console.error(
        "[BANAT COMMAND]",
        error.message
      );
    });

    return;
  }

  const threadID = String(
    event.threadID || ""
  );

  if (!threadID) return;

  /*
   * ==========================================================
   * EXISTING TARGET CLASSIFICATION
   * ==========================================================
   */

  let targetInfo = null;

  try {
    targetInfo = classifyBanatTarget(
      event,
      botUserID
    );
  } catch (error) {
    console.error(
      "[TARGET CLASSIFY]",
      error.message
    );
  }

  /*
   * ==========================================================
   * EXISTING ACTIVE MODE
   * ==========================================================
   */

  const modeActive =
    activeThreads.has(threadID) ||
    isBanatConversationModeActive(
      threadID
    );

  if (
    !modeActive &&
    !targetInfo?.isTarget
  ) {
    /*
     * Trigger replies can still work here.
     */
    const triggerReply =
      getTriggerReply(
        body,
        threadID
      );

    if (triggerReply) {
      sendBanat(
        api,
        event,
        triggerReply
      ).catch(error => {
        console.error(
          "[TRIGGER SEND]",
          error.message
        );
      });
    }

    return;
  }

  /*
   * ==========================================================
   * TRIGGER REPLY
   * ==========================================================
   */

  const triggerReply =
    getTriggerReply(
      body,
      threadID
    );

  if (triggerReply) {
    sendBanat(
      api,
      event,
      triggerReply
    ).catch(error => {
      console.error(
        "[TRIGGER SEND]",
        error.message
      );
    });

    return;
  }

  /*
   * ==========================================================
   * HUMAN BANAT CONVERSATION
   * ==========================================================
   */

  const banatReply =
    getBanatConversationReply(
      body,
      threadID
    );

  if (banatReply) {
    sendBanat(
      api,
      event,
      banatReply
    ).catch(error => {
      console.error(
        "[BANAT SEND]",
        error.message
      );
    });
  }
}

/*
 * ============================================================
 * START BOT
 * ============================================================
 */

function start(api) {
  botApi = api;

  botStatus = "online";
  botError = null;
  botConnecting = false;
  botLoginAt = Date.now();

  try {
    botUserID =
      api.getCurrentUserID();
  } catch (_) {
    botUserID = null;
  }

  console.log(
    `[BOT] Logged in as ${botUserID || "unknown"}`
  );

  /*
   * Default banat mode
   */
  if (DEFAULT_ON) {
    console.log(
      "[BANAT] Default mode enabled."
    );
  }

  /*
   * ==========================================================
   * MQTT LISTENER
   * ==========================================================
   */

  api.listenMqtt(
    (error, event) => {
      if (error) {
        botStatus = "error";
        botError =
          error?.errorDescription ||
          error?.message ||
          String(error);

        console.error(
          "[MQTT]",
          botError
        );

        return;
      }

      try {
        /*
         * ======================================================
         * NICKNAME PROTECTION
         * ======================================================
         */

        if (
          event &&
          event.threadID
        ) {
          Promise.resolve(
            protectNickname(
              api,
              event
            )
          ).catch(error => {
            console.error(
              "[NICKNAME PROTECTION]",
              error.message
            );
          });
        }

        /*
         * ======================================================
         * GC NAME PROTECTION
         * ======================================================
         */

        if (
          event &&
          event.threadID
        ) {
          Promise.resolve(
            protectGCName(
              api,
              event
            )
          ).catch(error => {
            console.error(
              "[GC NAME PROTECTION]",
              error.message
            );
          });
        }

        /*
         * ======================================================
         * DEFAULT BANAT MODE
         * ======================================================
         */

        if (
          DEFAULT_ON &&
          event?.threadID &&
          event?.senderID &&
          String(event.senderID) !==
            String(botUserID)
        ) {
          const key = String(
            event.threadID
          );

          if (
            !activeThreads.has(key)
          ) {
            activeThreads.add(key);

            try {
              setBanatConversationMode(
                key,
                true,
                event.senderID
              );
            } catch (error) {
              console.error(
                "[BANAT MODE]",
                error.message
              );
            }
          }
        }

        /*
         * ======================================================
         * NORMAL MESSAGE HANDLER
         * ======================================================
         */

        onMessage(
          api,
          event
        );
      } catch (handlerError) {
        console.error(
          "[EVENT HANDLER]",
          handlerError
        );
      }
    }
  );
}

/*
 * ============================================================
 * BOT LOGIN
 * ============================================================
 */

async function loginBot(sessionValue) {
  if (botConnecting) {
    throw new Error(
      "Bot login is already in progress."
    );
  }

  const normalized =
    parseSessionInput(
      sessionValue
    );

  if (!normalized) {
    throw new Error(
      "Invalid AppState / C3C session."
    );
  }

  botConnecting = true;
  botStatus = "connecting";
  botError = null;

  console.log(
    "[BOT] Attempting Messenger login..."
  );

  try {
    const api = await new Promise(
      (resolve, reject) => {
        let finished = false;

        function done(
          error,
          result
        ) {
          if (finished) return;

          finished = true;

          if (error) {
            reject(error);
            return;
          }

          if (!result) {
            reject(
              new Error(
                "Messenger login returned no API."
              )
            );

            return;
          }

          resolve(result);
        }

        try {
          /*
           * ws3-fca supports cookie/AppState-style
           * session login through the login function.
           */
          login(
            normalized,
            done
          );
        } catch (error) {
          done(error);
        }
      }
    );

    botApi = api;

    const account =
      await getBotAccountInfo(api);

    botUserID = account.uid;
    botName = account.name;

    /*
     * Save only after successful login.
     */
    saveSession(normalized);

    start(api);

    botStatus = "online";
    botError = null;
    botLoginAt = Date.now();

    console.log(
      `[BOT] Online: ${botName} (${botUserID})`
    );

    return {
      success: true,
      name: botName,
      uid: botUserID,
      status: botStatus
    };
  } catch (error) {
    botApi = null;
    botUserID = null;
    botName = "Not logged in";
    botStatus = "offline";
    botError =
      error?.errorDescription ||
      error?.message ||
      String(error);

    console.error(
      "[BOT LOGIN FAILED]",
      botError
    );

    throw error;
  } finally {
    botConnecting = false;
  }
}

/*
 * ============================================================
 * DASHBOARD AUTH
 * ============================================================
 */

function requireAuth(req, res, next) {
  if (req.session?.authenticated) {
    return next();
  }

  return res.redirect("/login");
}

/*
 * ============================================================
 * LOGIN PAGE
 * ============================================================
 */

app.get("/login", (req, res) => {
  if (req.session?.authenticated) {
    return res.redirect("/dashboard");
  }

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<title>SINZU AI — Login</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #080808;
  color: #fff;
  font-family: Arial, sans-serif;
}

.box {
  width: min(420px, 92%);
  padding: 30px;
  background: #111;
  border: 1px solid #292929;
  border-radius: 14px;
  box-shadow: 0 15px 50px rgba(0,0,0,.5);
}

h1 {
  margin: 0 0 8px;
  font-size: 25px;
}

p {
  color: #888;
  margin-bottom: 25px;
}

input {
  width: 100%;
  padding: 13px;
  margin-bottom: 12px;
  background: #080808;
  color: #fff;
  border: 1px solid #333;
  border-radius: 8px;
  outline: none;
}

button {
  width: 100%;
  padding: 13px;
  border: 0;
  border-radius: 8px;
  background: #fff;
  color: #000;
  font-weight: bold;
  cursor: pointer;
}

.error {
  color: #ff6565;
  margin-bottom: 15px;
}
</style>
</head>

<body>

<div class="box">

<h1>SINZU AI COMMAND CENTER</h1>

<p>Dashboard authentication</p>

${req.query.error
  ? `<div class="error">Invalid username or password.</div>`
  : ""}

<form method="POST" action="/login">

<input
  type="text"
  name="username"
  placeholder="Username"
  autocomplete="username"
  required
>

<input
  type="password"
  name="password"
  placeholder="Password"
  autocomplete="current-password"
  required
>

<button type="submit">
  LOGIN
</button>

</form>

</div>

</body>
</html>
  `);
});

/*
 * ============================================================
 * LOGIN POST
 * ============================================================
 */

app.post("/login", (req, res) => {
  const username =
    String(req.body.username || "");

  const password =
    String(req.body.password || "");

  if (
    username === ADMIN_USER &&
    password === ADMIN_PASS
  ) {
    req.session.authenticated = true;

    return req.session.save(error => {
      if (error) {
        console.error(
          "[SESSION SAVE]",
          error
        );

        return res.status(500).send(
          "Session error."
        );
      }

      return res.redirect(
        "/dashboard"
      );
    });
  }

  return res.redirect(
    "/login?error=1"
  );
});

/*
 * ============================================================
 * DASHBOARD
 * ============================================================
 */

app.get(
  "/dashboard",
  requireAuth,
  (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>SINZU AI — Dashboard</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #080808;
  color: #fff;
  font-family: Arial, sans-serif;
}

.container {
  width: min(900px, 94%);
  margin: 35px auto;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  margin-bottom: 25px;
}

.title {
  font-size: 26px;
  font-weight: bold;
}

.subtitle {
  color: #777;
  margin-top: 5px;
}

.logout {
  text-decoration: none;
  color: #fff;
  border: 1px solid #333;
  padding: 10px 14px;
  border-radius: 8px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(220px, 1fr));
  gap: 15px;
}

.card {
  background: #111;
  border: 1px solid #292929;
  border-radius: 14px;
  padding: 20px;
}

.label {
  color: #777;
  font-size: 13px;
  margin-bottom: 8px;
}

.value {
  font-size: 20px;
  font-weight: bold;
  word-break: break-word;
}

.online {
  color: #65ff91;
}

.offline {
  color: #ff6565;
}

.connecting {
  color: #ffd45f;
}

textarea {
  width: 100%;
  min-height: 230px;
  resize: vertical;
  background: #080808;
  color: #fff;
  border: 1px solid #333;
  border-radius: 10px;
  padding: 14px;
  font-family: monospace;
  outline: none;
}

button {
  border: 0;
  padding: 12px 17px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: bold;
}

.login-btn {
  background: #fff;
  color: #000;
}

.logout-btn {
  background: #351111;
  color: #ff8888;
}

.status-box {
  margin-top: 20px;
  padding: 15px;
  background: #0d0d0d;
  border: 1px solid #292929;
  border-radius: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

.warning {
  color: #ffcc66;
  font-size: 13px;
  line-height: 1.5;
  margin-top: 12px;
}

</style>

</head>

<body>

<div class="container">

<div class="header">

<div>
  <div class="title">
    SINZU AI COMMAND CENTER
  </div>

  <div class="subtitle">
    Messenger Bot Dashboard
  </div>
</div>

<a
  class="logout"
  href="/logout"
>
  Logout
</a>

</div>

<div class="grid">

<div class="card">
  <div class="label">BOT ACCOUNT</div>
  <div
    class="value"
    id="botName"
  >
    Loading...
  </div>
</div>

<div class="card">
  <div class="label">BOT UID</div>
  <div
    class="value"
    id="botUID"
  >
    Loading...
  </div>
</div>

<div class="card">
  <div class="label">MESSENGER STATUS</div>
  <div
    class="value"
    id="botStatus"
  >
    Loading...
  </div>
</div>

<div class="card">
  <div class="label">UPTIME</div>
  <div
    class="value"
    id="uptime"
  >
    Loading...
  </div>
</div>

</div>

<div class="card" style="margin-top:15px;">

<h2>Facebook / Messenger Login</h2>

<p style="color:#777;">
Paste your AppState/C3C session below.
</p>

<textarea
  id="appstate"
  placeholder='Paste AppState JSON or cookie/session value here...'
></textarea>

<div class="warning">
Keep your AppState/C3C private. Anyone who obtains a
valid session may potentially access the account.
</div>

<br>

<button
  class="login-btn"
  onclick="loginBot()"
>
  LOGIN BOT
</button>

<button
  class="logout-btn"
  onclick="logoutBot()"
  style="margin-left:8px;"
>
  BOT LOGOUT
</button>

<div
  class="status-box"
  id="message"
>
Ready.
</div>

</div>

</div>

<script>

async function refreshStatus() {

  try {

    const response =
      await fetch("/api/status");

    const data =
      await response.json();

    const name =
      document.getElementById("botName");

    const uid =
      document.getElementById("botUID");

    const status =
      document.getElementById("botStatus");

    const uptime =
      document.getElementById("uptime");

    name.textContent =
      data.name || "Not logged in";

    uid.textContent =
      data.uid || "—";

    status.textContent =
      data.status || "offline";

    uptime.textContent =
      data.uptime || "0s";

    status.className =
      "value " +
      (
        data.status === "online"
          ? "online"
          : data.status === "connecting"
          ? "connecting"
          : "offline"
      );

  } catch (error) {

    document.getElementById(
      "message"
    ).textContent =
      "Unable to read bot status.";

  }

}

async function loginBot() {

  const textarea =
    document.getElementById(
      "appstate"
    );

  const message =
    document.getElementById(
      "message"
    );

  const value =
    textarea.value.trim();

  if (!value) {

    message.textContent =
      "Paste your AppState/C3C first.";

    return;

  }

  message.textContent =
    "Logging in...";

  try {

    const response =
      await fetch(
        "/bot-login",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            appstate: value
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Login failed."
      );

    }

    message.textContent =
      "Bot successfully logged in.";

    textarea.value = "";

    refreshStatus();

  } catch (error) {

    message.textContent =
      "Login failed: " +
      error.message;

    refreshStatus();

  }

}

async function logoutBot() {

  const message =
    document.getElementById(
      "message"
    );

  try {

    const response =
      await fetch(
        "/bot-logout",
        {
          method: "POST"
        }
      );

    const data =
      await response.json();

    message.textContent =
      data.message ||
      "Bot logged out.";

    refreshStatus();

  } catch (error) {

    message.textContent =
      "Logout failed.";

  }

}

refreshStatus();

setInterval(
  refreshStatus,
  3000
);

</script>

</body>
</html>
    `);
  }
);

/*
 * ============================================================
 * BOT LOGIN API
 * ============================================================
 */

app.post(
  "/bot-login",
  requireAuth,
  async (req, res) => {
    try {
      const input =
        req.body?.appstate;

      if (!input) {
        return res.status(400).json({
          error:
            "AppState/C3C is required."
        });
      }

      if (botConnecting) {
        return res.status(409).json({
          error:
            "Bot login is already in progress."
        });
      }

      const result =
        await loginBot(input);

      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        error:
          error?.errorDescription ||
          error?.message ||
          String(error)
      });
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
  (req, res) => {
    try {
      if (
        botApi &&
        typeof botApi.logout ===
          "function"
      ) {
        try {
          botApi.logout();
        } catch (_) {}
      }

      botApi = null;
      botUserID = null;
      botName = "Not logged in";
      botStatus = "offline";
      botError = null;
      botLoginAt = null;
      botConnecting = false;

      return res.json({
        success: true,
        message:
          "Bot logged out."
      });
    } catch (error) {
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

/*
 * ============================================================
 * STATUS API
 * ============================================================
 */

app.get(
  "/api/status",
  requireAuth,
  (req, res) => {
    res.json({
      name: botName,
      uid: botUserID,
      status: botStatus,
      error: botError,
      uptime: uptimeText(),
      loggedIn: Boolean(botApi),
      connecting: botConnecting
    });
  }
);

/*
 * ============================================================
 * DASHBOARD LOGOUT
 * ============================================================
 */

app.get(
  "/logout",
  (req, res) => {
    req.session.destroy(() => {
      res.redirect("/login");
    });
  }
);

/*
 * ============================================================
 * ROOT
 * ============================================================
 */

app.get("/", (req, res) => {
  if (req.session?.authenticated) {
    return res.redirect("/dashboard");
  }

  return res.redirect("/login");
});

/*
 * ============================================================
 * SERVER
 * ============================================================
 */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "============================================"
    );

    console.log(
      "       SINZU AI COMMAND CENTER"
    );

    console.log(
      "============================================"
    );

    console.log(
      `[SERVER] Listening on port ${PORT}`
    );

    console.log(
      `[DASHBOARD] Username: ${ADMIN_USER}`
    );

    console.log(
      "[DASHBOARD] Password configured."
    );

    console.log(
      `[BANAT] Default: ${
        DEFAULT_ON ? "ON" : "OFF"
      }`
    );

    console.log(
      "[NICKNAME] Protection module loaded."
    );

    console.log(
      "[GC NAME] Protection module loaded."
    );

    console.log(
      "============================================"
    );

    /*
     * ==========================================================
     * AUTO LOGIN FROM SAVED APPSTATE
     * ==========================================================
     */

    const savedSession =
      getSavedSession();

    if (savedSession) {
      console.log(
        "[BOT] Saved AppState found. Starting login..."
      );

      loginBot(savedSession)
        .then(result => {
          console.log(
            `[BOT] Auto-login successful: ${result.name} (${result.uid})`
          );
        })
        .catch(error => {
          console.error(
            "[BOT] Auto-login failed:",
            error?.errorDescription ||
            error?.message ||
            error
          );
        });
    } else {
      console.log(
        "[BOT] No saved AppState found."
      );

      console.log(
        "[BOT] Login from the dashboard."
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

⚠️ Important: This assumes your existing "setallnick.js" and "gcname-lock.js" are already in the same root folder as "index.js", and both export "handleCommand" plus their protection function.

Your root should look like:

Cresi/
├── index.js
├── package.json
├── triggers.js
├── banat-human.js
├── banat-targeting.js
├── setallnick.js
├── gcname-lock.js
└── appstate.json        ← automatically created after successful login

Dashboard login: "admin" / "halimaw123".

Commands connected:

- "!setallnick <nickname>"
- "!restoreallnick"
- "!nickprotect"
- "!lockgcname <name>"
- "!unlockgcname"
- "!gcnameprotect"

Hindi ko ginalaw ang intended "triggers.js", "banat-human.js", at "banat-targeting.js" logic. Also, keep your AppState/C3C private and don't commit "appstate.json" to a public GitHub repo.
