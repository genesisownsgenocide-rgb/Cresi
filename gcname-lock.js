"use strict";

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(
  process.cwd(),
  "gcname-protection.json"
);

const ADMIN_UID = "61595204307407";

// Hintayan bago ibalik ang pangalan kapag may pagbabago.
const RESTORE_DELAY = 1800;

// Iwas paulit-ulit na restore sa parehong GC.
const RESTORE_COOLDOWN = 8000;

const running = new Set();
const lastRestore = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return {};
    }

    return JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8") || "{}"
    );
  } catch (error) {
    console.error(
      "[GCNAME] Database load failed:",
      error?.message || error
    );

    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function ensureThread(data, threadID) {
  const id = String(threadID);

  if (!data[id]) {
    data[id] = {
      enabled: false,
      name: "",
      updatedAt: null
    };
  }

  return data[id];
}

function send(api, threadID, message, reactionEmoji = null) {
  return new Promise(resolve => {
    try {
      if (reactionEmoji) {
        api.setMessageReaction(reactionEmoji, threadID, () => {}, true);
      }
      api.sendMessage(
        message,
        threadID,
        () => resolve()
      );
    } catch (_) {
      resolve();
    }
  });
}

function changeThreadName(
  api,
  threadID,
  name
) {
  return new Promise((resolve, reject) => {
    try {
      if (
        !api.changeThreadName ||
        typeof api.changeThreadName !== "function"
      ) {
        reject(
          new Error(
            "Ang ws3-fca session na ito ay walang changeThreadName."
          )
        );
        return;
      }

      api.changeThreadName(
        name,
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

async function protectGCName(
  api,
  event
) {
  if (!event?.threadID) {
    return false;
  }

  const threadID = String(event.threadID);

  const data = loadData();
  const config = data[threadID];

  if (
    !config ||
    config.enabled !== true ||
    !config.name
  ) {
    return false;
  }

  const now = Date.now();
  const last =
    Number(lastRestore.get(threadID) || 0);

  if (
    now - last <
    RESTORE_COOLDOWN
  ) {
    return false;
  }

  if (running.has(threadID)) {
    return false;
  }

  running.add(threadID);
  lastRestore.set(threadID, now);

  try {
    await sleep(RESTORE_DELAY);

    await changeThreadName(
      api,
      threadID,
      config.name
    );

    console.log(
      `[GCNAME] Restored locked name "${config.name}" in ${threadID}`
    );

    return true;
  } catch (error) {
    console.error(
      "[GCNAME] Restore failed:",
      error?.message || error
    );

    return false;
  } finally {
    running.delete(threadID);
  }
}

function handleCommand(
  api,
  event,
  body
) {
  const text = String(body || "").trim();

  if (!/^\.lockgcname(?:\s|$)/i.test(text)) {
    return false;
  }

  const requesterID = String(
    event.senderID || ""
  );

  const threadID = String(
    event.threadID || ""
  );

  if (requesterID !== ADMIN_UID) {
    send(
      api,
      threadID,
      "❌ Admin lamang ang puwedeng gumamit nito."
    );

    return true;
  }

  const name = text
    .replace(/^\.lockgcname\s*/i, "")
    .trim();

  const data = loadData();
  const config = ensureThread(data, threadID);

  // Kapag `.lockgcname` lang walang kasunod -> OFF (Unlock)
  if (!name) {
    config.enabled = false;
    config.updatedAt = Date.now();
    saveData(data);

    send(
      api,
      threadID,
      "🔓 GC Name protection OFF.",
      "💤"
    );

    return true;
  }

  if (name.length > 100) {
    send(api, threadID, "❌ Masyadong mahaba ang GC name.");
    return true;
  }

  if (running.has(threadID)) {
    send(api, threadID, "❌ May operation pang tumatakbo sa GC na ito.");
    return true;
  }

  running.add(threadID);

  send(
    api,
    threadID,
    `🔒 Ila-lock ang GC name sa "${name}".`,
    "❤️"
  );

  changeThreadName(api, threadID, name)
    .then(() => {
      config.enabled = true;
      config.name = name;
      config.updatedAt = Date.now();
      saveData(data);

      send(
        api,
        threadID,
        `🔒 GC Name Locked: "${name}"\nProteksyon: NAKA-ON`
      );
    })
    .catch(error => {
      send(
        api,
        threadID,
        `❌ Lock failed: ${error?.message || error}`
      );
    })
    .finally(() => {
      running.delete(threadID);
    });

  return true;
}

module.exports = {
  handleCommand,
  protectGCName
};
