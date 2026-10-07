"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
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

const gcnameLock = require("./gcname-lock");
const setallnick = require("./setallnick");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

const DASH_USER = "admin";
const DASH_PASS = "halimaw123";

const ADMIN_UID = "61595204307407";

const SESSION_FILE = path.join(process.cwd(), "appstate.json");
const CONFIG_FILE = path.join(process.cwd(), "bot-config.json");

const DEFAULT_ON = true;

const GLOBAL_SEND_LIMIT = 12;
const THREAD_COOLDOWN_MS = 2500;

const RETRY_DELAYS = [
  1500,
  3000,
  5000,
  8000
];

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "10mb"
}));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "sanzu-dashboard-session",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

/* =========================================================
   STATE
========================================================= */

let api = null;
let botOnline = false;
let botName = "Unknown";
let botUID = "";

let botStartedAt = null;
let lastMessageAt = null;
let lastError = null;

let savedSession = null;

const logs = [];
const sendQueue = new Map();
const threadCooldowns = new Map();

let totalMessages = 0;
let totalReplies = 0;
let totalErrors = 0;

/* =========================================================
   LOGGING
========================================================= */

function addLog(type, message) {
  const entry = {
    time: new Date().toISOString(),
    type,
    message: String(message || "")
  };

  logs.unshift(entry);

  if (logs.length > 200) {
    logs.length = 200;
  }

  console.log(`[${type}] ${message}`);
}

/* =========================================================
   FILE HELPERS
========================================================= */

function ensureFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify(fallback, null, 2),
        "utf8"
      );
    }
  } catch (error) {
    addLog("ERROR", `File error: ${error.message}`);
  }
}

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (error) {
    addLog("ERROR", `JSON load failed: ${error.message}`);
    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );

    return true;
  } catch (error) {
    addLog("ERROR", `JSON save failed: ${error.message}`);
    return false;
  }
}

/* =========================================================
   BOT CONFIG
========================================================= */

function getConfig() {
  return loadJSON(CONFIG_FILE, {
    enabled: DEFAULT_ON,
    replyEnabled: DEFAULT_ON
  });
}

function saveConfig(config) {
  saveJSON(CONFIG_FILE, config);
}

ensureFile(CONFIG_FILE, {
  enabled: DEFAULT_ON,
  replyEnabled: DEFAULT_ON
});

/* =========================================================
   APPSTATE NORMALIZER
========================================================= */

/*
  IMPORTANT:

  ws3-fca versions are inconsistent.

  Some versions expect:

  {
    appState: [
      {
        key: "...",
        value: "...",
        domain: "...",
        path: "/",
        expires: ...
      }
    ]
  }

  Other/older builds internally expect:

  {
    appState: "key=value; key2=value2"
  }

  This file supports BOTH.
*/

function normalizeAppState(input) {
  let value = input;

  if (value === undefined || value === null) {
    throw new Error("Walang AppState na inilagay.");
  }

  /*
    If dashboard sends JSON as string,
    try parsing it first.
  */

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      throw new Error("Empty ang AppState.");
    }

    try {
      const parsed = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        return parsed;
      }

      if (
        parsed &&
        Array.isArray(parsed.appState)
      ) {
        return parsed.appState;
      }

      if (
        parsed &&
        typeof parsed.appState === "string"
      ) {
        return parsed.appState;
      }
    } catch (_) {
      /*
        Not JSON.

        It may already be a cookie string.
      */

      if (
        trimmed.includes("=") &&
        (
          trimmed.includes(";") ||
          trimmed.includes("c_user")
        )
      ) {
        return trimmed;
      }
    }

    throw new Error(
      "Hindi valid na AppState JSON o cookie string."
    );
  }

  /*
    Direct array
  */

  if (Array.isArray(value)) {
    return value;
  }

  /*
    Object containing appState
  */

  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "appState")
  ) {
    return normalizeAppState(value.appState);
  }

  throw new Error("Hindi supported ang AppState format.");
}

/* =========================================================
   APPSTATE ARRAY -> COOKIE STRING
========================================================= */

function appStateToCookieString(state) {
  if (!Array.isArray(state)) {
    return String(state || "");
  }

  return state
    .filter(item =>
      item &&
      item.key !== undefined &&
      item.value !== undefined
    )
    .map(item => {
      return `${item.key}=${item.value}`;
    })
    .join("; ");
}

/* =========================================================
   SESSION SAVE
========================================================= */

function saveSession(state) {
  try {
    let data = state;

    /*
      Always prefer array format when available.
    */

    if (typeof state === "string") {
      try {
        const parsed = JSON.parse(state);

        if (Array.isArray(parsed)) {
          data = parsed;
        } else {
          data = state;
        }
      } catch (_) {
        data = state;
      }
    }

    fs.writeFileSync(
      SESSION_FILE,
      JSON.stringify(data, null, 2),
      "utf8"
    );

    savedSession = data;

    addLog("LOGIN", "AppState saved.");

    return true;
  } catch (error) {
    addLog(
      "ERROR",
      `Could not save AppState: ${error.message}`
    );

    return false;
  }
}

/* =========================================================
   LOAD SESSION
========================================================= */

function getSavedSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(
      SESSION_FILE,
      "utf8"
    );

    if (!raw.trim()) {
      return null;
    }

    const parsed = JSON.parse(raw);

    savedSession = parsed;

    return parsed;
  } catch (error) {
    addLog(
      "ERROR",
      `Saved session invalid: ${error.message}`
    );

    return null;
  }
}

/* =========================================================
   BOT ACCOUNT INFO
========================================================= */

function getBotAccountInfo(botApi) {
  return new Promise(resolve => {
    try {
      if (!botApi) {
        resolve({
          uid: "",
          name: "Unknown"
        });
        return;
      }

      const currentID =
        typeof botApi.getCurrentUserID === "function"
          ? botApi.getCurrentUserID()
          : "";

      if (!currentID) {
        resolve({
          uid: "",
          name: "Unknown"
        });
        return;
      }

      const uid = String(currentID);

      if (
        typeof botApi.getUserInfo !== "function"
      ) {
        resolve({
          uid,
          name: "Messenger Bot"
        });
        return;
      }

      botApi.getUserInfo(
        uid,
        (error, info) => {
          if (error || !info) {
            resolve({
              uid,
              name: "Messenger Bot"
            });
            return;
          }

          resolve({
            uid,
            name:
              info[uid]?.name ||
              info[uid]?.firstName ||
              "Messenger Bot"
          });
        }
      );
    } catch (error) {
      resolve({
        uid: "",
        name: "Unknown"
      });
    }
  });
}

/* =========================================================
   SEND MESSAGE
========================================================= */

function rawSendMessage(message, threadID) {
  return new Promise((resolve, reject) => {
    if (!api) {
      reject(new Error("Bot is offline."));
      return;
    }

    try {
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
    } catch (error) {
      reject(error);
    }
  });
}

/* =========================================================
   SAFE SEND WITH RETRIES
========================================================= */

async function trafficSendMessage(message, threadID) {
  const key = String(threadID);

  if (!message || !threadID) {
    return false;
  }

  if (!api || !botOnline) {
    return false;
  }

  if (!sendQueue.has(key)) {
    sendQueue.set(key, Promise.resolve());
  }

  const previous = sendQueue.get(key);

  const task = previous
    .catch(() => {})
    .then(async () => {
      const now = Date.now();

      const last =
        threadCooldowns.get(key) || 0;

      const remaining =
        THREAD_COOLDOWN_MS - (now - last);

      if (remaining > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, remaining)
        );
      }

      for (
        let attempt = 0;
        attempt <= RETRY_DELAYS.length;
        attempt++
      ) {
        try {
          await rawSendMessage(
            message,
            threadID
          );

          threadCooldowns.set(
            key,
            Date.now()
          );

          totalReplies++;

          return true;
        } catch (error) {
          lastError =
            error?.message ||
            String(error);

          totalErrors++;

          addLog(
            "SEND_ERROR",
            lastError
          );

          /*
            Messenger error 1545012 can happen
            when requests are sent too quickly.
          */

          if (
            attempt >= RETRY_DELAYS.length
          ) {
            return false;
          }

          await new Promise(resolve =>
            setTimeout(
              resolve,
              RETRY_DELAYS[attempt]
            )
          );
        }
      }

      return false;
    });

  sendQueue.set(key, task);

  try {
    return await task;
  } finally {
    if (sendQueue.get(key) === task) {
      sendQueue.delete(key);
    }
  }
}

/* =========================================================
   BANAT SEND
========================================================= */

async function sendBanat(
  message,
  event,
  targetInfo
) {
  if (!message || !event?.threadID) {
    return false;
  }

  try {
    /*
      Preserve existing banat-human behavior.
    */

    if (
      typeof sendBanatReplyWithTyping ===
      "function"
    ) {
      await sendBanatReplyWithTyping(
        api,
        event,
        message,
        targetInfo
      );

      totalReplies++;

      return true;
    }
  } catch (error) {
    addLog(
      "BANAT_ERROR",
      error?.message || String(error)
    );
  }

  return trafficSendMessage(
    message,
    event.threadID
  );
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function onMessage(event) {
  if (!event) {
    return;
  }

  /*
    Ignore own messages.
  */

  if (
    botUID &&
    String(event.senderID || "") ===
      String(botUID)
  ) {
    return;
  }

  if (
    event.type !== "message" &&
    event.type !== "message_reply"
  ) {
    return;
  }

  const body = String(
    event.body || ""
  ).trim();

  if (!body) {
    return;
  }

  totalMessages++;
  lastMessageAt = Date.now();

  const config = getConfig();

  if (config.enabled === false) {
    return;
  }

  if (config.replyEnabled === false) {
    return;
  }

  const threadID =
    String(event.threadID || "");

  if (!threadID) {
    return;
  }

  /* =====================================================
     SETALLNICK
  ===================================================== */

  try {
    if (
      typeof setallnick.handleCommand ===
      "function"
    ) {
      const handled =
        setallnick.handleCommand(
          api,
          event,
          body
        );

      if (handled) {
        return;
      }
    }
  } catch (error) {
    addLog(
      "NICKNAME_ERROR",
      error?.message || String(error)
    );
  }

  /* =====================================================
     GC NAME LOCK
  ===================================================== */

  try {
    if (
      typeof gcnameLock.handleCommand ===
      "function"
    ) {
      const handled =
        gcnameLock.handleCommand(
          api,
          event,
          body
        );

      if (handled) {
        return;
      }
    }
  } catch (error) {
    addLog(
      "GCNAME_ERROR",
      error?.message || String(error)
    );
  }

  /* =====================================================
     NICKNAME PROTECTION
  ===================================================== */

  try {
    if (
      typeof setallnick.protectNickname ===
      "function"
    ) {
      await setallnick.protectNickname(
        api,
        event
      );
    }
  } catch (error) {
    addLog(
      "NICKNAME_PROTECTION",
      error?.message || String(error)
    );
  }

  /* =====================================================
     GC NAME PROTECTION
  ===================================================== */

  try {
    if (
      typeof gcnameLock.protectGCName ===
      "function"
    ) {
      await gcnameLock.protectGCName(
        api,
        event
      );
    }
  } catch (error) {
    addLog(
      "GCNAME_PROTECTION",
      error?.message || String(error)
    );
  }

  /* =====================================================
     NORMAL TRIGGERS
     PRESERVED
  ===================================================== */

  try {
    const triggerReply =
      getTriggerReply(
        body,
        threadID
      );

    if (triggerReply) {
      await trafficSendMessage(
        triggerReply,
        threadID
      );

      return;
    }
  } catch (error) {
    addLog(
      "TRIGGER_ERROR",
      error?.message || String(error)
    );
  }

  /* =====================================================
     BANAT TARGETING
     PRESERVED
  ===================================================== */

  let targetInfo = null;

  try {
    if (
      typeof classifyBanatTarget ===
      "function"
    ) {
      targetInfo =
        classifyBanatTarget(
          body,
          event
        );
    }
  } catch (error) {
    addLog(
      "TARGET_ERROR",
      error?.message || String(error)
    );
  }

  /* =====================================================
     BANAT CONVERSATION
     PRESERVED
  ===================================================== */

  try {
    const banatReply =
      getBanatConversationReply(
        body,
        threadID
      );

    if (banatReply) {
      await sendBanat(
        banatReply,
        event,
        targetInfo
      );

      return;
    }
  } catch (error) {
    addLog(
      "BANAT_ERROR",
      error?.message || String(error)
    );
  }
}

/* =========================================================
   START BOT
========================================================= */

function start(apiInstance) {
  if (!apiInstance) {
    throw new Error(
      "Messenger API instance is missing."
    );
  }

  api = apiInstance;

  try {
    api.setOptions?.({
      listenEvents: true,
      selfListen: false,
      updatePresence: true,
      online: true
    });
  } catch (_) {}

  try {
    botUID = String(
      api.getCurrentUserID?.() || ""
    );
  } catch (_) {
    botUID = "";
  }

  botOnline = true;
  botStartedAt = Date.now();

  getBotAccountInfo(api)
    .then(info => {
      botUID = info.uid || botUID;
      botName = info.name || "Messenger Bot";

      addLog(
        "ONLINE",
        `${botName} (${botUID || "unknown"})`
      );
    })
    .catch(() => {});

  if (
    typeof api.listenMqtt !== "function"
  ) {
    throw new Error(
      "This ws3-fca build does not provide listenMqtt()."
    );
  }

  api.listenMqtt(
    async (error, event) => {
      if (error) {
        botOnline = false;

        lastError =
          error?.message ||
          String(error);

        addLog(
          "LISTENER_ERROR",
          lastError
        );

        return;
      }

      try {
        await onMessage(event);
      } catch (handlerError) {
        totalErrors++;

        addLog(
          "HANDLER_ERROR",
          handlerError?.message ||
            String(handlerError)
        );
      }
    }
  );

  addLog(
    "BOT",
    "Messenger listener started."
  );
}

/* =========================================================
   LOGIN — FIXED APPSTATE HANDLER
========================================================= */

function loginWithAppState(input) {
  return new Promise((resolve, reject) => {
    let normalized;

    try {
      normalized =
        normalizeAppState(input);
    } catch (error) {
      reject(error);
      return;
    }

    let completed = false;
    let retryStarted = false;

    function finish(error, loggedApi) {
      /*
        If login succeeds.
      */

      if (!error && loggedApi) {
        if (!completed) {
          completed = true;
          resolve(loggedApi);
        }

        return;
      }

      /*
        This is the IMPORTANT FIX.

        Some ws3-fca builds throw:

        appState?.split is not a function

        from inside the callback.

        We catch that callback error and retry
        with cookie-string format.
      */

      const errorText =
        String(
          error?.message ||
          error ||
          ""
        );

      const splitError =
        errorText
          .toLowerCase()
          .includes("split") &&
        errorText
          .toLowerCase()
          .includes("appstate");

      if (
        splitError &&
        !retryStarted &&
        Array.isArray(normalized)
      ) {
        retryStarted = true;

        addLog(
          "LOGIN",
          "Installed ws3-fca build expects cookie-string. Retrying automatically..."
        );

        const cookieString =
          appStateToCookieString(
            normalized
          );

        if (!cookieString) {
          if (!completed) {
            completed = true;

            reject(
              new Error(
                "Hindi ma-convert ang AppState array sa cookie string."
              )
            );
          }

          return;
        }

        try {
          login(
            {
              appState: cookieString
            },
            {
              online: true,
              updatePresence: true,
              selfListen: false,
              listenEvents: true,
              randomUserAgent: false
            },
            (retryError, retryApi) => {
              if (
                retryError
              ) {
                if (!completed) {
                  completed = true;

                  reject(
                    retryError
                  );
                }

                return;
              }

              if (!retryApi) {
                if (!completed) {
                  completed = true;

                  reject(
                    new Error(
                      "Messenger login returned no API."
                    )
                  );
                }

                return;
              }

              if (!completed) {
                completed = true;
                resolve(retryApi);
              }
            }
          );
        } catch (retryException) {
          if (!completed) {
            completed = true;
            reject(retryException);
          }
        }

        return;
      }

      /*
        Normal login failure.
      */

      if (!completed) {
        completed = true;

        reject(
          error ||
            new Error(
              "Messenger login failed."
            )
        );
      }
    }

    /*
      ======================================================
      FIRST ATTEMPT

      Array format for current ws3-fca.
      ======================================================
    */

    try {
      if (Array.isArray(normalized)) {
        addLog(
          "LOGIN",
          "Trying AppState array format..."
        );
      } else {
        addLog(
          "LOGIN",
          "Trying cookie-string format..."
        );
      }

      login(
        {
          appState: normalized
        },
        {
          online: true,
          updatePresence: true,
          selfListen: false,
          listenEvents: true,
          randomUserAgent: false
        },
        finish
      );
    } catch (error) {
      finish(
        error,
        null
      );
    }
  });
}

/* =========================================================
   LOGIN BOT
========================================================= */

async function loginBot(sessionValue) {
  if (!sessionValue) {
    throw new Error(
      "Walang AppState."
    );
  }

  /*
    Stop previous state.
  */

  botOnline = false;

  try {
    api?.logout?.();
  } catch (_) {}

  api = null;

  addLog(
    "LOGIN",
    "Starting Messenger login..."
  );

  const normalized =
    normalizeAppState(
      sessionValue
    );

  /*
    Save what the user supplied.

    Prefer array format.
  */

  saveSession(
    normalized
  );

  /*
    Login using automatic compatibility.
  */

  const loggedApi =
    await loginWithAppState(
      normalized
    );

  if (!loggedApi) {
    throw new Error(
      "No Messenger API returned."
    );
  }

  start(
    loggedApi
  );

  addLog(
    "LOGIN",
    "Messenger login successful."
  );

  return true;
}

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

function requireAuth(
  req,
  res,
  next
) {
  if (req.session?.authenticated) {
    next();
    return;
  }

  res.status(401).json({
    ok: false,
    error: "Unauthorized"
  });
}

/* =========================================================
   LOGIN PAGE
========================================================= */

const LOGIN_PAGE = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>SANZU AI LOGIN</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: #050505;
  color: #fff;
  font-family: Arial, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
}

.card {
  width: 92%;
  max-width: 420px;
  padding: 30px;
  border: 1px solid #292929;
  border-radius: 16px;
  background: #0d0d0d;
  box-shadow: 0 0 35px rgba(255,255,255,.04);
}

h1 {
  text-align: center;
  margin: 0 0 8px;
  letter-spacing: 3px;
}

.sub {
  text-align: center;
  color: #777;
  margin-bottom: 25px;
}

input,
button {
  width: 100%;
  padding: 13px;
  margin-top: 12px;
  border-radius: 9px;
  border: 1px solid #303030;
  background: #151515;
  color: white;
}

button {
  cursor: pointer;
  background: #fff;
  color: #000;
  font-weight: bold;
}

#msg {
  margin-top: 15px;
  text-align: center;
  color: #ff7070;
}
</style>
</head>

<body>

<div class="card">

<h1>SANZU AI</h1>

<div class="sub">
COMMAND CENTER
</div>

<form id="loginForm">

<input
  id="username"
  placeholder="Username"
  autocomplete="username"
  required
>

<input
  id="password"
  type="password"
  placeholder="Password"
  autocomplete="current-password"
  required
>

<button type="submit">
LOGIN
</button>

</form>

<div id="msg"></div>

</div>

<script>
document
  .getElementById("loginForm")
  .addEventListener("submit", async e => {

    e.preventDefault();

    const msg =
      document.getElementById("msg");

    msg.textContent =
      "Logging in...";

    try {

      const response =
        await fetch("/api/login", {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            username:
              document.getElementById(
                "username"
              ).value,

            password:
              document.getElementById(
                "password"
              ).value
          })
        });

      const data =
        await response.json();

      if (!data.ok) {
        msg.textContent =
          data.error ||
          "Login failed.";
        return;
      }

      location.href =
        "/dashboard";

    } catch (error) {

      msg.textContent =
        error.message;

    }

  });
</script>

</body>
</html>
`;

/* =========================================================
   DASHBOARD
========================================================= */

const DASHBOARD_PAGE = `
<!DOCTYPE html>
<html>
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>SANZU AI COMMAND CENTER</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #050505;
  color: white;
  font-family: Arial, sans-serif;
}

header {
  padding: 18px;
  border-bottom: 1px solid #222;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title {
  font-weight: bold;
  letter-spacing: 2px;
}

.container {
  width: 94%;
  max-width: 1000px;
  margin: 25px auto;
}

.card {
  background: #0d0d0d;
  border: 1px solid #242424;
  border-radius: 14px;
  padding: 20px;
  margin-bottom: 18px;
}

.status {
  font-size: 22px;
  font-weight: bold;
}

.online {
  color: #61ff8a;
}

.offline {
  color: #ff6464;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit,minmax(180px,1fr));
  gap: 12px;
}

.stat {
  background: #111;
  border: 1px solid #242424;
  border-radius: 10px;
  padding: 15px;
}

.label {
  color: #777;
  font-size: 12px;
  text-transform: uppercase;
}

.value {
  margin-top: 5px;
  font-size: 18px;
  word-break: break-word;
}

textarea {
  width: 100%;
  min-height: 220px;
  resize: vertical;
  background: #080808;
  border: 1px solid #303030;
  color: white;
  border-radius: 10px;
  padding: 14px;
  font-family: monospace;
}

button {
  padding: 11px 16px;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  font-weight: bold;
  margin-top: 10px;
}

.primary {
  background: white;
  color: black;
}

.danger {
  background: #7c2020;
  color: white;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 350px;
  overflow: auto;
  background: #080808;
  padding: 12px;
  border-radius: 8px;
}

small {
  color: #777;
}

</style>

</head>

<body>

<header>

<div class="title">
SANZU AI COMMAND CENTER
</div>

<button onclick="logout()">
LOGOUT
</button>

</header>

<div class="container">

<div class="card">

<div id="status"
     class="status offline">
OFFLINE
</div>

<div>
Messenger Bot Status
</div>

</div>

<div class="grid">

<div class="stat">
<div class="label">
Account
</div>
<div
  class="value"
  id="botName"
>
Unknown
</div>
</div>

<div class="stat">
<div class="label">
UID
</div>
<div
  class="value"
  id="botUID"
>
-
</div>
</div>

<div class="stat">
<div class="label">
Messages
</div>
<div
  class="value"
  id="messages"
>
0
</div>
</div>

<div class="stat">
<div class="label">
Replies
</div>
<div
  class="value"
  id="replies"
>
0
</div>
</div>

</div>

<div class="card">

<h3>Messenger AppState</h3>

<small>
Paste the AppState JSON here.
</small>

<textarea
  id="appState"
  placeholder='[{"key":"c_user","value":"..."},{"key":"xs","value":"..."}]'
></textarea>

<br>

<button
  class="primary"
  onclick="loginBot()"
>
LOGIN BOT
</button>

<button
  class="danger"
  onclick="logoutBot()"
>
LOGOUT BOT
</button>

<div id="result"></div>

</div>

<div class="card">

<h3>Logs</h3>

<pre id="logs">
Loading...
</pre>

</div>

</div>

<script>

async function loadStatus() {

  try {

    const r =
      await fetch("/api/status");

    if (r.status === 401) {
      location.href = "/";
      return;
    }

    const data =
      await r.json();

    const status =
      document.getElementById(
        "status"
      );

    status.textContent =
      data.online
        ? "ONLINE"
        : "OFFLINE";

    status.className =
      "status " +
      (
        data.online
          ? "online"
          : "offline"
      );

    document.getElementById(
      "botName"
    ).textContent =
      data.botName || "Unknown";

    document.getElementById(
      "botUID"
    ).textContent =
      data.botUID || "-";

    document.getElementById(
      "messages"
    ).textContent =
      data.totalMessages || 0;

    document.getElementById(
      "replies"
    ).textContent =
      data.totalReplies || 0;

    document.getElementById(
      "logs"
    ).textContent =
      (data.logs || [])
        .map(x =>
          "[" +
          x.time +
          "] [" +
          x.type +
          "] " +
          x.message
        )
        .join("\\n");

  } catch (error) {

    console.error(error);

  }

}

async function loginBot() {

  const result =
    document.getElementById(
      "result"
    );

  result.textContent =
    "Logging bot in...";

  const value =
    document.getElementById(
      "appState"
    ).value.trim();

  if (!value) {
    result.textContent =
      "Paste AppState first.";
    return;
  }

  try {

    const r =
      await fetch(
        "/api/bot/login",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            appState: value
          })
        }
      );

    const data =
      await r.json();

    result.textContent =
      data.ok
        ? "Bot login successful."
        : (
          data.error ||
          "Login failed."
        );

    loadStatus();

  } catch (error) {

    result.textContent =
      error.message;

  }

}

async function logoutBot() {

  try {

    await fetch(
      "/api/bot/logout",
      {
        method: "POST"
      }
    );

    loadStatus();

  } catch (error) {

    console.error(error);

  }

}

async function logout() {

  await fetch(
    "/api/logout",
    {
      method: "POST"
    }
  );

  location.href = "/";

}

loadStatus();

setInterval(
  loadStatus,
  3000
);

</script>

</body>
</html>
`;

/* =========================================================
   ROUTES
========================================================= */

app.get("/", (req, res) => {
  if (req.session?.authenticated) {
    res.redirect("/dashboard");
    return;
  }

  res.send(LOGIN_PAGE);
});

app.get(
  "/dashboard",
  requireAuth,
  (req, res) => {
    res.send(DASHBOARD_PAGE);
  }
);

/* =========================================================
   DASHBOARD LOGIN
========================================================= */

app.post(
  "/api/login",
  (req, res) => {
    const username =
      String(
        req.body?.username || ""
      );

    const password =
      String(
        req.body?.password || ""
      );

    if (
      username !== DASH_USER ||
      password !== DASH_PASS
    ) {
      res.status(401).json({
        ok: false,
        error: "Invalid username or password."
      });

      return;
    }

    req.session.authenticated = true;

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   LOGOUT DASHBOARD
========================================================= */

app.post(
  "/api/logout",
  (req, res) => {

    req.session.destroy(
      () => {
        res.json({
          ok: true
        });
      }
    );

  }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",
  requireAuth,
  (req, res) => {

    res.json({
      ok: true,
      online: botOnline,
      botName,
      botUID,
      botStartedAt,
      lastMessageAt,
      lastError,
      totalMessages,
      totalReplies,
      totalErrors,
      logs: logs.slice(0, 100)
    });

  }
);

/* =========================================================
   BOT LOGIN
========================================================= */

app.post(
  "/api/bot/login",
  requireAuth,
  async (req, res) => {

    try {

      const input =
        req.body?.appState;

      if (!input) {
        res.status(400).json({
          ok: false,
          error: "AppState is required."
        });

        return;
      }

      await loginBot(
        input
      );

      res.json({
        ok: true,
        online: botOnline,
        botName,
        botUID
      });

    } catch (error) {

      botOnline = false;

      lastError =
        error?.message ||
        String(error);

      totalErrors++;

      addLog(
        "LOGIN_ERROR",
        lastError
      );

      res.status(500).json({
        ok: false,
        error: lastError
      });

    }

  }
);

/* =========================================================
   BOT LOGOUT
========================================================= */

app.post(
  "/api/bot/logout",
  requireAuth,
  (req, res) => {

    try {
      api?.logout?.();
    } catch (_) {}

    api = null;
    botOnline = false;
    botUID = "";
    botName = "Unknown";

    addLog(
      "BOT",
      "Bot logged out."
    );

    res.json({
      ok: true
    });

  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {

    res.status(200).json({
      ok: true,
      botOnline,
      uptime: process.uptime()
    });

  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error: "Not found"
    });
  }
);

/* =========================================================
   SERVER
========================================================= */

server.listen(
  PORT,
  () => {

    console.log(
      "========================================"
    );

    console.log(
      "       SANZU AI COMMAND CENTER"
    );

    console.log(
      "========================================"
    );

    console.log(
      `Dashboard: http://localhost:${PORT}`
    );

    console.log(
      `Dashboard user: ${DASH_USER}`
    );

    console.log(
      "========================================"
    );

    /*
      Auto-login from saved AppState.
    */

    const oldSession =
      getSavedSession();

    if (oldSession) {

      addLog(
        "LOGIN",
        "Saved AppState detected. Attempting auto-login..."
      );

      loginBot(
        oldSession
      ).catch(error => {

        botOnline = false;

        lastError =
          error?.message ||
          String(error);

        addLog(
          "AUTO_LOGIN_ERROR",
          lastError
        );

      });

    } else {

      addLog(
        "BOT",
        "No saved AppState. Login from dashboard."
      );

    }

  }
);

/* =========================================================
   PROCESS ERROR HANDLERS
========================================================= */

process.on(
  "uncaughtException",
  error => {

    totalErrors++;

    lastError =
      error?.message ||
      String(error);

    addLog(
      "UNCAUGHT",
      lastError
    );

  }
);

process.on(
  "unhandledRejection",
  error => {

    totalErrors++;

    lastError =
      error?.message ||
      String(error);

    addLog(
      "UNHANDLED",
      lastError
    );

  }
);
