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

function send(api, threadID, message) {
  return new Promise(resolve => {
    try {
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

async function lockGCName(
  api,
  threadID,
  name,
  requesterID
) {
  threadID = String(threadID);
  name = String(name || "").trim();

  if (String(requesterID) !== ADMIN_UID) {
    throw new Error(
      "Hindi ka admin. Admin lamang ang puwedeng mag-lock ng GC name."
    );
  }

  if (!name) {
    throw new Error(
      "Gamitin: !lockgcname <pangalan ng GC>"
    );
  }

  if (name.length > 100) {
    throw new Error(
      "Masyadong mahaba ang GC name."
    );
  }

  if (running.has(threadID)) {
    throw new Error(
      "May GC-name operation pang tumatakbo."
    );
  }

  running.add(threadID);

  try {
    // Itakda muna ang pangalan ngayon.
    await changeThreadName(
      api,
      threadID,
      name
    );

    const data = loadData();

    const config = ensureThread(
      data,
      threadID
    );

    config.enabled = true;
    config.name = name;
    config.updatedAt = Date.now();

    saveData(data);

    console.log(
      `[GCNAME] Locked "${name}" in ${threadID}`
    );

    return {
      name,
      enabled: true
    };
  } finally {
    running.delete(threadID);
  }
}

async function unlockGCName(
  threadID,
  requesterID
) {
  threadID = String(threadID);

  if (String(requesterID) !== ADMIN_UID) {
    throw new Error(
      "Hindi ka admin."
    );
  }

  const data = loadData();
  const config = ensureThread(
    data,
    threadID
  );

  config.enabled = false;
  config.updatedAt = Date.now();

  saveData(data);

  console.log(
    `[GCNAME] Unlocked ${threadID}`
  );

  return true;
}

/*
 * Tinatawag kapag may GC-name change event.
 *
 * Hindi nito ina-activate ang lock.
 * Gumagana lamang ito sa GC na dating
 * na-lock gamit ang !lockgcname.
 */
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

  const isLock =
    /^!lockgcname(?:\s|$)/i.test(text);

  const isUnlock =
    /^!unlockgcname(?:\s|$)/i.test(text);

  const isStatus =
    /^!gcnameprotect(?:\s|$)/i.test(text);

  if (
    !isLock &&
    !isUnlock &&
    !isStatus
  ) {
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

  /*
   * !lockgcname
   */
  if (isLock) {
    const name = text
      .replace(
        /^!lockgcname\s*/i,
        ""
      )
      .trim();

    if (!name) {
      send(
        api,
        threadID,
        "Gamitin: !lockgcname <pangalan ng GC>"
      );

      return true;
    }

    send(
      api,
      threadID,
      `🔒 Ila-lock ang GC name sa "${name}".`
    );

    lockGCName(
      api,
      threadID,
      name,
      requesterID
    )
      .then(result => {
        send(
          api,
          threadID,
          [
            "🔒 GC NAME LOCKED",
            "",
            `Pangalan: ${result.name}`,
            "Proteksyon: NAKA-ON",
            "",
            "Kapag binago ang GC name, ibabalik ito ng bot."
          ].join("\n")
        );
      })
      .catch(error => {
        send(
          api,
          threadID,
          `❌ Lock failed: ${
            error?.message || error
          }`
        );
      });

    return true;
  }

  /*
   * !unlockgcname
   */
  if (isUnlock) {
    unlockGCName(
      threadID,
      requesterID
    )
      .then(() => {
        send(
          api,
          threadID,
          [
            "🔓 GC NAME LOCK OFF",
            "",
            "Hindi na ibabalik ng bot ang GC name kapag binago."
          ].join("\n")
        );
      })
      .catch(error => {
        send(
          api,
          threadID,
          `❌ Unlock failed: ${
            error?.message || error
          }`
        );
      });

    return true;
  }

  /*
   * !gcnameprotect
   */
  if (isStatus) {
    const data = loadData();
    const config = data[threadID];

    if (
      config?.enabled &&
      config?.name
    ) {
      send(
        api,
        threadID,
        [
          "🔒 GC NAME PROTECTION: ON",
          `Pangalan: ${config.name}`
        ].join("\n")
      );
    } else {
      send(
        api,
        threadID,
        "🔓 GC NAME PROTECTION: OFF"
      );
    }

    return true;
  }

  return true;
}

module.exports = {
  handleCommand,
  protectGCName,
  lockGCName,
  unlockGCName
};
