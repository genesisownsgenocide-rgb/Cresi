"use strict";

/*
 * BANAT-ONLY MESSENGER BOT + EMBEDDED DASHBOARD (CRESI FRAMEWORK)
 * -------------------------------------------------------------
 *
 * DASHBOARD LOGIN:
 *   Username: Admin
 *   Password: sinzuontop
 *
 * DASHBOARD:
 *   /
 *   /api/login
 *   /api/logout
 *   /api/status
 *   /api/connect
 *   /api/disconnect
 *   /health (for auto-reconnect/self-ping)
 *
 * MESSENGER COMMANDS:
 *   !banat on
 *   !banat off
 *   !banat toggle
 *   !banat status
 *   !banat help
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

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


/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

/*
 * Dashboard credentials.
 */
const DASHBOARD_USERNAME = "Admin";
const DASHBOARD_PASSWORD = "sinzuontop";

/*
 * ADMIN RESTRICTION CONFIG
 * Ilagay dito ang iyong totoong Facebook User ID para ikaw lang ang pwedeng mag-kontrol.
 */
const ADMIN_IDS = [
  "ILAGAY_MO_DITO_YUNG_FB_USER_ID_MO"
];


/* BANAT SETTINGS */

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
    process.env.BANAT_THREAD_COOLDOWN_MS ||
    12000
  )
);

const RETRY_DELAYS = [
  1500,
  4000,
  8000
];


/* =========================================================
   BOT STATE
========================================================= */

let api = null;
let botUserID = "";
let botConnectedAt = 0;
let botConnecting = false;

let messageCount = 0;
let commandCount = 0;

const activeThreads = new Set();

const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();

let globalActive = 0;


/* =========================================================
   DASHBOARD SESSION STATE
========================================================= */

const dashboardSessions = new Map();

const SESSION_MAX_AGE =
  24 * 60 * 60 * 1000;


/* =========================================================
   DASHBOARD LOG BUFFER
========================================================= */

const dashboardLogs = [];

const MAX_LOGS = 150;


function addLog(message) {
  const line =
    `[${new Date().toISOString()}] ${message}`;

  dashboardLogs.push(line);

  if (
    dashboardLogs.length >
    MAX_LOGS
  ) {
    dashboardLogs.shift();
  }

  console.log(message);
}


/*
 * Keep console output visible while also
 * storing it for the dashboard.
 */

const originalConsoleLog =
  console.log;

const originalConsoleError =
  console.error;

const originalConsoleWarn =
  console.warn;


console.log = (...args) => {
  const message = args
    .map(value => {

      if (
        typeof value === "string"
      ) {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch (_) {
        return String(value);
      }

    })
    .join(" ");

  dashboardLogs.push(
    `[${new Date().toISOString()}] ${message}`
  );

  if (
    dashboardLogs.length >
    MAX_LOGS
  ) {
    dashboardLogs.shift();
  }

  originalConsoleLog(...args);
};


console.error = (...args) => {
  const message = args
    .map(value => {

      if (
        typeof value === "string"
      ) {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch (_) {
        return String(value);
      }

    })
    .join(" ");

  dashboardLogs.push(
    `[${new Date().toISOString()}] ERROR ${message}`
  );

  if (
    dashboardLogs.length >
    MAX_LOGS
  ) {
    dashboardLogs.shift();
  }

  originalConsoleError(...args);
};


console.warn = (...args) => {
  const message = args
    .map(value => {

      if (
        typeof value === "string"
      ) {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch (_) {
        return String(value);
      }

    })
    .join(" ");

  dashboardLogs.push(
    `[${new Date().toISOString()}] WARN ${message}`
  );

  if (
    dashboardLogs.length >
    MAX_LOGS
  ) {
    dashboardLogs.shift();
  }

  originalConsoleWarn(...args);
};


/* =========================================================
   UTILS
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

      return JSON.parse(
        trimmed
      );

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
    "No Facebook session found. Enter a session in the dashboard or configure FB_COOKIES/FB_APPSTATE."
  );
}


/* =========================================================
   NORMALIZE SESSION (C3C AppState Only)
========================================================= */

function normalizeSession(value) {
  if (!value) {
    throw new Error("C3C session data is empty.");
  }

  let sessionData = value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("C3C session string is empty.");
    }

    try {
      sessionData = JSON.parse(trimmed);
    } catch (error) {
      throw new Error("Invalid C3C format. Please paste a valid JSON array or object from C3C.");
    }
  }

  if (!Array.isArray(sessionData) && typeof sessionData !== "object") {
    throw new Error("C3C session must be a valid JSON array or object.");
  }

  return sessionData;
}


/* =========================================================
   QUEUE
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
   GLOBAL SEND LIMIT
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
   ERROR CHECK
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
  apiInstance,
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
          threadCooldown.get(key) ||
          0
        );


      if (
        cooldownUntil >
        now
      ) {

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
          threadLastSent.get(key) ||
          0
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
                (resolve, reject) => {

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
                        apiInstance.sendMessage(
                          message,
                          threadID,
                          done,
                          replyToMessageID
                        );

                    } else {

                      returned =
                        apiInstance.sendMessage(
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


/* =========================================================
   BANAT COMMAND CHECK
========================================================= */

function isBanatCommand(body) {

  return /^!banat(?:\s|$)/i.test(
    String(body || "").trim()
  );
}


/* =========================================================
   DIRECT COMMAND SEND
========================================================= */

function commandSendMessage(
  apiInstance,
  message,
  threadID,
  replyToMessageID = null
) {

  return new Promise(
    (resolve, reject) => {

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

          settled =
            true;


          if (err) {
            reject(err);
          } else {
            resolve(info);
          }
        };


      try {

        const returned =
          replyToMessageID
            ? apiInstance.sendMessage(
                message,
                threadID,
                done,
                replyToMessageID
              )
            : apiInstance.sendMessage(
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
  apiInstance,
  event,
  message
) {

  const threadID =
    String(event.threadID);


  commandSendMessage(
    apiInstance,
    message,
    threadID,
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
        error?.message ||
          error
      );

    });
}


/* =========================================================
   BANAT COMMAND HANDLER
========================================================= */

function handleBanatCommand(
  apiInstance,
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
      `[BANAT] activated thread ${threadID} by ${
        event.senderID ||
        "unknown"
      }`
    );


    sendCommandReply(
      apiInstance,
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
      apiInstance,
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
        next
          ? "ON"
          : "OFF"
      }`
    );


    sendCommandReply(
      apiInstance,
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
      apiInstance,
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
      apiInstance,
      event,
      "!banat on · !banat off · !banat toggle · !banat status"
    );


    return true;
  }


  sendCommandReply(
    apiInstance,
    event,
    "unknown banat command. use !banat help"
  );


  return true;
}


/* =========================================================
   BANAT SEND
========================================================= */

async function sendBanat(
  apiInstance,
  event,
  text
) {

  return sendBanatReplyWithTyping(
    apiInstance,
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
   MESSAGE HANDLER
========================================================= */

function onMessage(
  apiInstance,
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

  // =========================================================
  // ADMIN-ONLY SECURITY CHECK (Haharangin kung hindi ikaw)
  // =========================================================
  const senderID = String(event.senderID || "");
  if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(senderID)) {
    return; // Huwag pansinin ang mensahe kung hindi galing sa Admin ID mo
  }


  messageCount++;


  /*
   * BANAT COMMANDS
   */

  if (
    isBanatCommand(body)
  ) {

    commandCount++;


    handleBanatCommand(
      apiInstance,
      event,
      body
    );


    return;
  }


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
      botID:
        botUserID
    });


  /*
   * ACTIVE BANAT THREAD
   */

  if (active) {

    console.log(
      `[BANAT] active message in ${threadID} from ${
        event.senderID ||
        "unknown"
      }`
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
        apiInstance,
        event,
        reply
      )
        .catch(error => {

          console.error(
            "[BANAT] reply error:",
            error
          );

        });

    } else {

      console.warn(
        `[BANAT] no reply generated for active message in ${threadID}`
      );
    }


    return;
  }


  /*
   * TARGETED BANAT
   */

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
        apiInstance,
        event,
        reply
      )
        .catch(error => {

          console.error(
            "[BANAT]",
            error
          );

        });
    }
  }
}


/* =========================================================
   BOT START
========================================================= */

function start(
  apiInstance
) {

  api =
    apiInstance;


  try {

    botUserID =
      String(
        apiInstance.getCurrentUserID?.() ||
        ""
      );

  } catch (_) {

    botUserID = "";
  }


  botConnectedAt =
    Date.now();


  botConnecting =
    false;


  if (
    DEFAULT_ON
  ) {

    console.log(
      "[BANAT] BANAT_DEFAULT_ON enabled."
    );
  }


  apiInstance.listenMqtt(
    (error, event) => {

      if (error) {

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
          String(
            event.senderID
          ) !==
            String(
              botUserID
            )
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
          apiInstance,
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


/* =========================================================
   CONNECT BOT USING SESSION
========================================================= */

function connectBotWithSession(
  session
) {

  if (
    botConnecting
  ) {

    return Promise.reject(
      new Error(
        "Bot is already connecting."
      )
    );
  }


  botConnecting =
    true;


  let appStateData;


  try {

    appStateData =
      normalizeSession(
        session
      );

  } catch (error) {

    botConnecting =
      false;


    return Promise.reject(
      error
    );
  }


  console.log(
    `[BANAT] logging in with dashboard C3C session...`
  );


  return new Promise(
    (resolve, reject) => {

      let finished =
        false;


      function finishError(
        error
      ) {

        if (finished) {
          return;
        }


        finished =
          true;


        botConnecting =
          false;


        console.error(
          "[BANAT] login failed:",
          error?.message ||
            error
        );


        reject(error);
      }


      try {

        login(
          appStateData,
          (error, loggedApi) => {

            if (error) {

              finishError(
                error
              );

              return;
            }


            if (!loggedApi) {

              finishError(
                new Error(
                  "Facebook login returned no API object."
                )
              );

              return;
            }


            try {

              start(
                loggedApi
              );


              finished =
                true;


              botConnecting =
                false;


              resolve({
                ok: true
              });


            } catch (error) {

              finishError(
                error
              );
            }
          }
        );


      } catch (error) {

        finishError(
          error
        );
      }
    }
  );
}


/* =========================================================
   DISCONNECT BOT
========================================================= */

function disconnectBot() {

  if (!api) {

    return false;
  }


  try {

    if (
      typeof api.logout ===
      "function"
    ) {

      api.logout(
        () => {}
      );
    }

  } catch (error) {

    console.error(
      "[BANAT] logout error:",
      error
    );
  }


  api =
    null;


  botUserID =
    "";


  botConnectedAt =
    0;


  botConnecting =
    false;


  console.log(
    "[BANAT] disconnected."
  );


  return true;
}


/* =========================================================
   DASHBOARD AUTH
========================================================= */

function createDashboardSession() {

  cleanupDashboardSessions();


  const token =
    crypto
      .randomBytes(48)
      .toString("hex");


  dashboardSessions.set(
    token,
    {
      createdAt:
        Date.now()
    }
  );


  return token;
}


function cleanupDashboardSessions() {

  const now =
    Date.now();


  for (
    const [
      token,
      session
    ] of dashboardSessions
  ) {

    const createdAt =
      typeof session ===
      "object"
        ? session.createdAt
        : session;


    if (
      !createdAt ||
      now - createdAt >
        SESSION_MAX_AGE
    ) {

      dashboardSessions.delete(
        token
      );
    }
  }
}


function getCookie(
  req,
  name
) {

  const header =
    req.headers.cookie ||
    "";


  const cookies =
    header
      .split(";")
      .map(
        value =>
          value.trim()
      );


  for (
    const item of cookies
  ) {

    const index =
      item.indexOf("=");


    if (
      index === -1
    ) {
      continue;
    }


    const key =
      item.slice(
        0,
        index
      );


    const value =
      item.slice(
        index + 1
      );


    if (
      key === name
    ) {

      try {

        return decodeURIComponent(
          value
        );

      } catch (_) {

        return value;
      }
    }
  }


  return null;
}


function isDashboardAuthenticated(
  req
) {

  cleanupDashboardSessions();


  const token =
    getCookie(
      req,
      "dashboard_session"
    );


  if (!token) {
    return false;
  }


  const session =
    dashboardSessions.get(
      token
    );


  if (!session) {
    return false;
  }


  const createdAt =
    typeof session ===
    "object"
      ? session.createdAt
      : session;


  if (
    !createdAt ||
    Date.now() -
      createdAt >
      SESSION_MAX_AGE
  ) {

    dashboardSessions.delete(
      token
    );


    return false;
  }


  return true;
}


/* =========================================================
   HTTP HELPERS
========================================================= */

function sendJSON(
  res,
  status,
  data
) {

  const body =
    JSON.stringify(
      data
    );


  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store",

      "Pragma":
        "no-cache"
    }
  );


  res.end(
    body
  );
}


function readBody(
  req
) {

  return new Promise(
    (resolve, reject) => {

      let data =
        "";


      req.on(
        "data",
        chunk => {

          data +=
            chunk;


          if (
            data.length >
            2 * 1024 * 1024
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
        () => {

          resolve(
            data
          );
        }
      );


      req.on(
        "error",
        reject
      );
    }
  );
}


/* =========================================================
   LOGIN PAGE
========================================================= */

function dashboardLoginHTML() {

  return `<!DOCTYPE html>
<html>
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<meta
  name="robots"
  content="noindex,nofollow"
>

<title>Sinzu • Admin Login</title>

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

  background:
    radial-gradient(
      circle at top,
      #18202a 0%,
      #080a0d 55%,
      #030405 100%
    );

  color: #fff;

  font-family:
    Arial,
    Helvetica,
    sans-serif;
}

.login-box {
  width: min(420px, 92%);
  padding: 30px;

  border: 1px solid #30363d;
  border-radius: 18px;

  background:
    rgba(15, 18, 23, .96);

  box-shadow:
    0 25px 80px
    rgba(0,0,0,.55);
}

.logo {
  text-align: center;
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 4px;
}

.sub {
  text-align: center;
  color: #8b949e;
  font-size: 13px;
  margin:
    5px 0 28px;
}

label {
  display: block;
  color: #8b949e;
  font-size: 12px;
  margin:
    15px 0 7px;
}

input {
  width: 100%;
  padding: 13px;

  border-radius: 10px;
  border: 1px solid #30363d;
  outline: none;

  background: #0d1117;
  color: white;

  font-size: 14px;
}

input:focus {
  border-color: #58a6ff;
}

button {
  width: 100%;
  margin-top: 20px;
  padding: 13px;

  border: 0;
  border-radius: 10px;

  background: #fff;
  color: #080a0d;

  font-weight: 800;
  cursor: pointer;
}

button:hover {
  opacity: .9;
}

button:disabled {
  opacity: .6;
  cursor: wait;
}

#error {
  display: none;

  margin-top: 15px;
  padding: 11px;

  border-radius: 9px;

  background: #30151a;
  border: 1px solid #7d2735;

  color: #ff7b8b;

  font-size: 13px;
  text-align: center;
}

.footer {
  margin-top: 20px;

  text-align: center;

  color: #484f58;

  font-size: 11px;
}

</style>

</head>

<body>

<div class="login-box">

  <div class="logo">
    SINZU
  </div>

  <div class="sub">
    BANAT COMMAND CENTER
  </div>


  <form id="loginForm">

    <label>
      USERNAME
    </label>

    <input
      id="username"
      autocomplete="username"
      placeholder="Enter username"
      required
    >


    <label>
      PASSWORD
    </label>

    <input
      id="password"
      type="password"
      autocomplete="current-password"
      placeholder="Enter password"
      required
    >


    <button
      id="loginButton"
      type="submit"
    >
      LOGIN
    </button>

  </form>


  <div id="error">
    Invalid username or password.
  </div>


  <div class="footer">
    Authorized dashboard only
  </div>

</div>


<script>

const form =
  document.getElementById(
    "loginForm"
  );

const button =
  document.getElementById(
    "loginButton"
  );

const errorBox =
  document.getElementById(
    "error"
  );


form.addEventListener(
  "submit",
  async function(event) {

    event.preventDefault();


    const username =
      document
        .getElementById(
          "username"
        )
        .value
        .trim();


    const password =
      document
        .getElementById(
          "password"
        )
        .value;


    errorBox.style.display =
      "none";


    button.disabled =
      true;

    button.textContent =
      "LOGGING IN...";


    try {

      const response =
        await fetch(
          "/api/login",
          {
            method: "POST",

            credentials:
              "same-origin",

            cache:
              "no-store",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                username,
                password
              })
          }
        );


      let data;


      try {

        data =
          await response.json();

      } catch (_) {

        data = {
          ok: false,
          error:
            "Server returned an invalid response."
        };
      }


      if (
        response.ok &&
        data.ok
      ) {

        window.location.replace(
          "/"
        );

        return;
      }


      errorBox.textContent =
        data.error ||
        "Invalid username or password.";

      errorBox.style.display =
        "block";


    } catch (error) {

      errorBox.textContent =
        "Connection error. Check the deployment logs.";

      errorBox.style.display =
        "block";

    } finally {

      button.disabled =
        false;

      button.textContent =
        "LOGIN";
    }

  }
);

</script>

</body>
</html>`;
}


/* =========================================================
   MAIN DASHBOARD
========================================================= */

function dashboardHTML() {

  return `<!DOCTYPE html>
<html>
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<meta
  name="robots"
  content="noindex,nofollow"
>

<title>Sinzu • Banat Dashboard</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;

  background: #090b0f;

  color: #f0f6fc;

  font-family:
    Arial,
    Helvetica,
    sans-serif;
}

header {
  padding: 20px;

  border-bottom:
    1px solid #21262d;

  background:
    #0d1117;

  display: flex;

  justify-content:
    space-between;

  align-items:
    center;

  gap: 15px;
}

.brand {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 3px;
}

.brand span {
  display: block;

  color: #8b949e;

  font-size: 10px;

  letter-spacing: 2px;

  margin-top: 4px;
}

.logout {
  width: auto;

  margin: 0;

  padding:
    9px 15px;

  border:
    1px solid #30363d;

  background:
    #161b22;

  color: #fff;

  border-radius:
    9px;

  cursor: pointer;
}

.container {
  width:
    min(1100px, 94%);

  margin:
    25px auto;
}

.grid {
  display: grid;

  grid-template-columns:
    repeat(
      auto-fit,
      minmax(220px, 1fr)
    );

  gap: 15px;
}

.card {
  background:
    #0d1117;

  border:
    1px solid #21262d;

  border-radius:
    14px;

  padding:
    18px;

  margin-bottom:
    15px;
}

.card h2 {
  font-size:
    15px;

  margin:
    0 0 14px;
}

.stat-label {
  color:
    #8b949e;

  font-size:
    11px;

  text-transform:
    uppercase;
}

.stat {
  margin-top:
    7px;

  font-size:
    24px;

  font-weight:
    800;
}

.status-online {
  color:
    #3fb950;
}

.status-offline {
  color:
    #f85149;
}

textarea {
  width: 100%;

  min-height:
    170px;

  resize:
    vertical;

  background:
    #080b0f;

  color:
    #f0f6fc;

  border:
    1px solid #30363d;

  border-radius:
    10px;

  padding:
    13px;

  outline:
    none;

  font-family:
    monospace;
}

textarea:focus {
  border-color:
    #58a6ff;
}

.buttons {
  display:
    flex;

  gap:
    10px;

  flex-wrap:
    wrap;

  margin-top:
    12px;
}

.buttons button {
  width:
    auto;

  margin:
    0;
}

button {
  padding:
    11px 16px;

  border:
    0;

  border-radius:
    9px;

  cursor:
    pointer;

  font-weight:
    700;
}

button:disabled {
  opacity:
    .6;

  cursor:
    wait;
}

.connect {
  background:
    #238636;

  color:
    #fff;
}

.disconnect {
  background:
    #da3633;

  color:
    #fff;
}

.clear {
  background:
    #21262d;

  color:
    #fff;
}

.notice {
  color:
    #8b949e;

  font-size:
    12px;

  line-height:
    1.6;
}

.commands {
  white-space:
    pre-line;

  color:
    #c9d1d9;

  font-family:
    monospace;

  font-size:
    13px;

  line-height:
    1.8;
}

.logs {
  background:
    #05070a;

  border:
    1px solid #21262d;

  border-radius:
    10px;

  padding:
    12px;

  height:
    300px;

  overflow:
    auto;

  font-family:
    monospace;

  font-size:
    11px;

  color:
    #8b949e;

  white-space:
    pre-wrap;
}

#message {
  display:
    none;

  padding:
    11px;

  border-radius:
    9px;

  margin-bottom:
    15px;

  background:
    #101820;

  border:
    1px solid #30363d;

  color:
    #c9d1d9;
}

.small {
  color:
    #8b949e;

  font-size:
    11px;

  margin-top:
    10px;
}

</style>

</head>

<body>


<header>

  <div class="brand">

    SINZU

    <span>
      BANAT COMMAND CENTER
    </span>

  </div>


  <button
    class="logout"
    onclick="logout()"
  >
    LOGOUT
  </button>

</header>


<div class="container">


  <div id="message"></div>


  <div class="grid">


    <div class="card">

      <div class="stat-label">
        Bot Status
      </div>

      <div
        id="status"
        class="stat status-offline"
      >
        OFFLINE
      </div>

    </div>


    <div class="card">

      <div class="stat-label">
        Bot UID
      </div>

      <div
        id="uid"
        class="stat"
        style="font-size:16px"
      >
        -
      </div>

    </div>


    <div class="card">

      <div class="stat-label">
        Uptime
      </div>

      <div
        id="uptime"
        class="stat"
      >
        0s
      </div>

    </div>


    <div class="card">

      <div class="stat-label">
        Messages
      </div>

      <div
        id="messages"
        class="stat"
      >
        0
      </div>

    </div>


    <div class="card">

      <div class="stat-label">
        Commands
      </div>

      <div
        id="commands"
        class="stat"
      >
        0
      </div>

    </div>


    <div class="card">

      <div class="stat-label">
        Active Threads
      </div>

      <div
        id="threads"
        class="stat"
      >
        0
      </div>

    </div>


  </div>


  <div class="card">

    <h2>
      Facebook Session / C3C AppState
    </h2>


    <div class="notice">

      Paste your exported C3C AppState JSON data below.

    </div>


    <br>


    <textarea
      id="session"
      placeholder="Paste C3C appstate JSON here..."
      spellcheck="false"
      autocomplete="off"
    ></textarea>


    <div class="buttons">


      <button
        id="connectButton"
        class="connect"
        onclick="connectBot()"
      >
        CONNECT
      </button>


      <button
        id="disconnectButton"
        class="disconnect"
        onclick="disconnectBot()"
      >
        DISCONNECT
      </button>


      <button
        class="clear"
        onclick="clearSession()"
      >
        CLEAR
      </button>


    </div>

  </div>


  <div class="card">

    <h2>
      Messenger Commands
    </h2>


    <div class="commands">

!banat on
!banat off
!banat toggle
!banat status
!banat help

    </div>

  </div>


  <div class="card">

    <h2>
      Logs
    </h2>


    <div
      id="logs"
      class="logs"
    >
      Loading...
    </div>

  </div>


</div>


<script>

let refreshing =
  false;


function showMessage(text) {

  const box =
    document.getElementById(
      "message"
    );


  box.textContent =
    text;


  box.style.display =
    "block";


  setTimeout(
    () => {

      box.style.display =
        "none";

    },
    4000
  );
}


function formatUptime(
  seconds
) {

  seconds =
    Math.max(
      0,
      Number(
        seconds || 0
      )
    );


  const d =
    Math.floor(
      seconds / 86400
    );


  seconds %= 86400;


  const h =
    Math.floor(
      seconds / 3600
    );


  seconds %= 3600;


  const m =
    Math.floor(
      seconds / 60
    );


  const s =
    Math.floor(
      seconds % 60
    );


  if (d > 0) {

    return (
      d + "d " +
      h + "h " +
      m + "m"
    );
  }


  if (h > 0) {

    return (
      h + "h " +
      m + "m " +
      s + "s"
    );
  }


  if (m > 0) {

    return (
      m + "m " +
      s + "s"
    );
  }


  return s + "s";
}


/* =========================================================
   STATUS
========================================================= */

async function refreshStatus() {

  if (refreshing) {
    return;
  }


  refreshing =
    true;


  try {

    const response =
      await fetch(
        "/api/status",
        {
          method:
            "GET",

          credentials:
            "same-origin",

          cache:
            "no-store"
        }
      );


    if (
      response.status ===
      401
    ) {

      window.location.replace(
        "/"
      );

      return;
    }


    const data =
      await response.json();


    const status =
      document.getElementById(
        "status"
      );


    status.textContent =
      data.connected
        ? "ONLINE"
        : (
            data.connecting
              ? "CONNECTING"
              : "OFFLINE"
          );


    status.className =
      "stat " +
      (
        data.connected
          ? "status-online"
          : "status-offline"
      );


    document.getElementById(
      "uid"
    ).textContent =
      data.userID ||
      "-";


    document.getElementById(
      "uptime"
    ).textContent =
      formatUptime(
        data.uptime
      );


    document.getElementById(
      "messages"
    ).textContent =
      data.messageCount ||
      0;


    document.getElementById(
      "commands"
    ).textContent =
      data.commandCount ||
      0;


    document.getElementById(
      "threads"
    ).textContent =
      data.activeThreads ||
      0;


    const logs =
      document.getElementById(
        "logs"
      );


    logs.textContent =
      (
        data.logs ||
        []
      ).join(
        "\\n"
      );


    logs.scrollTop =
      logs.scrollHeight;


  } catch (error) {

    console.error(
      error
    );

  } finally {

    refreshing =
      false;
  }
}


/* =========================================================
   CONNECT
========================================================= */

async function connectBot() {

  const sessionInput =
    document.getElementById(
      "session"
    );


  const button =
    document.getElementById(
      "connectButton"
    );


  const session =
    sessionInput.value.trim();


  if (!session) {

    showMessage(
      "Please paste your C3C appstate JSON first."
    );

    return;
  }


  button.disabled =
    true;


  button.textContent =
    "CONNECTING...";


  showMessage(
    "Connecting..."
  );


  try {

    const response =
      await fetch(
        "/api/connect",
        {
          method:
            "POST",

          credentials:
            "same-origin",

          cache:
            "no-store",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              session
            })
        }
      );


    let data;


    try {

      data =
        await response.json();

    } catch (_) {

      data = {
        ok: false,
        error:
          "Invalid server response."
      };
    }


    if (
      !response.ok ||
      !data.ok
    ) {

      showMessage(
        data.error ||
        "Connection failed."
      );

      return;
    }


    sessionInput.value =
      "";


    showMessage(
      "Bot connected successfully."
    );


    await refreshStatus();


  } catch (error) {

    showMessage(
      "Connection error."
    );


  } finally {

    button.disabled =
      false;


    button.textContent =
      "CONNECT";
  }
}


/* =========================================================
   DISCONNECT
========================================================= */

async function disconnectBot() {

  try {

    const response =
      await fetch(
        "/api/disconnect",
        {
          method:
            "POST",

          credentials:
            "same-origin",

          cache:
            "no-store"
        }
      );


    const data =
      await response.json();


    showMessage(
      data.ok
        ? "Bot disconnected."
        : (
            data.error ||
            "Disconnect failed."
          )
    );


    await refreshStatus();


  } catch (error) {

    showMessage(
      "Disconnect error."
    );
  }
}


/* =========================================================
   CLEAR
========================================================= */

function clearSession() {

  document.getElementById(
    "session"
  ).value =
    "";


  showMessage(
    "Session field cleared."
  );
}


/* =========================================================
   LOGOUT
========================================================= */

async function logout() {

  try {

    await fetch(
      "/api/logout",
      {
        method:
          "POST",

        credentials:
          "same-origin",

        cache:
          "no-store"
      }
    );

  } catch (_) {}


  window.location.replace(
    "/"
  );
}


/* =========================================================
   INITIAL STATUS
========================================================= */

refreshStatus();


setInterval(
  refreshStatus,
  3000
);

</script>

</body>
</html>`;
}


/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${
              req.headers.host ||
              "localhost"
            }`
          );


        const pathname =
          url.pathname;


        /* =========================================
           LOGIN API
        ========================================= */

        if (
          pathname ===
            "/api/login" &&
          req.method ===
            "POST"
        ) {

          const raw =
            await readBody(
              req
            );


          let body;


          try {

            body =
              JSON.parse(
                raw || "{}"
              );

          } catch (_) {

            sendJSON(
              res,
              400,
              {
                ok:
                  false,

                error:
                  "Invalid login request."
              }
            );

            return;
          }


          const username =
            String(
              body.username ??
              ""
            ).trim();


          const password =
            String(
              body.password ??
              ""
            );


          if (
            username !==
              DASHBOARD_USERNAME ||
            password !==
              DASHBOARD_PASSWORD
          ) {

            console.log(
              `[DASHBOARD] failed login attempt for username: ${
                username ||
                "(empty)"
              }`
            );


            sendJSON(
              res,
              401,
              {
                ok:
                  false,

                error:
                  "Invalid username or password."
              }
            );

            return;
          }


          const token =
            createDashboardSession();


          const isHTTPS =
            req.headers[
              "x-forwarded-proto"
            ] ===
              "https" ||
            !!req.socket.encrypted;


          const cookieParts = [
            `dashboard_session=${encodeURIComponent(token)}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=86400"
          ];


          if (isHTTPS) {

            cookieParts.push(
              "Secure"
            );
          }


          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json; charset=utf-8",

              "Cache-Control":
                "no-store",

              "Pragma":
                "no-cache",

              "Set-Cookie":
                cookieParts.join(
                  "; "
                )
            }
          );


          res.end(
            JSON.stringify({
              ok:
                true,

              message:
                "Login successful."
            })
          );


          console.log(
            "[DASHBOARD] Admin logged in successfully."
          );


          return;
        }


        /* =========================================
           LOGOUT
        ========================================= */

        if (
          pathname ===
            "/api/logout" &&
          req.method ===
            "POST"
        ) {

          const token =
            getCookie(
              req,
              "dashboard_session"
            );


          if (token) {

            dashboardSessions.delete(
              token
            );
          }


          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json; charset=utf-8",

              "Cache-Control":
                "no-store",

              "Set-Cookie":
                "dashboard_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
            }
          );


          res.end(
            JSON.stringify({
              ok:
                true
            })
          );


          return;
        }


        /* =========================================
           DASHBOARD PAGE
        ========================================= */

        if (
          pathname === "/" ||
          pathname === "/dashboard"
        ) {

          if (
            !isDashboardAuthenticated(
              req
            )
          ) {

            res.writeHead(
              200,
              {
                "Content-Type":
                  "text/html; charset=utf-8",

                "Cache-Control":
                  "no-store",

                "Pragma":
                  "no-cache"
              }
            );


            res.end(
              dashboardLoginHTML()
            );


            return;
          }


          res.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8",

              "Cache-Control":
                "no-store",

              "Pragma":
                "no-cache"
            }
          );


          res.end(
            dashboardHTML()
          );


          return;
        }


        /* =========================================
           AUTHENTICATION FOR API
        ========================================= */

        if (
          pathname.startsWith(
            "/api/"
          )
        ) {

          if (
            !isDashboardAuthenticated(
              req
            )
          ) {

            sendJSON(
              res,
              401,
              {
                ok:
                  false,

                error:
                  "Dashboard authentication required."
              }
            );


            return;
          }
        }


        /* =========================================
           STATUS
        ========================================= */

        if (
          pathname ===
            "/api/status" &&
          req.method ===
            "GET"
        ) {

          const connected =
            !!api;


          const uptime =
            connected &&
            botConnectedAt
              ? Math.floor(
                  (
                    Date.now() -
                    botConnectedAt
                  ) /
                  1000
                )
              : 0;


          sendJSON(
            res,
            200,
            {
              ok:
                true,

              connected,

              connecting:
                botConnecting,

              userID:
                botUserID ||
                "",

              uptime,

              messageCount,

              commandCount,

              activeThreads:
                activeThreads.size,

              queueThreads:
                threadQueues.size,

              logs:
                dashboardLogs.slice(
                  -80
                )
            }
          );


          return;
        }


        /* =========================================
           CONNECT
        ========================================= */

        if (
          pathname ===
            "/api/connect" &&
          req.method ===
            "POST"
        ) {

          if (api) {

            sendJSON(
              res,
              400,
              {
                ok:
                  false,

                error:
                  "Bot is already connected. Disconnect first."
              }
            );


            return;
          }


          if (
            botConnecting
          ) {

            sendJSON(
              res,
              409,
              {
                ok:
                  false,

                error:
                  "Bot is already connecting."
              }
            );


            return;
          }


          const raw =
            await readBody(
              req
            );


          let body;


          try {

            body =
              JSON.parse(
                raw || "{}"
              );

          } catch (_) {

            sendJSON(
              res,
              400,
              {
                ok:
                  false,

                error:
                  "Invalid JSON."
              }
            );


            return;
          }


          const session =
            body.session;


          if (
            !session ||
            !String(
              session
            ).trim()
          ) {

            sendJSON(
              res,
              400,
              {
                ok:
                  false,

                error:
                  "C3C session is required."
              }
            );


            return;
          }


          try {

            await connectBotWithSession(
              session
            );


            sendJSON(
              res,
              200,
              {
                ok:
                  true,

                connected:
                  true,

                userID:
                  botUserID ||
                  ""
              }
            );


          } catch (error) {

            sendJSON(
              res,
              500,
              {
                ok:
                  false,

                error:
                  error?.message ||
                  "Facebook login failed."
              }
            );
          }


          return;
        }


        /* =========================================
           DISCONNECT
        ========================================= */

        if (
          pathname ===
            "/api/disconnect" &&
          req.method ===
            "POST"
        ) {

          const disconnected =
            disconnectBot();


          sendJSON(
            res,
            200,
            {
              ok:
                true,

              disconnected
            }
          );


          return;
        }


        /* =========================================
           HEALTH CHECK (Para sa UptimeRobot)
        ========================================= */

        if (
          pathname ===
            "/health"
        ) {

          sendJSON(
            res,
            200,
            {
              ok:
                true,

              dashboard:
                "online",

              bot:
                !!api
                  ? "connected"
                  : "disconnected"
            }
          );


          return;
        }


        /* =========================================
           NOT FOUND
        ========================================= */

        sendJSON(
          res,
          404,
          {
            ok:
              false,

            error:
              "Not found."
          }
        );


      } catch (error) {

        console.error(
          "[HTTP] server error:",
          error
        );


        if (
          !res.headersSent
        ) {

          sendJSON(
            res,
            500,
            {
              ok:
                false,

              error:
                error?.message ||
                "Internal server error."
            }
          );
        }
      }
    }
  );


/* =========================================================
   START SERVER
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `[DASHBOARD] running on port ${PORT}`
    );

    console.log(
      `[DASHBOARD] username: ${DASHBOARD_USERNAME}`
    );

    console.log(
      "[DASHBOARD] password configured."
    );
  }
);


/* =========================================================
   OPTIONAL ENV / FILE SESSION AUTO LOGIN
========================================================= */

const hasSavedSession =
  !!(
    process.env.FB_COOKIES ||
    process.env.FB_APPSTATE
  ) ||
  fs.existsSync(
    path.join(
      process.cwd(),
      "appstate.json"
    )
  ) ||
  fs.existsSync(
    path.join(
      process.cwd(),
      "cookies.json"
    )
  );


if (hasSavedSession) {

  console.log(
    "[BANAT] saved session detected; attempting automatic login..."
  );


  try {

    const savedSession =
      readSession();


    connectBotWithSession(
      savedSession
    )
      .then(() => {

        console.log(
          "[BANAT] automatic login successful."
        );

      })
      .catch(error => {

        console.error(
          "[BANAT] automatic login failed:",
          error?.message ||
            error
        );

      });


  } catch (error) {

    console.error(
      "[BANAT] saved session error:",
      error?.message ||
        error
    );
  }
}


/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  trafficSendMessage,
  onMessage,
  handleBanatCommand
};
