"use strict";

function startTyping(api, threadID) {
  if (!api || !threadID) return false;
  try {
    if (typeof api.sendTypingIndicator === "function") {
      api.sendTypingIndicator(threadID, () => {});
      return true;
    }
    if (typeof api.sendTyping === "function") {
      api.sendTyping(threadID, true);
      return true;
    }
  } catch (_) {}
  return false;
}

function stopTyping(api, threadID) {
  if (!api || !threadID) return false;
  try {
    if (typeof api.sendTyping === "function") {
      api.sendTyping(threadID, false);
      return true;
    }
  } catch (_) {}
  return false;
}

module.exports = { startTyping, stopTyping };
