"use strict";

/*
 * BANAT-ONLY MESSENGER BOT + EMBEDDED DASHBOARD (CRESI FRAMEWORK)
 * -------------------------------------------------------------
 *
 * DASHBOARD LOGIN:
 *   Username: Admin
 *   Password: sinzuontop
 *
 * MESSENGER COMMANDS (Admin Only):
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

const DASHBOARD_USERNAME = "Admin";
const DASHBOARD_PASSWORD = "sinzuontop";

/*
 * ADMIN RESTRICTION CONFIG (Ikaw lang ang pwedeng mag-control ng commands)
 */
const ADMIN_IDS = [
  "61595204307407"
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
   MESSAGE HANDLER (Commands = Admin Only | Banat Replies = All in Active Thread)
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


  const senderID = String(event.senderID || "");

  messageCount++;


  /*
   * 1. BANAT COMMANDS (IKAW LANG ANG PWEDE)
   */

  if (
    isBanatCommand(body)
  ) {

    // Kung hindi ikaw ang nag-command, huwag pansinin
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(senderID)) {
      return;
    }

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
   * 2. ACTIVE BANAT THREAD (PWEDE NA ANG LAHAT NG TAO SA GC NA ITO)
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
   DASHBOARD AUTH & PAGES
========================================================= */

function createDashboardSession() {
  cleanupDashboardSessions();
  const token = crypto.randomBytes(48).toString("hex");
  dashboardSessions.set(token, { createdAt: Date.now() });
  return token;
}

function cleanupDashboardSessions() {
  const now = Date.now();
  for (const [token, session] of dashboardSessions) {
    const createdAt = typeof session === "object" ? session.createdAt : session;
    if (!createdAt || now - createdAt > SESSION_MAX_AGE) dashboardSessions.delete(token);
  }
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const cookies = header.split(";").map(v => v.trim());
  for (const item of cookies) {
    const index = item.indexOf("=");
    if (index === -1) continue;
    if (item.slice(0, index) === name) {
      try { return decodeURIComponent(item.slice(index + 1)); } catch (_) { return item.slice(index + 1); }
    }
  }
  return null;
}

function isDashboardAuthenticated(req) {
  cleanupDashboardSessions();
  const token = getCookie(req, "dashboard_session");
  if (!token) return false;
  const session = dashboardSessions.get(token);
  if (!session) return false;
  return true;
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) { reject(new Error("Request body too large.")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function dashboardLoginHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Login</title></head><body style="background:#080a0d;color:#fff;font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;"><form id="f" style="background:#0f1217;padding:30px;border-radius:12px;border:1px solid #30363d;"><h2 style="text-align:center">SINZU ADMIN</h2><input id="u" placeholder="Username" style="width:100%;padding:10px;margin-bottom:10px;background:#0d1117;color:#fff;border:1px solid #30363d;"><input id="p" type="password" placeholder="Password" style="width:100%;padding:10px;margin-bottom:15px;background:#0d1117;color:#fff;border:1px solid #30363d;"><button type="submit" style="width:100%;padding:10px;background:#fff;font-weight:bold;">LOGIN</button></form><script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();let res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});let d=await res.json();if(d.ok)location.replace('/');else alert(d.error);};</script></body></html>`;
}

function dashboardHTML() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dashboard</title></head><body style="background:#090b0f;color:#f0f6fc;font-family:Arial;padding:40px;"><h1>Sinzu Dashboard</h1><p>Bot Status: <span id="st" style="font-weight:bold;">Checking...</span></p><button onclick="fetch('/api/disconnect',{method:'POST'}).then(()=>location.reload())" style="padding:10px;background:#da3633;color:#fff;border:0;border-radius:6px;cursor:pointer;">DISCONNECT</button><script>setInterval(async()=>{let r=await fetch('/api/status');let d=await r.json();document.getElementById('st').textContent=d.connected?'ONLINE':'OFFLINE';},3000);</script></body></html>`;
}


/* =========================================================
   HTTP SERVER & HEALTH CHECK ENDPOINT
========================================================= */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/api/login" && req.method === "POST") {
      const raw = await readBody(req);
      const body = JSON.parse(raw || "{}");
      if (body.username !== DASHBOARD_USERNAME || body.password !== DASHBOARD_PASSWORD) {
        sendJSON(res, 401, { ok: false, error: "Invalid credentials." });
        return;
      }
      const token = createDashboardSession();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `dashboard_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/" || pathname === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(isDashboardAuthenticated(req) ? dashboardHTML() : dashboardLoginHTML());
      return;
    }

    if (pathname === "/api/status" && req.method === "GET") {
      sendJSON(res, 200, {
        ok: true,
        connected: !!api,
        userID: botUserID || "",
        uptime: botConnectedAt ? Math.floor((Date.now() - botConnectedAt) / 1000) : 0
      });
      return;
    }

    if (pathname === "/api/disconnect" && req.method === "POST") {
      disconnectBot();
      sendJSON(res, 200, { ok: true });
      return;
    }

    // Health check endpoint para sa watchdog / UptimeRobot
    if (pathname === "/health") {
      sendJSON(res, 200, {
        ok: true,
        status: "alive",
        bot: !!api ? "connected" : "disconnected"
      });
      return;
    }

    sendJSON(res, 404, { ok: false, error: "Not found." });

  } catch (error) {
    sendJSON(res, 500, { ok: false, error: error?.message || "Internal error." });
  }
});


server.listen(PORT, "0.0.0.0", () => {
  console.log(`[DASHBOARD] running on port ${PORT}`);
});

module.exports = { trafficSendMessage, onMessage, handleBanatCommand };
