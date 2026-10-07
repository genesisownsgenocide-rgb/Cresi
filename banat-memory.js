"use strict";

const MAX_RECENT = Math.max(4, Math.min(20, Number(process.env.BANAT_MEMORY_SIZE || 8)));
const TTL_MS = Math.max(60_000, Number(process.env.BANAT_MEMORY_TTL_MS || 20 * 60 * 1000));
const state = new Map();

function key(id) { return String(id || "unknown"); }
function normalize(v) { return String(v || "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim(); }
function signature(v) {
  return normalize(v).replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 7).join(" ");
}
function get(id) {
  const k = key(id), now = Date.now(), current = state.get(k);
  if (!current || now - current.at > TTL_MS) {
    const fresh = { at: now, replies: [], signatures: [] }; state.set(k, fresh); return fresh;
  }
  current.at = now; return current;
}
function rememberBanatReply(id, reply) {
  const text = String(reply || "").trim(); if (!text) return;
  const s = get(id), sig = signature(text);
  s.replies = [...s.replies.filter(x => x !== text), text].slice(-MAX_RECENT);
  if (sig) s.signatures = [...s.signatures.filter(x => x !== sig), sig].slice(-MAX_RECENT);
}
function isRecent(id, reply, fallback = []) {
  const text = String(reply || "").trim(), s = get(id), sig = signature(text);
  return s.replies.includes(text) || (sig && s.signatures.includes(sig)) || (Array.isArray(fallback) && fallback.includes(text));
}
function pickBanatReply(id, replies, fallback = []) {
  if (!Array.isArray(replies) || !replies.length) return null;
  const fresh = replies.filter(x => !isRecent(id, x, fallback));
  if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];
  const exact = replies.filter(x => !get(id).replies.includes(String(x).trim()));
  return (exact.length ? exact : replies)[Math.floor(Math.random() * (exact.length || replies.length))];
}

module.exports = { MAX_RECENT, TTL_MS, rememberBanatReply, pickBanatReply, isRecent };
