"use strict";

const {
  rememberBanatReply,
  pickBanatReply
} = require("./banat-memory");

// Mga base words at templates para awtomatikong makabuo ng libu-libong safe na banat
const subjects = ["ikaw", "si lolo", "ang tropa mo", "yung kasama mo", "porma mo", "utak mo", "ugali mo"];
const actions = ["pilit", "sablay", "luma", "walang kwenta", "pulpol", "frozen", "sabaw", "sabog"];
const suffixes = ["na naman", ulit, "kahapon pa", "parang sirang plaka", "wala sa hulog", "puro hangin"];

// Dynamic generator para sa libu-libong replies na hindi ma-dedetect ng Meta spam filter
function generateMassReplies() {
  const generated = [];
  const baseList = [
    "bot nang bot, anong ambag mo sa lipunan?",
    "ikaw ang may auto-reply sa utak",
    "bot ka rin naman, nagkaila ka pa",
    "bot nga lolo mo sa saudi",
    "o ayan, napaghalataan tuloy na bot ka",
    "pumapalag ka pa e pareho lang kayo ng script",
    "may bot na naman dito na nag-iingay",
    "asan na yung bagong banat mo? luma na yan e",
    "paulit-ulit ka na lang, parang sirang plaka",
    "wala ka na bang ibang maisip?",
    "bot ka nang bot, sarili mo namang salamin kinatatakutan mo",
    "edi ikaw na ang huling saksakan ng talino",
    "parang iisa lang ang pinagkakopyahan ng utak mo",
    "sige ulitin mo pa, baka sakaling may maniwala",
    "wala ka bang ibang alam kundi yan?",
    "sirang plaka ka na kuya, pa-reformat mo na yan",
    "isang salita lang ang umiikot dyan sa maliit mong mundo",
    "hindi ka ba nagsasawang maging paulit-ulit?",
    "ang bilis mong maubusan ng bala",
    "ano na naman ba ang pinagsasabi mo dyan?",
    "ang ingay mo, parang lata na walang laman",
    "bago ka magsalita, mag-isip ka muna kahit konti",
    "wag puro satsat kung wala namang sustansya",
    "nauna kasi ang bibig bago ang utak",
    "naiwan mo yata ang utak mo sa bahay niyo",
    "gumagana pa ba yan o display na lang?",
    "gulo mo kausap, parang timog at hilaga",
    "naligaw ka na naman ng landas, balik ka sa topic",
    "wala ka namang dalang punto, puro hangin lang",
    "yabang lang ang puhunan pero sablay naman",
    "feeling mo naman ang galing mo",
    "akala mo kung sino ka na sikat",
    "wag kang feeling main character kung extra ka lang",
    "ang lakas ng loob mong magsalita pero waley naman",
    "ano ba yan, yan na ba ang pinakamagaling mo?",
    "eto na naman tayo sa paulit-ulit mong hirit",
    "ang ingay mo, nakakarindi na",
    "wala ka bang ibang alam kundi yan?",
    "yan na naman ang luma mong banat",
    "narinig ko na yan kay kuya guard kahapon",
    "wala ka na talagang maisip na bago",
    "yan na ang pinaka-best mo? ang hina naman",
    "sobrang hina, hindi man lang umabot sa quota",
    "walang dating, parang ulan na walang tubig",
    "walang tama, sablay lahat ng tira mo",
    "di umubra ang porma mo",
    "walang epekto sa amin ang hangin mo",
    "lumalayo ka na naman sa totoong usapan",
    "di mo na alam ang sinasabi mo e",
    "ang labo mo kausap, magkaape ka muna",
    "puro ka ingay at satsat",
    "hangin lang ang laman ng sinasabi mo",
    "babaan mo naman ang ego mo, baka mapatid ka",
    "mataas na naman ang tingin sa sarili",
    "sino ka ba talaga para magmaganda dyan?",
    "feeling importante ka masyado",
    "pwede ka nang tumigil sa pagpapatawa",
    "bawas-bawasan ang yabang kung luto naman ang gawa",
    "daldal ka nang daldal, wala ka namang napatunayan",
    "magpahinga ka muna, napagod din ang mga nakikinig sa'yo",
    "ikaw na nga ang mali, ikaw pa ang may ganang mag-ingay",
    "halata namang tinatago mo lang ang kaba mo",
    "ang dali mo kasing ma-trigger sa simpleng bagay",
    "uwi ka na, hinahanap ka na ng nanay mo"
  ];

  // Algorithmic expansion para lumikha ng libu-libong kakaibang variations na pasok sa limit
  for (let i = 0; i < baseList.length; i++) {
    generated.push(baseList[i]);
    for (let j = 0; j < subjects.length; j++) {
      for (let k = 0; k < actions.length; k++) {
        generated.push(`${baseList[i]} - ${subjects[j]} ay ${actions[k]}`);
      }
    }
  }

  return generated;
}

const dynamicReplies = generateMassReplies();

const groups = [
  {
    name: "bot",
    triggers: ["bot", "robot", "ai"],
    replies: dynamicReplies.slice(0, Math.floor(dynamicReplies.length / 2))
  },
  {
    name: "trash-talk",
    triggers: [
      "weak",
      "laro",
      "lala",
      "patawa",
      "hahahaa",
      "pake ko",
      "sino yan",
      "angas",
      "hina"
    ],
    replies: dynamicReplies.slice(Math.floor(dynamicReplies.length / 2))
  }
];

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function findGroups(body) {
  const text = normalize(body);

  return groups.filter(group =>
    group.triggers.some(trigger => {
      const t = String(trigger).toLowerCase();

      return t.length <= 4
        ? new RegExp(
            `\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            "i"
          ).test(text)
        : text.includes(t);
    })
  );
}

function getTriggerReply(body, threadID = "") {
  const matched = findGroups(body);

  if (!matched.length) {
    return null;
  }

  const group = matched[Math.floor(Math.random() * matched.length)];
  const reply = pickBanatReply(threadID, group.replies);

  if (reply) {
    rememberBanatReply(threadID, reply);
  }

  return reply;
}

function getBanatConversationReply(body, threadID = "") {
  const direct = getTriggerReply(body, threadID);

  if (direct) {
    return direct;
  }

  const fallback = groups.flatMap(group => group.replies);
  const reply = pickBanatReply(threadID, fallback);

  if (reply) {
    rememberBanatReply(threadID, reply);
  }

  return reply;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getHumanLikeReply(body, threadID = "", minMs = 1000, maxMs = 3000) {
  const reply = getBanatConversationReply(body, threadID);

  if (!reply) return null;

  const baseDelay = Math.min(Math.max(reply.length * 40, minMs), maxMs);
  const randomJitter = Math.floor(Math.random() * 800);
  const finalDelay = baseDelay + randomJitter;

  await wait(finalDelay);

  return reply;
}

module.exports = {
  groups,
  getTriggerReply,
  getBanatConversationReply,
  getHumanLikeReply
};
