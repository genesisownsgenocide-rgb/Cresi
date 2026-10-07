"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
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

/*
 * Official admin UID.
 * Existing restriction preserved.
 */
const ADMIN_UID = "61595204307407";

/* =========================================================
   STATE
========================================================= */

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();

let globalActive = 0;
let botUserID = "";
let facebookAPI = null;
let shuttingDown = false;

/* =========================================================
   UTILITIES
========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeString(value) {
  return value == null ? "" : String(value);
}

/* =========================================================
   SESSION LOADER
========================================================= */

function readSession() {
  const raw =
    process.env.FB_COOKIES ||
    process.env.FB_APPSTATE;

  if (raw) {
    const trimmed = String(raw).trim();

    if (!trimmed) {
      throw new Error(
        "FB_COOKIES/FB_APPSTATE is empty."
      );
    }

    try {
      return JSON.parse(trimmed);
    } catch (_) {
      /*
       * Accept raw cookie string as-is.
       */
      return trimmed;
    }
  }

  const possibleFiles = [
    "appstate.json",
    "cookies.json"
  ];

  for (const file of possibleFiles) {
    const filePath = path.join(
      process.cwd(),
      file
    );

    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      const content =
        fs.readFileSync(filePath, "utf8").trim();

      if (!content) {
        continue;
      }

      return JSON.parse(content);
    } catch (error) {
      throw new Error(
        `Failed to read ${file}: ${error.message}`
      );
    }
  }

  throw new Error(
    "No Facebook session found. " +
    "Set FB_COOKIES/FB_APPSTATE or provide appstate.json locally."
  );
}

/* =========================================================
   SESSION NORMALIZER
========================================================= */

function normalizeSession(value) {
  if (typeof value === "string") {
    const cookie = value.trim();

    if (!cookie) {
      throw new Error(
        "Facebook cookie session is empty."
      );
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
      "Facebook session must be a cookie string " +
      "or a JSON array of cookie/appState entries."
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

/* =========================================================
   THREAD QUEUE
========================================================= */

function enqueue(threadID, job) {
  const key = String(threadID);

  const current =
    threadQueues.get(key) ||
    Promise.resolve();

  const next = current
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

/* =========================================================
   GLOBAL SEND LIMIT
========================================================= */

async function acquireGlobalSlot() {
  while (
    globalActive >= GLOBAL_SEND_LIMIT &&
    !shuttingDown
  ) {
    await sleep(150);
  }

  if (shuttingDown) {
    throw new Error(
      "Bot is shutting down."
    );
  }

  globalActive++;
}

function releaseGlobalSlot() {
  globalActive = Math.max(
    0,
    globalActive - 1
  );
}

/* =========================================================
   SEND ERROR DETECTION
========================================================= */

function is1545012(error) {
  const text = JSON.stringify(
    error || ""
  );

  return /1545012|temporarily unavailable|message could not be sent/i.test(
    text
  );
}

/* =========================================================
   TRAFFIC-SAFE SEND
========================================================= */

function trafficSendMessage(
  api,
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

                  const done = (
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
                        .then(info =>
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
            lastError = error;

            if (
              !is1545012(error) ||
              attempt >=
                RETRY_DELAYS.length
            ) {
              break;
            }

            const delay =
              RETRY_DELAYS[attempt];

            threadCooldown.set(
              key,
              Date.now() + delay
            );

            console.warn(
              `[BANAT] send retry ${attempt + 1}/${RETRY_DELAYS.length} ` +
              `for thread ${key} in ${delay}ms`
            );

            await sleep(delay);

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

        callback(lastError);
      } finally {
        releaseGlobalSlot();
      }
    }
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
    (resolve, reject) => {
      let settled = false;

      const done = (
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
   COMMAND DETECTION
========================================================= */

function isBanatCommand(body) {
  return /^!(?:banat|troll)(?:\s|$)/i.test(
    String(body || "").trim()
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

  const senderID =
    String(
      event.senderID || ""
    );

  const parts =
    String(body)
      .trim()
      .split(/\s+/);

  const cmd =
    (parts[0] || "")
      .toLowerCase();

  const sub =
    (parts[1] || "status")
      .toLowerCase();

  /*
   * Strict admin restriction
   * preserved.
   */
  if (cmd === "!troll") {
    if (
      senderID !== ADMIN_UID
    ) {
      sendCommandReply(
        api,
        event,
        "❌ Hoy, hindi ka admin! Tigil-tigilan mo yan."
      );

      return true;
    }

    const targetUID =
      parts[1] || "wala";

    sendCommandReply(
      api,
      event,
      `👑 Admin access granted. Na-troll ang target ID: ${targetUID}`
    );

    return true;
  }

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

    console.log(
      `[BANAT] toggled thread ${threadID}: ${
        next ? "ON" : "OFF"
      }`
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

  if (sub === "status") {
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

  if (sub === "help") {
    sendCommandReply(
      api,
      event,
      "!banat on · !banat off · !banat toggle · !banat status · !troll [uid]"
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
   BANAT REPLY
========================================================= */

async function sendBanat(
  api,
  event,
  text
) {
  return sendBanatReplyWithTyping(
    api,
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

  /*
   * Ignore own messages.
   */
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

  if (!body) {
    return;
  }

  /*
   * Handle commands first.
   */
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
    String(event.threadID);

  const active =
    activeThreads.has(
      threadID
    ) ||
    isBanatConversationModeActive(
      threadID
    );

  /*
   * Existing target classification
   * remains untouched.
   */
  const target =
    classifyBanatTarget({
      event,
      body,
      botID: botUserID
    });

  /*
   * Active conversation mode.
   */
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
      ).catch(error => {
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
   * Normal targeted response.
   */
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
        api,
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
   FACEBOOK LISTENER
========================================================= */

function start(api) {
  facebookAPI = api;

  try {
    botUserID = String(
      api.getCurrentUserID?.() || ""
    );
  } catch (_) {
    botUserID = "";
  }

  if (botUserID) {
    console.log(
      `[BANAT] logged in as UID: ${botUserID}`
    );
  } else {
    console.warn(
      "[BANAT] unable to read bot UID."
    );
  }

  if (DEFAULT_ON) {
    console.log(
      "[BANAT] BANAT_DEFAULT_ON enabled."
    );
  }

  api.listenMqtt(
    (error, event) => {
      if (shuttingDown) {
        return;
      }

      if (error) {
        console.error(
          "[BANAT] listener error:",
          error
        );

        return;
      }

      try {
        /*
         * Automatically activate threads
         * only when DEFAULT_ON is enabled.
         */
        if (
          DEFAULT_ON &&
          event?.threadID &&
          event?.senderID &&
          String(event.senderID) !==
            botUserID
        ) {
          const key =
            String(event.threadID);

          if (
            !activeThreads.has(key)
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

/* =========================================================
   LOGIN
========================================================= */

function loginBot() {
  if (shuttingDown) {
    return;
  }

  let session;

  try {
    session =
      readSession();

    const cookie =
      normalizeSession(
        session
      );

    console.log(
      "[BANAT] logging in with saved Facebook session..."
    );

    console.log(
      `[BANAT] session format: cookie string (${cookie.length} chars)`
    );

    login(
      cookie,
      (error, api) => {
        if (shuttingDown) {
          return;
        }

        if (error) {
          console.error(
            "[BANAT] login failed:",
            error
          );

          process.exitCode = 1;
          return;
        }

        if (!api) {
          console.error(
            "[BANAT] login returned no API object."
          );

          process.exitCode = 1;
          return;
        }

        start(api);
      }
    );
  } catch (error) {
    console.error(
      "[BANAT] startup/login preparation failed:",
      error.message || error
    );

    process.exitCode = 1;
  }
}

/* =========================================================
   HEALTH SERVER
========================================================= */

const healthServer =
  http.createServer(
    (req, res) => {
      const url =
        String(
          req.url || "/"
        ).split("?")[0];

      if (
        req.method !== "GET" &&
        req.method !== "HEAD"
      ) {
        res.writeHead(
          405,
          {
            "content-type":
              "application/json; charset=utf-8"
          }
        );

        res.end(
          JSON.stringify({
            ok: false,
            error: "method not allowed"
          })
        );

        return;
      }

      if (
        url === "/health" ||
        url === "/" ||
        url === "/status"
      ) {
        const payload = {
          ok: true,
          service: "banat-only",
          botOnline: Boolean(
            facebookAPI
          ),
          botUserID:
            botUserID || null,
          activeThreads:
            activeThreads.size,
          queuedThreads:
            threadQueues.size,
          globalActive,
          timestamp:
            new Date().toISOString()
        };

        res.writeHead(
          200,
          {
            "content-type":
              "application/json; charset=utf-8",
            "cache-control":
              "no-store"
          }
        );

        res.end(
          JSON.stringify(payload)
        );

        return;
      }

      res.writeHead(
        404,
        {
          "content-type":
            "application/json; charset=utf-8"
        }
      );

      res.end(
        JSON.stringify({
          ok: false,
          error: "not found"
        })
      );
    }
  );

healthServer.on(
  "error",
  error => {
    console.error(
      "[BANAT] health server error:",
      error
    );
  }
);

healthServer.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `[BANAT] health server listening on 0.0.0.0:${PORT}`
    );

    loginBot();
  }
);

/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on(
  "uncaughtException",
  error => {
    console.error(
      "[BANAT] uncaught exception:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  reason => {
    console.error(
      "[BANAT] unhandled rejection:",
      reason
    );
  }
);

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(
  signal
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `[BANAT] ${signal} received. Shutting down...`
  );

  try {
    if (
      facebookAPI &&
      typeof facebookAPI.logout ===
        "function"
    ) {
      await new Promise(resolve => {
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
            facebookAPI.logout(
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
      });
    }
  } catch (error) {
    console.error(
      "[BANAT] logout error:",
      error
    );
  }

  try {
    healthServer.close(
      () => {
        console.log(
          "[BANAT] health server closed."
        );

        process.exit(0);
      }
    );

    setTimeout(
      () => process.exit(0),
      5000
    );
  } catch (_) {
    process.exit(0);
  }
}

process.once(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.once(
  "SIGINT",
  () => shutdown("SIGINT")
);

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  trafficSendMessage,
  onMessage,
  handleBanatCommand
};
