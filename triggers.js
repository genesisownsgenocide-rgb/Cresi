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
      "bot nang bot, aning ka?",
      "ikaw mukhang bot tanga",
      "wag aning sa ope",
      "bot nga yung lolo mo",
      "o na, bot na",
      "pumapalag ka pala sa bot",
      "may bot pala rito",
      "asan nga yung bot, kulit mo",
      "tangina, paulit-ulit ka",
      "paulit-ulit ka ba?",
      "bot ka nang bot, wala ka nang bago",
      "bobo, wala akong pake sa sinasabi mo",
      "edi bot, kuwento mo yan",
      "amoy basang aso tong kumag na to",
      "puta, baho mo, lumayo ka nga",
      "bot na nga, maingay pa",
      "ikaw yata ang tau-tauhan dito",
      "parang iisa lang ang alam mong sabihin",
      "sige, ulitin mo pa",
      "wala ka na bang ibang alam?",
      "paulit-ulit na lang bibig mo",
      "parang sirang plaka ka",
      "iisang salita lang umiikot sa ulo mo",
      "bot ka nga, pati sagot mo paulit-ulit",
      "ang dami mong sinasabi, iisa lang naman",
      "may bago ka bang banat?",
      "hindi ka ba nagsasawa sa sarili mong salita?",
      "paulit-ulit, akala mo nakakatawa",
      "ikaw ang tunay na sirang plaka",
      "sige lang, baka may maisip ka ring bago",
      "ang bilis mong maubusan ng sasabihin",
      "wala na bang laman yang utak mo?",
      "parang nakasulat na lang sa noo mo ang kabobohan",
      "ang hirap mong kausap, paikot-ikot",
      "sino ba nagturo sayo magsalita?",
      "mukhang kailangan mong mag-isip muna",
      "hindi lahat ng pumapasok sa isip sinasabi",
      "bago ka magsalita, isipin mo muna",
      "mabagal yata ang takbo ng isip mo",
      "ang isip mo yata nasa bakasyon",
      "bumalik ka muna sa katinuan",
      "hanapin mo muna ang matinong sagot",
      "nawala yata ang bait mo",
      "nawala rin yata ang sentido kumon mo",
      "ang yabang mo, wala namang laman",
      "ang tapang mo, wala namang patunay"
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
      "yun na yun?",
      "yan na ang pinakamagaling mong banat?",
      "parang pinag-isipan mo pa talaga yan",
      "ang tapang mo naman para sa ganyang banat",
      "ang lakas ng loob, ang hina ng banat",
      "ang ingay mo pero walang laman",
      "may punto ka ba?",
      "saan banda yung nakakatawa?",
      "pinilit mo pa talaga",
      "sayang ang oras mo",
      "sayang ang pag-iisip mo kung yan lang",
      "masyado kang kampante sa maling sagot",
      "ang taas ng kumpiyansa, ang baba ng tama",
      "ang yabang mo, nasaan ang patunay?",
      "may patunay ka ba o puro salita?",
      "puro ka salita, kulang ka sa laman",
      "ang dami mong sinabi, wala namang saysay",
      "mahaba ang sinabi, wala namang punto",
      "ikaw lang yata ang natuwa sa sinabi mo",
      "walang natawa, ikaw lang",
      "hindi umabot sa nakakatawa",
      "hindi man lang tumama",
      "parang hangin lang yung banat mo",
      "walang epekto",
      "wala kang tinamaan",
      "masakit ba dapat yan?",
      "ganyan na ba kalakas ang banat mo?",
      "parang wala ka nang maisip",
      "mag-isip ka muna bago bumanat",
      "huminga ka muna bago magsalita",
      "kumalma ka muna, nagmamadali ka",
      "dahan-dahan lang, nauuna bibig mo sa isip mo",
      "isip muna bago salita",
      "salita muna nang salita, isip wala",
      "nag-iisip ka ba o basta ka lang nagsasalita?",
      "gumagana pa ba utak mo?",
      "nasa tamang kalagayan ka ba?",
      "parang wala ka sa sarili",
      "bumalik ka muna sa realidad",
      "naligaw yata ang isip mo",
      "naligaw ka na sa sarili mong sinasabi",
      "hindi mo na alam ang punto mo",
      "nakalimutan mo yata kung ano ang pinag-uusapan",
      "lumayo ka na sa paksa",
      "balik ka muna sa punto",
      "kung may punto ka man",
      "may patutunguhan ba yang sinasabi mo?",
      "saan mo naman nakuha yan?",
      "sino nagsabi sayo niyan?",
      "sarili mo lang ba nagsabi niyan?",
      "galing ba yan sa isip mo o sa imahinasyon?",
      "puro hula ang dala mo",
      "puro palagay, walang patunay",
      "palagay mo lang yan",
      "hindi dahil sigurado ka ay tama ka",
      "hindi sapat ang kumpiyansa para maging tama",
      "malakas ang loob mo sa maling bagay",
      "ang bilis mong magpasya kahit wala kang alam",
      "ang bilis mong humatol",
      "ang bilis mong magsalita, mabagal naman umunawa",
      "mabilis ang bibig, mabagal ang isip",
      "mabilis ang salita, kulang sa pag-iisip",
      "parang hindi mo binasa bago mo sinabi",
      "parang hindi mo inintindi",
      "naiintindihan mo ba talaga?",
      "basahin mo ulit bago ka sumagot",
      "intindihin mo muna bago ka pumalag",
      "hindi lahat ng sagot kailangang pilitin",
      "pwede namang tumahimik kung walang alam",
      "minsan mas maganda ang tahimik",
      "tumahimik ka muna at mag-isip",
      "pahinga muna ang bibig mo",
      "pagod na kami sa paulit-ulit mong banat",
      "pare-pareho lang sinasabi mo",
      "wala ka na bang bagong maisip?",
      "luma na yang banat mo",
      "ilang ulit mo na yan sinabi?",
      "narinig na namin yan",
      "wala nang bago sa sinasabi mo",
      "paulit-ulit na lang",
      "parang sirang plaka ka",
      "umiikot ka lang sa parehong salita",
      "ikaw mismo ang naliligaw sa sinasabi mo",
      "gulo ng isip mo",
      "gulo ng paliwanag mo",
      "gulo ng argumento mo",
      "wala kang maayos na punto",
      "wala kang matibay na sagot",
      "wala kang maipakitang patunay",
      "salita lang ang puhunan mo",
      "tapang lang ang dala mo",
      "yabang lang ang meron ka",
      "yabang muna bago isip",
      "kumpiyansa muna bago katotohanan",
      "mali na nga, matapang pa",
      "mali na nga, ipinagmamalaki pa",
      "maling sagot, malaking kumpiyansa",
      "ang kapal ng kumpiyansa mo",
      "ang kapal ng mukha mo sa ganyang banat",
      "hindi ka ba nahihiya sa sinabi mo?",
      "ako na ang nahiya para sayo",
      "nakakahiya naman yan",
      "pinag-isipan mo ba talaga yan?",
      "yan na talaga ang naisip mo?",
      "yan ang napili mong sabihin?",
      "marami kang pagpipilian, yan pa pinili mo",
      "maling sagot na nga, mali pa ang dating",
      "wala nang maisalba sa sinabi mo",
      "mahihirapan kang ipagtanggol yan",
      "kahit ikaw hindi kumbinsido sa sinabi mo",
      "parang ikaw mismo ayaw sa sarili mong sagot",
      "hindi mo kayang panindigan ang sinabi mo",
      "kapag tinanong ka, mawawala ka rin",
      "isang tanong lang, ligwak ka na",
      "isang tanong lang, tahimik ka agad",
      "isang tanong lang, wala ka nang sagot",
      "handa ka ba sa susunod na tanong?",
      "baka maligaw ka ulit",
      "baka mawala na naman ang punto mo",
      "baka makalimutan mo na naman sinabi mo",
      "tandaan mo muna yung sinabi mo",
      "huwag mong salungatin ang sarili mo",
      "ikaw rin ang kumokontra sa sarili mo",
      "sarili mong salita ang sumisira sayo",
      "sarili mong sagot ang bumabaon sayo",
      "wala nang kailangang gawin, ikaw na ang nagpapatalo sa sarili mo",
      "hindi kita kailangang talunin, ginagawa mo na mag-isa",
      "hindi ko kailangang bumanat, sapat na yang sinabi mo",
      "hindi ko na kailangang sagutin yan",
      "kusang bumagsak ang punto mo",
      "kusang nawala ang saysay",
      "wala nang kailangang idagdag",
      "sapat na yung kahihiyan",
      "tama na, baka lalo ka pang mapahiya",
      "huwag mo nang dagdagan",
      "habang nadadagdagan sinasabi mo, lalo kang sablay",
      "mas marami kang salita, mas lumalabas ang kabobohan",
      "mas mahaba ang paliwanag, mas lalong magulo",
      "ang galing mong gumawa ng problema sa simpleng tanong",
      "ang galing mong palalimin ang walang laman",
      "pinapahirapan mo pati sarili mo",
      "ang layo ng sagot mo sa tanong",
      "tanong dito, sagot kung saan",
      "parang ibang usapan ang sinasagot mo",
      "nakikinig ka ba sa sarili mong sinasabi?",
      "naiintindihan mo ba ang sariling sinabi mo?",
      "mukhang hindi",
      "halatang hindi",
      "kitang-kita ang kalituhan",
      "nalilito ka na",
      "huwag mong itago, litong-lito ka na",
      "aminin mo na lang na wala kang alam",
      "walang masama sa hindi alam, pero wag magkunwari",
      "mas okay ang umamin kaysa magpanggap",
      "nagpapanggap kang alam mo pero hindi naman",
      "ang tapang mong magkunwari",
      "magaling kang magpanggap na alam ang lahat",
      "hindi mo kailangang maging eksperto sa lahat",
      "hindi lahat ng usapan kailangan mong salihan",
      "hindi lahat ng tanong kailangan mong sagutin",
      "hindi lahat ng laban kailangan mong pasukan",
      "pinili mong pumasok, ngayon nahirapan ka",
      "pumasok ka sa usapan nang walang dalang bala",
      "salita lang dala mo",
      "wala kang maipakita kundi kumpiyansa",
      "kumpiyansa lang ang sandata mo",
      "pero wala namang tama",
      "puro palya",
      "puro sablay",
      "puro ligaw",
      "puro ingay",
      "puro yabang",
      "puro salita",
      "kulang sa laman",
      "kulang sa punto",
      "kulang sa patunay",
      "kulang sa pag-unawa",
      "kulang sa pag-iisip",
      "kulang sa lahat",
      "parang minadali mo",
      "parang hindi pinag-isipan",
      "parang bahala na ang sagot",
      "bahala na ang bibig, wala nang isip",
      "nauna na naman ang bibig",
      "naiwan na naman ang utak",
      "naiwan sa likod ang pag-iisip",
      "hinabol ng bibig ang utak",
      "hindi umabot ang utak sa bibig",
      "masyadong mabilis ang bibig mo",
      "pigil-pigil din kapag walang saysay",
      "huwag mong ubusin ang salita sa wala",
      "sayang ang bawat titik",
      "sayang ang oras sa ganyang sagot",
      "sayang ang pagod mo",
      "sayang ang lakas ng loob mo",
      "sayang ang pagkakataon mong manahimik",
      "pwede sanang maayos, pinili mong magulo",
      "pwede sanang tama, pinili mong mali",
      "pwede sanang tahimik, pinili mong maingay",
      "pwede sanang matino, pinili mong ganyan",
      "sarili mo lang nagpapahirap sayo",
      "ikaw rin ang gumagawa ng sariling problema",
      "ikaw rin ang sumisira sa sarili mong punto",
      "ikaw rin ang bumubutas sa sarili mong argumento",
      "huwag mong sisihin ang iba sa sarili mong sablay",
      "sarili mong salita ang problema",
      "sarili mong yabang ang kalaban mo",
      "yabang mo ang unang bumagsak",
      "kumpiyansa mo ang unang sumuko",
      "punto mo ang unang nawala",
      "sagot mo ang unang naligaw",
      "wala pang simula, tapos na agad",
      "hindi man lang umabot sa unang hakbang",
      "hindi umabot sa unang punto",
      "simula pa lang, talo na ang paliwanag",
      "mahirap ipagtanggol ang walang laman",
      "mahirap panindigan ang maling sagot",
      "mahirap gawing tama ang mali",
      "kahit anong ikot mo, mali pa rin",
      "kahit anong paliwanag mo, sablay pa rin",
      "kahit dagdagan mo, walang saysay pa rin",
      "kahit lakasan mo boses mo, hindi magiging tama",
      "hindi lumalakas ang katotohanan dahil sa sigaw",
      "hindi nagiging tama ang mali dahil sa kumpiyansa",
      "hindi nagiging totoo ang hula dahil paulit-ulit",
      "hindi nagiging matalino ang mahabang salita",
      "hindi sapat ang maraming salita",
      "mas mahalaga ang laman kaysa ingay",
      "mas mahalaga ang patunay kaysa yabang",
      "mas mahalaga ang isip kaysa tapang",
      "isipin mo muna bago ka muling bumanat",
      "subukan mong intindihin bago ka pumalag",
      "subukan mong maghanap ng patunay",
      "subukan mong huwag hulaan ang lahat",
      "subukan mong maging tama kahit minsan",
      "baka sakaling gumana",
      "baka sakaling may saysay sa susunod",
      "baka sakaling tumama naman",
      "baka sakaling may punto",
      "baka sakaling may patunay",
      "baka sakaling may laman",
      "baka sakaling matauhan ka",
      "baka sakaling matahimik ka",
      "baka sakaling mapagod ka rin",
      "pero mukhang hindi",
      "mukhang malayo pa",
      "mukhang mahaba pa ang paglalakbay mo",
      "mahaba pa ang kailangan mong matutunan",
      "marami ka pang kakaining bigas",
      "marami ka pang kailangang matutunan",
      "mag-aral ka muna bago magyabang",
      "matuto ka muna bago pumalag",
      "umunawa ka muna bago humatol",
      "makinig ka muna bago sumagot",
      "mag-isip ka muna bago magpadala",
      "huwag puro bibig",
      "gamitin mo rin yang utak mo",
      "sayang naman kung hindi ginagamit",
      "may utak ka naman siguro",
      "baka nakatago lang",
      "hanapin mo muna",
      "baka naiwan mo kung saan",
      "baka natabunan ng yabang",
      "baka nalunod sa kumpiyansa",
      "baka nawala sa ingay",
      "baka kailangan mo lang tumahimik",
      "tahimik ka muna para makapag-isip",
      "isang minuto ng katahimikan para sa punto mo",
      "ipagdasal natin ang nawalang saysay",
      "hanapin natin ang nawawalang punto",
      "hanapin natin ang nawawalang isip",
      "hanapin natin ang nawawalang patunay",
      "hanapin natin ang nawawalang katinuan",
      "parang nawawala lahat sayo",
      "pero yabang nandyan pa rin",
      "yun lang talaga ang hindi nawawala sayo",
      "yabang ang pinaka-matibay mong katangian",
      "kung yabang ang sukatan, panalo ka",
      "kung ingay ang sukatan, panalo ka",
      "kung salita ang sukatan, marami ka",
      "pero kung punto, kulang",
      "kung patunay, kulang",
      "kung pag-unawa, kulang",
      "kung sentido, kulang",
      "kung bait, pag-usapan natin",
      "huwag mong ipilit ang sarili mo sa usapang hindi mo naiintindihan",
      "lumabas ka muna sa usapan kung wala ka nang maisip",
      "magpahinga ka muna",
      "balikan mo kapag may maayos ka nang sagot",
      "balikan mo kapag may patunay ka na",
      "balikan mo kapag may punto ka na",
      "balikan mo kapag handa ka nang umunawa",
      "hanggang dito muna ang kabiguan mo",
      "tama na ang pagdurusa ng usapan",
      "itigil na natin bago pa lumala",
      "mas lumalala habang nagsasalita ka",
      "bawat dagdag mong salita, dagdag kahihiyan",
      "bawat sagot mo, lalo kang naliligaw",
      "bawat paliwanag mo, lalo kang bumabaon",
      "huminto ka na habang may natitira pang dangal",
      "salbahe na sa sarili mong dangal yang ginagawa mo",
      "huwag mo nang dagdagan ang sarili mong kahihiyan",
      "sapat na ang ipinakita mo",
      "nakita na namin ang kaya mo",
      "alam na namin ang antas mo",
      "hindi na kailangang ulitin",
      "naiintindihan na namin kung gaano ka kasablay",
      "tapos na ang palabas",
      "ibaba na ang tabing",
      "wala nang kailangang palakpakan",
      "wala nang kailangang ulitin",
      "sunod na banat na lang",
      "baka sakaling mas maayos",
      "pero huwag umasa nang sobra",
      "dahan-dahan lang sa kumpiyansa",
      "baka mauna na naman sa katotohanan",
      "huwag mong unahan ang sariling kakayahan",
      "kilalanin mo muna ang limitasyon mo",
      "hindi kahinaan ang pag-amin na mali",
      "pero ikaw yata takot umamin",
      "mas gusto mong ipaglaban ang mali",
      "kahit halata nang mali",
      "kahit ikaw mismo alam mong mali",
      "ipinagmamalaki mo pa rin",
      "ibang klase ang tibay ng mukha mo",
      "mas matibay pa sa argumento mo",
      "ang kapal, pero walang laman",
      "malakas ang loob, mahina ang patunay",
      "malakas ang boses, mahina ang punto",
      "malakas ang yabang, mahina ang isip",
      "malakas ang salita, mahina ang gawa",
      "malakas ang simula, mahina ang dulo",
      "mahina na nga, pinipilit pa",
      "sablay na nga, ipinagmamalaki pa",
      "mali na nga, galit pa",
      "wala nang sagot, galit na lang",
      "kapag wala nang punto, galit ang puhunan",
      "kapag wala nang patunay, sigaw ang dala",
      "kapag wala nang masasabi, paulit-ulit na lang",
      "kapag wala nang alam, lakas ng loob na lang",
      "at yun ang meron ka ngayon",
      "lakas ng loob at wala nang iba",
      "sige lang, patunayan mong kaya mong mas lumala",
      "may pagkakataon ka pang bumawi",
      "pero kailangan mong mag-isip",
      "at mukhang yun ang pinakamahirap para sayo"
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
