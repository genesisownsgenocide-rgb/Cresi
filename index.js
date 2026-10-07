"use strict";

/*
 * BANAT-ONLY MESSENGER BOT + DASHBOARD
 * ------------------------------------
 * Existing BANAT logic preserved.
 *
 * Dashboard:
 *   Username: admin
 *   Password: halimaw123
 *
 * Messenger:
 *   Paste AppState / C3C in dashboard.
 */

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

const PORT = Number(process.env.PORT || 10000);

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
    process.env.BANAT_THREAD_COOLDOWN_MS || 12000
  )
);

const RETRY_DELAYS = [
  1500,
  4000,
  8000
];

/* =========================================================
   DASHBOARD SETTINGS
========================================================= */

const DASHBOARD_USERNAME = "admin";
const DASHBOARD_PASSWORD = "halimaw123";

const SESSION_FILE = path.join(
  process.cwd(),
  "appstate.json"
);

/* =========================================================
   BANAT STATE
========================================================= */

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();

let globalActive = 0;
let botUserID = "";
let botName = "Unknown";
let botOnline = false;
let botStartedAt = null;
let lastError = null;

let totalMessages = 0;
let totalReplies = 0;
let totalErrors = 0;

const logs = [];

/* =========================================================
   EXPRESS
========================================================= */

const app = express();

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb"
  })
);

app.use(
  session({
    secret:
      process.env.DASHBOARD_SESSION_SECRET ||
      "sanzu-dashboard-session-secret",

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
   LOGGING
========================================================= */

function addLog(type, message) {
  const item = {
    time: new Date().toISOString(),
    type,
    message: String(message || "")
  };

  logs.unshift(item);

  if (logs.length > 200) {
    logs.length = 200;
  }

  console.log(
    `[${type}] ${message}`
  );
}

/* =========================================================
   SLEEP
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
  const raw =
    process.env.FB_COOKIES ||
    process.env.FB_APPSTATE;

  if (raw) {
    const trimmed =
      String(raw).trim();

    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return trimmed;
    }
  }

  for (
    const file of [
      "appstate.json",
      "cookies.json"
    ]
  ) {
    const filePath =
      path.join(
        process.cwd(),
        file
      );

    if (
      fs.existsSync(filePath)
    ) {
      return JSON.parse(
        fs.readFileSync(
          filePath,
          "utf8"
        )
      );
    }
  }

  throw new Error(
    "No Facebook session found. Paste AppState in the dashboard or set FB_COOKIES/FB_APPSTATE."
  );
}

/* =========================================================
   NORMALIZE FACEBOOK SESSION
========================================================= */

function normalizeSession(value) {
  /*
   * IMPORTANT:
   * This bot uses cookie STRING format
   * because the installed ws3-fca build
   * expects the session as a string.
   */

  if (
    typeof value === "string"
  ) {
    const cookie =
      value.trim();

    if (!cookie) {
      throw new Error(
        "Facebook cookie session is empty."
      );
    }

    /*
     * If dashboard supplied JSON
     * as a string, parse it.
     */

    try {
      const parsed =
        JSON.parse(cookie);

      if (
        Array.isArray(parsed) ||
        Array.isArray(parsed?.appState) ||
        Array.isArray(parsed?.cookies)
      ) {
        return normalizeSession(
          parsed
        );
      }
    } catch (_) {
      /*
       * Normal cookie string.
       */
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
      "Facebook session must be a cookie string or a JSON array of cookie/AppState entries."
    );
  }

  const parts =
    entries
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

/* =========================================================
   SAVE SESSION
========================================================= */

function saveSession(value) {
  try {
    const cookie =
      normalizeSession(value);

    /*
     * Save as string because this
     * version of ws3-fca expects
     * cookie-string login.
     */

    fs.writeFileSync(
      SESSION_FILE,
      JSON.stringify(
        cookie,
        null,
        2
      ),
      "utf8"
    );

    return true;
  } catch (error) {
    addLog(
      "SESSION_ERROR",
      error.message
    );

    return false;
  }
}

/* =========================================================
   LOAD SAVED SESSION
========================================================= */

function getSavedSession() {
  try {
    if (
      !fs.existsSync(
        SESSION_FILE
      )
    ) {
      return null;
    }

    const raw =
      fs.readFileSync(
        SESSION_FILE,
        "utf8"
      );

    if (!raw.trim()) {
      return null;
    }

    return JSON.parse(raw);
  } catch (error) {
    addLog(
      "SESSION_ERROR",
      `Saved AppState could not be loaded: ${error.message}`
    );

    return null;
  }
}

/* =========================================================
   ENQUEUE
========================================================= */

function enqueue(
  threadID,
  job
) {
  const key =
    String(threadID);

  const current =
    threadQueues.get(key) ||
    Promise.resolve();

  const next =
    current
      .catch(() => {})
      .then(job)
      .finally(() => {
        if (
          threadQueues.get(key) ===
          next
        ) {
          threadQueues.delete(
            key
          );
        }
      });

  threadQueues.set(
    key,
    next
  );

  return next;
}

/* =========================================================
   GLOBAL SLOT
========================================================= */

async function acquireGlobalSlot() {
  while (
    globalActive >=
    GLOBAL_SEND_LIMIT
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

/* =========================================================
   FACEBOOK ERROR
========================================================= */

function is1545012(error) {
  const text =
    JSON.stringify(
      error || ""
    );

  return /1545012|temporarily unavailable|message could not be sent/i.test(
    text
  );
}

/* =========================================================
   TRAFFIC SEND
========================================================= */

function trafficSendMessage(
  api,
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
          threadCooldown.get(
            key
          ) || 0
        );

      if (
        cooldownUntil >
        now
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
          threadLastSent.get(
            key
          ) || 0
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
        let lastError =
          null;

        for (
          let attempt = 0;
          attempt <=
          RETRY_DELAYS.length;
          attempt++
        ) {
          try {
            const result =
              await new Promise(
                (
                  resolve,
                  reject
                ) => {
                  let settled =
                    false;

                  const done =
                    (
                      err,
                      info
                    ) => {
                      if (
                        settled
                      ) {
                        return;
                      }

                      settled =
                        true;

                      err
                        ? reject(err)
                        : resolve(info);
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
                        .then(
                          info =>
                            done(
                              null,
                              info
                            )
                        )
                        .catch(
                          done
                        );
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

            totalReplies++;

            callback(
              null,
              result
            );

            return;
          } catch (error) {
            lastError =
              error;

            totalErrors++;

            if (
              !is1545012(
                error
              ) ||
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
                  RETRY_DELAYS[
                    attempt
                  ]
                )
            );

            await sleep(
              RETRY_DELAYS[
                attempt
              ]
            );

            threadCooldown.delete(
              key
            );
          }
        }

        if (
          is1545012(
            lastError
          )
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

/* =========================================================
   BANAT COMMAND
========================================================= */

function isBanatCommand(body) {
  return /^!banat(?:\s|$)/i.test(
    String(body || "").trim()
  );
}

/* =========================================================
   COMMAND SEND
========================================================= */

function commandSendMessage(
  api,
  message,
  threadID,
  replyToMessageID = null
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      let settled =
        false;

      const done =
        (
          err,
          info
        ) => {
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
            .then(
              info =>
                done(
                  null,
                  info
                )
            )
            .catch(done);
        }
      } catch (error) {
        done(error);
      }
    }
  );
}

/* =========================================================
   COMMAND REPLY
========================================================= */

function sendCommandReply(
  api,
  event,
  message
) {
  const threadID =
    String(event.threadID);

  commandSendMessage(
    api,
    message,
    threadID,
    event.messageID ||
      null
  )
    .then(() =>
      console.log(
        `[BANAT] command reply sent: ${message}`
      )
    )
    .catch(error =>
      console.error(
        "[BANAT] command reply failed:",
        error?.message ||
          error
      )
    );
}

/* =========================================================
   BANAT COMMAND HANDLER
========================================================= */

function handleBanatCommand(
  api,
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
      `[BANAT] toggled thread ${threadID}: ${next ? "ON" : "OFF"}`
    );

    sendCommandReply(
      api,
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
      api,
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
      api,
      event,
      "!banat on · !banat off · !banat toggle · !banat status"
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

/* =========================================================
   SEND BANAT
========================================================= */

async function sendBanat(
  api,
  event,
  text
) {
  return sendBanatReplyWithTyping(
    api,
    text,
    String(
      event.threadID
    ),
    event.messageID ||
      null,
    {
      trafficSendMessage,
      incomingText:
        event.body || ""
    }
  );
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

function onMessage(
  api,
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
    String(
      event.senderID
    ) ===
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

  const threadID =
    String(
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
      botID:
        botUserID
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
        api,
        event,
        reply
      ).catch(error =>
        console.error(
          "[BANAT] reply error:",
          error
        )
      );
    } else {
      console.warn(
        `[BANAT] no reply generated for active message in ${threadID}`
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

/* =========================================================
   GET BOT ACCOUNT INFO
========================================================= */

function getBotAccountInfo(
  api
) {
  return new Promise(
    resolve => {
      try {
        const uid =
          String(
            api.getCurrentUserID?.() ||
              ""
          );

        if (!uid) {
          resolve({
            uid: "",
            name: "Unknown"
          });

          return;
        }

        if (
          typeof api.getUserInfo !==
          "function"
        ) {
          resolve({
            uid,
            name: "Messenger Bot"
          });

          return;
        }

        api.getUserInfo(
          uid,
          (
            error,
            info
          ) => {
            if (
              error ||
              !info
            ) {
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
                info[uid]
                  ?.firstName ||
                "Messenger Bot"
            });
          }
        );
      } catch (_) {
        resolve({
          uid: "",
          name: "Unknown"
        });
      }
    }
  );
}

/* =========================================================
   START BOT
========================================================= */

function start(
  api
) {
  try {
    botUserID =
      String(
        api.getCurrentUserID?.() ||
          ""
      );
  } catch (_) {
    botUserID = "";
  }

  botOnline = true;
  botStartedAt =
    Date.now();
  lastError = null;

  getBotAccountInfo(
    api
  ).then(info => {
    botUserID =
      info.uid ||
      botUserID;

    botName =
      info.name ||
      "Messenger Bot";

    addLog(
      "ONLINE",
      `${botName} (${botUserID || "unknown"})`
    );
  });

  if (
    DEFAULT_ON
  ) {
    console.log(
      "[BANAT] BANAT_DEFAULT_ON enabled."
    );
  }

  api.listenMqtt(
    (
      error,
      event
    ) => {
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
        if (
          DEFAULT_ON &&
          event?.threadID &&
          event?.senderID &&
          String(
            event.senderID
          ) !==
            String(botUserID)
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
    `[BANAT] online${botUserID ? ` as ${botUserID}` : ""}`
  );
}

/* =========================================================
   LOGIN
========================================================= */

function loginWithSession(
  sessionValue
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      let cookie;

      try {
        cookie =
          normalizeSession(
            sessionValue
          );
      } catch (error) {
        reject(error);
        return;
      }

      console.log(
        "[BANAT] logging in with cookie-string session..."
      );

      /*
       * IMPORTANT:
       *
       * This intentionally uses:
       *
       * login(cookie, callback)
       *
       * instead of:
       *
       * login({ appState: [...] }, ...)
       *
       * because your installed ws3-fca
       * build expects a string and calls
       * .split() internally.
       */

      try {
        login(
          cookie,
          (
            error,
            loggedApi
          ) => {
            if (error) {
              reject(error);
              return;
            }

            if (!loggedApi) {
              reject(
                new Error(
                  "Messenger login returned no API."
                )
              );

              return;
            }

            resolve(
              loggedApi
            );
          }
        );
      } catch (error) {
        reject(error);
      }
    }
  );
}

/* =========================================================
   LOGIN BOT
========================================================= */

async function loginBot(
  sessionValue
) {
  const cookie =
    normalizeSession(
      sessionValue
    );

  /*
   * Save successful-format
   * session before login.
   */

  saveSession(
    cookie
  );

  /*
   * Reset old bot state.
   */

  botOnline = false;
  api = null;

  addLog(
    "LOGIN",
    "Starting Messenger login..."
  );

  const loggedApi =
    await loginWithSession(
      cookie
    );

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
   AUTH
========================================================= */

function requireDashboardAuth(
  req,
  res,
  next
) {
  if (
    req.session &&
    req.session.dashboardAuth
  ) {
    next();
    return;
  }

  res.status(401).json({
    ok: false,
    error: "Unauthorized"
  });
}

/* =========================================================
   DASHBOARD LOGIN PAGE
========================================================= */

const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>SANZU AI - Login</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: Arial, sans-serif;
  background:
    linear-gradient(
      135deg,
      #f4f7fb,
      #e9eef5
    );
  display: flex;
  justify-content: center;
  align-items: center;
  color: #111827;
}

.login-box {
  width: 92%;
  max-width: 410px;
  background: #ffffff;
  border-radius: 18px;
  padding: 34px;
  box-shadow:
    0 20px 60px
    rgba(15,23,42,.12);
}

.logo {
  text-align: center;
  font-size: 27px;
  font-weight: 800;
  letter-spacing: 3px;
}

.subtitle {
  text-align: center;
  color: #64748b;
  margin-top: 8px;
  margin-bottom: 28px;
}

label {
  display: block;
  margin-top: 15px;
  margin-bottom: 7px;
  font-size: 13px;
  font-weight: 700;
}

input {
  width: 100%;
  padding: 13px 14px;
  border: 1px solid #d7dee8;
  border-radius: 10px;
  outline: none;
  font-size: 14px;
}

input:focus {
  border-color: #2563eb;
}

button {
  width: 100%;
  border: 0;
  border-radius: 10px;
  padding: 13px;
  margin-top: 20px;
  background: #2563eb;
  color: white;
  font-weight: 700;
  cursor: pointer;
}

button:hover {
  background: #1d4ed8;
}

#error {
  margin-top: 15px;
  color: #dc2626;
  text-align: center;
  font-size: 13px;
}

</style>

</head>

<body>

<div class="login-box">

<div class="logo">
SANZU AI
</div>

<div class="subtitle">
COMMAND CENTER
</div>

<form id="loginForm">

<label>
Username
</label>

<input
  id="username"
  type="text"
  autocomplete="username"
  required
>

<label>
Password
</label>

<input
  id="password"
  type="password"
  autocomplete="current-password"
  required
>

<button type="submit">
LOGIN
</button>

</form>

<div id="error"></div>

</div>

<script>

document
  .getElementById("loginForm")
  .addEventListener(
    "submit",
    async function(e) {

      e.preventDefault();

      const errorBox =
        document.getElementById(
          "error"
        );

      errorBox.textContent =
        "Logging in...";

      try {

        const response =
          await fetch(
            "/api/dashboard/login",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
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

        if (!data.ok) {
          errorBox.textContent =
            data.error ||
            "Login failed.";

          return;
        }

        location.href =
          "/dashboard";

      } catch (error) {

        errorBox.textContent =
          error.message;

      }

    }
  );

</script>

</body>
</html>
`;

/* =========================================================
   DASHBOARD
========================================================= */

const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>SANZU AI Dashboard</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #f4f7fb;
  color: #172033;
}

.header {
  background: white;
  border-bottom: 1px solid #e1e7ef;
  padding: 17px 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.brand {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 2px;
}

.logout {
  border: 0;
  background: #fee2e2;
  color: #b91c1c;
  padding: 9px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 700;
}

.container {
  width: 94%;
  max-width: 1100px;
  margin: 25px auto;
}

.card {
  background: white;
  border: 1px solid #e1e7ef;
  border-radius: 15px;
  padding: 22px;
  margin-bottom: 18px;
  box-shadow:
    0 5px 20px
    rgba(15,23,42,.04);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 13px;
  border-radius: 999px;
  font-weight: 800;
  font-size: 13px;
}

.online {
  background: #dcfce7;
  color: #15803d;
}

.offline {
  background: #fee2e2;
  color: #b91c1c;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(
      auto-fit,
      minmax(190px, 1fr)
    );
  gap: 14px;
  margin-bottom: 18px;
}

.stat {
  background: white;
  border: 1px solid #e1e7ef;
  border-radius: 14px;
  padding: 18px;
}

.label {
  color: #718096;
  font-size: 12px;
  text-transform: uppercase;
  font-weight: 700;
}

.value {
  margin-top: 8px;
  font-size: 19px;
  font-weight: 800;
  word-break: break-word;
}

textarea {
  width: 100%;
  min-height: 210px;
  resize: vertical;
  border: 1px solid #d5dce7;
  border-radius: 10px;
  padding: 13px;
  font-family: monospace;
  outline: none;
}

textarea:focus {
  border-color: #2563eb;
}

button.action {
  border: 0;
  border-radius: 9px;
  padding: 11px 17px;
  margin-top: 12px;
  cursor: pointer;
  font-weight: 800;
}

.loginbot {
  background: #2563eb;
  color: white;
}

.logoutbot {
  background: #fee2e2;
  color: #b91c1c;
}

.result {
  margin-top: 12px;
  color: #475569;
}

pre {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 13px;
  max-height: 350px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}

small {
  color: #718096;
}

</style>

</head>

<body>

<div class="header">

<div class="brand">
SANZU AI COMMAND CENTER
</div>

<button
  class="logout"
  onclick="dashboardLogout()"
>
LOGOUT
</button>

</div>

<div class="container">

<div class="card">

<div
  id="status"
  class="status offline"
>
🔴 OFFLINE
</div>

<h2>
Messenger Bot
</h2>

<p>
Control your Messenger bot from this dashboard.
</p>

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
Messenger UID
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
  id="totalMessages"
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
  id="totalReplies"
>
0
</div>

</div>

</div>

<div class="card">

<h2>
Messenger Login
</h2>

<p>
<small>
Paste your AppState/C3C JSON or cookie string below.
</small>
</p>

<textarea
  id="appState"
  placeholder='[{"key":"c_user","value":"..."},{"key":"xs","value":"..."}]'
></textarea>

<br>

<button
  class="action loginbot"
  onclick="loginBot()"
>
LOGIN BOT
</button>

<button
  class="action logoutbot"
  onclick="logoutBot()"
>
LOGOUT BOT
</button>

<div
  class="result"
  id="result"
></div>

</div>

<div class="card">

<h2>
System Logs
</h2>

<pre id="logs">
Loading...
</pre>

</div>

</div>

<script>

async function loadStatus() {

  try {

    const response =
      await fetch(
        "/api/status"
      );

    if (
      response.status === 401
    ) {
      location.href = "/";
      return;
    }

    const data =
      await response.json();

    const status =
      document.getElementById(
        "status"
      );

    if (data.online) {

      status.textContent =
        "🟢 ONLINE";

      status.className =
        "status online";

    } else {

      status.textContent =
        "🔴 OFFLINE";

      status.className =
        "status offline";

    }

    document.getElementById(
      "botName"
    ).textContent =
      data.botName ||
      "Unknown";

    document.getElementById(
      "botUID"
    ).textContent =
      data.botUID ||
      "-";

    document.getElementById(
      "totalMessages"
    ).textContent =
      data.totalMessages ||
      0;

    document.getElementById(
      "totalReplies"
    ).textContent =
      data.totalReplies ||
      0;

    document.getElementById(
      "logs"
    ).textContent =
      (data.logs || [])
        .map(item =>
          "[" +
          item.time +
          "] [" +
          item.type +
          "] " +
          item.message
        )
        .join("\\n");

  } catch (error) {

    console.error(error);

  }

}

/* =====================================================
   BOT LOGIN
===================================================== */

async function loginBot() {

  const result =
    document.getElementById(
      "result"
    );

  const appState =
    document.getElementById(
      "appState"
    ).value.trim();

  if (!appState) {

    result.textContent =
      "Paste AppState/C3C first.";

    return;
  }

  result.textContent =
    "Logging Messenger bot in...";

  try {

    const response =
      await fetch(
        "/api/bot/login",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              appState
            })
        }
      );

    const data =
      await response.json();

    if (!data.ok) {

      result.textContent =
        "❌ " +
        (
          data.error ||
          "Login failed."
        );

      return;
    }

    result.textContent =
      "✅ Messenger bot is online.";

    loadStatus();

  } catch (error) {

    result.textContent =
      "❌ " +
      error.message;

  }

}

/* =====================================================
   BOT LOGOUT
===================================================== */

async function logoutBot() {

  try {

    const response =
      await fetch(
        "/api/bot/logout",
        {
          method: "POST"
        }
      );

    const data =
      await response.json();

    document.getElementById(
      "result"
    ).textContent =
      data.ok
        ? "Bot logged out."
        : (
          data.error ||
          "Logout failed."
        );

    loadStatus();

  } catch (error) {

    document.getElementById(
      "result"
    ).textContent =
      error.message;

  }

}

/* =====================================================
   DASHBOARD LOGOUT
===================================================== */

async function dashboardLogout() {

  await fetch(
    "/api/dashboard/logout",
    {
      method: "POST"
    }
  );

  location.href = "/";

}

/* =====================================================
   AUTO REFRESH
===================================================== */

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
   DASHBOARD ROUTES
========================================================= */

app.get(
  "/",
  (req, res) => {
    if (
      req.session &&
      req.session.dashboardAuth
    ) {
      res.redirect(
        "/dashboard"
      );

      return;
    }

    res.send(
      LOGIN_HTML
    );
  }
);

app.post(
  "/api/dashboard/login",
  (req, res) => {
    const username =
      String(
        req.body?.username ||
          ""
      );

    const password =
      String(
        req.body?.password ||
          ""
      );

    if (
      username !==
        DASHBOARD_USERNAME ||
      password !==
        DASHBOARD_PASSWORD
    ) {
      res.status(401).json({
        ok: false,
        error:
          "Invalid dashboard username or password."
      });

      return;
    }

    req.session.dashboardAuth =
      true;

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/dashboard/logout",
  (
    req,
    res
  ) => {
    req.session.destroy(
      () => {
        res.json({
          ok: true
        });
      }
    );
  }
);

app.get(
  "/dashboard",
  requireDashboardAuth,
  (
    req,
    res
  ) => {
    res.send(
      DASHBOARD_HTML
    );
  }
);

/* =========================================================
   STATUS API
========================================================= */

app.get(
  "/api/status",
  requireDashboardAuth,
  (
    req,
    res
  ) => {
    res.json({
      ok: true,

      online:
        botOnline,

      botName:
        botName,

      botUID:
        botUserID,

      botStartedAt:
        botStartedAt,

      lastError:
        lastError,

      totalMessages:
        totalMessages,

      totalReplies:
        totalReplies,

      totalErrors:
        totalErrors,

      activeThreads:
        activeThreads.size,

      logs:
        logs.slice(
          0,
          100
        )
    });
  }
);

/* =========================================================
   BOT LOGIN API
========================================================= */

app.post(
  "/api/bot/login",
  requireDashboardAuth,
  async (
    req,
    res
  ) => {
    try {
      const input =
        req.body?.appState;

      if (!input) {
        res.status(400).json({
          ok: false,
          error:
            "AppState/C3C is required."
        });

        return;
      }

      await loginBot(
        input
      );

      res.json({
        ok: true,
        online:
          botOnline,

        botName:
          botName,

        botUID:
          botUserID
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
        error:
          lastError
      });
    }
  }
);

/* =========================================================
   BOT LOGOUT API
========================================================= */

app.post(
  "/api/bot/logout",
  requireDashboardAuth,
  (
    req,
    res
  ) => {
    try {
      /*
       * ws3-fca may expose logout.
       */

      if (
        globalThis.api &&
        typeof globalThis.api.logout ===
          "function"
      ) {
        globalThis.api.logout();
      }
    } catch (_) {}

    botOnline = false;
    botUserID = "";
    botName = "Unknown";

    addLog(
      "BOT",
      "Messenger bot logged out."
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  (
    req,
    res
  ) => {
    res.status(200).json({
      ok: true,
      service:
        "banat-dashboard",
      botOnline:
        botOnline,
      uptime:
        process.uptime()
    });
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (
    req,
    res
  ) => {
    res.status(404).json({
      ok: false,
      error:
        "Not found"
    });
  }
);

/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    app
  );

server.listen(
  PORT,
  () => {
    console.log(
      "========================================"
    );

    console.log(
      "      SANZU AI BANAT COMMAND CENTER"
    );

    console.log(
      "========================================"
    );

    console.log(
      `Dashboard running on port ${PORT}`
    );

    console.log(
      `Dashboard username: ${DASHBOARD_USERNAME}`
    );

    console.log(
      "Dashboard password: halimaw123"
    );

    console.log(
      "========================================"
    );

    /*
     * Auto-login from appstate.json
     */

    const saved =
      getSavedSession();

    if (saved) {
      addLog(
        "LOGIN",
        "Saved AppState detected. Attempting automatic login..."
      );

      loginBot(
        saved
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
        "No saved session. Login from dashboard."
      );
    }
  }
);

/* =========================================================
   PROCESS ERRORS
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

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  trafficSendMessage,
  onMessage,
  handleBanatCommand
};
