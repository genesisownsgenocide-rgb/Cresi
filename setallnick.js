"use strict";

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(
  process.cwd(),
  "nickname-protection.json"
);

const ADMIN_UID = "61595204307407";

// Delay bawat nickname change para hindi ma-spam ang Facebook API.
const CHANGE_DELAY = 2500;

let running = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (error) {
    console.error(
      "[NICKNAME] Failed loading database:",
      error.message
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

function getThreadData(threadID) {
  const data = loadData();
  const key = String(threadID);

  if (!data[key]) {
    data[key] = {
      enabled: false,
      nickname: "",
      members: {},
      updatedAt: null
    };
  }

  return data;
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

function changeNickname(
  api,
  nickname,
  threadID,
  userID
) {
  return new Promise((resolve, reject) => {
    try {
      api.changeNickname(
        nickname,
        threadID,
        userID,
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

function getThreadInfo(api, threadID) {
  return new Promise((resolve, reject) => {
    try {
      api.getThreadInfo(
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

async function getMembers(api, threadID) {
  const info = await getThreadInfo(api, threadID);

  if (!info || !Array.isArray(info.participantIDs)) {
    throw new Error(
      "Hindi makuha ang listahan ng members ng GC."
    );
  }

  return info;
}

function extractNicknames(info) {
  return (
    info.nicknames ||
    info.nickNames ||
    {}
  );
}

async function backupOriginalNicknames(
  api,
  threadID,
  info
) {
  const data = getThreadData(threadID);
  const key = String(threadID);

  const nicknames = extractNicknames(info);

  if (!data[key].members) {
    data[key].members = {};
  }

  for (const uid of info.participantIDs || []) {
    const id = String(uid);

    if (
      Object.prototype.hasOwnProperty.call(
        data[key].members,
        id
      )
    ) {
      continue;
    }

    const original =
      nicknames[id] == null
        ? null
        : String(nicknames[id]);

    data[key].members[id] = {
      original,
      savedAt: Date.now()
    };
  }

  saveData(data);
}

async function setAllNicknames(
  api,
  threadID,
  nickname,
  requesterID
) {
  threadID = String(threadID);
  nickname = String(nickname || "").trim();

  if (String(requesterID) !== ADMIN_UID) {
    throw new Error(
      "Hindi ka admin. Hindi mo puwedeng gamitin ang setallnick."
    );
  }

  if (!nickname) {
    throw new Error(
      "Gamitin: .setallnick <nickname>"
    );
  }

  if (nickname.length > 100) {
    throw new Error(
      "Masyadong mahaba ang nickname."
    );
  }

  if (running.has(threadID)) {
    throw new Error(
      "May nickname operation pang tumatakbo sa GC na ito."
    );
  }

  running.add(threadID);

  try {
    const info = await getMembers(
      api,
      threadID
    );

    await backupOriginalNicknames(
      api,
      threadID,
      info
    );

    const data = getThreadData(threadID);

    data[threadID].enabled = true;
    data[threadID].nickname = nickname;
    data[threadID].updatedAt = Date.now();

    saveData(data);

    let success = 0;
    let failed = 0;

    for (const uid of info.participantIDs) {
      const id = String(uid);

      let botID = "";

      try {
        botID = String(
          api.getCurrentUserID?.() || ""
        );
      } catch (_) {}

      if (botID && id === botID) {
        continue;
      }

      try {
        await changeNickname(
          api,
          nickname,
          threadID,
          id
        );

        success++;
      } catch (error) {
        failed++;

        console.error(
          `[NICKNAME] Failed ${id}:`,
          error?.message || error
        );
      }

      await sleep(CHANGE_DELAY);
    }

    return {
      success,
      failed,
      total: info.participantIDs.length,
      nickname
    };
  } finally {
    running.delete(threadID);
  }
}

async function restoreAllNicknames(
  api,
  threadID,
  requesterID
) {
  threadID = String(threadID);

  if (String(requesterID) !== ADMIN_UID) {
    throw new Error(
      "Hindi ka admin."
    );
  }

  if (running.has(threadID)) {
    throw new Error(
      "May nickname operation pang tumatakbo sa GC na ito."
    );
  }

  running.add(threadID);

  try {
    const data = getThreadData(threadID);
    const members =
      data[threadID]?.members || {};

    let restored = 0;
    let failed = 0;

    for (const [uid, saved] of Object.entries(
      members
    )) {
      try {
        const original =
          saved.original == null
            ? ""
            : String(saved.original);

        await changeNickname(
          api,
          original,
          threadID,
          uid
        );

        restored++;
      } catch (error) {
        failed++;

        console.error(
          `[NICKNAME] Restore failed ${uid}:`,
          error?.message || error
        );
      }

      await sleep(CHANGE_DELAY);
    }

    data[threadID].enabled = false;
    data[threadID].nickname = "";

    saveData(data);

    return {
      restored,
      failed
    };
  } finally {
    running.delete(threadID);
  }
}

async function protectNickname(
  api,
  event
) {
  if (!event?.threadID) {
    return false;
  }

  const threadID = String(event.threadID);
  const data = getThreadData(threadID);
  const config = data[threadID];

  if (!config?.enabled) {
    return false;
  }

  if (!config.nickname) {
    return false;
  }

  const changedUser =
    event?.logMessageData?.participant_id ||
    event?.logMessageData?.participantID ||
    event?.participantID ||
    event?.userID ||
    null;

  if (!changedUser) {
    return false;
  }

  const uid = String(changedUser);

  let botID = "";

  try {
    botID = String(
      api.getCurrentUserID?.() || ""
    );
  } catch (_) {}

  if (botID && uid === botID) {
    return false;
  }

  if (running.has(threadID)) {
    return false;
  }

  try {
    running.add(threadID);

    await sleep(1800);

    await changeNickname(
      api,
      config.nickname,
      threadID,
      uid
    );

    console.log(
      `[NICKNAME] Protection restored ${uid} in${threadID}`
    );

    return true;
  } catch (error) {
    console.error(
      "[NICKNAME] Protection failed:",
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

  if (!/^\.setallnick(?:\s|$)/i.test(text) &&
      !/^\.\.restoreallnick(?:\s|$)/i.test(text) &&
      !/^\.nickprotect(?:\s|$)/i.test(text)) {
    return false;
  }

  const senderID = String(
    event.senderID || ""
  );

  const threadID = String(
    event.threadID || ""
  );

  const parts = text.split(/\s+/);
  const command = (
    parts[0] || ""
  ).toLowerCase();

  if (senderID !== ADMIN_UID) {
    send(
      api,
      threadID,
      "❌ Admin lamang ang puwedeng gumamit nito."
    );

    return true;
  }

  if (command === ".setallnick") {
    const nickname =
      parts.slice(1).join(" ").trim();

    if (!nickname) {
      send(
        api,
        threadID,
        "Gamitin: .setallnick <nickname>"
      );

      return true;
    }

    send(
      api,
      threadID,
      `⏳ Sine-set ko ang nickname ng members sa "${nickname}".`,
      "❤️"
    );

    setAllNicknames(
      api,
      threadID,
      nickname,
      senderID
    )
      .then(result => {
        send(
          api,
          threadID,
          [
            "✅ Tapos na.",
            `Nickname: ${result.nickname}`,
            `Matagumpay: ${result.success}`,
            `Hindi nagawa: ${result.failed}`,
            "",
            "🛡️ Proteksyon: NAKA-ON"
          ].join("\n")
        );
      })
      .catch(error => {
        send(
          api,
          threadID,
          `❌ Set nickname failed: ${
            error?.message || error
          }`
        );
      });

    return true;
  }

  if (command === "..restoreallnick") {
    send(
      api,
      threadID,
      "⏳ Ibinabalik ko ang dating nicknames...",
      "💤"
    );

    restoreAllNicknames(
      api,
      threadID,
      senderID
    )
      .then(result => {
        send(
          api,
          threadID,
          [
            "✅ Nickname restore complete.",
            `Naibalik: ${result.restored}`,
            `Hindi naibalik: ${result.failed}`,
            "",
            "🛡️ Proteksyon: NAKA-OFF`"
          ].join("\n")
        );
      })
      .catch(error => {
        send(
          api,
          threadID,
          `❌ Restore failed: ${
            error?.message || error
          }`
        );
      });

    return true;
  }

  if (command === ".nickprotect") {
    const data = getThreadData(threadID);

    const enabled =
      data[threadID]?.enabled === true;

    send(
      api,
      threadID,
      enabled
        ? `🛡️ Nickname protection: ON\nNickname: ${data[threadID].nickname}`
        : "🛡️ Nickname protection: OFF"
    );

    return true;
  }

  return true;
}

module.exports = {
  handleCommand,
  protectNickname,
  setAllNicknames,
  restoreAllNicknames
};
