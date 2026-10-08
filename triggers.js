"use strict";

const {
  rememberBanatReply,
  pickBanatReply
} = require("./banat-memory");

// Purong Tagalog na mga banat.
// Walang AI service na ginagamit dito.

const groups = [
  {
    name: "bot",
    triggers: ["bot", "robot", "ai"],
    replies: [
      "ikaw bot",
      "mama mo bot",
      "bot nang bot, anong ambag mo?",
      "ikaw mukhang bot",
      "bot ka rin naman",
      "bot nga lolo mo",
      "o ayan bot na",
      "pumapalag ka pala sa bot",
      "may bot na naman dito",
      "asan nga yung bagong banat mo",
      "paulit-ulit ka",
      "wala ka nang bago",
      "bot ka nang bot, wala ka nang maisip",
      "edi bot, tapos?",
      "ikaw yata ang naka-auto reply",
      "parang iisa lang alam mong sabihin",
      "sige ulitin mo pa",
      "wala ka bang ibang alam?",
      "paulit-ulit bibig mo",
      "sirang plaka ka",
      "isang salita lang umiikot sa ulo mo",
      "may bago ka bang banat?",
      "hindi ka ba nagsasawa?",
      "ang bilis mong maubusan",
      "wala ka nang maisip",
      "ano na naman yan",
      "ang ingay mo",
      "daldal ka nang daldal",
      "bago ka magsalita, intindi muna",
      "wag puro satsat",
      "isip muna bago salita",
      "nauna bibig mo",
      "naiwan utak mo",
      "gumagana pa ba yan?",
      "ano ba talaga sinasabi mo",
      "gulo mo kausap",
      "naligaw ka na naman",
      "balik ka sa topic",
      "lumayo ka na sa usapan",
      "wala kang punto",
      "asan punto mo",
      "may punto ka ba?",
      "puro salita",
      "wala namang laman",
      "yabang lang dala mo",
      "ang yabang mo",
      "feeling mo naman",
      "akala mo naman kung sino ka",
      "wag kang feeling",
      "ang lakas ng loob mo",
      "pero wala namang punto"
    ]
  },

  {
    name: "trash-talk",
    triggers: [
      "weak",
      "laro",
      "tanginamo",
      "lala",
      "patawa",
      "gago",
      "bobo",
      "tanga",
      "hahahaa",
      "pake ko",
      "sino yan"
    ],

    replies: [
      "ano ba yan",
      "eto na naman",
      "ang ingay mo",
      "wala ka bang ibang alam",
      "paulit ulit ka",
      "yan na naman banat mo",
      "luma na yan",
      "narinig na namin yan",
      "wala ka nang maisip",
      "yan lang kaya mo",
      "yan na pinaka-best mo?",
      "ang hina naman",
      "sobrang hina",
      "walang dating",
      "walang tama",
      "di tumama",
      "di umubra",
      "di gumana",
      "walang epekto",
      "wala namang punto",
      "asan punto",
      "lumalayo ka na",
      "di mo na alam sinasabi mo",
      "ano ba pinagsasabi mo",
      "gulo mo kausap",
      "ang labo mo",
      "di ka maintindihan",
      "puro ka salita",
      "puro ingay",
      "ang dami mong satsat",
      "satsat ka nang satsat",
      "wala namang laman",
      "hangin lang sinasabi mo",
      "salita lang kaya mo",
      "yabang lang dala mo",
      "yabang na naman",
      "ang yabang mo",
      "sobra yabang mo",
      "baba mo ego mo",
      "mataas na naman tingin mo sa sarili mo",
      "sino ka ba",
      "akala mo kung sino ka",
      "feeling mo naman",
      "feeling importante",
      "feeling main character",
      "di ka naman bida",
      "wag kang feeling",
      "wag kang umasta",
      "wag kang mayabang",
      "ang lakas ng loob mo",
      "tapang mo magsalita",
      "pero wala namang punto",
      "ang bilis mo magsalita",
      "di ka muna mag-isip?",
      "isip muna bago satsat",
      "bibig muna bago utak",
      "nauna bibig mo",
      "naiwan utak mo",
      "asan utak mo",
      "ginagamit mo ba utak mo",
      "may laman ba yan",
      "gumagana pa ba yan",
      "nag-iisip ka ba",
      "ano iniisip mo",
      "kung ano ano na sinasabi mo",
      "di mo na alam",
      "naligaw ka na",
      "naligaw ka sa sarili mong sinabi",
      "sarili mong banat di mo maintindihan",
      "ikaw mismo di mo gets",
      "gets mo ba sarili mo",
      "ulit ulit ka",
      "paulit ulit na lang",
      "pareho lagi sinasabi mo",
      "wala ka bang bago",
      "baguhin mo naman banat mo",
      "nakakasawa ka",
      "nakakaumay ka",
      "nakakapagod basahin",
      "nakakapagod ka kausap",
      "ang kulit mo",
      "sobrang kulit",
      "tigil mo yan",
      "tama na",
      "sobra na",
      "hinto na",
      "manahimik ka muna",
      "pahinga muna bibig mo",
      "pahinga muna sa satsat",
      "tahimik ka nga",
      "ang ingay mo talaga",
      "di ka nauubusan ng salita",
      "sayang salita mo",
      "sayang oras",
      "ano bang gusto mong mangyari",
      "may point ka ba talaga",
      "wala ka namang napapala",
      "puro ka lang yabang",
      "puro ka lang salita",
      "puro ka lang satsat",
      "wala ka namang gawa",
      "hanggang salita ka lang",
      "daldal mo",
      "daldal nang daldal",
      "madaldal ka masyado",
      "bawas bawasan mo salita mo",
      "di kailangan lahat sabihin",
      "lahat na lang sinasabi mo",
      "lahat kailangan may say ka",
      "lahat pinapakelaman mo",
      "di mo naman alam",
      "wala ka namang alam",
      "nagpapanggap ka lang",
      "feeling alam lahat",
      "akala mo alam lahat",
      "di mo alam lahat",
      "wag kang magpanggap",
      "wag kang feeling eksperto",
      "bakit parang alam mo lahat",
      "ang dami mong alam kuno",
      "puro haka-haka",
      "hula na naman",
      "basehan mo ano",
      "saan mo nakuha yan",
      "imbento mo lang yan",
      "gawa-gawa mo lang",
      "kwento mo yan",
      "di kami interesado",
      "wala kaming pake",
      "wala akong pake",
      "di kailangan opinyon mo",
      "di kailangan dagdag mo",
      "pwede ka nang tumahimik",
      "pwede ka nang tumabi",
      "konting hiya naman",
      "wala ka bang hiya",
      "ang kapal mo",
      "kapal ng mukha",
      "di ka nahiya",
      "ikaw na nga mali ikaw pa maingay",
      "mali ka na nga",
      "mali ka na nga galit ka pa",
      "mali ka na nga mayabang ka pa",
      "wala ka nang tama",
      "lahat na lang sablay",
      "lahat na lang mali",
      "kahit anong sabihin mo mali",
      "kahit anong ikot mo mali pa rin",
      "ikot ka nang ikot",
      "paligoy ligoy ka",
      "ano ba talaga punto mo",
      "nakalimutan mo na naman",
      "nakalimutan mo sinabi mo",
      "kontra ka sa sarili mo",
      "sarili mo kinokontra mo",
      "halata naman",
      "kitang kita",
      "obvious na obvious",
      "ang dali mong hulaan",
      "alam na agad sasabihin mo",
      "predictable mo",
      "pareho ka lagi",
      "walang pagbabago",
      "walang bago sayo",
      "walang bago sa bibig mo",
      "parehong script",
      "parehong banat",
      "parehong satsat",
      "nakakainis ka na",
      "nakakairita ka",
      "nakakairita basahin",
      "nakakairita kausap",
      "ang kulit kulit mo",
      "di ka ba napapagod",
      "di ka ba nagsasawa",
      "wala ka bang ibang ginagawa",
      "lagi ka na lang nandito",
      "lagi ka na lang may sinasabi",
      "lagi ka na lang maingay",
      "lagi ka na lang sumisingit",
      "lahat kailangan may say ka",
      "lahat gusto mong sagutin",
      "nagpapanggap ka lang",
      "feeling eksperto",
      "teacher ka ba",
      "professor ka ba",
      "bakit parang alam mo lahat",
      "kuno ka naman",
      "puro kuno",
      "puro haka-haka",
      "hula lang naman",
      "basehan mo ano",
      "saan mo nakuha yan",
      "imbento mo lang yan",
      "gawa-gawa mo lang",
      "wag dito",
      "di kami interesado",
      "di namin kailangan marinig yan",
      "di kailangan opinyon mo",
      "pwede ka nang umalis",
      "pwede ka nang magpahinga",
      "pwede ka nang manahimik",
      "tama na daldal",
      "tama na satsat",
      "tama na yabang",
      "tama na feeling",
      "tama na arte",
      "tama na drama",
      "wag na dagdagan",
      "lalo ka lang bumabaon",
      "lalo ka lang napapahiya",
      "habang nagsasalita ka lalong lumalala",
      "bawat salita mo sablay",
      "bawat dagdag mo nakakainis",
      "bawat reply mo pareho",
      "bawat banat mo pilit",
      "wala nang maayos",
      "wala nang maisalba",
      "di na mababawi yan",
      "nasabi mo na eh",
      "huli na para bawiin",
      "panindigan mo na yan",
      "wag mo nang dagdagan",
      "mas lalo lang pangit",
      "mas lalo lang magulo",
      "mas lalo lang sablay",
      "mas lalo kang naliligaw",
      "tigil habang pwede pa",
      "huminto ka na",
      "wag mo nang ituloy",
      "wag mo nang pahabain",
      "di kailangan nobela",
      "ang haba mo magsalita",
      "ang haba wala namang laman",
      "mahaba pero wala",
      "marami pero wala",
      "madami sinabi wala naman",
      "puro filler",
      "puro dagdag",
      "walang direksyon",
      "walang patutunguhan",
      "ikot ka na naman",
      "bumabalik ka sa wala",
      "saan ka ba papunta",
      "ano ba talaga gusto mo",
      "di mo alam gusto mo",
      "di mo alam ginagawa mo",
      "di mo alam sinasabi mo",
      "di mo alam kung saan ka lulugar",
      "ang gulo mo",
      "magulo utak mo",
      "magulo banat mo",
      "magulo kausap",
      "konting utak naman",
      "konting common sense",
      "common sense nasaan",
      "nawala common sense mo",
      "baka hinahanap mo pa",
      "hanapin mo muna",
      "ano ba yan",
      "ewan sayo",
      "bahala ka",
      "sayo na yan",
      "sawa na ako",
      "nakakasawa ka",
      "next na lang",
      "sunod na topic",
      "iba naman",
      "palit usapan",
      "wag na ikaw",
      "skip muna sayo",
      "pass sa banat mo",
      "pass sa drama mo",
      "pass sa yabang mo",
      "pass sa satsat mo",
      "di worth patulan",
      "sayang oras patulan ka",
      "sayang oras sayo",
      "short lang sayo",
      "isang salita sapat na",
      "tama na yan",
      "wala nang kailangan sabihin",
      "gets na namin",
      "alam na namin",
      "nakita na namin",
      "narinig na namin",
      "enough na",
      "stop na",
      "end na",
      "tapos na",
      "uwi ka na",
      "logout ka muna",
      "log out ka na",
      "pahinga ka muna",
      "tulog ka muna",
      "bukas mo na isipin",
      "mamaya ka na bumalik",
      "balik ka pag may bagong banat",
      "balik ka pag may sense na",
      "balik ka pag gets mo na",
      "hanggang dito ka lang muna",
      "dito ka muna sa gilid",
      "wag ka muna sumali",
      "manood ka muna",
      "basa ka muna",
      "observe ka muna",
      "wag puro salita",
      "tingin ka muna",
      "makinig ka muna",
      "intindi ka muna",
      "wag ka agad sumagot",
      "wag ka agad pumalag",
      "wag ka agad magyabang",
      "wag ka agad mag-ingay",
      "ang bilis mo naman",
      "di ka hinahabol",
      "ang gigil mo",
      "sobrang gigil",
      "gigil na gigil",
      "parang may hinahabol",
      "wala ka namang kaaway",
      "ikaw lang may problema",
      "ikaw lang affected",
      "parang ikaw yung tinamaan",
      "tinamaan ka ba",
      "bakit ka affected",
      "bakit ka nagagalit",
      "bakit ka defensive",
      "defensive agad",
      "ang bilis ma-trigger",
      "triggered agad",
      "konting salita triggered",
      "konting banat galit agad",
      "ang dali mong maasar",
      "ikaw pala madaling asarin",
      "eto pala kahinaan mo",
      "konting asar lang",
      "wag ka maiyak",
      "wag ka magalit",
      "wag ka magdrama",
      "wag ka mag-arte",
      "wag kang feeling",
      "wag kang mayabang",
      "wag kang epal",
      "wag kang sumingit",
      "wag kang bida-bida",
      "bida-bida ka na naman",
      "papansin ka na naman",
      "pansin na naman hanap mo",
      "gusto mo attention?",
      "ayan attention mo",
      "ayan napansin ka na",
      "masaya ka na?",
      "okay ka na?",
      "nakuha mo na gusto mo",
      "tapos na",
      "pwede ka nang tumigil"
    ]
  }
];

function normalize(text) {
  return String(
    text || ""
  )
    .toLowerCase()
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function findGroups(body) {
  const text =
    normalize(body);

  return groups.filter(
    group =>
      group.triggers.some(
        trigger => {
          const t =
            String(
              trigger
            ).toLowerCase();

          return t.length <= 4
            ? new RegExp(
                `\\b${t.replace(
                  /[.*+?^${}()|[\]\\]/g,
                  "\\$&"
                )}\\b`,
                "i"
              ).test(text)
            : text.includes(t);
        }
      )
  );
}

function getTriggerReply(
  body,
  threadID = ""
) {
  const matched =
    findGroups(body);

  if (
    !matched.length
  ) {
    return null;
  }

  const group =
    matched[
      Math.floor(
        Math.random() *
          matched.length
      )
    ];

  const reply =
    pickBanatReply(
      threadID,
      group.replies
    );

  if (reply) {
    rememberBanatReply(
      threadID,
      reply
    );
  }

  return reply;
}

function getBanatConversationReply(
  body,
  threadID = ""
) {
  const direct =
    getTriggerReply(
      body,
      threadID
    );

  if (direct) {
    return direct;
  }

  const fallback =
    groups.flatMap(
      group =>
        group.replies
    );

  const reply =
    pickBanatReply(
      threadID,
      fallback
    );

  if (reply) {
    rememberBanatReply(
      threadID,
      reply
    );
  }

  return reply;
}

module.exports = {
  groups,
  getTriggerReply,
  getBanatConversationReply
};
