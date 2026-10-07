"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const { login } = require("ws3-fca");

/* ============================================================
   EXISTING HUMAN / BANAT SYSTEM
   ============================================================ */

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

/* ============================================================
   NICKNAME / GC NAME PROTECTION
   ============================================================ */

const {
  handleCommand: handleNicknameCommand,
  protectNickname
} = require("./setallnick");

const {
  handleCommand: handleGCNameCommand,
  protectGCName
} = require("./gcname-lock");

/* ============================================================
   EXPRESS
   ============================================================ */

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 10000);

app.set("trust proxy", 1);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "5mb"
}));

/* ============================================================
   DASHBOARD AUTH
   ============================================================ */

const ADMIN_USER = "admin";
const ADMIN_PASS = "halimaw123";

app.use(
  session({
    secret: "sinzu-command-center-session-secret",
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

/* ============================================================
   CONFIG
   ============================================================ */

const DEFAULT_ON =
  String(process.env.BANAT_DEFAULT_ON || "true")
    .toLowerCase() === "true";

const GLOBAL_SEND_LIMIT = Math.max(
  1,
  Number(process.env.GLOBAL_SEND_LIMIT || 2)
);

const THREAD_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.THREAD_COOLDOWN_MS || 12000)
);

const RETRY_DELAYS = [
  1500,
  4000,
  8000
];

const ADMIN_UID = "61595204307407";

/* ============================================================
   BOT STATE
   ============================================================ */

let botApi = null;
let botUserID = null;
let botName = "Not logged in";
let botStatus = "offline";
let botError = null;
let botLoginAt = null;
let botConnecting = false;

const systemLogs = [];

function addLog(type, message) {
  const entry = {
    time: new Date().toISOString(),
    type: String(type || "INFO"),
    message: String(message || "")
  };

  systemLogs.unshift(entry);

  if (systemLogs.length > 80) {
    systemLogs.length = 80;
  }

  console.log(
    `[${entry.type}] ${entry.message}`
  );
}

/* ============================================================
   BANAT STATE
   ============================================================ */

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();

let globalActive = 0;

/* ============================================================
   HELPERS
   ============================================================ */

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
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
  if (!botLoginAt) {
    return "0s";
  }

  const seconds = Math.floor(
    (Date.now() - botLoginAt) / 1000
  );

  const days = Math.floor(
    seconds / 86400
  );

  const hours = Math.floor(
    (seconds % 86400) / 3600
  );

  const minutes = Math.floor(
    (seconds % 3600) / 60
  );

  const secs = seconds % 60;

  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);

  parts.push(`${secs}s`);

  return parts.join(" ");
}

function getProtectionStatus() {
  return {
    nickname: {
      loaded: true
    },
    gcname: {
      loaded: true
    }
  };
}

/* ============================================================
   APPSTATE / SESSION
   ============================================================ */

function normalizeSession(input) {
  if (!input) {
    return null;
  }

  if (
    typeof input === "object" &&
    !Array.isArray(input)
  ) {
    return input;
  }

  const value =
    String(input).trim();

  if (!value) {
    return null;
  }

  try {
    const parsed =
      JSON.parse(value);

    if (
      parsed &&
      typeof parsed === "object"
    ) {
      return parsed;
    }
  } catch (_) {}

  return value;
}

function parseSessionInput(input) {
  return normalizeSession(input);
}

function getSavedSession() {
  const envSessions = [
    process.env.FB_APPSTATE,
    process.env.FB_COOKIES
  ];

  for (const value of envSessions) {
    if (value) {
      const parsed =
        parseSessionInput(value);

      if (parsed) {
        return parsed;
      }
    }
  }

  const file =
    path.join(
      __dirname,
      "appstate.json"
    );

  try {
    if (!fs.existsSync(file)) {
      return null;
    }

    const raw =
      fs.readFileSync(
        file,
        "utf8"
      ).trim();

    if (!raw) {
      return null;
    }

    return parseSessionInput(raw);
  } catch (error) {
    addLog(
      "ERROR",
      `Could not read appstate: ${error.message}`
    );

    return null;
  }
}

function saveSession(sessionValue) {
  try {
    const file =
      path.join(
        __dirname,
        "appstate.json"
      );

    fs.writeFileSync(
      file,
      JSON.stringify(
        sessionValue,
        null,
        2
      ),
      "utf8"
    );

    addLog(
      "SECURITY",
      "Messenger session saved locally."
    );

    return true;
  } catch (error) {
    addLog(
      "ERROR",
      `Could not save session: ${error.message}`
    );

    return false;
  }
}

/* ============================================================
   ACCOUNT INFO
   ============================================================ */

function getBotAccountInfo(api) {
  return new Promise(resolve => {
    if (
      !api ||
      typeof api.getCurrentUserID !==
        "function"
    ) {
      resolve({
        uid: null,
        name: "Unknown"
      });

      return;
    }

    let uid = null;

    try {
      uid =
        api.getCurrentUserID();
    } catch (_) {}

    if (!uid) {
      resolve({
        uid: null,
        name: "Unknown"
      });

      return;
    }

    if (
      typeof api.getUserInfo !==
        "function"
    ) {
      resolve({
        uid: String(uid),
        name: "Messenger Bot"
      });

      return;
    }

    api.getUserInfo(
      [uid],
      (error, info) => {
        if (
          error ||
          !info ||
          !info[uid]
        ) {
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

/* ============================================================
   MESSAGE QUEUE
   ============================================================ */

function enqueue(threadID, task) {
  const key =
    String(threadID);

  if (!threadQueues.has(key)) {
    const queue = [];
    queue.running = false;
    threadQueues.set(
      key,
      queue
    );
  }

  const queue =
    threadQueues.get(key);

  return new Promise(
    (resolve, reject) => {
      queue.push({
        task,
        resolve,
        reject
      });

      processQueue(key);
    }
  );
}

async function processQueue(threadID) {
  const key =
    String(threadID);

  const queue =
    threadQueues.get(key);

  if (
    !queue ||
    !queue.length ||
    queue.running
  ) {
    return;
  }

  queue.running = true;

  while (queue.length) {
    const item =
      queue.shift();

    try {
      const result =
        await item.task();

      item.resolve(result);
    } catch (error) {
      item.reject(error);
    }
  }

  queue.running = false;
}

async function acquireGlobalSlot() {
  while (
    globalActive >=
    GLOBAL_SEND_LIMIT
  ) {
    await sleep(100);
  }

  globalActive++;
}

function releaseGlobalSlot() {
  globalActive =
    Math.max(
      0,
      globalActive - 1
    );
}

function is1545012(error) {
  const text =
    String(
      error?.errorDescription ||
      error?.message ||
      error ||
      ""
    );

  return text.includes(
    "1545012"
  );
}

async function trafficSendMessage(
  api,
  message,
  threadID
) {
  if (
    !api ||
    typeof api.sendMessage !==
      "function"
  ) {
    throw new Error(
      "Messenger API unavailable."
    );
  }

  const key =
    String(threadID);

  return enqueue(
    key,
    async () => {
      const lastSent =
        threadLastSent.get(key) ||
        0;

      const wait =
        THREAD_COOLDOWN_MS -
        (
          Date.now() -
          lastSent
        );

      if (wait > 0) {
        await sleep(wait);
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
                (
                  resolve,
                  reject
                ) => {
                  api.sendMessage(
                    message,
                    threadID,
                    (
                      error,
                      info
                    ) => {
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
              attempt >=
                RETRY_DELAYS.length ||
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
    }
  );
}

/* ============================================================
   BANAT COMMANDS
   ============================================================ */

function isBanatCommand(body) {
  const text =
    String(body || "")
      .trim()
      .toLowerCase();

  return (
    text === "/banat" ||
    text.startsWith("/banat ")
  );
}

function commandSendMessage(
  api,
  message,
  threadID
) {
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
  if (!message) {
    return;
  }

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
  const parts =
    String(body || "")
      .trim()
      .split(/\s+/);

  const command =
    (
      parts[0] || ""
    ).toLowerCase();

  if (command !== "/banat") {
    return false;
  }

  const action =
    (
      parts[1] || ""
    ).toLowerCase();

  const threadID =
    String(event.threadID);

  if (
    event.senderID &&
    String(event.senderID) ===
      String(ADMIN_UID)
  ) {
    if (action === "on") {
      activeThreads.add(
        threadID
      );

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

      addLog(
        "BANAT",
        `Banat enabled in ${threadID}`
      );

      return true;
    }

    if (action === "off") {
      activeThreads.delete(
        threadID
      );

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

      addLog(
        "BANAT",
        `Banat disabled in ${threadID}`
      );

      return true;
    }

    if (action === "status") {
      const status =
        activeThreads.has(
          threadID
        );

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

/* ============================================================
   HUMAN BANAT SEND
   ============================================================ */

async function sendBanat(
  api,
  event,
  reply
) {
  if (!reply) {
    return;
  }

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
      addLog(
        "ERROR",
        `Human reply failed: ${error.message}`
      );
    }
  }

  return trafficSendMessage(
    api,
    reply,
    event.threadID
  );
}

/* ============================================================
   MESSAGE HANDLER
   ============================================================ */

function onMessage(
  api,
  event
) {
  if (!event) {
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

  const body =
    String(
      event.body || ""
    ).trim();

  /* --------------------------------------------
     PROTECTION COMMANDS
     -------------------------------------------- */

  if (body) {
    try {
      if (
        handleNicknameCommand(
          api,
          event,
          body
        )
      ) {
        addLog(
          "NICKNAME",
          `Command executed in ${event.threadID}`
        );

        return;
      }
    } catch (error) {
      addLog(
        "ERROR",
        `Nickname command: ${error.message}`
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
        addLog(
          "GC NAME",
          `Command executed in ${event.threadID}`
        );

        return;
      }
    } catch (error) {
      addLog(
        "ERROR",
        `GC name command: ${error.message}`
      );
    }
  }

  if (
    event.type &&
    event.type !== "message"
  ) {
    return;
  }

  if (!body) {
    return;
  }

  /* --------------------------------------------
     BANAT COMMAND
     -------------------------------------------- */

  if (
    isBanatCommand(body)
  ) {
    handleBanatCommand(
      api,
      event,
      body
    ).catch(error => {
      addLog(
        "ERROR",
        `Banat command: ${error.message}`
      );
    });

    return;
  }

  const threadID =
    String(
      event.threadID || ""
    );

  if (!threadID) {
    return;
  }

  /* --------------------------------------------
     TARGET CLASSIFICATION
     -------------------------------------------- */

  let targetInfo = null;

  try {
    targetInfo =
      classifyBanatTarget(
        event,
        botUserID
      );
  } catch (error) {
    addLog(
      "ERROR",
      `Target classification: ${error.message}`
    );
  }

  const modeActive =
    activeThreads.has(
      threadID
    ) ||
    isBanatConversationModeActive(
      threadID
    );

  /* --------------------------------------------
     TRIGGER REPLY
     -------------------------------------------- */

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
      addLog(
        "ERROR",
        `Trigger send: ${error.message}`
      );
    });

    return;
  }

  /* --------------------------------------------
     ONLY CONTINUE BANAT WHEN ACTIVE/TARGETED
     -------------------------------------------- */

  if (
    !modeActive &&
    !targetInfo?.isTarget
  ) {
    return;
  }

  /* --------------------------------------------
     HUMAN BANAT CONVERSATION
     -------------------------------------------- */

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
      addLog(
        "ERROR",
        `Banat send: ${error.message}`
      );
    });
  }
}

/* ============================================================
   START BOT
   ============================================================ */

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

  addLog(
    "BOT",
    `Logged in as ${botName} (${botUserID || "unknown"})`
  );

  if (DEFAULT_ON) {
    addLog(
      "BANAT",
      "Default banat mode is enabled."
    );
  }

  api.listenMqtt(
    (error, event) => {
      if (error) {
        botStatus = "error";

        botError =
          error?.errorDescription ||
          error?.message ||
          String(error);

        addLog(
          "MQTT ERROR",
          botError
        );

        return;
      }

      try {
        /* ----------------------------------------
           NICKNAME PROTECTION
           ---------------------------------------- */

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
            addLog(
              "ERROR",
              `Nickname protection: ${error.message}`
            );
          });
        }

        /* ----------------------------------------
           GC NAME PROTECTION
           ---------------------------------------- */

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
            addLog(
              "ERROR",
              `GC name protection: ${error.message}`
            );
          });
        }

        /* ----------------------------------------
           DEFAULT BANAT
           ---------------------------------------- */

        if (
          DEFAULT_ON &&
          event?.threadID &&
          event?.senderID &&
          String(event.senderID) !==
            String(botUserID)
        ) {
          const key =
            String(
              event.threadID
            );

          if (
            !activeThreads.has(key)
          ) {
            activeThreads.add(key);

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
      } catch (handlerError) {
        addLog(
          "ERROR",
          `Event handler: ${handlerError.message}`
        );
      }
    }
  );
}

/* ============================================================
   LOGIN BOT
   ============================================================ */

async function loginBot(
  sessionValue
) {
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

  addLog(
    "LOGIN",
    "Attempting Messenger login..."
  );

  try {
    const api =
      await new Promise(
        (
          resolve,
          reject
        ) => {
          let finished = false;

          function done(
            error,
            result
          ) {
            if (finished) {
              return;
            }

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
      await getBotAccountInfo(
        api
      );

    botUserID =
      account.uid;

    botName =
      account.name;

    saveSession(
      normalized
    );

    start(api);

    botStatus = "online";
    botError = null;
    botLoginAt = Date.now();

    addLog(
      "SUCCESS",
      `Bot online: ${botName} (${botUserID})`
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

    addLog(
      "LOGIN ERROR",
      botError
    );

    throw error;
  } finally {
    botConnecting = false;
  }
}

/* ============================================================
   AUTH
   ============================================================ */

function requireAuth(
  req,
  res,
  next
) {
  if (
    req.session &&
    req.session.authenticated
  ) {
    return next();
  }

  return res.redirect(
    "/login"
  );
}

/* ============================================================
   LOGIN PAGE
   ============================================================ */

app.get(
  "/login",
  (req, res) => {
    if (
      req.session?.authenticated
    ) {
      return res.redirect(
        "/dashboard"
      );
    }

    const error =
      req.query.error
        ? `
          <div class="login-error">
            Invalid username or password.
          </div>
        `
        : "";

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>SINZU AI — Login</title>

<style>

* {
  box-sizing: border-box;
}

html,
body {
  width: 100%;
  min-height: 100%;
}

body {
  margin: 0;
  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  padding: 20px;

  background:
    radial-gradient(
      circle at 50% 0%,
      #351014 0,
      #12090b 28%,
      #050505 65%
    );

  color: #fff;

  font-family:
    Inter,
    Arial,
    sans-serif;
}

body::before {
  content: "";

  position: fixed;
  inset: 0;

  pointer-events: none;

  background:
    linear-gradient(
      rgba(255,255,255,.015) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      rgba(255,255,255,.015) 1px,
      transparent 1px
    );

  background-size: 35px 35px;
}

.login-wrap {
  width: 100%;
  max-width: 430px;

  position: relative;
  z-index: 2;
}

.brand {
  text-align: center;
  margin-bottom: 25px;
}

.logo {
  width: 72px;
  height: 72px;

  margin: auto;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 22px;

  background:
    linear-gradient(
      145deg,
      #ff334c,
      #6e0714
    );

  box-shadow:
    0 0 40px
    rgba(255,30,55,.2);

  font-size: 32px;
  font-weight: 900;
}

.brand h1 {
  margin:
    17px 0 5px;

  letter-spacing:
    2px;

  font-size: 25px;
}

.brand p {
  margin: 0;

  color: #777;

  font-size: 13px;
}

.login-card {
  background:
    rgba(17,17,17,.88);

  backdrop-filter:
    blur(20px);

  border:
    1px solid
    rgba(255,255,255,.08);

  border-radius: 20px;

  padding: 25px;

  box-shadow:
    0 30px 100px
    rgba(0,0,0,.55);
}

.field {
  margin-bottom: 15px;
}

.field label {
  display: block;

  margin-bottom: 7px;

  color: #888;

  font-size: 12px;

  text-transform:
    uppercase;

  letter-spacing:
    1px;
}

.field input {
  width: 100%;

  padding: 14px 15px;

  background: #090909;

  color: #fff;

  border:
    1px solid
    #292929;

  border-radius: 11px;

  outline: none;

  transition:
    .2s;
}

.field input:focus {
  border-color:
    #e52b42;

  box-shadow:
    0 0 0 3px
    rgba(229,43,66,.08);
}

.login-button {
  width: 100%;

  margin-top: 5px;

  padding: 14px;

  border: 0;

  border-radius: 11px;

  background:
    linear-gradient(
      135deg,
      #ff344c,
      #a70e21
    );

  color: #fff;

  font-weight: 800;

  cursor: pointer;

  box-shadow:
    0 10px 30px
    rgba(190,15,40,.18);
}

.login-error {
  margin-bottom: 15px;

  padding: 11px;

  border-radius: 9px;

  background:
    rgba(255,50,70,.08);

  border:
    1px solid
    rgba(255,50,70,.2);

  color: #ff7c89;

  font-size: 13px;
}

.footer {
  text-align: center;

  margin-top: 20px;

  color: #444;

  font-size: 11px;
}

</style>

</head>

<body>

<div class="login-wrap">

  <div class="brand">

    <div class="logo">
      S
    </div>

    <h1>
      SINZU AI
    </h1>

    <p>
      COMMAND CENTER
    </p>

  </div>

  <div class="login-card">

    ${error}

    <form
      method="POST"
      action="/login"
    >

      <div class="field">

        <label>
          Username
        </label>

        <input
          type="text"
          name="username"
          placeholder="Enter username"
          autocomplete="username"
          required
        >

      </div>

      <div class="field">

        <label>
          Password
        </label>

        <input
          type="password"
          name="password"
          placeholder="Enter password"
          autocomplete="current-password"
          required
        >

      </div>

      <button
        class="login-button"
        type="submit"
      >
        ENTER COMMAND CENTER
      </button>

    </form>

  </div>

  <div class="footer">
    SINZU AI • PRIVATE CONTROL PANEL
  </div>

</div>

</body>
</html>
    `);
  }
);

/* ============================================================
   LOGIN POST
   ============================================================ */

app.post(
  "/login",
  (req, res) => {
    const username =
      String(
        req.body.username || ""
      );

    const password =
      String(
        req.body.password || ""
      );

    if (
      username === ADMIN_USER &&
      password === ADMIN_PASS
    ) {
      req.session.authenticated =
        true;

      return req.session.save(
        error => {
          if (error) {
            addLog(
              "ERROR",
              `Dashboard session: ${error.message}`
            );

            return res
              .status(500)
              .send(
                "Session error."
              );
          }

          return res.redirect(
            "/dashboard"
          );
        }
      );
    }

    return res.redirect(
      "/login?error=1"
    );
  }
);

/* ============================================================
   DASHBOARD
   ============================================================ */

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

<title>SINZU AI — Command Center</title>

<style>

:root {
  --bg: #050505;
  --panel: rgba(16,16,17,.82);
  --panel2: #0d0d0e;
  --border: rgba(255,255,255,.08);
  --text: #f4f4f4;
  --muted: #777;
  --red: #ff334d;
  --red2: #a50d21;
  --green: #45e28a;
  --yellow: #ffd166;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;

  min-height: 100vh;

  background:
    radial-gradient(
      circle at 75% -10%,
      rgba(164,12,32,.23),
      transparent 35%
    ),
    radial-gradient(
      circle at 5% 30%,
      rgba(90,10,20,.14),
      transparent 30%
    ),
    var(--bg);

  color: var(--text);

  font-family:
    Inter,
    Arial,
    sans-serif;
}

body::before {
  content: "";

  position: fixed;
  inset: 0;

  pointer-events: none;

  opacity: .45;

  background:
    linear-gradient(
      rgba(255,255,255,.012) 1px,
      transparent 1px
    ),
    linear-gradient(
      90deg,
      rgba(255,255,255,.012) 1px,
      transparent 1px
    );

  background-size: 35px 35px;
}

/* =========================================================
   APP
   ========================================================= */

.app {
  position: relative;
  z-index: 1;

  width: min(
    1250px,
    94%
  );

  margin:
    0 auto;

  padding:
    25px 0 50px;
}

/* =========================================================
   TOPBAR
   ========================================================= */

.topbar {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 20px;

  margin-bottom: 25px;

  padding:
    16px 18px;

  background:
    rgba(14,14,15,.78);

  backdrop-filter:
    blur(20px);

  border:
    1px solid
    var(--border);

  border-radius:
    17px;

  box-shadow:
    0 20px 70px
    rgba(0,0,0,.28);
}

.brand-area {
  display: flex;

  align-items: center;

  gap: 13px;
}

.brand-icon {
  width: 45px;
  height: 45px;

  flex: 0 0 45px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 13px;

  background:
    linear-gradient(
      145deg,
      #ff344d,
      #740817
    );

  font-weight: 900;

  box-shadow:
    0 0 25px
    rgba(255,35,60,.15);
}

.brand-title {
  font-size: 16px;

  font-weight: 900;

  letter-spacing: 1.4px;
}

.brand-subtitle {
  margin-top: 3px;

  color: #666;

  font-size: 11px;

  letter-spacing: .7px;
}

.top-actions {
  display: flex;

  align-items: center;

  gap: 9px;
}

.status-pill {
  display: flex;

  align-items: center;

  gap: 7px;

  padding:
    8px 11px;

  border:
    1px solid
    var(--border);

  border-radius: 999px;

  background:
    rgba(255,255,255,.025);

  color: #aaa;

  font-size: 11px;

  font-weight: 700;
}

.dot {
  width: 7px;
  height: 7px;

  border-radius: 50%;

  background: #666;
}

.dot.online {
  background:
    var(--green);

  box-shadow:
    0 0 12px
    rgba(69,226,138,.75);
}

.logout {
  padding:
    9px 12px;

  border:
    1px solid
    var(--border);

  border-radius: 9px;

  color: #999;

  text-decoration: none;

  font-size: 11px;
}

.logout:hover {
  color: #fff;

  border-color:
    rgba(255,255,255,.18);
}

/* =========================================================
   HERO
   ========================================================= */

.hero {
  position: relative;

  overflow: hidden;

  margin-bottom: 16px;

  padding: 30px;

  border:
    1px solid
    rgba(255,255,255,.08);

  border-radius: 22px;

  background:
    linear-gradient(
      120deg,
      rgba(28,11,14,.96),
      rgba(12,12,13,.92)
    );

  box-shadow:
    0 30px 90px
    rgba(0,0,0,.38);
}

.hero::after {
  content: "";

  position: absolute;

  width: 280px;
  height: 280px;

  right: -100px;
  top: -140px;

  border-radius: 50%;

  background:
    rgba(255,35,60,.08);

  filter:
    blur(20px);
}

.hero-content {
  position: relative;
  z-index: 2;
}

.eyebrow {
  color:
    #e74b5c;

  font-size: 10px;

  font-weight: 900;

  letter-spacing:
    2.5px;

  text-transform:
    uppercase;
}

.hero h1 {
  margin:
    9px 0 6px;

  font-size:
    clamp(27px, 5vw, 43px);

  line-height:
    1.05;

  letter-spacing:
    -1.5px;
}

.hero p {
  margin: 0;

  max-width: 650px;

  color: #777;

  line-height:
    1.6;

  font-size: 13px;
}

/* =========================================================
   STAT GRID
   ========================================================= */

.stats {
  display: grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap: 13px;

  margin-bottom: 16px;
}

.card {
  background:
    var(--panel);

  backdrop-filter:
    blur(18px);

  border:
    1px solid
    var(--border);

  border-radius:
    17px;

  box-shadow:
    0 15px 50px
    rgba(0,0,0,.18);
}

.stat-card {
  padding: 19px;

  min-height:
    126px;

  transition:
    transform .2s,
    border-color .2s;
}

.stat-card:hover {
  transform:
    translateY(-2px);

  border-color:
    rgba(255,255,255,.13);
}

.stat-top {
  display: flex;

  align-items: center;

  justify-content:
    space-between;
}

.stat-label {
  color:
    #666;

  font-size:
    10px;

  font-weight:
    800;

  letter-spacing:
    1.4px;
}

.stat-icon {
  width: 31px;
  height: 31px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius:
    9px;

  background:
    rgba(255,255,255,.04);

  color:
    #aaa;

  font-size:
    13px;
}

.stat-value {
  margin-top:
    20px;

  font-size:
    19px;

  font-weight:
    850;

  white-space:
    nowrap;

  overflow:
    hidden;

  text-overflow:
    ellipsis;
}

.stat-meta {
  margin-top:
    5px;

  color:
    #555;

  font-size:
    10px;
}

.online-text {
  color:
    var(--green);
}

.offline-text {
  color:
    #ff6575;
}

.connecting-text {
  color:
    var(--yellow);
}

/* =========================================================
   MAIN GRID
   ========================================================= */

.main-grid {
  display: grid;

  grid-template-columns:
    1.5fr 1fr;

  gap: 16px;
}

.section {
  padding:
    20px;
}

.section-head {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 10px;

  margin-bottom:
    17px;
}

.section-title {
  font-size:
    15px;

  font-weight:
    850;
}

.section-desc {
  margin-top:
    3px;

  color:
    #5f5f5f;

  font-size:
    11px;
}

/* =========================================================
   SESSION LOGIN
   ========================================================= */

textarea {
  width: 100%;

  min-height:
    205px;

  resize:
    vertical;

  padding:
    14px;

  background:
    #080808;

  color:
    #ddd;

  border:
    1px solid
    #252525;

  border-radius:
    12px;

  outline:
    none;

  font-family:
    "Courier New",
    monospace;

  font-size:
    11px;

  line-height:
    1.5;

  transition:
    .2s;
}

textarea:focus {
  border-color:
    rgba(255,50,70,.5);

  box-shadow:
    0 0 0 3px
    rgba(255,50,70,.06);
}

.security-note {
  display: flex;

  gap: 10px;

  margin-top:
    12px;

  padding:
    11px 12px;

  border-radius:
    10px;

  background:
    rgba(255,190,70,.035);

  border:
    1px solid
    rgba(255,190,70,.09);

  color:
    #8e7951;

  font-size:
    10px;

  line-height:
    1.5;
}

.buttons {
  display: flex;

  gap: 9px;

  flex-wrap:
    wrap;

  margin-top:
    13px;
}

button {
  border:
    0;

  cursor:
    pointer;

  border-radius:
    10px;

  padding:
    11px 15px;

  font-size:
    11px;

  font-weight:
    850;

  transition:
    transform .15s,
    opacity .15s;
}

button:active {
  transform:
    scale(.98);
}

.primary {
  color:
    #fff;

  background:
    linear-gradient(
      135deg,
      #ff344d,
      #a70d21
    );

  box-shadow:
    0 10px 25px
    rgba(180,15,35,.17);
}

.secondary {
  color:
    #bbb;

  background:
    #181819;

  border:
    1px solid
    #292929;
}

.danger {
  color:
    #ff7a88;

  background:
    rgba(130,10,25,.15);

  border:
    1px solid
    rgba(255,50,70,.12);
}

/* =========================================================
   MODULES
   ========================================================= */

.modules {
  display:
    grid;

  grid-template-columns:
    repeat(2, 1fr);

  gap:
    10px;
}

.module {
  padding:
    15px;

  background:
    #0c0c0d;

  border:
    1px solid
    #202021;

  border-radius:
    12px;
}

.module-head {
  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;
}

.module-name {
  font-size:
    11px;

  font-weight:
    800;
}

.module-status {
  padding:
    4px 7px;

  border-radius:
    999px;

  background:
    rgba(69,226,138,.06);

  color:
    var(--green);

  font-size:
    8px;

  font-weight:
    900;
}

.module-desc {
  margin-top:
    8px;

  color:
    #5c5c5c;

  font-size:
    9px;

  line-height:
    1.5;
}

/* =========================================================
   LOGS
   ========================================================= */

.logs {
  height:
    290px;

  overflow:
    auto;

  background:
    #080808;

  border:
    1px solid
    #202020;

  border-radius:
    12px;

  padding:
    8px;
}

.log {
  display:
    grid;

  grid-template-columns:
    68px 76px 1fr;

  gap:
    7px;

  padding:
    9px;

  border-bottom:
    1px solid
    rgba(255,255,255,.035);

  font-family:
    "Courier New",
    monospace;

  font-size:
    9px;
}

.log:last-child {
  border-bottom:
    0;
}

.log-time {
  color:
    #444;
}

.log-type {
  color:
    #b34b59;

  font-weight:
    800;
}

.log-message {
  color:
    #8a8a8a;

  word-break:
    break-word;
}

/* =========================================================
   QUICK COMMANDS
   ========================================================= */

.command-list {
  display:
    grid;

  gap:
    8px;
}

.command {
  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  padding:
    11px 12px;

  background:
    #0c0c0d;

  border:
    1px solid
    #202020;

  border-radius:
    10px;
}

.command code {
  color:
    #d2d2d2;

  font-size:
    10px;
}

.command span {
  color:
    #555;

  font-size:
    9px;
}

/* =========================================================
   FOOTER
   ========================================================= */

.footer {
  margin-top:
    20px;

  text-align:
    center;

  color:
    #3d3d3d;

  font-size:
    10px;

  letter-spacing:
    .5px;
}

/* =========================================================
   RESPONSIVE
   ========================================================= */

@media (
  max-width: 900px
) {

  .stats {
    grid-template-columns:
      repeat(2, 1fr);
  }

  .main-grid {
    grid-template-columns:
      1fr;
  }

}

@media (
  max-width: 600px
) {

  .app {
    width:
      94%;
  }

  .topbar {
    align-items:
      flex-start;

    flex-direction:
      column;
  }

  .top-actions {
    width:
      100%;

    justify-content:
      space-between;
  }

  .hero {
    padding:
      23px;
  }

  .stats {
    grid-template-columns:
      1fr 1fr;

    gap:
      9px;
  }

  .stat-card {
    min-height:
      112px;

    padding:
      14px;
  }

  .stat-value {
    font-size:
      15px;
  }

  .section {
    padding:
      15px;
  }

  .modules {
    grid-template-columns:
      1fr;
  }

  .log {
    grid-template-columns:
      55px 62px 1fr;

    font-size:
      8px;
  }

}

</style>

</head>

<body>

<div class="app">

  <!-- TOPBAR -->

  <header class="topbar">

    <div class="brand-area">

      <div class="brand-icon">
        S
      </div>

      <div>

        <div class="brand-title">
          SINZU AI
        </div>

        <div class="brand-subtitle">
          COMMAND CENTER
        </div>

      </div>

    </div>

    <div class="top-actions">

      <div class="status-pill">

        <span
          class="dot"
          id="topDot"
        ></span>

        <span id="topStatus">
          CHECKING
        </span>

      </div>

      <a
        href="/logout"
        class="logout"
      >
        LOGOUT
      </a>

    </div>

  </header>

  <!-- HERO -->

  <section class="hero">

    <div class="hero-content">

      <div class="eyebrow">
        Messenger Control System
      </div>

      <h1>
        Command Center
      </h1>

      <p>
        Monitor the bot, manage the Messenger
        session, and keep your protection
        modules connected from one dashboard.
      </p>

    </div>

  </section>

  <!-- STATS -->

  <section class="stats">

    <div class="card stat-card">

      <div class="stat-top">

        <div class="stat-label">
          BOT ACCOUNT
        </div>

        <div class="stat-icon">
          ◉
        </div>

      </div>

      <div
        class="stat-value"
        id="botName"
      >
        Loading...
      </div>

      <div class="stat-meta">
        Messenger account
      </div>

    </div>

    <div class="card stat-card">

      <div class="stat-top">

        <div class="stat-label">
          BOT UID
        </div>

        <div class="stat-icon">
          #
        </div>

      </div>

      <div
        class="stat-value"
        id="botUID"
      >
        —
      </div>

      <div class="stat-meta">
        Current account identifier
      </div>

    </div>

    <div class="card stat-card">

      <div class="stat-top">

        <div class="stat-label">
          CONNECTION
        </div>

        <div class="stat-icon">
          ↯
        </div>

      </div>

      <div
        class="stat-value"
        id="botStatus"
      >
        Checking
      </div>

      <div class="stat-meta">
        Live bot state
      </div>

    </div>

    <div class="card stat-card">

      <div class="stat-top">

        <div class="stat-label">
          UPTIME
        </div>

        <div class="stat-icon">
          ◷
        </div>

      </div>

      <div
        class="stat-value"
        id="uptime"
      >
        0s
      </div>

      <div class="stat-meta">
        Current process session
      </div>

    </div>

  </section>

  <!-- MAIN -->

  <div class="main-grid">

    <!-- LEFT -->

    <div>

      <!-- LOGIN -->

      <section class="card section">

        <div class="section-head">

          <div>

            <div class="section-title">
              Messenger Session
            </div>

            <div class="section-desc">
              Connect the bot using AppState / C3C.
            </div>

          </div>

        </div>

        <textarea
          id="appstate"
          placeholder="Paste AppState / C3C here..."
          spellcheck="false"
        ></textarea>

        <div class="security-note">

          <span>
            🔐
          </span>

          <span>
            Keep your AppState/C3C private.
            Do not publish it on GitHub or send
            it to other people.
          </span>

        </div>

        <div class="buttons">

          <button
            class="primary"
            onclick="loginBot()"
          >
            CONNECT BOT
          </button>

          <button
            class="secondary"
            onclick="clearSessionInput()"
          >
            CLEAR
          </button>

          <button
            class="danger"
            onclick="logoutBot()"
          >
            DISCONNECT
          </button>

        </div>

        <div
          class="section-desc"
          id="actionMessage"
          style="margin-top:12px;"
        >
          Ready.

        </div>

      </section>

      <!-- ACTIVITY -->

      <section
        class="card section"
        style="margin-top:16px;"
      >

        <div class="section-head">

          <div>

            <div class="section-title">
              System Activity
            </div>

            <div class="section-desc">
              Recent bot and dashboard events.
            </div>

          </div>

          <button
            class="secondary"
            onclick="refreshLogs()"
          >
            REFRESH
          </button>

        </div>

        <div
          class="logs"
          id="logs"
        >
          Loading...
        </div>

      </section>

    </div>

    <!-- RIGHT -->

    <div>

      <!-- MODULES -->

      <section class="card section">

        <div class="section-head">

          <div>

            <div class="section-title">
              Protection Modules
            </div>

            <div class="section-desc">
              Loaded modules connected to index.js.
            </div>

          </div>

        </div>

        <div class="modules">

          <div class="module">

            <div class="module-head">

              <div class="module-name">
                Nickname Protection
              </div>

              <div class="module-status">
                LOADED
              </div>

            </div>

            <div class="module-desc">
              Restores protected nicknames when
              supported Messenger events are received.
            </div>

          </div>

          <div class="module">

            <div class="module-head">

              <div class="module-name">
                GC Name Lock
              </div>

              <div class="module-status">
                LOADED
              </div>

            </div>

            <div class="module-desc">
              Keeps the configured group name
              protected when supported events occur.
            </div>

          </div>

          <div class="module">

            <div class="module-head">

              <div class="module-name">
                Human Banat
              </div>

              <div class="module-status">
                LOADED
              </div>

            </div>

            <div class="module-desc">
              Existing human-style reply system
              remains connected.
            </div>

          </div>

          <div class="module">

            <div class="module-head">

              <div class="module-name">
                Trigger System
              </div>

              <div class="module-status">
                LOADED
              </div>

            </div>

            <div class="module-desc">
              Existing trigger reply system remains
              connected to the message handler.
            </div>

          </div>

        </div>

      </section>

      <!-- QUICK COMMANDS -->

      <section
        class="card section"
        style="margin-top:16px;"
      >

        <div class="section-head">

          <div>

            <div class="section-title">
              Quick Commands
            </div>

            <div class="section-desc">
              Commands available inside Messenger.
            </div>

          </div>

        </div>

        <div class="command-list">

          <div class="command">

            <code>
              !setallnick &lt;nickname&gt;
            </code>

            <span>
              ADMIN
            </span>

          </div>

          <div class="command">

            <code>
              !restoreallnick
            </code>

            <span>
              ADMIN
            </span>

          </div>

          <div class="command">

            <code>
              !nickprotect
            </code>

            <span>
              STATUS
            </span>

          </div>

          <div class="command">

            <code>
              !lockgcname &lt;name&gt;
            </code>

            <span>
              ADMIN
            </span>

          </div>

          <div class="command">

            <code>
              !unlockgcname
            </code>

            <span>
              ADMIN
            </span>

          </div>

          <div class="command">

            <code>
              !gcnameprotect
            </code>

            <span>
              STATUS
            </span>

          </div>

          <div class="command">

            <code>
              /banat on
            </code>

            <span>
              ADMIN
            </span>

          </div>

          <div class="command">

            <code>
              /banat off
            </code>

            <span>
              ADMIN
            </span>

          </div>

        </div>

      </section>

    </div>

  </div>

  <div class="footer">
    SINZU AI • COMMAND CENTER • LIVE DASHBOARD
  </div>

</div>

<script>

function setActionMessage(text) {
  document.getElementById(
    "actionMessage"
  ).textContent = text;
}

async function refreshStatus() {

  try {

    const response =
      await fetch(
        "/api/status",
        {
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        "Status request failed."
      );
    }

    const data =
      await response.json();

    const name =
      document.getElementById(
        "botName"
      );

    const uid =
      document.getElementById(
        "botUID"
      );

    const status =
      document.getElementById(
        "botStatus"
      );

    const uptime =
      document.getElementById(
        "uptime"
      );

    const topStatus =
      document.getElementById(
        "topStatus"
      );

    const topDot =
      document.getElementById(
        "topDot"
      );

    name.textContent =
      data.name ||
      "Not logged in";

    uid.textContent =
      data.uid ||
      "—";

    status.textContent =
      data.status ||
      "offline";

    uptime.textContent =
      data.uptime ||
      "0s";

    status.className =
      "stat-value";

    if (
      data.status === "online"
    ) {
      status.classList.add(
        "online-text"
      );

      topStatus.textContent =
        "ONLINE";

      topDot.classList.add(
        "online"
      );

    } else if (
      data.status === "connecting"
    ) {

      status.classList.add(
        "connecting-text"
      );

      topStatus.textContent =
        "CONNECTING";

      topDot.classList.remove(
        "online"
      );

    } else {

      status.classList.add(
        "offline-text"
      );

      topStatus.textContent =
        "OFFLINE";

      topDot.classList.remove(
        "online"
      );

    }

  } catch (error) {

    document.getElementById(
      "topStatus"
    ).textContent =
      "ERROR";

  }

}

async function loginBot() {

  const textarea =
    document.getElementById(
      "appstate"
    );

  const value =
    textarea.value.trim();

  if (!value) {

    setActionMessage(
      "Paste your AppState/C3C first."
    );

    return;
  }

  setActionMessage(
    "Connecting to Messenger..."
  );

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

          body:
            JSON.stringify({
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

    textarea.value = "";

    setActionMessage(
      "Connected successfully as " +
      (
        data.name ||
        "Messenger Bot"
      ) +
      "."
    );

    await refreshStatus();
    await refreshLogs();

  } catch (error) {

    setActionMessage(
      "Login failed: " +
      error.message
    );

    refreshStatus();

  }

}

function clearSessionInput() {

  document.getElementById(
    "appstate"
  ).value = "";

  setActionMessage(
    "Input cleared."
  );

}

async function logoutBot() {

  setActionMessage(
    "Disconnecting bot..."
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

    setActionMessage(
      data.message ||
      "Bot disconnected."
    );

    refreshStatus();
    refreshLogs();

  } catch (error) {

    setActionMessage(
      "Disconnect failed."
    );

  }

}

async function refreshLogs() {

  const container =
    document.getElementById(
      "logs"
    );

  try {

    const response =
      await fetch(
        "/api/logs",
        {
          cache: "no-store"
        }
      );

    const data =
      await response.json();

    if (
      !data.logs ||
      !data.logs.length
    ) {

      container.innerHTML =
        '<div style="padding:12px;color:#444;font-size:10px;">No activity yet.</div>';

      return;
    }

    container.innerHTML =
      data.logs
        .map(log => {

          const date =
            new Date(
              log.time
            );

          const time =
            date.toLocaleTimeString();

          return `
            <div class="log">

              <div class="log-time">
                ${escapeText(time)}
              </div>

              <div class="log-type">
                ${escapeText(log.type)}
              </div>

              <div class="log-message">
                ${escapeText(log.message)}
              </div>

            </div>
          `;

        })
        .join("");

  } catch (error) {

    container.innerHTML =
      '<div style="padding:12px;color:#555;font-size:10px;">Unable to load logs.</div>';

  }

}

function escapeText(value) {

  return String(
    value ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );

}

refreshStatus();
refreshLogs();

setInterval(
  refreshStatus,
  3000
);

setInterval(
  refreshLogs,
  5000
);

</script>

</body>
</html>
    `);
  }
);

/* ============================================================
   STATUS API
   ============================================================ */

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
      connecting: botConnecting,
      protection: getProtectionStatus()
    });
  }
);

/* ============================================================
   LOG API
   ============================================================ */

app.get(
  "/api/logs",
  requireAuth,
  (req, res) => {
    res.json({
      logs: systemLogs
    });
  }
);

/* ============================================================
   BOT LOGIN API
   ============================================================ */

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

      return res
        .status(500)
        .json({
          error:
            error?.errorDescription ||
            error?.message ||
            String(error)
        });

    }
  }
);

/* ============================================================
   BOT LOGOUT
   ============================================================ */

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
      botName =
        "Not logged in";
      botStatus =
        "offline";
      botError = null;
      botLoginAt = null;
      botConnecting = false;

      addLog(
        "BOT",
        "Bot disconnected from dashboard."
      );

      return res.json({
        success: true,
        message:
          "Bot disconnected."
      });

    } catch (error) {

      return res
        .status(500)
        .json({
          error:
            error.message
        });

    }

  }
);

/* ============================================================
   DASHBOARD LOGOUT
   ============================================================ */

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

/* ============================================================
   ROOT
   ============================================================ */

app.get(
  "/",
  (req, res) => {

    if (
      req.session?.authenticated
    ) {
      return res.redirect(
        "/dashboard"
      );
    }

    return res.redirect(
      "/login"
    );

  }
);

/* ============================================================
   SERVER
   ============================================================ */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "=============================================="
    );

    console.log(
      "          SINZU AI COMMAND CENTER"
    );

    console.log(
      "=============================================="
    );

    console.log(
      `[SERVER] Port: ${PORT}`
    );

    console.log(
      `[DASHBOARD] Username: ${ADMIN_USER}`
    );

    console.log(
      "[DASHBOARD] Password configured."
    );

    console.log(
      `[BANAT] Default: ${
        DEFAULT_ON
          ? "ON"
          : "OFF"
      }`
    );

    console.log(
      "[MODULE] setallnick.js loaded."
    );

    console.log(
      "[MODULE] gcname-lock.js loaded."
    );

    console.log(
      "=============================================="
    );

    addLog(
      "SERVER",
      `Command Center started on port ${PORT}`
    );

    /* ------------------------------------------
       AUTO LOGIN
       ------------------------------------------ */

    const savedSession =
      getSavedSession();

    if (savedSession) {

      addLog(
        "LOGIN",
        "Saved Messenger session detected."
      );

      loginBot(
        savedSession
      )
        .then(result => {

          addLog(
            "SUCCESS",
            `Auto-login successful: ${result.name}`
          );

        })
        .catch(error => {

          addLog(
            "LOGIN ERROR",
            `Auto-login failed: ${
              error?.errorDescription ||
              error?.message ||
              error
            }`
          );

        });

    } else {

      addLog(
        "LOGIN",
        "No saved session. Login from dashboard."
      );

    }

  }
);

/* ============================================================
   EXPORTS
   ============================================================ */

module.exports = {
  trafficSendMessage,
  onMessage,
  handleBanatCommand,
  loginBot
};
