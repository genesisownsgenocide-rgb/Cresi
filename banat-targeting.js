"use strict";

const TTL = Math.max(10 * 60 * 1000, Number(process.env.BANAT_CONVERSATION_TTL_MS || 60 * 60 * 1000));
const states = new Map();
const DIRECT = /^(?:hey|hi|hello|yo|sup|oi|ayy|bro|bruh)?\s*(?:bot|banat)\b/i;

function setBanatConversationMode(threadID, enabled, activatedBy = null) {
  const key = String(threadID || "").trim(); if (!key) return false;
  if (!enabled) { states.delete(key); return false; }
  states.set(key, { active: true, activatedBy: activatedBy ? String(activatedBy) : null, activatedAt: Date.now(), lastActivityAt: Date.now() });
  return true;
}
function isBanatConversationModeActive(threadID) {
  const key = String(threadID || "").trim(), s = states.get(key);
  if (!s?.active) return false;
  if (Date.now() - s.lastActivityAt > TTL) { states.delete(key); return false; }
  return true;
}
function touchBanatConversation(threadID) {
  if (!isBanatConversationModeActive(threadID)) return false;
  const s = states.get(String(threadID)); s.lastActivityAt = Date.now(); return true;
}
function replyTarget(event) { return event?.messageReply?.senderID ?? event?.messageReply?.senderId ?? event?.messageReply?.sender_id ?? null; }
function mentioned(event) { return Object.keys(event?.mentions || {}).map(String); }
function classifyBanatTarget({ event, body, botID = "" }) {
  const text = String(body || "").replace(/\s+/g, " ").trim(), id = String(botID || "");
  if (!text) return { shouldRespond: false, reason: "empty" };
  const replyToBot = !!id && String(replyTarget(event) || "") === id;
  const mentionedBot = !!id && mentioned(event).includes(id);
  const direct = DIRECT.test(text) || /^@?(?:bot|banat)\b/i.test(text);
  const active = isBanatConversationModeActive(event?.threadID);
  const question = /\?$|^(?:why|what|how|who|where|when|bakit|ano|paano|sino|saan)\b/i.test(text);
  if (active) { touchBanatConversation(event?.threadID); return { shouldRespond: true, reason: "active-conversation", directed: true, replyToBot, mentionedBot, directAddress: direct, question, conversationActive: true }; }
  if (replyToBot) return { shouldRespond: true, reason: "reply-to-bot", directed: true, via: "reply", replyToBot: true, mentionedBot, directAddress: direct, question, conversationActive: false };
  if (mentionedBot) return { shouldRespond: true, reason: "mention-bot", directed: true, via: "mention", replyToBot, mentionedBot: true, directAddress: direct, question, conversationActive: false };
  if (direct) return { shouldRespond: true, reason: "name-address", directed: true, via: "name", replyToBot, mentionedBot, directAddress: true, question, conversationActive: false };
  return { shouldRespond: false, reason: question ? "question-not-directed" : "not-directed", directed: false, replyToBot, mentionedBot, directAddress: direct, question, conversationActive: false };
}
module.exports = { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive, touchBanatConversation };
