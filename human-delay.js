"use strict";

function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function calculateHumanDelay(text, context = {}, options = {}) {
  const chars = String(text || "").length;
  const words = countWords(text);
  const mode = context.mode || "chill";
  const momentum = Number(context.momentum || 1);

  const reactionBase = 500 + Math.min(900, chars * 10) + Math.random() * 450;
  const speed = mode === "rushed" ? 0.68 : mode === "normal" ? 0.84 : 1;
  const hesitation = Math.random() < Number(options.hesitationRate ?? 0.11)
    ? 120 + Math.random() * 520
    : 0;

  const reactionMs = Math.max(120, Math.min(1800, reactionBase * speed + hesitation * 0.25));
  const typingMs = Math.max(350, Math.min(
    Number(options.maxTypingMs || options.max || 6500),
    (450 + words * 115 + chars * 8) * speed + hesitation + Math.max(0, momentum - 3) * 100
  ));

  return { reactionMs, typingMs };
}

module.exports = { countWords, calculateHumanDelay };
