"use strict";

// Pure local humanization. No AI, model calls, network calls, or user profiling.

const KEYBOARD = {
  q: "wa", w: "qase", e: "wsdr", r: "edft", t: "rfgy", y: "tghu", u: "yhji",
  i: "ujko", o: "iklp", p: "ol", a: "qwsz", s: "awedxz", d: "serfcx", f: "drtgvc",
  g: "ftyhbv", h: "gyujnb", j: "huikmn", k: "jiolm", l: "kop", z: "asx", x: "zsdc",
  c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk"
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function pick(arr, random = Math.random) { return arr?.length ? arr[Math.floor(random() * arr.length)] : null; }
function preserveCase(src, out) {
  if (src === src.toUpperCase()) return out.toUpperCase();
  if (src && src[0] === src[0].toUpperCase()) return out[0].toUpperCase() + out.slice(1);
  return out;
}

function normalizeEntries(dict) {
  const out = [];
  for (const [from, values] of Object.entries(dict || {})) {
    for (const value of Array.isArray(values) ? values : [values]) out.push([from, value]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

function replaceOne(text, dict, rate, random) {
  if (random() >= clamp(Number(rate) || 0, 0, 1)) return text;
  const candidates = [];
  for (const [from, to] of normalizeEntries(dict)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(text)) candidates.push([re, to]);
  }
  const choice = pick(candidates, random);
  if (!choice) return text;
  return text.replace(choice[0], match => preserveCase(match, choice[1]));
}

function typoWord(word, random) {
  if (word.length < 4) return word;
  const i = 1 + Math.floor(random() * (word.length - 2));
  const mode = Math.floor(random() * 4);
  if (mode === 0 && KEYBOARD[word[i].toLowerCase()]) {
    const n = pick(KEYBOARD[word[i].toLowerCase()].split(""), random);
    return word.slice(0, i) + preserveCase(word[i], n) + word.slice(i + 1);
  }
  if (mode === 1) return word.slice(0, i) + word.slice(i + 1);
  if (mode === 2) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  return word.slice(0, i) + word[i] + word.slice(i);
}

function addTypo(text, rate, random) {
  if (random() >= clamp(Number(rate) || 0, 0, 1)) return text;
  const parts = text.split(/(\s+)/);
  const eligible = parts.map((x, i) => /^[A-Za-z]{4,}$/.test(x) ? i : -1).filter(i => i >= 0);
  const i = pick(eligible, random);
  if (i == null) return text;
  const changed = typoWord(parts[i], random);
  return changed === parts[i] ? text : (parts[i] = changed, parts.join(""));
}

function caseSlip(text, rate, random) {
  if (random() >= clamp(Number(rate) || 0, 0, 1)) return text;
  const parts = text.split(/(\s+)/);
  const eligible = parts.map((x, i) => /^[A-Za-z]{3,}$/.test(x) ? i : -1).filter(i => i >= 0);
  const i = pick(eligible, random);
  if (i == null) return text;
  parts[i] = random() < 0.75 ? parts[i].toLowerCase() : parts[i][0].toUpperCase() + parts[i].slice(1).toLowerCase();
  return parts.join("");
}

function spaceSlip(text, rate, random) {
  if (random() >= clamp(Number(rate) || 0, 0, 1)) return text;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) return text;
  const i = 1 + Math.floor(random() * (words.length - 2));
  if (random() < 0.7) { words[i - 1] += words[i]; words.splice(i, 1); }
  else words[i - 1] += "  " + words[i];
  return words.join(" ");
}

function casualPunctuation(text, random) {
  let out = text.trim();
  if (random() < 0.12) out = out.replace(/\.$/, "");
  if (random() < 0.07 && !/[!?…]$/.test(out)) out += "...";
  if (random() < 0.04) out = out.replace(/, /g, ",");
  return out;
}

function humanize(text, options = {}) {
  const random = options.random || Math.random;
  let out = String(text || "").trim();
  if (!out) return out;
  if (options.abbreviate !== false) out = replaceOne(out, options.abbreviations, options.abbreviationRate ?? 0.08, random);
  if (options.typos !== false) out = addTypo(out, options.typoRate ?? 0.025, random);
  out = caseSlip(out, options.caseVariationRate ?? 0.025, random);
  out = spaceSlip(out, options.spaceVariationRate ?? 0.012, random);
  if (options.punctuation !== false) out = casualPunctuation(out, random);
  if (random() < 0.018) out = out.replace(/\b(lol|haha)\b/i, m => m + (random() < 0.5 ? "ll" : "a"));
  return out;
}

module.exports = { humanize };
