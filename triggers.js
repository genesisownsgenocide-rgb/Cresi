"use strict";

const {
  rememberBanatReply,
  pickBanatReply
} = require("./banat-memory");

// Helper para makagawa ng 250 organic, parang-taong banat na walang kapareho
function generateHumanLikePool(rawSeeds, targetCount = 250) {
  const generated = [...rawSeeds];

  // Mga panapos na parang tunay na tropa ang kausap sa chat
  const humanFlavors = [
    "haist ewan ko sa'yo",
    "ramdam ko yung kaba mo e",
    "ayos ka lang ba kuya?",
    "delikado ka dyan sa ugali mo",
    "parang tanga lang e",
    "ikaw na naman ang naghahanap ng sakit ng ulo",
    "himbing pa ng tulog ng mga problema mo oh",
    "wag mo akong simulan ha",
    "halata namang wala kang maisip na matino",
    "ganyan ka na lang palagi, walang pinagbago",
    "ano na namangtrip mo sa buhay?",
    "ramdam na ramdam ko yung pilit mong hirit",
    "huminga ka muna bago ka magpakita rito",
    "umayos ka nga, hindi natinka ka-close",
    "kaya ka walang kaibigan e"
  ];

  const extensions = [
    "tapos magrereklamo ka",
    "sabagay sanay ka naman maging sablay",
    "sunod na tanong mo, galingan mo na ha",
    "tawa na sana kami kaso hindi nakakatuwa",
    "bili ka na rin ng hiya pag may time",
    "asado ka namang may maniniwala sa'yo",
    "balita ko hinahanap ka na sa inyo",
    "puro ka na lang satsat sa totoo lang"
  ];

  let fIndex = 0;
  let eIndex = 0;

  while (generated.length < targetCount) {
    const seed = rawSeeds[generated.length % rawSeeds.length];
    const flavor = humanFlavors[fIndex % humanFlavors.length];
    const ext = extensions[eIndex % extensions.length];

    // Ginawang parang totoong chat message ang format (walang robot-like symbols)
    const naturalLine = `${seed} ${flavor}, ${ext}`;

    if (!generated.includes(naturalLine)) {
      generated.push(naturalLine);
    }

    fIndex++;
    if (fIndex % humanFlavors.length === 0) {
      eIndex++;
    }
  }

  return generated.slice(0, targetCount);
}

// Mga natural at makataong raw seeds para sa bawat sitwasyon
const rawIntro = [
  "uy bago ka mag-chat, naghilamos ka na ba?",
  "oh bakit ka napapadpad dito? naubusan ka na naman ba ng kausap sa totoong buhay?",
  "musta ka na? mukhang masama pa rin itsura mo ngayon ah",
  "anong kailangan mo boss? kung pautang, wag na kasi waley din ako",
  "hala nagparamdam na naman ang pasikat ng taon",
  "uy hello din, kaso wala akong ganang makipag-plastikan ngayon",
  "oh anong meron? bakit parang gigil na gigil ka na magpapansin?",
  "aba, milagro buhay ka pa? akala ko tinangay ka na ng hangin",
  "pwede ba, wag kang umastang close tayo kasi hindi",
  "namukhaan mo na naman ako nung wala kang magawa sa buhay mo noh?"
];

const rawTanong = [
  "tanong ka nang tanong, may nasagot ka na ba kahit minsan sa sarili mong problema?",
  "sarili mong desisyon sa buhay di mo maayos, sa akin mo pinapasan yang tanong mo",
  "anong klaseng tanong yan? para kang ewan na naghahanap ng hustisya sa dilim",
  "himala, nag-isip ka na naman kuno... kaso sablay pa rin",
  "paulit-ulit kang nagtatanong eh halata namang di mo rin iintindihin ang sagot",
  "wala ka bang ibang mapag-abalahan bukod sa pag-imbento ng mga tanong na yan?",
  "tinanong mo pa lang sumakit na agad ang ulo ko sa'yo",
  "huli ka na sa balita, tapos magtatanong ka pa ng ganyan",
  "hindi mo na kailangang alaman kasi wala namang maitutulong sa kawawa mong diskarte",
  "ano ba talagang gusto mong palabasin? diretsuhin mo na kasi paikot-ikot ka pa"
];

const rawGalit = [
  "uy galit na galit oh, tinamaan ka ba masyado sa salamin niyo?",
  "dami mong mura at kuda pero wala ka namang binatbat sa totoo lang",
  "iyak ka muna konti sa tabi bago ka magsalita ulit ha",
  "yan na ba ang pinakamatapang mong vocabulary? ang hina naman",
  "nagwala na naman ang napag-iwanan ng panahon at diskarte",
  "buhos mo lang lahat ng sama ng loob mo, total wala ka namang ibang magawa",
  "kumalma ka baka atakihin ka sa puso dyan sa tapang-tapangan mo",
  "galit ka na naman, parang laging pinagagalitan ng nanay mo",
  "kala mo naman nakakatakot ka e parang tuta ka lang naman sumagot",
  "iyak kana niyan? hihintayin ko matapos luha mo para may masabi ka ulit"
];

const rawYabang = [
  "wow angas ah, pautang naman diyan kahit pambili lang ng hiya mo",
  "yabang mo e noh? parang hindi napag-iwanan sa kanto niyo",
  "lakas ng hangin mo, lumilipad na pati buhok ko dito sa kabilang screen",
  "puro ka yabang at angas pero pag singilan na ng gawa, tiklop ka naman",
  "sige ipagmalaki mo pa yan, baka sakaling may maniwala maliban sa sarili mo",
  "taas ng tingin sa sarili, e lugmok na lugmok naman ang diskarte sa buhay",
  "hanggang yabang ka na lang talaga no? walang laman ang gawa",
  "lakas ng loob magyabang, e pautangin ka lang ng singkong-duling hirap na hirap ka",
  "porma mo pangmayaman pero yung laman ng bulsa mo kasing-gaan ng hangin",
  "ikaw na nga ang bida sa sarili mong gawa-gawang kwento"
];

const rawDefault = [
  "ano na namang pinagsasabi mo dyan? lumilipad na naman yung lutang mong utak",
  "ha? anong konek nun sa mukha mo? sabog ka nanaman yata",
  "hindi ko naintindihan, paki-translate nga sa may sense na salita",
  "sumakit lang ang ulo ko sa pinaglalaban mong ewan",
  "ikot ka pa ng ikot sa sinasabi mo, wala ka namang pinupuntahang punto",
  "hinto ka muna, uminom ka muna ng tubig para mahimasmasan ka naman",
  "ang haba ng sinabi mo pero wala namang sustansya, parang buhay mo",
  "nakakaantok ka kausap, pwede bang mag-off ka muna ng chat?",
  "wala ka bang maisip na matino ngayon kundi magkalat dito?",
  "panibagong sablay na naman mula sa eksperto ng katangahan"
];

// Buuin ang eksaktong 250 human-like replies bawat kategorya
const conversationalGroups = [
  {
    name: "kamusta_intro",
    triggers: ["hi", "hello", "musta", "kamusta", "uy", "boss", "lodi", "paps", "master"],
    replies: generateHumanLikePool(rawIntro, 250)
  },
  {
    name: "tanong_pilosopo",
    triggers: ["bakit", "ano", "saan", "sino", "paano", "kailan", "ilan", "may pa"],
    replies: generateHumanLikePool(rawTanong, 250)
  },
  {
    name: "galit_tropa",
    triggers: ["ulol", "gago", "tanga", "bobo", "tarantado", "pota", "punyeta", "kupal"],
    replies: generateHumanLikePool(rawGalit, 250)
  },
  {
    name: "yabang_flex",
    triggers: ["ako", "ako nga", "magaling", "gwapo", "maganda", "yabang", "angas", "mayaman", "pera"],
    replies: generateHumanLikePool(rawYabang, 250)
  },
  {
    name: "default_sablay",
    triggers: [],
    replies: generateHumanLikePool(rawDefault, 250)
  }
];

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getSmartConversationReply(body, threadID = "") {
  const text = normalize(body);
  let selectedReplies = [];

  for (const group of conversationalGroups) {
    if (group.triggers.length > 0) {
      const matched = group.triggers.some(trigger => {
        const t = String(trigger).toLowerCase();
        return t.length <= 4
          ? new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)
          : text.includes(t);
      });

      if (matched) {
        selectedReplies = group.replies;
        break;
      }
    }
  }

  if (selectedReplies.length === 0) {
    const defaultGroup = conversationalGroups.find(g => g.name === "default_sablay");
    selectedReplies = defaultGroup ? defaultGroup.replies : ["ano ba yan?"];
  }

  const reply = pickBanatReply(threadID, selectedReplies);

  if (reply) {
    rememberBanatReply(threadID, reply);
  }

  return reply;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Makataong typing delay na kunwari ay nag-iisip at nagti-tipa base sa haba ng sagot
async function getHumanLikeReply(body, threadID = "", minMs = 1200, maxMs = 3500) {
  const reply = getSmartConversationReply(body, threadID);

  if (!reply) return null;

  const baseDelay = Math.min(Math.max(reply.length * 45, minMs), maxMs);
  const randomJitter = Math.floor(Math.random() * 900);
  const finalDelay = baseDelay + randomJitter;

  await wait(finalDelay);

  return reply;
}

module.exports = {
  conversationalGroups,
  getSmartConversationReply,
  getHumanLikeReply
};
