"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const { login } = require("ws3-fca");

// ======================================================
// EXISTING MODULES — HUWAG BAGUHIN ANG LOGIC NILA
// ======================================================

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

const {
  handleCommand: handleNicknameCommand,
  protectNickname
} = require("./setallnick");

const {
  handleCommand: handleGCNameCommand,
  protectGCName
} = require("./gcname-lock");

// ======================================================
// APP
// ======================================================

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 10000);

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "5mb"
}));

// ======================================================
// DASHBOARD LOGIN
// ======================================================

const DASHBOARD_USERNAME = "admin";
const DASHBOARD_PASSWORD = "halimaw123";

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "cresi-dashboard-session-secret-change-this";

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      sameSite: "lax",

      // Compatible with Render + local testing.
      secure: false,

      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

// ======================================================
// CONFIG
// ======================================================

const DEFAULT_ON =
  String(process.env.DEFAULT_ON || "true").toLowerCase() !== "false";

const GLOBAL_SEND_LIMIT =
  Math.max(1, Number(process.env.GLOBAL_SEND_LIMIT || 2));

const THREAD_COOLDOWN_MS =
  Math.max(1000, Number(process.env.THREAD_COOLDOWN_MS || 12000));

const RETRY_DELAYS = [1500, 4000, 8000];

const ADMIN_UID = "61595204307407";

// ======================================================
// BOT STATE
// ======================================================

let botApi = null;
let botUserID = null;
let botName = "Not connected";
let botOnline = false;
let botStartedAt = null;
let loginInProgress = false;

let savedSessionExists = false;

let globalActive = DEFAULT_ON;

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();

let globalSendCount = 0;

const systemLogs = [];

const MAX_LOGS = 100;

// ======================================================
// HELPERS
// ======================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function uptimeText() {
  if (!botStartedAt) return "Offline";

  const seconds = Math.floor(
    (Date.now() - botStartedAt) / 1000
  );

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    `${secs}s`
  ].filter(Boolean).join(" ");
}

function addLog(type, message) {
  const entry = {
    time: new Date().toISOString(),
    type: String(type || "INFO"),
    message: String(message || "")
  };

  systemLogs.unshift(entry);

  if (systemLogs.length > MAX_LOGS) {
    systemLogs.length = MAX_LOGS;
  }

  console.log(`[${entry.type}] ${entry.message}`);
}

function normalizeSession(input) {
  if (Array.isArray(input)) {
    return input;
  }

  if (
    input &&
    typeof input === "object" &&
    Array.isArray(input.appState)
  ) {
    return input.appState;
  }

  throw new Error(
    "Invalid AppState/C3C format. Expected an array or { appState: [...] }."
  );
}

function parseSessionInput(input) {
  if (!input) {
    throw new Error("Walang Messenger session na inilagay.");
  }

  let parsed;

  try {
    parsed = JSON.parse(input);
  } catch (_) {
    throw new Error(
      "Hindi valid JSON ang Messenger AppState/C3C."
    );
  }

  const appState = normalizeSession(parsed);

  if (!Array.isArray(appState) || appState.length === 0) {
    throw new Error(
      "Empty ang AppState/C3C."
    );
  }

  return appState;
}

function getSavedSession() {
  const file = path.join(process.cwd(), "appstate.json");

  if (!fs.existsSync(file)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) {
      return null;
    }

    const parsed = JSON.parse(raw);

    const appState = normalizeSession(parsed);

    if (!Array.isArray(appState) || appState.length === 0) {
      return null;
    }

    savedSessionExists = true;

    return appState;
  } catch (error) {
    savedSessionExists = false;

    addLog(
      "WARN",
      `Saved session could not be loaded: ${error.message}`
    );

    return null;
  }
}

function saveSession(appState) {
  const file = path.join(process.cwd(), "appstate.json");

  fs.writeFileSync(
    file,
    JSON.stringify(appState, null, 2),
    "utf8"
  );

  savedSessionExists = true;
}

function deleteSavedSession() {
  const file = path.join(process.cwd(), "appstate.json");

  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (error) {
    addLog(
      "WARN",
      `Could not delete saved session: ${error.message}`
    );
  }

  savedSessionExists = false;
}

function getBotAccountInfo(api) {
  return new Promise(resolve => {
    try {
      const uid = String(
        api.getCurrentUserID?.() || ""
      );

      if (!uid) {
        resolve({
          uid: "",
          name: "Messenger Account"
        });

        return;
      }

      if (
        typeof api.getUserInfo !== "function"
      ) {
        resolve({
          uid,
          name: "Messenger Account"
        });

        return;
      }

      api.getUserInfo(uid, (error, info) => {
        if (error || !info || !info[uid]) {
          resolve({
            uid,
            name: "Messenger Account"
          });

          return;
        }

        resolve({
          uid,
          name:
            info[uid].name ||
            "Messenger Account"
        });
      });
    } catch (_) {
      resolve({
        uid: "",
        name: "Messenger Account"
      });
    }
  });
}

// ======================================================
// SAFE API LOGOUT
// ======================================================

async function disconnectBot(removeSession = false) {
  const oldApi = botApi;

  botApi = null;
  botOnline = false;
  botUserID = null;
  botName = "Not connected";
  botStartedAt = null;

  if (oldApi) {
    try {
      if (
        typeof oldApi.stopListenMqtt === "function"
      ) {
        oldApi.stopListenMqtt();
      }
    } catch (_) {}

    try {
      if (
        typeof oldApi.logout === "function"
      ) {
        await new Promise(resolve => {
          try {
            oldApi.logout(() => resolve());
          } catch (_) {
            resolve();
          }
        });
      }
    } catch (_) {}
  }

  if (removeSession) {
    deleteSavedSession();
  }

  addLog("BOT", "Messenger connection closed.");
}

// ======================================================
// MESSAGE SENDING
// ======================================================

function enqueueThread(threadID, task) {
  const id = String(threadID);

  if (!threadQueues.has(id)) {
    threadQueues.set(id, Promise.resolve());
  }

  const previous = threadQueues.get(id);

  const next = previous
    .catch(() => {})
    .then(task)
    .catch(error => {
      addLog(
        "SEND",
        `Thread ${id} queue error: ${error.message}`
      );
    });

  threadQueues.set(id, next);

  return next;
}

function sendMessageOnce(api, message, threadID) {
  return new Promise((resolve, reject) => {
    try {
      api.sendMessage(
        message,
        threadID,
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(result);
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function trafficSendMessage(
  api,
  message,
  threadID
) {
  if (!api) {
    throw new Error("Bot is not connected.");
  }

  if (!threadID) {
    throw new Error("Missing threadID.");
  }

  const id = String(threadID);

  return enqueueThread(id, async () => {
    const lastSent = threadLastSent.get(id) || 0;

    const elapsed =
      Date.now() - lastSent;

    if (elapsed < THREAD_COOLDOWN_MS) {
      await sleep(
        THREAD_COOLDOWN_MS - elapsed
      );
    }

    while (
      globalSendCount >= GLOBAL_SEND_LIMIT
    ) {
      await sleep(500);
    }

    globalSendCount++;

    try {
      let lastError = null;

      for (
        let attempt = 0;
        attempt <= RETRY_DELAYS.length;
        attempt++
      ) {
        try {
          const result =
            await sendMessageOnce(
              api,
              message,
              id
            );

          threadLastSent.set(
            id,
            Date.now()
          );

          return result;
        } catch (error) {
          lastError = error;

          if (
            attempt >=
            RETRY_DELAYS.length
          ) {
            break;
          }

          await sleep(
            RETRY_DELAYS[attempt]
          );
        }
      }

      throw lastError ||
        new Error("Message send failed.");
    } finally {
      globalSendCount =
        Math.max(
          0,
          globalSendCount - 1
        );
    }
  });
}

// ======================================================
// BANAT COMMAND
// ======================================================

function handleBanatCommand(
  api,
  event,
  body
) {
  const text =
    String(body || "").trim();

  if (!/^\/banat(?:\s|$)/i.test(text)) {
    return false;
  }

  const senderID =
    String(event.senderID || "");

  const threadID =
    String(event.threadID || "");

  if (senderID !== ADMIN_UID) {
    trafficSendMessage(
      api,
      "❌ Admin lamang ang puwedeng gumamit nito.",
      threadID
    ).catch(() => {});

    return true;
  }

  const args =
    text.split(/\s+/);

  const action =
    String(args[1] || "status")
      .toLowerCase();

  if (
    action === "on" ||
    action === "enable"
  ) {
    setBanatConversationMode(
      threadID,
      true
    );

    trafficSendMessage(
      api,
      "🔥 Banat mode: ON",
      threadID
    ).catch(() => {});

    return true;
  }

  if (
    action === "off" ||
    action === "disable"
  ) {
    setBanatConversationMode(
      threadID,
      false
    );

    trafficSendMessage(
      api,
      "🛑 Banat mode: OFF",
      threadID
    ).catch(() => {});

    return true;
  }

  trafficSendMessage(
    api,
    `Banat mode: ${
      isBanatConversationModeActive(
        threadID
      )
        ? "ON"
        : "OFF"
    }`,
    threadID
  ).catch(() => {});

  return true;
}

// ======================================================
// BANAT SENDER
// ======================================================

async function sendBanat(
  api,
  event,
  reply
) {
  if (!reply) return;

  const threadID =
    String(event.threadID || "");

  try {
    if (
      typeof sendBanatReplyWithTyping ===
      "function"
    ) {
      await sendBanatReplyWithTyping(
        api,
        event,
        reply
      );

      return;
    }
  } catch (error) {
    addLog(
      "BANAT",
      `Typing sender failed: ${error.message}`
    );
  }

  await trafficSendMessage(
    api,
    reply,
    threadID
  );
}

// ======================================================
// MAIN MESSAGE HANDLER
// ======================================================

async function onMessage(
  api,
  event
) {
  if (!event) return;

  const threadID =
    String(event.threadID || "");

  const senderID =
    String(event.senderID || "");

  if (!threadID) return;

  let currentBotID = "";

  try {
    currentBotID =
      String(
        api.getCurrentUserID?.() || ""
      );
  } catch (_) {}

  if (
    currentBotID &&
    senderID === currentBotID
  ) {
    return;
  }

  const body =
    String(event.body || "").trim();

  // --------------------------------------------
  // Protection commands/events
  // --------------------------------------------

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
    addLog(
      "NICKNAME",
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
    addLog(
      "GCNAME",
      error.message
    );
  }

  if (!body) return;

  // --------------------------------------------
  // BANAT ADMIN COMMAND
  // --------------------------------------------

  if (
    handleBanatCommand(
      api,
      event,
      body
    )
  ) {
    return;
  }

  // --------------------------------------------
  // Target classification
  // --------------------------------------------

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
  } catch (_) {}

  // --------------------------------------------
  // Global OFF
  // --------------------------------------------

  if (!globalActive) {
    return;
  }

  // --------------------------------------------
  // Trigger system
  // --------------------------------------------

  try {
    const triggerReply =
      getTriggerReply(
        body,
        threadID
      );

    if (triggerReply) {
      await trafficSendMessage(
        api,
        triggerReply,
        threadID
      );

      return;
    }
  } catch (error) {
    addLog(
      "TRIGGER",
      error.message
    );
  }

  // --------------------------------------------
  // Banat conversation
  // --------------------------------------------

  let banatActive =
    false;

  try {
    banatActive =
      isBanatConversationModeActive(
        threadID
      );
  } catch (_) {}

  if (
    targetInfo &&
    targetInfo.shouldActivate
  ) {
    try {
      setBanatConversationMode(
        threadID,
        true
      );

      banatActive = true;
    } catch (_) {}
  }

  if (!banatActive) {
    return;
  }

  try {
    const banatReply =
      getBanatConversationReply(
        body,
        threadID
      );

    if (banatReply) {
      await sendBanat(
        api,
        event,
        banatReply
      );
    }
  } catch (error) {
    addLog(
      "BANAT",
      error.message
    );
  }
}

// ======================================================
// START MQTT
// ======================================================

function start(api) {
  if (!api) {
    throw new Error(
      "Cannot start bot: API is missing."
    );
  }

  botApi = api;

  try {
    botUserID =
      String(
        api.getCurrentUserID?.() || ""
      );
  } catch (_) {
    botUserID = "";
  }

  botOnline = true;
  botStartedAt = Date.now();

  addLog(
    "BOT",
    `Connected as ${botName} (${botUserID || "unknown UID"})`
  );

  try {
    if (
      typeof api.setOptions ===
      "function"
    ) {
      api.setOptions({
        online: true,
        selfListen: false,
        listenEvents: true,
        updatePresence: true
      });
    }
  } catch (error) {
    addLog(
      "MQTT",
      `setOptions warning: ${error.message}`
    );
  }

  try {
    api.listenMqtt(
      async (error, event) => {
        if (error) {
          addLog(
            "MQTT",
            error.message ||
            String(error)
          );

          return;
        }

        if (!event) return;

        const threadID =
          String(
            event.threadID || ""
          );

        if (!threadID) return;

        // ----------------------------------------
        // GC NAME PROTECTION
        // ----------------------------------------

        try {
          await protectGCName(
            api,
            event
          );
        } catch (error) {
          addLog(
            "GCNAME",
            error.message
          );
        }

        // ----------------------------------------
        // NICKNAME PROTECTION
        // ----------------------------------------

        try {
          await protectNickname(
            api,
            event
          );
        } catch (error) {
          addLog(
            "NICKNAME",
            error.message
          );
        }

        // ----------------------------------------
        // MESSAGE HANDLER
        // ----------------------------------------

        if (
          event.type !== "message"
        ) {
          return;
        }

        try {
          await onMessage(
            api,
            event
          );
        } catch (error) {
          addLog(
            "MESSAGE",
            error.stack ||
            error.message ||
            String(error)
          );
        }
      }
    );

    addLog(
      "MQTT",
      "Messenger listener started."
    );
  } catch (error) {
    botOnline = false;

    addLog(
      "MQTT",
      `Listener failed: ${error.stack || error.message}`
    );

    throw error;
  }
}

// ======================================================
// LOGIN
// ======================================================

function loginWithAppState(
  appState
) {
  return new Promise(
    (resolve, reject) => {
      let finished = false;

      const done = (
        error,
        api
      ) => {
        if (finished) return;

        finished = true;

        if (error) {
          reject(error);
          return;
        }

        if (!api) {
          reject(
            new Error(
              "Facebook login returned no API object."
            )
          );

          return;
        }

        resolve(api);
      };

      try {
        /*
         * ws3-fca supports:
         *
         * login(
         *   { appState },
         *   options,
         *   callback
         * )
         */

        login(
          {
            appState
          },
          {
            online: true,
            updatePresence: true,
            selfListen: false,
            listenEvents: true,
            randomUserAgent: false
          },
          done
        );
      } catch (error) {
        reject(error);
      }
    }
  );
}

async function loginBot(
  sessionValue
) {
  if (loginInProgress) {
    throw new Error(
      "May login operation nang tumatakbo."
    );
  }

  loginInProgress = true;

  try {
    const appState =
      Array.isArray(sessionValue)
        ? sessionValue
        : parseSessionInput(
            sessionValue
          );

    if (
      !Array.isArray(appState) ||
      appState.length === 0
    ) {
      throw new Error(
        "Invalid or empty AppState."
      );
    }

    addLog(
      "LOGIN",
      "Starting Messenger login..."
    );

    // Close previous session first.
    if (botApi) {
      await disconnectBot(false);
    }

    const api =
      await loginWithAppState(
        appState
      );

    if (!api) {
      throw new Error(
        "Login succeeded but API is unavailable."
      );
    }

    const account =
      await getBotAccountInfo(api);

    botUserID =
      account.uid ||
      String(
        api.getCurrentUserID?.() || ""
      );

    botName =
      account.name ||
      "Messenger Account";

    saveSession(
      typeof api.getAppState ===
      "function"
        ? api.getAppState()
        : appState
    );

    botApi = api;

    start(api);

    addLog(
      "LOGIN",
      `Login successful: ${botName} (${botUserID})`
    );

    return {
      success: true,
      name: botName,
      uid: botUserID
    };
  } catch (error) {
    botApi = null;
    botOnline = false;
    botUserID = null;
    botName = "Not connected";
    botStartedAt = null;

    addLog(
      "LOGIN ERROR",
      error.stack ||
      error.message ||
      String(error)
    );

    throw error;
  } finally {
    loginInProgress = false;
  }
}

// ======================================================
// AUTH
// ======================================================

function requireAuth(
  req,
  res,
  next
) {
  if (req.session?.authenticated) {
    return next();
  }

  if (
    req.path.startsWith("/api/") ||
    req.path.startsWith("/bot-")
  ) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  return res.redirect("/login");
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
  "/health",
  (req, res) => {
    res.status(200).json({
      ok: true,
      service: "Cresi SINZU AI",
      botOnline,
      uptime: uptimeText(),
      timestamp: new Date().toISOString()
    });
  }
);

// ======================================================
// LOGIN PAGE
// ======================================================

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

    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SINZU AI Login</title>

<style>
*{
  box-sizing:border-box;
}

body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#050505;
  color:#fff;
  font-family:Arial,sans-serif;
}

.card{
  width:min(420px,92%);
  background:#111;
  border:1px solid #292929;
  border-radius:18px;
  padding:28px;
  box-shadow:0 20px 80px rgba(0,0,0,.55);
}

h1{
  margin:0 0 8px;
  font-size:28px;
}

.sub{
  color:#888;
  margin-bottom:25px;
}

input{
  width:100%;
  padding:14px;
  margin:7px 0;
  border-radius:10px;
  border:1px solid #333;
  background:#080808;
  color:#fff;
  outline:none;
}

button{
  width:100%;
  padding:14px;
  margin-top:12px;
  border:0;
  border-radius:10px;
  background:#fff;
  color:#000;
  font-weight:bold;
  cursor:pointer;
}

.error{
  margin-top:15px;
  color:#ff5555;
  display:none;
}
</style>
</head>

<body>

<div class="card">

<h1>SINZU AI</h1>

<div class="sub">
Messenger Command Center
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

<div
  id="error"
  class="error"
></div>

</div>

<script>
const form =
  document.getElementById("loginForm");

const errorBox =
  document.getElementById("error");

form.addEventListener(
  "submit",
  async function(e){

    e.preventDefault();

    errorBox.style.display =
      "none";

    try{

      const response =
        await fetch(
          "/login",
          {
            method:"POST",
            headers:{
              "Content-Type":
                "application/json"
            },
            body:JSON.stringify({
              username:
                document.getElementById(
                  "username"
                ).value,

              password:
                document.getElementById(
                  "password"
                ).value
            })
          }
        );

      const data =
        await response.json();

      if(!data.success){

        errorBox.textContent =
          data.error ||
          "Login failed.";

        errorBox.style.display =
          "block";

        return;
      }

      location.href =
        "/dashboard";

    }catch(error){

      errorBox.textContent =
        "Server error.";

      errorBox.style.display =
        "block";
    }

  }
);
</script>

</body>
</html>
`);
  }
);

// ======================================================
// LOGIN POST
// ======================================================

app.post(
  "/login",
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
      username !==
        DASHBOARD_USERNAME ||
      password !==
        DASHBOARD_PASSWORD
    ) {
      return res.status(401).json({
        success: false,
        error: "Invalid username or password."
      });
    }

    req.session.authenticated =
      true;

    req.session.username =
      username;

    return res.json({
      success: true
    });
  }
);

// ======================================================
// DASHBOARD
// ======================================================

app.get(
  "/dashboard",
  requireAuth,
  (req, res) => {

    res.send(`
<!DOCTYPE html>
<html>
<head>

<meta charset="UTF-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>SINZU AI Dashboard</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:#060606;
  color:#eee;
  font-family:Arial,sans-serif;
}

header{
  position:sticky;
  top:0;
  z-index:5;
  background:#0c0c0c;
  border-bottom:1px solid #222;
  padding:16px 20px;
  display:flex;
  justify-content:space-between;
  align-items:center;
}

.brand{
  font-weight:900;
  letter-spacing:2px;
}

.status{
  font-size:13px;
  color:#777;
}

.container{
  width:min(1100px,94%);
  margin:25px auto 60px;
}

.hero{
  background:
    linear-gradient(
      135deg,
      #151515,
      #090909
    );

  border:1px solid #252525;
  border-radius:20px;
  padding:25px;
  margin-bottom:18px;
}

.hero h1{
  margin:0 0 8px;
  font-size:34px;
}

.hero p{
  color:#888;
  margin:0;
}

.grid{
  display:grid;
  grid-template-columns:
    repeat(auto-fit,minmax(220px,1fr));

  gap:15px;
}

.card{
  background:#101010;
  border:1px solid #242424;
  border-radius:16px;
  padding:20px;
}

.label{
  color:#777;
  font-size:12px;
  text-transform:uppercase;
  letter-spacing:1px;
}

.value{
  margin-top:8px;
  font-size:20px;
  font-weight:bold;
  word-break:break-word;
}

textarea{
  width:100%;
  min-height:180px;
  resize:vertical;
  background:#070707;
  border:1px solid #303030;
  color:#eee;
  border-radius:12px;
  padding:14px;
  margin-top:10px;
  outline:none;
  font-family:monospace;
}

button{
  border:0;
  border-radius:10px;
  padding:12px 16px;
  margin:8px 5px 0 0;
  cursor:pointer;
  font-weight:bold;
}

.primary{
  background:#fff;
  color:#000;
}

.secondary{
  background:#222;
  color:#fff;
  border:1px solid #333;
}

.danger{
  background:#401515;
  color:#ff9b9b;
}

pre{
  white-space:pre-wrap;
  word-break:break-word;
  background:#070707;
  border:1px solid #222;
  padding:15px;
  border-radius:12px;
  min-height:150px;
  max-height:350px;
  overflow:auto;
  font-size:12px;
}

.module{
  margin-top:15px;
}

.online{
  color:#69ff9a;
}

.offline{
  color:#ff6969;
}

.small{
  color:#777;
  font-size:13px;
  line-height:1.5;
}

</style>

</head>

<body>

<header>

<div class="brand">
SINZU AI
</div>

<div>

<span
  id="topStatus"
  class="status"
>
Checking...
</span>

<button
  class="secondary"
  onclick="logout()"
>
Logout
</button>

</div>

</header>

<div class="container">

<div class="hero">

<h1>
Messenger Command Center
</h1>

<p>
Dashboard ng Cresi / SINZU AI
</p>

</div>

<div class="grid">

<div class="card">
<div class="label">Bot Name</div>
<div
  id="botName"
  class="value"
>
Not connected
</div>
</div>

<div class="card">
<div class="label">Bot UID</div>
<div
  id="botUID"
  class="value"
>
-
</div>
</div>

<div class="card">
<div class="label">Connection</div>
<div
  id="connection"
  class="value offline"
>
OFFLINE
</div>
</div>

<div class="card">
<div class="label">Uptime</div>
<div
  id="uptime"
  class="value"
>
Offline
</div>
</div>

</div>

<div class="card module">

<h2>
Messenger Session
</h2>

<div class="small">
I-paste dito ang AppState/C3C JSON.
Huwag itong i-share sa ibang tao.
</div>

<textarea
  id="sessionInput"
  placeholder='[
  {
    "key": "c_user",
    "value": "..."
  }
]'
></textarea>

<br>

<button
  class="primary"
  onclick="connectBot()"
>
CONNECT BOT
</button>

<button
  class="secondary"
  onclick="clearSessionBox()"
>
CLEAR
</button>

<button
  class="danger"
  onclick="disconnectBot()"
>
DISCONNECT
</button>

<div
  id="botMessage"
  class="small"
  style="margin-top:12px"
></div>

</div>

<div class="grid">

<div class="card module">

<div class="label">
Nickname Protection
</div>

<div class="value">
ACTIVE MODULE
</div>

<p class="small">
!setallnick<br>
!restoreallnick<br>
!nickprotect
</p>

</div>

<div class="card module">

<div class="label">
GC Name Protection
</div>

<div class="value">
ACTIVE MODULE
</div>

<p class="small">
!lockgcname<br>
!unlockgcname<br>
!gcnameprotect
</p>

</div>

<div class="card module">

<div class="label">
Human Banat
</div>

<div class="value">
ACTIVE MODULE
</div>

<p class="small">
/banat on<br>
/banat off<br>
/banat status
</p>

</div>

<div class="card module">

<div class="label">
Trigger System
</div>

<div class="value">
ACTIVE
</div>

<p class="small">
Existing triggers.js preserved.
</p>

</div>

</div>

<div class="card module">

<h2>
System Logs
</h2>

<pre id="logs">
Loading...
</pre>

</div>

</div>

<script>

async function getStatus(){

  try{

    const response =
      await fetch(
        "/api/status",
        {
          cache:"no-store"
        }
      );

    if(
      response.status === 401
    ){
      location.href =
        "/login";

      return;
    }

    const data =
      await response.json();

    document.getElementById(
      "botName"
    ).textContent =
      data.name ||
      "Not connected";

    document.getElementById(
      "botUID"
    ).textContent =
      data.uid ||
      "-";

    const connection =
      document.getElementById(
        "connection"
      );

    connection.textContent =
      data.online
        ? "ONLINE"
        : "OFFLINE";

    connection.className =
      "value " +
      (
        data.online
          ? "online"
          : "offline"
      );

    document.getElementById(
      "uptime"
    ).textContent =
      data.uptime ||
      "Offline";

    document.getElementById(
      "topStatus"
    ).textContent =
      data.online
        ? "● ONLINE"
        : "● OFFLINE";

  }catch(error){

    document.getElementById(
      "topStatus"
    ).textContent =
      "● SERVER ERROR";
  }
}

async function getLogs(){

  try{

    const response =
      await fetch(
        "/api/logs",
        {
          cache:"no-store"
        }
      );

    if(
      response.status === 401
    ){
      location.href =
        "/login";

      return;
    }

    const data =
      await response.json();

    const logs =
      (data.logs || [])
        .map(
          item =>
            "[" +
            item.time +
            "] [" +
            item.type +
            "] " +
            item.message
        )
        .join("\\n");

    document.getElementById(
      "logs"
    ).textContent =
      logs ||
      "No logs yet.";

  }catch(error){}
}

async function connectBot(){

  const input =
    document.getElementById(
      "sessionInput"
    );

  const message =
    document.getElementById(
      "botMessage"
    );

  if(!input.value.trim()){

    message.textContent =
      "Paste your AppState/C3C first.";

    return;
  }

  message.textContent =
    "Connecting...";

  try{

    const response =
      await fetch(
        "/bot-login",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            session:
              input.value
          })
        }
      );

    const data =
      await response.json();

    if(!data.success){

      message.textContent =
        "❌ " +
        (
          data.error ||
          "Login failed."
        );

      return;
    }

    message.textContent =
      "✅ Connected as " +
      (
        data.name ||
        "Messenger account"
      );

    input.value = "";

    await getStatus();
    await getLogs();

  }catch(error){

    message.textContent =
      "❌ Server error.";
  }
}

function clearSessionBox(){

  document.getElementById(
    "sessionInput"
  ).value = "";

  document.getElementById(
    "botMessage"
  ).textContent = "";
}

async function disconnectBot(){

  if(
    !confirm(
      "Disconnect Messenger bot?"
    )
  ){
    return;
  }

  try{

    await fetch(
      "/bot-logout",
      {
        method:"POST"
      }
    );

    await getStatus();
    await getLogs();

  }catch(error){}
}

async function logout(){

  try{

    await fetch(
      "/logout",
      {
        method:"POST"
      }
    );

  }finally{

    location.href =
      "/login";
  }
}

getStatus();
getLogs();

setInterval(
  getStatus,
  3000
);

setInterval(
  getLogs,
  5000
);

</script>

</body>
</html>
`);
  }
);

// ======================================================
// STATUS API
// ======================================================

app.get(
  "/api/status",
  requireAuth,
  (req, res) => {
    res.json({
      online: botOnline,
      name: botName,
      uid: botUserID,
      uptime: uptimeText(),
      globalActive,
      savedSession: savedSessionExists,
      loginInProgress
    });
  }
);

// ======================================================
// LOG API
// ======================================================

app.get(
  "/api/logs",
  requireAuth,
  (req, res) => {
    res.json({
      logs: systemLogs
    });
  }
);

// ======================================================
// BOT LOGIN API
// ======================================================

app.post(
  "/bot-login",
  requireAuth,
  async (req, res) => {

    if (loginInProgress) {
      return res.status(409).json({
        success: false,
        error:
          "May login operation nang tumatakbo."
      });
    }

    try {

      const sessionValue =
        req.body?.session;

      if (
        !sessionValue ||
        !String(sessionValue).trim()
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Missing AppState/C3C."
        });
      }

      const result =
        await loginBot(
          String(sessionValue)
        );

      return res.json(result);

    } catch (error) {

      return res.status(400).json({
        success: false,
        error:
          error?.message ||
          String(error)
      });
    }
  }
);

// ======================================================
// BOT LOGOUT
// ======================================================

app.post(
  "/bot-logout",
  requireAuth,
  async (req, res) => {

    try {

      await disconnectBot(true);

      return res.json({
        success: true
      });

    } catch (error) {

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          String(error)
      });
    }
  }
);

// ======================================================
// DASHBOARD LOGOUT
// ======================================================

app.post(
  "/logout",
  (req, res) => {

    req.session.destroy(
      () => {
        res.json({
          success: true
        });
      }
    );
  }
);

// ======================================================
// ROOT
// ======================================================

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

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    addLog(
      "SERVER",
      error.stack ||
      error.message ||
      String(error)
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      success: false,
      error: "Internal server error."
    });
  }
);

// ======================================================
// PROCESS ERROR HANDLERS
// ======================================================

process.on(
  "unhandledRejection",
  error => {

    addLog(
      "PROCESS",
      `Unhandled rejection: ${
        error?.stack ||
        error?.message ||
        String(error)
      }`
    );
  }
);

process.on(
  "uncaughtException",
  error => {

    addLog(
      "PROCESS",
      `Uncaught exception: ${
        error?.stack ||
        error?.message ||
        String(error)
      }`
    );
  }
);

// ======================================================
// SERVER START
// ======================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    addLog(
      "SERVER",
      `Dashboard listening on port ${PORT}`
    );

    console.log(
      `SINZU AI running on 0.0.0.0:${PORT}`
    );

    // --------------------------------------------
    // Auto-load saved AppState if available.
    // --------------------------------------------

    const saved =
      getSavedSession();

    if (saved) {

      addLog(
        "LOGIN",
        "Saved AppState found. Attempting automatic login..."
      );

      loginBot(saved)
        .then(result => {

          addLog(
            "LOGIN",
            `Automatic login successful: ${result.name}`
          );

        })
        .catch(error => {

          addLog(
            "LOGIN",
            `Automatic login failed: ${
              error?.message ||
              String(error)
            }`
          );

        });

    } else {

      addLog(
        "LOGIN",
        "No saved AppState. Waiting for dashboard login."
      );
    }
  }
);

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  trafficSendMessage,
  onMessage,
  handleBanatCommand,
  loginBot
};
