"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const { login } = require("ws3-fca");

/* ============================================================
   EXISTING SYSTEMS — HUWAG GALAWIN
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
   PROTECTION MODULES
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
   EXPRESS SERVER
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
   DASHBOARD LOGIN
   ============================================================ */

const ADMIN_USER = "admin";
const ADMIN_PASS = "halimaw123";

const SESSION_SECRET =
  process.env.DASHBOARD_SESSION_SECRET ||
  "sinzu-command-center-session-secret-change-this";

/*
 * secure cookie automatically follows HTTPS.
 * Mas compatible ito sa Render at local testing.
 */
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
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

  if (systemLogs.length > 100) {
    systemLogs.length = 100;
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

function uptimeText() {
  if (!botLoginAt) {
    return "0s";
  }

  const seconds = Math.max(
    0,
    Math.floor(
      (Date.now() - botLoginAt) / 1000
    )
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

/* ============================================================
   SESSION / APPSTATE
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
    if (!value) {
      continue;
    }

    const parsed =
      parseSessionInput(value);

    if (parsed) {
      return parsed;
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
      `Could not read saved session: ${error.message}`
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
      "Messenger session saved."
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

  /*
   * Protection commands
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
        addLog(
          "NICKNAME",
          `Command handled in ${event.threadID}`
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
          `Command handled in ${event.threadID}`
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

  /*
   * Ignore non-message events for normal replies.
   * Protection handlers above still receive
   * the event.
   */

  if (
    event.type &&
    event.type !== "message"
  ) {
    return;
  }

  if (!body) {
    return;
  }

  /*
   * Banat command
   */

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

  /*
   * Target classification
   */

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

  /*
   * Existing trigger system
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
      addLog(
        "ERROR",
        `Trigger send: ${error.message}`
      );
    });

    return;
  }

  /*
   * Only continue banat when active/targeted
   */

  if (
    !modeActive &&
    !targetInfo?.isTarget
  ) {
    return;
  }

  /*
   * Existing human banat conversation
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

  if (
    !api ||
    typeof api.listenMqtt !==
      "function"
  ) {
    botStatus = "error";
    botError =
      "Messenger API does not provide listenMqtt.";

    addLog(
      "ERROR",
      botError
    );

    return;
  }

  try {
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

        /*
         * Protection events
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
            addLog(
              "ERROR",
              `Nickname protection: ${error.message}`
            );
          });

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

        /*
         * Default banat
         */

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

        try {
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
  } catch (error) {
    botStatus = "error";

    botError =
      error?.message ||
      String(error);

    addLog(
      "ERROR",
      `listenMqtt failed: ${botError}`
    );
  }
}

/* ============================================================
   BOT LOGIN
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
    /*
     * Disconnect old session first.
     */

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

    /*
     * Save only after successful login.
     */

    saveSession(
      normalized
    );

    start(api);

    botStatus = "online";
    botError = null;
    botLoginAt = Date.now();

    addLog(
      "SUCCESS",
      `Bot online: ${botName} (${botUserID || "unknown"})`
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
          <div class="error">
            Invalid username or password.
          </div>
        `
        : "";

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>

<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>SINZU AI • Login</title>

<style>

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
}

body {
  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  padding: 20px;

  color: #fff;

  font-family:
    Inter,
    Arial,
    sans-serif;

  background:
    radial-gradient(
      circle at 50% -10%,
      rgba(255,35,60,.25),
      transparent 38%
    ),
    radial-gradient(
      circle at 0% 100%,
      rgba(120,0,20,.18),
      transparent 35%
    ),
    #030303;

  overflow: hidden;
}

body::before {
  content: "";

  position: fixed;
  inset: 0;

  pointer-events: none;

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

  background-size:
    34px 34px;
}

.login {
  width: 100%;
  max-width: 420px;

  position: relative;
  z-index: 2;
}

.logo {
  width: 76px;
  height: 76px;

  margin: 0 auto 20px;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 24px;

  background:
    linear-gradient(
      145deg,
      #ff4058,
      #760817
    );

  font-size: 32px;
  font-weight: 950;

  box-shadow:
    0 0 60px
    rgba(255,40,65,.25);
}

.title {
  text-align: center;
}

.title h1 {
  margin: 0;

  font-size: 28px;

  letter-spacing: 3px;
}

.title p {
  margin: 7px 0 25px;

  color: #666;

  font-size: 10px;

  letter-spacing: 3px;
}

.card {
  padding: 26px;

  background:
    rgba(14,14,15,.82);

  backdrop-filter:
    blur(25px);

  border:
    1px solid
    rgba(255,255,255,.09);

  border-radius: 22px;

  box-shadow:
    0 40px 120px
    rgba(0,0,0,.6);
}

label {
  display: block;

  margin-bottom: 7px;

  color: #777;

  font-size: 10px;

  font-weight: 800;

  letter-spacing: 1.5px;

  text-transform: uppercase;
}

.field {
  margin-bottom: 15px;
}

input {
  width: 100%;

  padding: 14px;

  border:
    1px solid
    #292929;

  border-radius: 11px;

  outline: none;

  background: #080808;

  color: #fff;

  transition: .2s;
}

input:focus {
  border-color: #d5223b;

  box-shadow:
    0 0 0 3px
    rgba(213,34,59,.08);
}

button {
  width: 100%;

  margin-top: 3px;

  padding: 14px;

  border: 0;

  border-radius: 11px;

  color: #fff;

  font-weight: 900;

  letter-spacing: .4px;

  cursor: pointer;

  background:
    linear-gradient(
      135deg,
      #ff344d,
      #990c20
    );

  box-shadow:
    0 12px 35px
    rgba(180,15,40,.2);
}

.error {
  margin-bottom: 15px;

  padding: 11px;

  color: #ff8a98;

  background:
    rgba(255,40,60,.08);

  border:
    1px solid
    rgba(255,40,60,.2);

  border-radius: 10px;

  font-size: 12px;
}

.note {
  margin-top: 18px;

  text-align: center;

  color: #444;

  font-size: 9px;

  letter-spacing: .5px;
}

</style>

</head>

<body>

<div class="login">

  <div class="logo">S</div>

  <div class="title">
    <h1>SINZU AI</h1>
    <p>PRIVATE COMMAND CENTER</p>
  </div>

  <div class="card">

    ${error}

    <form method="POST" action="/login">

      <div class="field">
        <label>Username</label>

        <input
          type="text"
          name="username"
          autocomplete="username"
          placeholder="Username"
          required
        >
      </div>

      <div class="field">
        <label>Password</label>

        <input
          type="password"
          name="password"
          autocomplete="current-password"
          placeholder="Password"
          required
        >
      </div>

      <button type="submit">
        ENTER COMMAND CENTER
      </button>

    </form>

  </div>

  <div class="note">
    SINZU AI • AUTHORIZED ACCESS ONLY
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
              `Dashboard session error: ${error.message}`
            );

            return res
              .status(500)
              .send(
                "Dashboard session error."
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
   PREMIUM DASHBOARD
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

<meta
  name="theme-color"
  content="#080808"
>

<title>SINZU AI • Command Center</title>

<style>

:root {
  --bg: #050505;
  --panel: rgba(15,15,16,.76);
  --panel2: #0a0a0b;
  --border: rgba(255,255,255,.075);
  --border2: rgba(255,255,255,.12);
  --text: #f5f5f5;
  --muted: #686868;
  --muted2: #444;
  --red: #ff334d;
  --red2: #9d0b20;
  --green: #49e69a;
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

  color: var(--text);

  font-family:
    Inter,
    Arial,
    sans-serif;

  background:
    radial-gradient(
      circle at 80% -10%,
      rgba(190,15,40,.23),
      transparent 32%
    ),
    radial-gradient(
      circle at -10% 55%,
      rgba(110,5,20,.12),
      transparent 30%
    ),
    var(--bg);
}

body::before {
  content: "";

  position: fixed;
  inset: 0;

  pointer-events: none;

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

  background-size: 36px 36px;

  opacity: .8;
}

body::after {
  content: "";

  position: fixed;
  inset: 0;

  pointer-events: none;

  background:
    linear-gradient(
      transparent 0%,
      rgba(255,255,255,.012) 50%,
      transparent 100%
    );

  background-size:
    100% 7px;

  opacity: .18;
}

.app {
  position: relative;
  z-index: 2;

  width: min(1320px, 94%);

  margin: auto;

  padding:
    20px 0 45px;
}

/* TOPBAR */

.topbar {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 15px;

  padding:
    13px 15px;

  margin-bottom: 16px;

  background:
    rgba(12,12,13,.72);

  backdrop-filter:
    blur(22px);

  border:
    1px solid
    var(--border);

  border-radius: 17px;

  box-shadow:
    0 20px 70px
    rgba(0,0,0,.3);
}

.brand {
  display: flex;

  align-items: center;

  gap: 11px;
}

.brand-icon {
  width: 43px;
  height: 43px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 13px;

  background:
    linear-gradient(
      145deg,
      #ff4058,
      #730817
    );

  font-weight: 950;

  box-shadow:
    0 0 30px
    rgba(255,40,65,.16);
}

.brand-name {
  font-size: 14px;

  font-weight: 900;

  letter-spacing: 1.5px;
}

.brand-sub {
  margin-top: 3px;

  color: #555;

  font-size: 9px;

  letter-spacing: 1.2px;
}

.top-right {
  display: flex;

  align-items: center;

  gap: 8px;
}

.status {
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

  color: #888;

  font-size: 9px;

  font-weight: 900;

  letter-spacing: .8px;
}

.status-dot {
  width: 7px;
  height: 7px;

  border-radius: 50%;

  background: #555;
}

.status-dot.online {
  background: var(--green);

  box-shadow:
    0 0 13px
    rgba(73,230,154,.8);
}

.logout {
  padding:
    8px 11px;

  border:
    1px solid
    var(--border);

  border-radius: 9px;

  color: #777;

  text-decoration: none;

  font-size: 9px;

  font-weight: 800;
}

.logout:hover {
  color: #fff;

  border-color:
    var(--border2);
}

/* HERO */

.hero {
  position: relative;

  overflow: hidden;

  padding:
    29px 30px;

  margin-bottom: 14px;

  border:
    1px solid
    rgba(255,255,255,.08);

  border-radius: 21px;

  background:
    linear-gradient(
      125deg,
      rgba(37,10,14,.95),
      rgba(12,12,13,.91)
    );

  box-shadow:
    0 30px 100px
    rgba(0,0,0,.35);
}

.hero::before {
  content: "";

  position: absolute;

  width: 360px;
  height: 360px;

  right: -140px;
  top: -180px;

  border-radius: 50%;

  background:
    rgba(255,30,55,.08);

  filter: blur(25px);
}

.hero::after {
  content: "SINZU";

  position: absolute;

  right: 30px;
  bottom: -20px;

  color:
    rgba(255,255,255,.025);

  font-size:
    90px;

  font-weight:
    950;

  letter-spacing:
    -5px;
}

.hero-content {
  position: relative;
  z-index: 2;
}

.eyebrow {
  color: #d64253;

  font-size: 9px;

  font-weight: 900;

  letter-spacing: 2.5px;

  text-transform: uppercase;
}

.hero h1 {
  margin:
    8px 0 7px;

  font-size:
    clamp(28px, 5vw, 48px);

  line-height: 1;

  letter-spacing: -2px;
}

.hero p {
  max-width: 690px;

  margin: 0;

  color: #696969;

  font-size: 12px;

  line-height: 1.7;
}

/* STATS */

.stats {
  display: grid;

  grid-template-columns:
    repeat(4, 1fr);

  gap: 11px;

  margin-bottom: 14px;
}

.card {
  background:
    var(--panel);

  backdrop-filter:
    blur(20px);

  border:
    1px solid
    var(--border);

  border-radius: 16px;

  box-shadow:
    0 18px 60px
    rgba(0,0,0,.2);
}

.stat {
  min-width: 0;

  padding: 17px;

  transition:
    transform .2s,
    border-color .2s;
}

.stat:hover {
  transform:
    translateY(-2px);

  border-color:
    var(--border2);
}

.stat-head {
  display: flex;

  justify-content:
    space-between;

  align-items:
    center;
}

.stat-label {
  color: #555;

  font-size: 8px;

  font-weight: 900;

  letter-spacing: 1.5px;
}

.stat-icon {
  width: 29px;
  height: 29px;

  display: flex;

  align-items: center;
  justify-content: center;

  border-radius: 9px;

  background:
    rgba(255,255,255,.035);

  color: #777;

  font-size: 12px;
}

.stat-value {
  margin-top: 17px;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;

  font-size: 18px;

  font-weight: 900;
}

.stat-meta {
  margin-top: 5px;

  color: #444;

  font-size: 9px;
}

.online {
  color: var(--green);
}

.offline {
  color: #ff6878;
}

.connecting {
  color: var(--yellow);
}

/* GRID */

.grid {
  display: grid;

  grid-template-columns:
    minmax(0, 1.45fr)
    minmax(320px, .85fr);

  gap: 14px;
}

.section {
  padding: 19px;
}

.section + .section {
  margin-top: 14px;
}

.section-head {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 12px;

  margin-bottom: 15px;
}

.section-title {
  font-size: 13px;

  font-weight: 900;
}

.section-desc {
  margin-top: 4px;

  color: #505050;

  font-size: 9px;
}

/* SESSION */

textarea {
  width: 100%;

  min-height: 185px;

  padding: 14px;

  resize: vertical;

  outline: none;

  color: #ccc;

  background: #070707;

  border:
    1px solid
    #222;

  border-radius: 12px;

  font-family:
    "Courier New",
    monospace;

  font-size: 10px;

  line-height: 1.5;

  transition: .2s;
}

textarea:focus {
  border-color:
    rgba(255,50,70,.42);

  box-shadow:
    0 0 0 3px
    rgba(255,50,70,.055);
}

.security {
  display: flex;

  gap: 9px;

  margin-top: 10px;

  padding: 10px;

  color: #81704d;

  background:
    rgba(255,190,70,.03);

  border:
    1px solid
    rgba(255,190,70,.075);

  border-radius: 10px;

  font-size: 9px;

  line-height: 1.5;
}

.actions {
  display: flex;

  flex-wrap: wrap;

  gap: 8px;

  margin-top: 11px;
}

button {
  border: 0;

  border-radius: 9px;

  padding:
    10px 14px;

  cursor: pointer;

  font-size: 9px;

  font-weight: 900;

  transition:
    transform .15s,
    opacity .15s;
}

button:active {
  transform:
    scale(.97);
}

.primary {
  color: #fff;

  background:
    linear-gradient(
      135deg,
      #ff344d,
      #970d20
    );

  box-shadow:
    0 9px 25px
    rgba(170,15,35,.16);
}

.secondary {
  color: #aaa;

  background: #151516;

  border:
    1px solid
    #292929;
}

.danger {
  color: #ff7d8b;

  background:
    rgba(120,8,25,.12);

  border:
    1px solid
    rgba(255,45,65,.12);
}

#actionMessage {
  min-height: 14px;
}

/* MODULES */

.modules {
  display: grid;

  grid-template-columns:
    repeat(2, 1fr);

  gap: 8px;
}

.module {
  padding: 13px;

  background:
    #0a0a0b;

  border:
    1px solid
    #1d1d1e;

  border-radius: 11px;
}

.module-head {
  display: flex;

  justify-content:
    space-between;

  align-items: center;

  gap: 8px;
}

.module-name {
  font-size: 10px;

  font-weight: 850;
}

.badge {
  flex: 0 0 auto;

  padding:
    4px 6px;

  border-radius:
    999px;

  color:
    var(--green);

  background:
    rgba(73,230,154,.055);

  font-size:
    7px;

  font-weight:
    950;

  letter-spacing:
    .6px;
}

.module p {
  margin:
    7px 0 0;

  color: #4e4e4e;

  font-size: 8px;

  line-height: 1.5;
}

/* COMMANDS */

.commands {
  display: grid;

  gap: 7px;
}

.command {
  display: flex;

  align-items: center;

  justify-content: space-between;

  gap: 10px;

  padding:
    10px 11px;

  background:
    #0a0a0b;

  border:
    1px solid
    #1c1c1d;

  border-radius: 9px;
}

.command code {
  color: #bbb;

  font-family:
    "Courier New",
    monospace;

  font-size: 9px;
}

.command span {
  color: #444;

  font-size: 7px;

  font-weight: 900;
}

/* LOGS */

.logs {
  height: 285px;

  overflow-y: auto;

  padding: 5px;

  background:
    #070707;

  border:
    1px solid
    #1d1d1d;

  border-radius: 11px;
}

.log {
  display: grid;

  grid-template-columns:
    63px 70px 1fr;

  gap: 7px;

  padding:
    8px;

  border-bottom:
    1px solid
    rgba(255,255,255,.025);

  font-family:
    "Courier New",
    monospace;

  font-size: 8px;
}

.log:last-child {
  border-bottom: 0;
}

.log-time {
  color: #3e3e3e;
}

.log-type {
  color: #b34354;

  font-weight: 900;
}

.log-message {
  color: #777;

  word-break: break-word;
}

/* FOOTER */

.footer {
  margin-top: 17px;

  text-align: center;

  color: #333;

  font-size: 8px;

  letter-spacing: 1px;
}

/* RESPONSIVE */

@media (max-width: 950px) {

  .stats {
    grid-template-columns:
      repeat(2, 1fr);
  }

  .grid {
    grid-template-columns:
      1fr;
  }

}

@media (max-width: 600px) {

  .app {
    width: 94%;

    padding-top: 10px;
  }

  .topbar {
    align-items:
      flex-start;

    flex-direction:
      column;
  }

  .top-right {
    width: 100%;

    justify-content:
      space-between;
  }

  .hero {
    padding: 23px;
  }

  .hero h1 {
    font-size: 32px;
  }

  .hero::after {
    font-size: 55px;

    right: 10px;
  }

  .stats {
    gap: 8px;
  }

  .stat {
    padding: 13px;
  }

  .stat-value {
    margin-top: 14px;

    font-size: 14px;
  }

  .stat-meta {
    font-size: 8px;
  }

  .section {
    padding: 14px;
  }

  .modules {
    grid-template-columns:
      1fr;
  }

  .log {
    grid-template-columns:
      52px 58px 1fr;

    font-size: 7px;
  }

  textarea {
    min-height: 160px;
  }

}

</style>

</head>

<body>

<div class="app">

  <!-- TOPBAR -->

  <header class="topbar">

    <div class="brand">

      <div class="brand-icon">
        S
      </div>

      <div>

        <div class="brand-name">
          SINZU AI
        </div>

        <div class="brand-sub">
          PRIVATE COMMAND CENTER
        </div>

      </div>

    </div>

    <div class="top-right">

      <div class="status">

        <span
          class="status-dot"
          id="topDot"
        ></span>

        <span id="topStatus">
          CHECKING
        </span>

      </div>

      <a
        class="logout"
        href="/logout"
      >
        LOGOUT
      </a>

    </div>

  </header>

  <!-- HERO -->

  <section class="hero">

    <div class="hero-content">

      <div class="eyebrow">
        MESSENGER CONTROL SYSTEM
      </div>

      <h1>
        Command Center
      </h1>

      <p>
        Monitor your Messenger connection,
        manage the session, and keep the
        protection systems connected from
        one control panel.
      </p>

    </div>

  </section>

  <!-- STAT CARDS -->

  <section class="stats">

    <div class="card stat">

      <div class="stat-head">

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

    <div class="card stat">

      <div class="stat-head">

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

    <div class="card stat">

      <div class="stat-head">

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
        Live connection state
      </div>

    </div>

    <div class="card stat">

      <div class="stat-head">

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
        Current bot session
      </div>

    </div>

  </section>

  <!-- MAIN -->

  <div class="grid">

    <main>

      <!-- SESSION -->

      <section class="card section">

        <div class="section-head">

          <div>

            <div class="section-title">
              Messenger Session
            </div>

            <div class="section-desc">
              Connect using your AppState / C3C session.
            </div>

          </div>

        </div>

        <textarea
          id="appstate"
          placeholder="Paste AppState / C3C here..."
          spellcheck="false"
          autocomplete="off"
        ></textarea>

        <div class="security">

          <span>🔐</span>

          <span>
            Keep your session private.
            Never publish AppState/C3C in GitHub,
            screenshots, logs, or public chats.
          </span>

        </div>

        <div class="actions">

          <button
            class="primary"
            onclick="loginBot()"
          >
            CONNECT BOT
          </button>

          <button
            class="secondary"
            onclick="clearInput()"
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
          id="actionMessage"
          class="section-desc"
          style="margin-top:12px;"
        >
          System ready.
        </div>

      </section>

      <!-- LOGS -->

      <section class="card section">

        <div class="section-head">

          <div>

            <div class="section-title">
              Live Activity
            </div>

            <div class="section-desc">
              Recent system events.
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

    </main>

    <aside>

      <!-- MODULES -->

      <section class="card section">

        <div class="section-head">

          <div>

            <div class="section-title">
              Protection Modules
            </div>

            <div class="section-desc">
              Connected to the bot event handler.
            </div>

          </div>

        </div>

        <div class="modules">

          <div class="module">

            <div class="module-head">

              <div class="module-name">
                Nickname Protection
              </div>

              <div class="badge">
                ACTIVE
              </div>

            </div>

            <p>
              Connected to setallnick.js.
            </p>

          </div>

          <div class="module">

            <div class="module-head">

              <div class="module-name">
                GC Name Lock
              </div>

              <div class="badge">
                ACTIVE
              </div>

            </div>

            <p>
              Connected to gcname-lock.js.
            </p>

          </div>

          <div class="module">

            <div class="module-head">

              <div class="module-name">
                Human Banat
              </div>

              <div class="badge">
                LOADED
              </div>

            </div>

            <p>
              Existing human reply system.
            </p>

          </div>

          <div class="module">

            <div class="module-head">

              <div class="module-name">
                Trigger System
              </div>

              <div class="badge">
                LOADED
              </div>

            </div>

            <p>
              Existing trigger reply system.
            </p>

          </div>

        </div>

      </section>

      <!-- COMMANDS -->

      <section
        class="card section"
      >

        <div class="section-head">

          <div>

            <div class="section-title">
              Quick Commands
            </div>

            <div class="section-desc">
              Messenger-side controls.
            </div>

          </div>

        </div>

        <div class="commands">

          <div class="command">
            <code>!setallnick &lt;nickname&gt;</code>
            <span>ADMIN</span>
          </div>

          <div class="command">
            <code>!restoreallnick</code>
            <span>ADMIN</span>
          </div>

          <div class="command">
            <code>!nickprotect</code>
            <span>STATUS</span>
          </div>

          <div class="command">
            <code>!lockgcname &lt;name&gt;</code>
            <span>ADMIN</span>
          </div>

          <div class="command">
            <code>!unlockgcname</code>
            <span>ADMIN</span>
          </div>

          <div class="command">
            <code>!gcnameprotect</code>
            <span>STATUS</span>
          </div>

          <div class="command">
            <code>/banat on</code>
            <span>ADMIN</span>
          </div>

          <div class="command">
            <code>/banat off</code>
            <span>ADMIN</span>
          </div>

        </div>

      </section>

    </aside>

  </div>

  <div class="footer">
    SINZU AI • COMMAND CENTER • LIVE SYSTEM
  </div>

</div>

<script>

function setActionMessage(message) {

  const element =
    document.getElementById(
      "actionMessage"
    );

  if (element) {
    element.textContent =
      message;
  }

}

/* ==========================================================
   STATUS
   ========================================================== */

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
      String(
        data.status ||
        "offline"
      ).toUpperCase();

    uptime.textContent =
      data.uptime ||
      "0s";

    status.className =
      "stat-value";

    topDot.classList.remove(
      "online"
    );

    if (
      data.status === "online"
    ) {

      status.classList.add(
        "online"
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
        "connecting"
      );

      topStatus.textContent =
        "CONNECTING";

    } else {

      status.classList.add(
        "offline"
      );

      topStatus.textContent =
        "OFFLINE";

    }

  } catch (error) {

    const topStatus =
      document.getElementById(
        "topStatus"
      );

    if (topStatus) {
      topStatus.textContent =
        "ERROR";
    }

  }

}

/* ==========================================================
   LOGIN
   ========================================================== */

async function loginBot() {

  const input =
    document.getElementById(
      "appstate"
    );

  const value =
    input.value.trim();

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

    let data = {};

    try {
      data =
        await response.json();
    } catch (_) {}

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Login failed."
      );

    }

    input.value = "";

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

/* ==========================================================
   CLEAR
   ========================================================== */

function clearInput() {

  const input =
    document.getElementById(
      "appstate"
    );

  input.value = "";

  setActionMessage(
    "Session input cleared."
  );

}

/* ==========================================================
   DISCONNECT
   ========================================================== */

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

/* ==========================================================
   LOGS
   ========================================================== */

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

    if (!response.ok) {
      throw new Error(
        "Logs request failed."
      );
    }

    const data =
      await response.json();

    if (
      !data.logs ||
      !data.logs.length
    ) {

      container.innerHTML =
        '<div style="padding:12px;color:#444;font-size:9px;">No activity yet.</div>';

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
      '<div style="padding:12px;color:#555;font-size:9px;">Unable to load logs.</div>';

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

/* ==========================================================
   START DASHBOARD REFRESH
   ========================================================== */

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
      connecting: botConnecting
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

        return res
          .status(400)
          .json({
            error:
              "AppState/C3C is required."
          });

      }

      if (botConnecting) {

        return res
          .status(409)
          .json({
            error:
              "Bot login is already in progress."
          });

      }

      const result =
        await loginBot(
          input
        );

      return res.json(
        result
      );

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

    /*
     * Auto-login from saved session.
     */

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

Files na dapat nasa root:

Cresi/
├── index.js              ← itong bago
├── package.json
├── triggers.js
├── banat-human.js
├── banat-targeting.js
├── setallnick.js
├── gcname-lock.js
└── appstate.json         ← optional; automatic na nagagawa pagkatapos successful login

Important: kung Render pa rin ang gamit mo, siguraduhing ang Start Command ay:

npm start

At sa "package.json", dapat may:

"scripts": {
  "start": "node index.js"
}

Huwag mong i-run ang "dashboard.js" separately. Ang dashboard ay built-in na mismo sa "index.js".

Isang security note: dahil hardcoded ang dashboard credentials na "admin / halimaw123", huwag mong gawing public ang repository kung ayaw mong madaling makita ang credentials.
