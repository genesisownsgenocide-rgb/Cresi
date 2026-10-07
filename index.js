"use strict";

/*
 * OPAKANKOMAMAMO
 * BANAT + EMBEDDED DASHBOARD
 *
 * Dashboard:
 *   GET /
 *
 * Session:
 *   POST /api/connect
 *   POST /api/disconnect
 *   GET  /api/status
 *
 * Messenger commands remain Messenger commands:
 *   !banat on
 *   !banat off
 *   !banat toggle
 *   !banat status
 *   !banat help
 *
 * Existing framework commands such as:
 *   !setallnickname
 *   !lockgc
 *   !unlockgc
 *
 * are NOT executed by the dashboard.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

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

const PORT = Number(process.env.PORT || 10000);

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

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();

let globalActive = 0;

let api = null;
let botUserID = "";

let botConnectedAt = null;
let messageCount = 0;
let commandCount = 0;
let lastActivity = null;
let lastError = null;

const dashboardLogs = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================================
 * DASHBOARD LOGGING
 * ======================================================= */

function dashboardLog(message, type = "info") {
  const entry = {
    time: new Date().toISOString(),
    type,
    message: String(message)
  };

  dashboardLogs.push(entry);

  if (dashboardLogs.length > 100) {
    dashboardLogs.shift();
  }

  console.log(`[DASHBOARD] ${message}`);
}

function getUptime() {
  if (!botConnectedAt) return 0;

  return Math.max(
    0,
    Date.now() - botConnectedAt
  );
}

/* =========================================================
 * SESSION
 * ======================================================= */

function normalizeSession(value) {
  if (typeof value === "string") {
    const cookie = value.trim();

    if (!cookie) {
      throw new Error("Session is empty.");
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
      "Session must be a cookie string or JSON cookie/appState array."
    );
  }

  const parts = entries
    .map(cookie => {
      const key = cookie?.key ?? cookie?.name;
      const val = cookie?.value;

      if (key == null || val == null) {
        return null;
      }

      return (
        String(key).trim() +
        "=" +
        String(val)
      );
    })
    .filter(Boolean);

  if (!parts.length) {
    throw new Error(
      "Session contains no valid cookies."
    );
  }

  return parts.join("; ");
}

function readEnvironmentSession() {
  const raw =
    process.env.FB_COOKIES ||
    process.env.FB_APPSTATE;

  if (!raw) return null;

  try {
    return normalizeSession(
      JSON.parse(String(raw).trim())
    );
  } catch (_) {
    return normalizeSession(raw);
  }
}

/*
 * Local fallback.
 * Dashboard sessions are preferred.
 */
function readLocalSession() {
  for (const file of [
    "appstate.json",
    "cookies.json"
  ]) {
    const filePath = path.join(
      process.cwd(),
      file
    );

    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      const raw = fs.readFileSync(
        filePath,
        "utf8"
      );

      return normalizeSession(
        JSON.parse(raw)
      );
    } catch (error) {
      throw new Error(
        `${file}: ${error.message}`
      );
    }
  }

  return null;
}

/* =========================================================
 * BOT CONNECTION
 * ======================================================= */

let loginInProgress = false;

function connectBot(session) {
  return new Promise((resolve, reject) => {
    if (loginInProgress) {
      return reject(
        new Error("A connection is already in progress.")
      );
    }

    if (api) {
      return reject(
        new Error("Bot is already connected.")
      );
    }

    loginInProgress = true;

    let cookie;

    try {
      cookie = normalizeSession(session);
    } catch (error) {
      loginInProgress = false;
      return reject(error);
    }

    dashboardLog("Connecting Messenger session...");

    login(
      cookie,
      (error, newApi) => {
        loginInProgress = false;

        if (error) {
          lastError =
            error?.message ||
            String(error);

          dashboardLog(
            `Login failed: ${lastError}`,
            "error"
          );

          return reject(error);
        }

        api = newApi;

        try {
          botUserID = String(
            api.getCurrentUserID?.() || ""
          );
        } catch (_) {
          botUserID = "";
        }

        botConnectedAt = Date.now();
        lastError = null;

        dashboardLog(
          `Bot connected${botUserID ? ` as ${botUserID}` : ""}`,
          "success"
        );

        startListener(api);

        resolve({
          connected: true,
          userID: botUserID
        });
      }
    );
  });
}

function disconnectBot() {
  if (!api) {
    return false;
  }

  try {
    if (typeof api.logout === "function") {
      api.logout(() => {});
    }
  } catch (error) {
    dashboardLog(
      `Logout warning: ${error.message}`,
      "error"
    );
  }

  api = null;
  botUserID = "";
  botConnectedAt = null;

  activeThreads.clear();
  threadQueues.clear();
  threadLastSent.clear();
  threadCooldown.clear();

  dashboardLog(
    "Bot disconnected.",
    "warning"
  );

  return true;
}

/* =========================================================
 * MESSAGE QUEUE
 * ======================================================= */

function enqueue(threadID, job) {
  const key = String(threadID);

  const current =
    threadQueues.get(key) ||
    Promise.resolve();

  const next =
    current
      .catch(() => {})
      .then(job)
      .finally(() => {
        if (
          threadQueues.get(key) === next
        ) {
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
  globalActive =
    Math.max(
      0,
      globalActive - 1
    );
}

function is1545012(error) {
  const text =
    JSON.stringify(error || "");

  return /1545012|temporarily unavailable|message could not be sent/i.test(
    text
  );
}

function trafficSendMessage(
  messengerApi,
  message,
  threadID,
  callback,
  replyToMessageID = null
) {
  const key = String(threadID);

  return enqueue(
    key,
    async () => {
      const now = Date.now();

      const cooldownUntil =
        Number(
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

                  const done =
                    (err, info) => {
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
                        messengerApi.sendMessage(
                          message,
                          threadID,
                          done,
                          replyToMessageID
                        );
                    } else {
                      returned =
                        messengerApi.sendMessage(
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

            threadCooldown.delete(key);
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
    }
  );
}

/* =========================================================
 * COMMAND SENDER
 * ======================================================= */

function commandSendMessage(
  messengerApi,
  message,
  threadID,
  replyToMessageID = null
) {
  return new Promise(
    (resolve, reject) => {
      let settled = false;

      const done =
        (err, info) => {
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
            ? messengerApi.sendMessage(
                message,
                threadID,
                done,
                replyToMessageID
              )
            : messengerApi.sendMessage(
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
  messengerApi,
  event,
  message
) {
  commandSendMessage(
    messengerApi,
    message,
    String(event.threadID),
    event.messageID || null
  )
    .then(() => {
      console.log(
        `[BANAT] command reply sent: ${message}`
      );
    })
    .catch(error => {
      console.error(
        "[BANAT] command reply failed:",
        error?.message || error
      );
    });
}

/* =========================================================
 * BANAT COMMAND
 * ======================================================= */

function isBanatCommand(body) {
  return /^!banat(?:\s|$)/i.test(
    String(body || "").trim()
  );
}

function handleBanatCommand(
  messengerApi,
  event,
  body
) {
  commandCount++;

  const threadID =
    String(event.threadID);

  const parts =
    String(body)
      .trim()
      .split(/\s+/);

  const sub =
    (parts[1] || "status")
      .toLowerCase();

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

    activeThreads.add(threadID);

    dashboardLog(
      `BANAT ON: ${threadID}`
    );

    sendCommandReply(
      messengerApi,
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

    dashboardLog(
      `BANAT OFF: ${threadID}`
    );

    sendCommandReply(
      messengerApi,
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

    dashboardLog(
      `BANAT TOGGLE: ${threadID} -> ${
        next ? "ON" : "OFF"
      }`
    );

    sendCommandReply(
      messengerApi,
      event,
      next
        ? "banat is on 😭"
        : "banat is off"
    );

    return true;
  }

  if (sub === "status") {
    const on =
      activeThreads.has(threadID) ||
      isBanatConversationModeActive(
        threadID
      );

    sendCommandReply(
      messengerApi,
      event,
      on
        ? "banat: ON 🟢"
        : "banat: OFF 🔴"
    );

    return true;
  }

  if (sub === "help") {
    sendCommandReply(
      messengerApi,
      event,
      "!banat on · !banat off · !banat toggle · !banat status"
    );

    return true;
  }

  sendCommandReply(
    messengerApi,
    event,
    "unknown banat command. use !banat help"
  );

  return true;
}

/* =========================================================
 * BANAT REPLY
 * ======================================================= */

async function sendBanat(
  messengerApi,
  event,
  text
) {
  return sendBanatReplyWithTyping(
    messengerApi,
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

/* =========================================================
 * MESSAGE HANDLER
 * ======================================================= */

function onMessage(
  messengerApi,
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

  const body =
    String(event.body || "")
      .trim();

  if (!body) return;

  messageCount++;
  lastActivity =
    new Date().toISOString();

  /*
   * BANAT command.
   */
  if (isBanatCommand(body)) {
    handleBanatCommand(
      messengerApi,
      event,
      body
    );

    return;
  }

  /*
   * IMPORTANT:
   *
   * Other Messenger commands such as:
   *
   * !setallnickname
   * !lockgc
   * !unlockgc
   *
   * remain handled by the framework's
   * normal command system.
   *
   * This index.js does NOT execute them
   * from the dashboard.
   */

  const threadID =
    String(event.threadID);

  const active =
    activeThreads.has(threadID) ||
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
        messengerApi,
        event,
        reply
      ).catch(error => {
        console.error(
          "[BANAT] reply error:",
          error
        );
      });
    }

    return;
  }

  if (target.shouldRespond) {
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
        messengerApi,
        event,
        reply
      ).catch(error => {
        console.error(
          "[BANAT] reply error:",
          error
        );
      });
    }
  }
}

/* =========================================================
 * LISTENER
 * ======================================================= */

function startListener(
  messengerApi
) {
  try {
    messengerApi.listenMqtt(
      (error, event) => {
        if (error) {
          lastError =
            error?.message ||
            String(error);

          dashboardLog(
            `Listener error: ${lastError}`,
            "error"
          );

          return;
        }

        try {
          if (
            DEFAULT_ON &&
            event?.threadID &&
            event?.senderID &&
            String(event.senderID) !==
              String(botUserID)
          ) {
            const key =
              String(event.threadID);

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

          /*
           * Existing Messenger framework
           * event flow.
           */
          onMessage(
            messengerApi,
            event
          );
        } catch (error) {
          lastError =
            error?.message ||
            String(error);

          console.error(
            "[BANAT] message handler error:",
            error
          );
        }
      }
    );

    dashboardLog(
      "Messenger listener started.",
      "success"
    );
  } catch (error) {
    lastError =
      error?.message ||
      String(error);

    dashboardLog(
      `Listener failed: ${lastError}`,
      "error"
    );
  }
}

/* =========================================================
 * DASHBOARD HTML
 * ======================================================= */

function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1.0">

<title>Opakankomamamo Control Panel</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #0d1117;
  color: #e6edf3;
  font-family: Arial, sans-serif;
}

.container {
  width: min(900px, 94%);
  margin: 30px auto;
}

.header {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 18px;
}

.header h1 {
  margin: 0 0 8px;
  font-size: 25px;
}

.header p {
  margin: 0;
  color: #8b949e;
}

.card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 18px;
}

.card h2 {
  margin-top: 0;
  font-size: 18px;
}

textarea {
  width: 100%;
  min-height: 130px;
  resize: vertical;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 10px;
  color: #e6edf3;
  padding: 13px;
  outline: none;
}

button {
  border: 0;
  border-radius: 9px;
  padding: 11px 16px;
  margin: 5px 4px 0 0;
  cursor: pointer;
  background: #238636;
  color: white;
  font-weight: bold;
}

button.red {
  background: #da3633;
}

button.gray {
  background: #30363d;
}

.status {
  font-size: 18px;
  font-weight: bold;
}

.green {
  color: #3fb950;
}

.redText {
  color: #f85149;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(170px, 1fr));
  gap: 10px;
}

.stat {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 10px;
  padding: 14px;
}

.stat small {
  display: block;
  color: #8b949e;
  margin-bottom: 5px;
}

.stat strong {
  font-size: 17px;
}

pre {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 10px;
  padding: 14px;
  white-space: pre-wrap;
  max-height: 280px;
  overflow: auto;
  color: #8b949e;
}

.note {
  color: #8b949e;
  font-size: 13px;
  line-height: 1.5;
}
</style>
</head>

<body>

<div class="container">

  <div class="header">
    <h1>OPAKANKOMAMAMO</h1>
    <p>Messenger Bot Control Panel</p>
  </div>

  <div class="card">

    <h2>🔐 C3C / SESSION</h2>

    <textarea
      id="session"
      placeholder="Paste your C3C / session here..."
    ></textarea>

    <br>

    <button onclick="connectBot()">
      CONNECT BOT
    </button>

    <button
      class="red"
      onclick="disconnectBot()"
    >
      DISCONNECT
    </button>

    <button
      class="gray"
      onclick="clearSession()"
    >
      CLEAR
    </button>

    <p class="note">
      The dashboard uses a session/C3C value only.
      Your Facebook password is not requested.
      The raw session is not displayed in the status panel.
    </p>

  </div>

  <div class="card">

    <h2>🤖 BOT STATUS</h2>

    <div id="status"
         class="status redText">
      🔴 OFFLINE
    </div>

    <br>

    <div class="grid">

      <div class="stat">
        <small>Bot UID</small>
        <strong id="uid">—</strong>
      </div>

      <div class="stat">
        <small>Uptime</small>
        <strong id="uptime">—</strong>
      </div>

      <div class="stat">
        <small>Messages</small>
        <strong id="messages">0</strong>
      </div>

      <div class="stat">
        <small>Commands</small>
        <strong id="commands">0</strong>
      </div>

      <div class="stat">
        <small>Active Threads</small>
        <strong id="threads">0</strong>
      </div>

    </div>

  </div>

  <div class="card">

    <h2>⚔️ BANAT</h2>

    <p class="note">
      BANAT is controlled through Messenger.
      The dashboard does not send Messenger commands.
    </p>

    <pre>
!banat on
!banat off
!banat toggle
!banat status
!banat help</pre>

  </div>

  <div class="card">

    <h2>👥 GROUP COMMANDS</h2>

    <p class="note">
      These remain Messenger commands and are handled
      by your existing framework:
    </p>

    <pre>
!setallnickname
!lockgc
!unlockgc</pre>

  </div>

  <div class="card">

    <h2>📜 LOGS</h2>

    <pre id="logs">Loading...</pre>

  </div>

</div>

<script>

function formatUptime(ms) {
  if (!ms) return "—";

  let total =
    Math.floor(ms / 1000);

  const days =
    Math.floor(total / 86400);

  total %= 86400;

  const hours =
    Math.floor(total / 3600);

  total %= 3600;

  const minutes =
    Math.floor(total / 60);

  const seconds =
    total % 60;

  if (days > 0) {
    return days + "d " +
           hours + "h " +
           minutes + "m";
  }

  return String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0");
}

async function connectBot() {

  const session =
    document
      .getElementById("session")
      .value
      .trim();

  if (!session) {
    alert("Paste your C3C/session first.");
    return;
  }

  try {

    const response =
      await fetch("/api/connect", {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          session
        })
      });

    const data =
      await response.json();

    if (!data.ok) {
      alert(
        data.error ||
        "Connection failed."
      );
      return;
    }

    document
      .getElementById("session")
      .value = "";

    refresh();

  } catch (error) {
    alert(error.message);
  }
}

async function disconnectBot() {

  if (!confirm(
    "Disconnect the bot?"
  )) {
    return;
  }

  await fetch(
    "/api/disconnect",
    { method: "POST" }
  );

  refresh();
}

function clearSession() {
  document
    .getElementById("session")
    .value = "";
}

async function refresh() {

  try {

    const response =
      await fetch("/api/status");

    const data =
      await response.json();

    const status =
      document.getElementById(
        "status"
      );

    if (data.connected) {

      status.textContent =
        "🟢 ONLINE";

      status.className =
        "status green";

    } else {

      status.textContent =
        "🔴 OFFLINE";

      status.className =
        "status redText";
    }

    document
      .getElementById("uid")
      .textContent =
        data.userID || "—";

    document
      .getElementById("uptime")
      .textContent =
        formatUptime(data.uptime);

    document
      .getElementById("messages")
      .textContent =
        data.messageCount;

    document
      .getElementById("commands")
      .textContent =
        data.commandCount;

    document
      .getElementById("threads")
      .textContent =
        data.activeThreads;

    document
      .getElementById("logs")
      .textContent =
        (data.logs || [])
          .map(item =>
            "[" +
            item.time +
            "] " +
            item.type.toUpperCase() +
            " - " +
            item.message
          )
          .join("\\n");

  } catch (_) {
    // dashboard can retry automatically
  }
}

refresh();

setInterval(
  refresh,
  3000
);

</script>

</body>
</html>`;
}

/* =========================================================
 * HTTP HELPERS
 * ======================================================= */

function sendJSON(
  res,
  statusCode,
  data
) {
  const body =
    JSON.stringify(data);

  res.writeHead(
    statusCode,
    {
      "content-type":
        "application/json; charset=utf-8",
      "cache-control":
        "no-store"
    }
  );

  res.end(body);
}

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        chunk => {
          body += chunk;

          if (
            body.length >
            1024 * 1024
          ) {
            reject(
              new Error(
                "Request body too large."
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => resolve(body)
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

/* =========================================================
 * HTTP SERVER
 * ======================================================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );

        /*
         * Dashboard
         */
        if (
          req.method === "GET" &&
          url.pathname === "/"
        ) {
          res.writeHead(
            200,
            {
              "content-type":
                "text/html; charset=utf-8"
            }
          );

          res.end(
            dashboardHTML()
          );

          return;
        }

        /*
         * Status
         */
        if (
          req.method === "GET" &&
          url.pathname ===
            "/api/status"
        ) {

          sendJSON(
            res,
            200,
            {
              ok: true,
              connected: !!api,
              userID:
                botUserID || null,
              uptime:
                getUptime(),
              messageCount,
              commandCount,
              activeThreads:
                activeThreads.size,
              lastActivity,
              lastError,
              logs:
                dashboardLogs.slice(-50)
            }
          );

          return;
        }

        /*
         * Connect
         */
        if (
          req.method === "POST" &&
          url.pathname ===
            "/api/connect"
        ) {

          const raw =
            await readBody(req);

          let payload;

          try {
            payload =
              JSON.parse(raw || "{}");
          } catch (_) {
            sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  "Invalid JSON."
              }
            );

            return;
          }

          if (!payload.session) {
            sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  "Session is required."
              }
            );

            return;
          }

          try {

            const result =
              await connectBot(
                payload.session
              );

            sendJSON(
              res,
              200,
              {
                ok: true,
                connected:
                  true,
                userID:
                  result.userID || null
              }
            );

          } catch (error) {

            sendJSON(
              res,
              500,
              {
                ok: false,
                error:
                  error?.message ||
                  String(error)
              }
            );
          }

          return;
        }

        /*
         * Disconnect
         */
        if (
          req.method === "POST" &&
          url.pathname ===
            "/api/disconnect"
        ) {

          const disconnected =
            disconnectBot();

          sendJSON(
            res,
            200,
            {
              ok: true,
              disconnected
            }
          );

          return;
        }

        sendJSON(
          res,
          404,
          {
            ok: false,
            error: "Not found."
          }
        );

      } catch (error) {

        lastError =
          error?.message ||
          String(error);

        console.error(
          "[HTTP]",
          error
        );

        sendJSON(
          res,
          500,
          {
            ok: false,
            error:
              "Internal server error."
          }
        );
      }
    }
  );

/* =========================================================
 * SERVER START
 * ======================================================= */

server.listen(
  PORT,
  () => {
    console.log(
      `[DASHBOARD] listening on port ${PORT}`
    );

    dashboardLog(
      `Dashboard running on port ${PORT}`,
      "success"
    );

    /*
     * Optional environment session.
     */
    try {

      const envSession =
        readEnvironmentSession();

      if (envSession) {
        connectBot(
          envSession
        ).catch(error => {
          console.error(
            "[BANAT] automatic login failed:",
            error?.message || error
          );
        });

        return;
      }

      /*
       * Optional local appstate/cookies.
       */
      const localSession =
        readLocalSession();

      if (localSession) {
        connectBot(
          localSession
        ).catch(error => {
          console.error(
            "[BANAT] local session login failed:",
            error?.message || error
          );
        });
      }

    } catch (error) {

      dashboardLog(
        `Automatic session unavailable: ${error.message}`,
        "warning"
      );
    }
  }
);

/* =========================================================
 * CLEAN SHUTDOWN
 * ======================================================= */

function shutdown(signal) {
  console.log(
    `[BANAT] received ${signal}`
  );

  try {
    disconnectBot();
  } catch (_) {}

  server.close(
    () => process.exit(0)
  );

  setTimeout(
    () => process.exit(0),
    5000
  );
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

/* =========================================================
 * EXPORTS
 * ======================================================= */

module.exports = {
  trafficSendMessage,
  onMessage,
  handleBanatCommand,
  connectBot,
  disconnectBot
};
