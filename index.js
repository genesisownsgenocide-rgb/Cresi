"use strict";

/*
 * BANAT MESSENGER BOT + DASHBOARD
 * --------------------------------
 *
 * Dashboard:
 *   /
 *   /dashboard
 *
 * Dashboard login:
 *   Username: admin
 *   Password: halimaw123
 *
 * Messenger commands:
 *   !banat on
 *   !banat off
 *   !banat toggle
 *   !banat status
 *   !banat help
 *
 * Other modules:
 *   setallnick.js
 *   gcname-lock.js
 *
 * Facebook session:
 *   Dashboard -> C3C / AppState
 *
 * IMPORTANT:
 *   This version uses the old ws3-fca cookie-string login style.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
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


// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const DASHBOARD_USERNAME = "admin";
const DASHBOARD_PASSWORD = "halimaw123";

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

const SESSION_FILE = path.join(
  process.cwd(),
  "appstate.json"
);


// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(express.json({
  limit: "10mb"
}));

app.use(express.urlencoded({
  extended: true,
  limit: "10mb"
}));


// ============================================================
// BOT STATE
// ============================================================

let api = null;
let botUserID = "";
let botName = "";

let botOnline = false;
let botLoggingIn = false;

let totalMessages = 0;
let totalReplies = 0;
let totalErrors = 0;

let lastError = "";
let lastLoginTime = null;
let lastMessageTime = null;

const activeThreads = new Set();

const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();

let globalActive = 0;


// ============================================================
// DASHBOARD AUTH
// ============================================================

const dashboardTokens = new Set();

function createDashboardToken() {
  return crypto.randomBytes(32).toString("hex");
}

function isDashboardAuthenticated(req) {
  const token =
    req.headers["x-dashboard-token"] ||
    req.query.token;

  return Boolean(
    token &&
    dashboardTokens.has(String(token))
  );
}

function requireDashboard(req, res, next) {
  if (!isDashboardAuthenticated(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  next();
}


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ============================================================
// SESSION READER
// ============================================================

function readSession() {
  const raw =
    process.env.FB_COOKIES ||
    process.env.FB_APPSTATE;

  if (raw) {
    const trimmed = String(raw).trim();

    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return trimmed;
    }
  }

  if (fs.existsSync(SESSION_FILE)) {
    try {
      return JSON.parse(
        fs.readFileSync(SESSION_FILE, "utf8")
      );
    } catch (_) {
      return fs.readFileSync(
        SESSION_FILE,
        "utf8"
      );
    }
  }

  for (const file of [
    "cookies.json"
  ]) {
    const filePath = path.join(
      process.cwd(),
      file
    );

    if (fs.existsSync(filePath)) {
      return JSON.parse(
        fs.readFileSync(
          filePath,
          "utf8"
        )
      );
    }
  }

  throw new Error(
    "No Facebook session found."
  );
}


// ============================================================
// NORMALIZE APPSTATE / C3C
// ============================================================

function normalizeSession(value) {

  /*
   * Already a cookie string
   */

  if (typeof value === "string") {

    const cookie = value.trim();

    if (!cookie) {
      throw new Error(
        "Facebook cookie session is empty."
      );
    }

    /*
     * If dashboard sends JSON as string,
     * parse it first.
     */

    if (
      cookie.startsWith("[") ||
      cookie.startsWith("{")
    ) {
      try {
        return normalizeSession(
          JSON.parse(cookie)
        );
      } catch (_) {
        // Not valid JSON.
        // Continue treating it as cookie string.
      }
    }

    return cookie;
  }


  /*
   * Standard AppState array
   */

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
      "Facebook session must be a cookie string or JSON AppState array."
    );
  }

  const parts = entries
    .map(cookie => {

      const key =
        cookie?.key ??
        cookie?.name;

      const val =
        cookie?.value;

      if (
        key == null ||
        val == null
      ) {
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
      "Facebook session contains no valid cookie entries."
    );
  }

  return parts.join("; ");
}


// ============================================================
// SAVE SESSION
// ============================================================

function saveSession(cookieString) {

  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify(
      {
        cookies: cookieString
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    "[BANAT] Facebook session saved."
  );
}


// ============================================================
// TRAFFIC QUEUE
// ============================================================

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

  threadQueues.set(
    key,
    next
  );

  return next;
}


// ============================================================
// GLOBAL SEND LIMIT
// ============================================================

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


// ============================================================
// FACEBOOK ERROR CHECK
// ============================================================

function is1545012(error) {

  const text =
    JSON.stringify(
      error || ""
    );

  return /1545012|temporarily unavailable|message could not be sent/i
    .test(text);
}


// ============================================================
// TRAFFIC SEND MESSAGE
// ============================================================

function trafficSendMessage(
  messengerApi,
  message,
  threadID,
  callback,
  replyToMessageID = null
) {

  const key =
    String(threadID);

  return enqueue(
    key,
    async () => {

      const now =
        Date.now();

      const cooldownUntil =
        Number(
          threadCooldown.get(key) || 0
        );

      if (
        cooldownUntil > now
      ) {

        callback(
          new Error(
            `thread cooldown active for ${cooldownUntil - now}ms`
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

                      if (settled) {
                        return;
                      }

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

                  } catch (e) {
                    reject(e);
                  }

                }
              );

            threadLastSent.set(
              key,
              Date.now()
            );

            callback(
              null,
              result
            );

            return;

          } catch (error) {

            lastError =
              error;

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

        if (
          is1545012(lastError)
        ) {

          threadCooldown.set(
            key,
            Date.now() +
            5 * 60 * 1000
          );

        }

        callback(
          lastError
        );

      } finally {

        releaseGlobalSlot();

      }

    }
  );
}


// ============================================================
// COMMAND SEND
// ============================================================

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

          if (settled) {
            return;
          }

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

  const threadID =
    String(event.threadID);

  commandSendMessage(
    messengerApi,
    message,
    threadID,
    event.messageID || null
  )
    .then(() => {

      totalReplies++;

      console.log(
        `[BANAT] command reply sent: ${message}`
      );

    })
    .catch(error => {

      totalErrors++;

      lastError =
        error?.message ||
        String(error);

      console.error(
        "[BANAT] command reply failed:",
        lastError
      );

    });
}


// ============================================================
// BANAT COMMAND
// ============================================================

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

  const threadID =
    String(event.threadID);

  const parts =
    String(body)
      .trim()
      .split(/\s+/);

  const sub =
    (
      parts[1] ||
      "status"
    ).toLowerCase();


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
      `[BANAT] activated thread ${threadID} by ${event.senderID || "unknown"}`
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

    console.log(
      `[BANAT] deactivated thread ${threadID}`
    );

    sendCommandReply(
      messengerApi,
      event,
      "banat off. peace 😭"
    );

    return true;
  }


  if (
    sub === "toggle"
  ) {

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

    console.log(
      `[BANAT] toggled thread ${threadID}: ${
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


  if (
    sub === "status"
  ) {

    const on =
      activeThreads.has(
        threadID
      ) ||
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


  if (
    sub === "help"
  ) {

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


// ============================================================
// BANAT REPLY
// ============================================================

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


// ============================================================
// MESSAGE HANDLER
// ============================================================

function onMessage(
  messengerApi,
  event
) {

  if (!event) {
    return;
  }

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
    String(
      event.body || ""
    ).trim();

  if (!body) {
    return;
  }

  totalMessages++;
  lastMessageTime =
    new Date().toISOString();


  // ==========================================================
  // SET ALL NICK COMMANDS
  // ==========================================================

  try {

    if (
      setallnick &&
      typeof setallnick.handleCommand ===
        "function"
    ) {

      if (
        setallnick.handleCommand(
          messengerApi,
          event,
          body
        )
      ) {
        return;
      }

    }

  } catch (error) {

    totalErrors++;

    console.error(
      "[SETALLNICK] command error:",
      error
    );

  }


  // ==========================================================
  // GC NAME LOCK COMMANDS
  // ==========================================================

  try {

    if (
      gcnameLock &&
      typeof gcnameLock.handleCommand ===
        "function"
    ) {

      if (
        gcnameLock.handleCommand(
          messengerApi,
          event,
          body
        )
      ) {
        return;
      }

    }

  } catch (error) {

    totalErrors++;

    console.error(
      "[GCNAME] command error:",
      error
    );

  }


  // ==========================================================
  // NICKNAME PROTECTION
  // ==========================================================

  try {

    if (
      setallnick &&
      typeof setallnick.protectNickname ===
        "function"
    ) {

      setallnick.protectNickname(
        messengerApi,
        event
      );

    }

  } catch (error) {

    console.error(
      "[SETALLNICK] protection error:",
      error
    );

  }


  // ==========================================================
  // GC NAME PROTECTION
  // ==========================================================

  try {

    if (
      gcnameLock &&
      typeof gcnameLock.protectGCName ===
        "function"
    ) {

      gcnameLock.protectGCName(
        messengerApi,
        event
      );

    }

  } catch (error) {

    console.error(
      "[GCNAME] protection error:",
      error
    );

  }


  // ==========================================================
  // BANAT COMMAND
  // ==========================================================

  if (
    isBanatCommand(body)
  ) {

    handleBanatCommand(
      messengerApi,
      event,
      body
    );

    return;
  }


  // ==========================================================
  // BANAT NORMAL MESSAGE
  // ==========================================================

  const threadID =
    String(event.threadID);

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

    console.log(
      `[BANAT] active message in ${threadID} from ${event.senderID || "unknown"}`
    );

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
      )
        .then(() => {
          totalReplies++;
        })
        .catch(error => {

          totalErrors++;

          lastError =
            error?.message ||
            String(error);

          console.error(
            "[BANAT] reply error:",
            lastError
          );

        });

    } else {

      console.warn(
        `[BANAT] no reply generated for active message in ${threadID}`
      );

    }

    return;
  }


  // ==========================================================
  // TARGETED BANAT
  // ==========================================================

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
        messengerApi,
        event,
        reply
      )
        .then(() => {
          totalReplies++;
        })
        .catch(error => {

          totalErrors++;

          lastError =
            error?.message ||
            String(error);

          console.error(
            "[BANAT]",
            lastError
          );

        });

    }

  }

}


// ============================================================
// GET BOT NAME
// ============================================================

function updateBotInfo() {

  if (!api) {
    return;
  }

  try {

    botUserID =
      String(
        api.getCurrentUserID?.() ||
        ""
      );

  } catch (_) {}


  if (
    !botUserID
  ) {
    return;
  }


  if (
    typeof api.getUserInfo ===
    "function"
  ) {

    api.getUserInfo(
      [botUserID],
      (error, info) => {

        if (
          error ||
          !info ||
          !info[botUserID]
        ) {
          return;
        }

        botName =
          info[botUserID].name ||
          "";

        console.log(
          `[BANAT] account: ${botName} (${botUserID})`
        );

      }
    );

  }

}


// ============================================================
// START BOT
// ============================================================

function start(
  messengerApi
) {

  /*
   * IMPORTANT:
   * This assigns the module-level api variable.
   * This fixes "api is not defined".
   */

  api = messengerApi;

  botOnline = true;
  botLoggingIn = false;

  lastLoginTime =
    new Date().toISOString();

  lastError = "";

  updateBotInfo();


  if (DEFAULT_ON) {

    console.log(
      "[BANAT] BANAT_DEFAULT_ON enabled."
    );

  }


  api.listenMqtt(
    (error, event) => {

      if (error) {

        totalErrors++;

        lastError =
          error?.message ||
          String(error);

        console.error(
          "[BANAT] listener error:",
          error
        );

        return;
      }

      try {

        if (
          DEFAULT_ON &&
          event?.threadID &&
          event?.senderID &&
          String(event.senderID) !==
            botUserID
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

      } catch (e) {

        totalErrors++;

        lastError =
          e?.message ||
          String(e);

        console.error(
          "[BANAT] message handler error:",
          e
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


// ============================================================
// LOGIN BOT
// ============================================================

function loginBot(
  suppliedSession = null
) {

  if (botLoggingIn) {

    throw new Error(
      "Facebook login is already in progress."
    );

  }

  botLoggingIn = true;

  let cookie;

  try {

    const session =
      suppliedSession !== null
        ? suppliedSession
        : readSession();

    cookie =
      normalizeSession(
        session
      );

  } catch (error) {

    botLoggingIn = false;

    throw error;
  }


  console.log(
    "[BANAT] logging in with saved Facebook session..."
  );

  console.log(
    `[BANAT] session format: cookie string (${cookie.length} chars)`
  );


  login(
    cookie,
    (error, loggedInApi) => {

      botLoggingIn = false;

      if (error) {

        botOnline = false;

        /*
         * Important:
         * Don't destroy dashboard when Facebook login fails.
         */

        lastError =
          error?.message ||
          String(error);

        console.error(
          "[BANAT] login failed:",
          lastError
        );

        return;
      }


      /*
       * THIS IS THE IMPORTANT FIX:
       *
       * The API returned by ws3-fca
       * is assigned to the module-level
       * variable.
       */

      api = loggedInApi;

      botOnline = true;

      lastError = "";

      /*
       * Save the normalized cookie string.
       * Do not print it.
       */

      try {

        saveSession(
          cookie
        );

      } catch (saveError) {

        console.error(
          "[BANAT] session save failed:",
          saveError?.message ||
            saveError
        );

      }


      start(
        loggedInApi
      );

    }
  );

}


// ============================================================
// BOT LOGOUT
// ============================================================

async function logoutBot() {

  const currentApi =
    api;

  api = null;

  botOnline = false;
  botLoggingIn = false;

  botUserID = "";
  botName = "";

  activeThreads.clear();

  threadQueues.clear();
  threadLastSent.clear();
  threadCooldown.clear();


  if (
    currentApi &&
    typeof currentApi.logout ===
      "function"
  ) {

    try {

      await new Promise(
        resolve => {

          let finished = false;

          const done = () => {

            if (finished) {
              return;
            }

            finished = true;

            resolve();

          };

          try {

            const result =
              currentApi.logout(
                done
              );

            if (
              result &&
              typeof result.then ===
                "function"
            ) {

              result
                .then(done)
                .catch(done);

            }

          } catch (_) {

            done();

          }

          setTimeout(
            done,
            3000
          );

        }
      );

    } catch (error) {

      console.error(
        "[BANAT] logout error:",
        error?.message ||
          error
      );

    }

  }


  /*
   * Remove saved local session.
   */

  try {

    if (
      fs.existsSync(
        SESSION_FILE
      )
    ) {

      fs.unlinkSync(
        SESSION_FILE
      );

    }

  } catch (error) {

    console.error(
      "[BANAT] session delete failed:",
      error?.message ||
        error
    );

  }

}


// ============================================================
// DASHBOARD LOGIN PAGE
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">

<title>Halimaw Dashboard Login</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: Arial, sans-serif;
  background: #f3f4f6;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #111827;
}

.login-box {
  width: min(420px, 92%);
  background: white;
  border-radius: 18px;
  padding: 30px;
  box-shadow: 0 15px 45px rgba(0,0,0,.12);
}

.logo {
  text-align: center;
  font-size: 30px;
  font-weight: 800;
  margin-bottom: 8px;
}

.subtitle {
  text-align: center;
  color: #6b7280;
  margin-bottom: 25px;
}

label {
  display: block;
  font-weight: 700;
  margin: 14px 0 7px;
}

input {
  width: 100%;
  padding: 13px;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  font-size: 15px;
  outline: none;
}

input:focus {
  border-color: #2563eb;
}

button {
  width: 100%;
  border: 0;
  border-radius: 10px;
  padding: 14px;
  margin-top: 20px;
  background: #2563eb;
  color: white;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}

button:hover {
  background: #1d4ed8;
}

#error {
  display: none;
  margin-top: 15px;
  padding: 12px;
  border-radius: 9px;
  background: #fee2e2;
  color: #991b1b;
}

</style>
</head>

<body>

<div class="login-box">

  <div class="logo">
    HALIMAW
  </div>

  <div class="subtitle">
    Messenger Bot Dashboard
  </div>

  <form id="loginForm">

    <label>Username</label>

    <input
      id="username"
      autocomplete="username"
      placeholder="Username"
      required
    >

    <label>Password</label>

    <input
      id="password"
      type="password"
      autocomplete="current-password"
      placeholder="Password"
      required
    >

    <button type="submit">
      Login
    </button>

  </form>

  <div id="error"></div>

</div>

<script>

document
  .getElementById("loginForm")
  .addEventListener("submit", async function(e) {

    e.preventDefault();

    const errorBox =
      document.getElementById("error");

    errorBox.style.display = "none";

    const username =
      document.getElementById("username").value;

    const password =
      document.getElementById("password").value;

    try {

      const response =
        await fetch("/api/dashboard/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            username,
            password
          })
        });

      const data =
        await response.json();

      if (!data.ok) {
        throw new Error(
          data.error || "Login failed."
        );
      }

      localStorage.setItem(
        "dashboardToken",
        data.token
      );

      location.href =
        "/dashboard";

    } catch (error) {

      errorBox.textContent =
        error.message;

      errorBox.style.display =
        "block";

    }

  });

</script>

</body>
</html>
    `);

  }
);


// ============================================================
// DASHBOARD PAGE
// ============================================================

app.get(
  "/dashboard",
  (req, res) => {

    if (
      !isDashboardAuthenticated(req)
    ) {

      return res.redirect("/");

    }

    res.send(`
<!DOCTYPE html>
<html>
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<title>Halimaw Dashboard</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f3f4f6;
  color: #111827;
  font-family: Arial, sans-serif;
}

header {
  background: white;
  border-bottom: 1px solid #e5e7eb;
  padding: 18px 22px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.brand {
  font-size: 22px;
  font-weight: 800;
}

.logout {
  background: #ef4444;
  color: white;
  border: 0;
  padding: 9px 15px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 700;
}

.container {
  width: min(1000px, 94%);
  margin: 25px auto;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(220px, 1fr));
  gap: 15px;
}

.card {
  background: white;
  border-radius: 15px;
  padding: 20px;
  box-shadow:
    0 5px 20px rgba(0,0,0,.06);
}

.card h3 {
  margin-top: 0;
}

.status {
  font-size: 22px;
  font-weight: 800;
}

.online {
  color: #16a34a;
}

.offline {
  color: #dc2626;
}

textarea {
  width: 100%;
  min-height: 220px;
  resize: vertical;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  padding: 12px;
  font-family: monospace;
  font-size: 13px;
}

button.action {
  border: 0;
  border-radius: 9px;
  padding: 12px 17px;
  color: white;
  font-weight: 700;
  cursor: pointer;
  margin-top: 10px;
  margin-right: 7px;
}

.login-btn {
  background: #2563eb;
}

.stop-btn {
  background: #ef4444;
}

.refresh-btn {
  background: #111827;
}

.message {
  margin-top: 12px;
  padding: 11px;
  border-radius: 9px;
  background: #f3f4f6;
  display: none;
}

.small {
  color: #6b7280;
  font-size: 13px;
}

.value {
  font-size: 20px;
  font-weight: 800;
  margin-top: 7px;
}

.warning {
  color: #92400e;
  background: #fef3c7;
  padding: 12px;
  border-radius: 9px;
  margin-bottom: 15px;
}

</style>

</head>

<body>

<header>

  <div class="brand">
    HALIMAW BOT
  </div>

  <button
    class="logout"
    onclick="logoutDashboard()"
  >
    Logout
  </button>

</header>


<div class="container">

  <div class="warning">
    Never share your AppState/C3C publicly.
    The dashboard does not display your saved session.
  </div>


  <div class="grid">

    <div class="card">
      <h3>Messenger Status</h3>
      <div
        id="status"
        class="status"
      >
        Checking...
      </div>
    </div>


    <div class="card">
      <h3>Bot Account</h3>

      <div
        id="botName"
        class="value"
      >
        -
      </div>

      <div
        id="botUID"
        class="small"
      >
        UID: -
      </div>

    </div>


    <div class="card">
      <h3>Messages</h3>

      <div
        id="messages"
        class="value"
      >
        0
      </div>

    </div>


    <div class="card">
      <h3>Replies</h3>

      <div
        id="replies"
        class="value"
      >
        0
      </div>

    </div>


    <div class="card">
      <h3>Errors</h3>

      <div
        id="errors"
        class="value"
      >
        0
      </div>

    </div>

  </div>


  <br>


  <div class="card">

    <h3>Facebook C3C / AppState</h3>

    <div class="small">
      Paste your exported AppState JSON or cookie string below.
    </div>

    <br>

    <textarea
      id="session"
      placeholder="Paste C3C / AppState here..."
    ></textarea>

    <br>

    <button
      class="action login-btn"
      onclick="loginBot()"
    >
      Login Messenger
    </button>

    <button
      class="action stop-btn"
      onclick="logoutBot()"
    >
      Logout Messenger
    </button>

    <button
      class="action refresh-btn"
      onclick="loadStatus()"
    >
      Refresh
    </button>

    <div
      id="message"
      class="message"
    ></div>

  </div>


  <br>


  <div class="card">

    <h3>Bot Information</h3>

    <p>
      Last login:
      <strong id="lastLogin">-</strong>
    </p>

    <p>
      Last message:
      <strong id="lastMessage">-</strong>
    </p>

    <p>
      Active threads:
      <strong id="threads">0</strong>
    </p>

    <p>
      Last error:
      <strong id="lastError">None</strong>
    </p>

  </div>

</div>


<script>

const token =
  localStorage.getItem(
    "dashboardToken"
  );

if (!token) {
  location.href = "/";
}


async function apiRequest(
  url,
  options = {}
) {

  options.headers = {
    ...(options.headers || {}),
    "x-dashboard-token": token
  };

  const response =
    await fetch(
      url,
      options
    );

  const data =
    await response.json();

  if (
    response.status === 401
  ) {

    localStorage.removeItem(
      "dashboardToken"
    );

    location.href = "/";

    throw new Error(
      "Session expired."
    );

  }

  return data;
}


function showMessage(
  text
) {

  const box =
    document.getElementById(
      "message"
    );

  box.textContent =
    text;

  box.style.display =
    "block";

}


async function loadStatus() {

  try {

    const data =
      await apiRequest(
        "/api/status"
      );

    if (!data.ok) {
      return;
    }


    const status =
      document.getElementById(
        "status"
      );

    status.textContent =
      data.bot.online
        ? "ONLINE 🟢"
        : "OFFLINE 🔴";

    status.className =
      "status " +
      (
        data.bot.online
          ? "online"
          : "offline"
      );


    document.getElementById(
      "botName"
    ).textContent =
      data.bot.name || "-";


    document.getElementById(
      "botUID"
    ).textContent =
      "UID: " +
      (data.bot.uid || "-");


    document.getElementById(
      "messages"
    ).textContent =
      data.stats.messages;


    document.getElementById(
      "replies"
    ).textContent =
      data.stats.replies;


    document.getElementById(
      "errors"
    ).textContent =
      data.stats.errors;


    document.getElementById(
      "threads"
    ).textContent =
      data.stats.activeThreads;


    document.getElementById(
      "lastLogin"
    ).textContent =
      data.bot.lastLogin || "-";


    document.getElementById(
      "lastMessage"
    ).textContent =
      data.bot.lastMessage || "-";


    document.getElementById(
      "lastError"
    ).textContent =
      data.bot.lastError || "None";

  } catch (error) {

    console.error(
      error
    );

  }

}


async function loginBot() {

  const session =
    document.getElementById(
      "session"
    ).value.trim();

  if (!session) {

    showMessage(
      "Paste your C3C/AppState first."
    );

    return;
  }


  showMessage(
    "Logging into Messenger..."
  );


  try {

    const data =
      await apiRequest(
        "/api/bot/login",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            session
          })
        }
      );


    if (!data.ok) {

      showMessage(
        "❌ " +
        (
          data.error ||
          "Login failed."
        )
      );

      return;
    }


    document.getElementById(
      "session"
    ).value = "";


    showMessage(
      "✅ Login started. Refreshing status..."
    );


    setTimeout(
      loadStatus,
      2500
    );

  } catch (error) {

    showMessage(
      "❌ " +
      error.message
    );

  }

}


async function logoutBot() {

  if (
    !confirm(
      "Logout the Messenger bot?"
    )
  ) {
    return;
  }


  try {

    const data =
      await apiRequest(
        "/api/bot/logout",
        {
          method: "POST"
        }
      );


    showMessage(
      data.ok
        ? "✅ Messenger bot logged out."
        : "❌ Logout failed."
    );


    loadStatus();

  } catch (error) {

    showMessage(
      "❌ " +
      error.message
    );

  }

}


async function logoutDashboard() {

  try {

    await apiRequest(
      "/api/dashboard/logout",
      {
        method: "POST"
      }
    );

  } catch (_) {}


  localStorage.removeItem(
    "dashboardToken"
  );

  location.href = "/";

}


loadStatus();

setInterval(
  loadStatus,
  5000
);

</script>

</body>
</html>
    `);

  }
);


// ============================================================
// DASHBOARD LOGIN API
// ============================================================

app.post(
  "/api/dashboard/login",
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
        ok: false,
        error: "Invalid username or password."
      });

    }


    const token =
      createDashboardToken();

    dashboardTokens.add(
      token
    );


    res.json({
      ok: true,
      token
    });

  }
);


// ============================================================
// DASHBOARD LOGOUT API
// ============================================================

app.post(
  "/api/dashboard/logout",
  requireDashboard,
  (req, res) => {

    const token =
      req.headers[
        "x-dashboard-token"
      ];

    if (token) {
      dashboardTokens.delete(
        String(token)
      );
    }

    res.json({
      ok: true
    });

  }
);


// ============================================================
// BOT STATUS
// ============================================================

app.get(
  "/api/status",
  requireDashboard,
  (req, res) => {

    res.json({
      ok: true,

      bot: {
        online: botOnline,
        loggingIn: botLoggingIn,
        name: botName,
        uid: botUserID,
        lastLogin: lastLoginTime,
        lastMessage: lastMessageTime,
        lastError
      },

      stats: {
        messages: totalMessages,
        replies: totalReplies,
        errors: totalErrors,
        activeThreads:
          activeThreads.size,
        globalActive
      }

    });

  }
);


// ============================================================
// BOT LOGIN API
// ============================================================

app.post(
  "/api/bot/login",
  requireDashboard,
  (req, res) => {

    const session =
      req.body?.session;

    if (!session) {

      return res.status(400).json({
        ok: false,
        error: "C3C/AppState is required."
      });

    }


    if (botLoggingIn) {

      return res.status(409).json({
        ok: false,
        error: "Bot login is already in progress."
      });

    }


    try {

      loginBot(
        session
      );

      res.json({
        ok: true,
        message:
          "Facebook login started."
      });

    } catch (error) {

      botLoggingIn = false;

      res.status(400).json({
        ok: false,
        error:
          error?.message ||
          String(error)
      });

    }

  }
);


// ============================================================
// BOT LOGOUT API
// ============================================================

app.post(
  "/api/bot/logout",
  requireDashboard,
  async (req, res) => {

    try {

      await logoutBot();

      res.json({
        ok: true,
        message:
          "Messenger bot logged out."
      });

    } catch (error) {

      res.status(500).json({
        ok: false,
        error:
          error?.message ||
          String(error)
      });

    }

  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      service: "banat-messenger-dashboard",
      botOnline,
      uptime:
        process.uptime()
    });

  }
);


// ============================================================
// SERVER
// ============================================================

const server =
  http.createServer(
    app
  );

server.listen(
  PORT,
  () => {

    console.log(
      `[DASHBOARD] server running on port ${PORT}`
    );

    console.log(
      `[DASHBOARD] login: ${DASHBOARD_USERNAME}`
    );

  }
);


// ============================================================
// AUTO LOGIN SAVED SESSION
// ============================================================

setTimeout(
  () => {

    if (
      process.env.FB_COOKIES ||
      process.env.FB_APPSTATE ||
      fs.existsSync(
        SESSION_FILE
      ) ||
      fs.existsSync(
        path.join(
          process.cwd(),
          "cookies.json"
        )
      )
    ) {

      try {

        console.log(
          "[BANAT] saved Facebook session detected."
        );

        loginBot();

      } catch (error) {

        botLoggingIn = false;

        lastError =
          error?.message ||
          String(error);

        console.error(
          "[BANAT] auto-login failed:",
          lastError
        );

        console.log(
          "[BANAT] Dashboard is still available."
        );

      }

    } else {

      console.log(
        "[BANAT] No saved Facebook session."
      );

      console.log(
        "[BANAT] Login through the dashboard."
      );

    }

  },
  1000
);


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  trafficSendMessage,
  onMessage,
  handleBanatCommand,
  loginBot,
  logoutBot
};
