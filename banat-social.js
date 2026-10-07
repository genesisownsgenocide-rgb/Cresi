"use strict";

const REACTION_WORDS = new Set(["lol", "lmao", "lmfao", "haha", "hahaha", "fr", "real", "damn", "wtf", "bro", "bruh", "nah", "😭", "💀", "🤣"]);
function normalize(text) { return String(text || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim(); }
function countWords(text) { return normalize(text).split(" ").filter(Boolean).length; }
function energy(text) {
  const v = String(text || ""); let n = 0;
  if (/[!?]{2,}/.test(v)) n++;
  if (/\b(?:HAHA+|LMAO+|LMFAO+)\b/i.test(v)) n++;
  if (/[😭💀🤣]/u.test(v)) n++;
  if (/\b(?:bro|bruh|wtf|nah)\b/i.test(v)) n++;
  if (v === v.toUpperCase() && /[A-Z]/.test(v)) n++;
  return Math.min(5, n);
}
function isQuestion(text) { const v = normalize(text); return /\?|\b(?:why|what|how|who|where|when|bakit|ano|paano|sino|saan|kelan)\b/i.test(v); }
function isReaction(text) { const v = normalize(text), w = v.split(" ").filter(Boolean); return w.length > 0 && w.length <= 3 && (w.every(x => REACTION_WORDS.has(x)) || /^[!?😭💀🤣.]+$/u.test(v)); }
function chooseSocialResponse(incomingText, candidateText = "", context = {}) {
  const incoming = String(incomingText || "").trim(), words = countWords(incoming), e = energy(incoming), momentum = Number(context.momentum || 1);
  let type = "tease", reason = "banat-style conversational reply";
  if (isReaction(incoming)) { type = "reaction"; reason = "short reaction"; }
  else if (isQuestion(incoming)) { type = "answer"; reason = "question"; }
  else if (momentum >= 4 && words <= 8) { type = "short"; reason = "fast exchange"; }
  else if (e >= 3) { type = "react"; reason = "high-energy incoming"; }
  else if (/\b(?:agree|tama|true|real|same|exactly|oo|yes|yep|yup)\b/i.test(incoming)) type = "agree";
  else if (/\b(?:idk|i don't know|di ko alam|wala|nothing|nvm|never mind)\b/i.test(incoming)) type = "deflect";
  else if (candidateText && /\?\s*$/.test(candidateText)) type = "ask";
  else if (context.recentMessages >= 3 && words >= 12) type = "callback";
  return { type, reason, energy: e, momentum, incomingWords: words };
}
function socialTimingMultiplier(d) {
  return ({ reaction: .55, react: .75, short: .72, answer: 1.05, ask: 1.02, callback: 1.08, deflect: .82, agree: .78 }[d?.type] || 1);
}
module.exports = { chooseSocialResponse, socialTimingMultiplier };
