
"use strict";

const {
  rememberBanatReply,
  pickBanatReply
} = require("./banat-memory");

// ============================================
// CRESI HUMAN-LIKE BANAT ENGINE
// ============================================

const COOLDOWN_MS = 4000;
const THREAD_COOLDOWN = new Map();

const groups = [
  {
    name: "greetings",
    triggers: [
      "hi", "hello", "hey", "hoy", "uy",
      "kumusta", "kamusta", "good morning",
      "good afternoon", "good evening", "good night"
    ],
    replies: [
      "hello rin, may kailangan ka o bored ka lang?",
      "uy, buhay ka pa pala",
      "hi rin, anong kailangan mo ngayon?",
      "hello, sino ka nga ulit?",
      "uy ikaw na naman, wala ka bang ibang pinagkakaabalahan?",
      "good morning din, aga mo namang manggulo",
      "hello po, anong problema natin today?",
      "hi, sige ituloy mo na, nandito na ako",
      "uy kumusta, may sasabihin ka ba o hanggang hello lang?",
      "hello, ano na namang kalokohan 'yan?",
      "uy, naalala mo na naman ako ah",
      "hi rin, may lima kang segundo para magpaliwanag",
      "hello, may announcement ka ba?",
      "oh ikaw pala, akala ko notification lang",
      "hi, simulan mo na ang panggugulo mo",
      "hello rin, kumpleto na araw mo?",
      "uy, may ambag ka ba sa usapan o greeting lang?",
      "hello, ano ang ganap sa buhay mong magulo?",
      "uy, present ka na naman sa attendance",
      "hi, may sasabihin ka ba o gusto mo lang manggulo?"
    ]
  },
  {
    name: "questions",
    triggers: [
      "bakit", "paano", "pano", "ano", "sino",
      "saan", "kailan", "alin", "talaga",
      "totoo ba", "sure ka", "weh"
    ],
    replies: [
      "bakit, may quiz ba tayo ngayon?",
      "ano raw? pakilinaw, hindi ako manghuhula",
      "paano ko malalaman kung ikaw mismo malabo magtanong?",
      "sino raw? bakit parang may attendance?",
      "saan? sa lugar na hindi mo pa napupuntahan",
      "talaga ba, may ebidensya o tiwala lang sa sarili?",
      "weh, ulitin mo nga nang may konting sense",
      "tanong ka nang tanong, may premyo ba 'to?",
      "hindi ko gets, pero sige ituloy mo ang pagpapahirap",
      "bakit parang ako pa ang kailangan mag-adjust sa tanong mo?",
      "ano na naman, may bagong episode ba?",
      "sure ka na ba o gusto mo pang mag-isip?",
      "tanong mo muna nang maayos, baka maintindihan ko",
      "ano raw ulit? nag-loading ako sa tanong mo",
      "sige nga, ikaw muna sumagot sa sarili mong tanong",
      "may context ba 'yan o hulaan challenge?",
      "hindi ako psychic, pakikumpleto naman",
      "bakit parang may interrogation tayo ngayon?",
      "ano ang gusto mong marinig na sagot?",
      "sige, tanong mo nang buo para hindi tayo paikot-ikot"
    ]
  },
  {
    name: "laughter",
    triggers: [
      "haha", "hahaha", "hahahaha", "hehe",
      "hehehe", "lol", "lmao", "😭", "🤣", "😂"
    ],
    replies: [
      "tawa ka pa, ikaw naman ang dahilan ng gulo",
      "ano nakakatawa, kwento mo baka matawa rin ako",
      "huy wag ka masyadong masaya, wala ka pang napapatunayan",
      "HAHAHA sige ikaw na masaya",
      "tawa muna bago mag-isip no?",
      "ayan na naman, may sariling comedy show",
      "ang saya mo naman, may nanalo ba sa raffle?",
      "natawa ka na? sige balik na tayo sa realidad",
      "hindi ko alam kung nakakatawa ka o natutuwa ka lang sa sarili mo",
      "sige lang, support kita sa hobby mong tumawa",
      "HAHAHA anong nakain mo?",
      "tawa ka nang tawa, share mo naman ang joke",
      "ikaw lang ba natatawa diyan?",
      "ayan na, may audience na ang sarili mong joke",
      "sige pa, baka sumakit tiyan mo sa kakatawa",
      "hahaha, may point ba o sound effects lang?",
      "ang saya mo, parang may sahod kang natanggap",
      "natawa ka na, ako naman magtatanong: bakit?",
      "hahaha, may kasunod pa ba o credits na?",
      "tawang-tawa ka naman, share mo ang kaligayahan mo"
    ]
  },
  {
    name: "agreement",
    triggers: [
      "oo", "opo", "sige", "ge", "okay",
      "ok", "oki", "noted", "gets", "sure", "fine"
    ],
    replies: [
      "buti naman, may desisyon ka rin",
      "sige, screenshot ko 'yan baka makalimutan mo",
      "okay, tapos na ba ang meeting natin?",
      "noted with matching pagod",
      "ge, ikaw na bahala sa buhay mo",
      "sige na nga, ang kulit mo rin",
      "okay po, may iba pa po ba tayong problema?",
      "gets mo talaga o ayaw mo lang magtanong ulit?",
      "fine, kunwari kumbinsido ako",
      "sige, next topic naman bago tayo tumanda rito",
      "okay, noted sa aking imaginary notebook",
      "oo na, panalo ka na sa sarili mong argumento",
      "sige, huwag mo nang ulitin baka maniwala ako",
      "ge, basta huwag mo akong sisihin mamaya",
      "okay, at least may natapos din tayo",
      "noted, kahit hindi ko hiniling ang update",
      "sige, move on na tayo bago ka mag-recap",
      "okay, may kasunod pa ba ang desisyon mo?",
      "sige, ikaw na ang bahala sa susunod na kabanata",
      "okay, at least nagkaintindihan tayo kunwari"
    ]
  },
  {
    name: "disagreement",
    triggers: [
      "hindi", "ayaw", "no", "wrong",
      "mali", "impossible", "never"
    ],
    replies: [
      "edi huwag, hindi naman kita pinipilit",
      "okay, noted ang pagtutol mo",
      "hindi raw, sige may sarili kang paninindigan",
      "mali pala, edi ipaliwanag mo nang maayos",
      "sige ikaw na muna ang tama sa sarili mong mundo",
      "okay, may rebuttal ka ba o hanggang hindi lang?",
      "ayaw mo pala, bakit ka pa sumasagot?",
      "fine, ilaban mo muna bago ka magbago ng isip",
      "sige, explain mo naman kung bakit",
      "hindi ka sang-ayon, noted. may dahilan ba?",
      "okay, hindi kita pipilitin sa opinyon mo",
      "edi sabihin mo kung ano ang tama para sa'yo",
      "sige, huwag tayong mag-away dahil lang sa sagot",
      "hindi raw, sige bigyan natin ng chance ang paliwanag mo",
      "okay, may iba ka bang dahilan bukod sa ayaw mo?",
      "sige, ipagtanggol mo ang panig mo",
      "hindi pala, edi malinaw na ang sagot",
      "okay, hindi lahat ng usapan kailangan pagtatalunan"
    ]
  },
  {
    name: "insults",
    triggers: [
      "bobo", "tanga", "gago", "ulol",
      "weak", "gunggong", "tangina", "pikon",
      "trash", "skill issue", "baliw"
    ],
    replies: [
      "ayan na, naubusan na ng matinong sasabihin",
      "ang bilis mo naman maubusan ng argumento",
      "sige pa, baka sakaling may point sa susunod",
      "kung insulto lang ang ambag mo, mahaba-habang usapan 'to",
      "relax, hindi naman kita kinakaaway nang seryoso",
      "ikaw na, may medalya ka na sa kakareklamo",
      "ang ingay mo, pakisama naman ng paliwanag",
      "okay, tapos na ba ang speech mo?",
      "sige, sagutin mo na lang yung sinabi ko",
      "hindi sapat ang lakas ng boses para maging tama",
      "may kasunod pa ba o ubos na ang vocabulary?",
      "ayan na naman tayo, balik sa topic kapag ready ka na",
      "sige, ilabas mo lang lahat ng stock lines mo",
      "parang galit ka sa keyboard mo ah",
      "okay, pero nasaan ang punto?",
      "ang tapang mo naman sa chat, ano'ng kasunod?",
      "sige, personal best mo na ba 'yan?",
      "insulto na naman, wala na bang bagong script?",
      "ang dami mong sinasabi, nasaan ang argumento?",
      "sige, mag-isip ka muna bago mag-round two",
      "hindi ako natitinag sa caps lock mo",
      "may bago ka bang banat o rerun na naman?",
      "okay, tapos na ang introduction mo?",
      "sige, balik tayo sa topic kapag tapos ka nang magalit"
    ]
  },
  {
    name: "bot",
    triggers: ["bot", "robot", "ai"],
    replies: [
      "ikaw bot, bakit ikaw ang paulit-ulit?",
      "bot nang bot, may bago ka bang linya?",
      "edi bot, at least may sagot ako",
      "sige, ikaw na detective ng chat",
      "pumapalag ka pa sa bot, ano na lang kaya sa tao?",
      "bot na kung bot, may tanong ka pa ba?",
      "paulit-ulit ka rin naman, magkamag-anak yata tayo",
      "sige, hanapan mo pa ako ng birth certificate",
      "nahuli mo ako, may premyo ka ba?",
      "bot nga, pero ikaw ang hindi matapos-tapos magsalita",
      "sige, tawagin mo pa akong bot baka magbago ako",
      "ikaw ang expert, ikaw na mag-debug sa sarili mo",
      "bot ako, ikaw naman certified makulit",
      "okay detective, ano pang kaso ang lutasin natin?"
    ]
  },
  {
    name: "jaiden",
    triggers: ["jaiden"],
    replies: [
      "jaiden na naman, may attendance ba?",
      "ayan, pangalan na naman niya ang topic",
      "jaiden? bakit, may hinahanap ka?",
      "si jaiden na naman ang bida sa usapan",
      "hindi kumpleto araw mo pag walang jaiden no?",
      "jaiden na naman, ibang pangalan naman para maiba",
      "may update ba kay jaiden o name drop lang?",
      "bakit siya na naman, may fan club ba rito?"
    ]
  },
  {
    name: "compliments",
    triggers: [
      "maganda", "gwapo", "cute", "handsome",
      "pretty", "love you", "mahal kita", "miss kita"
    ],
    replies: [
      "alam ko, hindi mo na kailangang ipaalala",
      "hala, may kailangan ka ba sa akin?",
      "ulitin mo nga, baka may favor kang kasunod",
      "uy, lambing mode ka ngayon ah",
      "sige, noted ang iyong biglaang appreciation",
      "may kapalit ba 'yang compliment mo?",
      "miss mo ako o wala ka lang makausap?",
      "love you rin, sa tamang panahon at tamang internet",
      "cute talaga ako, ikaw kailan?",
      "salamat, ngayon balik tayo sa pang-aasar"
    ]
  }
];

const fallbackReplies = [
  "ah ganon ba, sige ikwento mo pa",
  "okay, anong gusto mong mangyari ngayon?",
  "sige, narinig kita. may kasunod pa ba?",
  "ikaw talaga, kung ano-ano na naman",
  "interesting, kahit hindi ko alam kung bakit",
  "edi wow, ano pa ang balita sa buhay mo?",
  "sige tuloy mo, nakikinig naman ako kunwari",
  "at ano ang gusto mong isagot ko diyan?",
  "okay, noted. may kailangan ka pa?",
  "hindi ko alam kung saan papunta 'to pero sige",
  "aba, may update na naman sa buhay mo",
  "sige, bigyan natin ng pagkakataon ang kwento mo",
  "ikaw na naman ang may bagong announcement",
  "ah talaga? tapos ano ang plot twist?",
  "hmm, sige nga. ipaliwanag mo pa",
  "okay, may point ka ba o nagkukuwento ka lang?",
  "sige, tuloy mo bago ako mawalan ng interes",
  "ayan na naman tayo sa topic mong walang katapusan",
  "narinig ko, hindi ibig sabihin sang-ayon ako",
  "sige, anong next episode natin?",
  "ano pa, may part two ba 'yan?",
  "ikaw talaga, hindi nauubusan ng sasabihin",
  "ah ganun, noted sa ating munting pagpupulong",
  "sige lang, hindi naman kita pinuputol",
  "may gusto ka pang sabihin o testing lang kung online ako?",
  "okay, anong gusto mong mangyari pagkatapos niyan?",
  "sige, ipagpatuloy mo ang iyong talumpati",
  "ayan, may bagong impormasyon na naman tayong hindi hiniling",
  "ah okay, salamat sa napakahalagang balitang 'yan",
  "sige, may iba ka pa bang topic?",
  "hmm, interesting. may resibo ka ba diyan?",
  "sige, sige, kunwari nagulat ako",
  "ano na naman 'yan, bagong episode?",
  "okay, ikaw muna ang bida sa usapan",
  "sige, tuloy mo lang ang iyong press conference",
  "may punto ka ba o warm-up pa lang 'yan?",
  "ayan, may laman na naman ang group chat",
  "sige, magpaliwanag ka. hindi kita minamadali",
  "ah okay, at ano ang reaksyon na inaasahan mo?",
  "sige, ipagpatuloy mo ang iyong contribution",
  "parang may gusto kang sabihin, diretsuhin mo na",
  "okay, may kasunod pa ba ang balitang 'yan?",
  "sige, naghihintay ako ng mas nakakagulat na part",
  "ikaw na naman ang may bagong theory",
  "hmm, sige. pag-usapan natin 'yan",
  "okay, at saan papasok ang point mo?",
  "sige, noted. hindi ko muna huhusgahan",
  "ah ganun pala, may bago na naman akong natutunan",
  "sige, go on. huwag kang mahiya",
  "okay, tapos ano ang gusto mong sabihin talaga?",
  "aba, may pa-update na naman tayo ngayon",
  "sige, ako na naman ang audience mo",
  "hmm, may context ba bago ako mag-react?",
  "sige, sabihin mo nang diretso para matapos tayo",
  "okay, ano ang next move mo diyan?",
  "ikaw talaga, may sariling programa sa chat",
  "sige, kwento mo. may popcorn lang akong kulang",
  "okay, at bakit parang ako ang kailangan mag-solve?",
  "sige, magpatuloy ka sa iyong mission",
  "ah, may point ka siguro. hanapin pa natin",
  "sige, sabihin mo lahat bago ka mag-iba ng topic",
  "okay, hindi ko inaasahan 'yan, pero sige",
  "ano pa ang balita sa iyong munting mundo?",
  "sige, ikaw ang may hawak ng mikropono",
  "okay, may gusto ka bang itanong o mag-share lang?",
  "hmm, sige. bigyan kita ng oras mag-isip",
  "ah ganun ba, sige na nga",
  "okay, narito na naman tayo sa usapang ito",
  "sige, hindi ko haharangin ang iyong creativity",
  "may continuation ba 'yan o credits na?",
  "okay, sabihin mo pa bago ka maunahan ng iba",
  "sige, tanggap ko ang update mo kahit walang request",
  "hmm, sige. mukhang may kuwento pa 'yan",
  "okay, hindi pa tapos ang episode natin",
  "sige, ituloy mo ang iyong broadcast",
  "ano pa, may announcement ka pa ba?",
  "okay, noted. move tayo sa susunod na topic",
  "sige, hintayin natin ang plot twist",
  "ikaw na naman ang source ng bagong impormasyon",
  "okay, go. huwag mo lang akong gawing narrator",
  "sige, may follow-up question ako mamaya",
  "ah okay, at anong gagawin natin sa impormasyong 'yan?",
  "sige, interesting ang timing mo",
  "okay, hindi ko alam kung dapat akong matuwa",
  "sige, magpatuloy ka habang may momentum ka pa",
  "hmm, may kulang sa kuwento mo. ano 'yon?",
  "okay, sige. ikaw muna ang may floor",
  "sige, may sasabihin ka pa ba bago ako mag-react?",
  "ah, noted. napakahalaga ng update na 'yan",
  "okay, sa susunod na balita ulit",
  "sige, mukhang mahaba-habang usapan 'to",
  "ikaw talaga, may bagong topic kada minuto",
  "okay, tapusin mo muna bago ako magtanong",
  "sige, hindi kita iiwan sa ere. ituloy mo",
  "hmm, sige. nakikinig ang buong imaginary audience",
  "okay, anong gusto mong reaksyon ko rito?",
  "sige, may twist ba o diretso lang ang kuwento?",
  "ah, interesting. sabihin mo pa nang kaunti",
  "okay, hindi ako handa pero nandito na tayo",
  "sige, bigyan natin ng chance ang topic mo",
  "hmm, mukhang may sequel pa 'yan",
  "okay, ikaw ang bahala sa susunod na linya",
  "sige, go lang. hindi pa naman tayo bayad kada message",
  "aba, may bagong mensahe na naman",
  "sige, sabihin mo ang buong istorya",
  "okay, may gusto ka bang linawin?",
  "ikaw na naman ang may bagong topic",
  "hmm, mukhang kailangan natin ng context",
  "sige, ipagpatuloy mo ang iyong broadcast",
  "okay, ano ang pinakapunto ng sinabi mo?",
  "ah ganun pala, may follow-up pa ba?",
  "sige, ikaw ang bahala sa susunod na eksena",
  "okay, noted. hindi ko muna papatulan",
  "sige, magbigay ka pa ng detalye",
  "ano pa ang bago sa iyong mundo?",
  "okay, nandito pa ako. ano'ng kasunod?",
  "sige, ituloy mo lang, hindi pa naman tapos ang usapan",
  "hmm, parang may gusto kang iparating",
  "okay, ano ang gusto mong pag-usapan?",
  "sige, may karugtong pa ba ang story time mo?",
  "ah okay, malinaw. siguro",
  "sige, isa-isahin natin bago ka magdagdag ulit",
  "okay, salamat sa update na hindi ko in-expect",
  "hmm, mukhang may sasabihin ka pang iba",
  "sige, magpatuloy ka, may oras pa tayo",
  "okay, ano ang ending ng kuwento mo?",
  "ikaw talaga, hindi nauubusan ng paksa",
  "sige, ilabas mo na ang buong konteksto",
  "okay, at anong sagot ang hinahanap mo?",
  "hmm, sige. pakituloy ang report",
  "aba, may bagong development na naman",
  "sige, narito ang iyong audience",
  "okay, may tanong ka ba sa akin?",
  "sige, ipaliwanag mo nang hindi paikot-ikot",
  "hmm, okay. anong susunod?",
  "sige, may iba ka pa bang gustong idagdag?",
  "okay, at bakit mo naisip 'yan?",
  "aba, may bagong balita na naman tayo",
  "sige, hindi kita pipigilan sa pagkukuwento",
  "okay, tapusin mo muna ang thought mo",
  "hmm, sige. ano pa ang meron?",
  "okay, sige, ikaw muna ang magsalita",
  "sige, gusto ko munang malaman ang context",
  "aba, may update na naman ang ating correspondent",
  "okay, sige, huwag mong bitinin ang kuwento",
  "hmm, anong gusto mong mangyari pagkatapos nito?",
  "sige, may iba ka pang gustong sabihin?",
  "okay, noted. move on na tayo kapag ready ka na"
];

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTrigger(text, trigger) {
  const t = normalize(trigger);

  if (!t) return false;

  if (/^[a-z0-9]+$/i.test(t) && t.length <= 3) {
    return new RegExp(
      `\\b${escapeRegex(t)}\\b`,
      "i"
    ).test(text);
  }

  return text.includes(t);
}

function findGroups(body) {
  const text = normalize(body);

  if (!text) return [];

  return groups.filter(group =>
    group.triggers.some(trigger =>
      matchesTrigger(text, trigger)
    )
  );
}

function chooseReply(replies, threadID = "") {
  if (!Array.isArray(replies) || replies.length === 0) {
    return null;
  }

  let reply = null;

  try {
    reply = pickBanatReply(threadID, replies);
  } catch (error) {
    // Random fallback if memory fails.
  }

  if (
    typeof reply !== "string" ||
    !reply.trim() ||
    !replies.includes(reply)
  ) {
    reply = replies[
      Math.floor(Math.random() * replies.length)
    ];
  }

  return reply;
}

function getTriggerReply(body, threadID = "") {
  const matched = findGroups(body);

  if (!matched.length) return null;

  const id = String(threadID || "default");
  const group = matched[
    Math.floor(Math.random() * matched.length)
  ];

  const reply = chooseReply(group.replies, id);

  if (reply) {
    try {
      rememberBanatReply(id, reply);
    } catch (error) {}
  }

  return reply;
}

function getBanatConversationReply(body, threadID = "") {
  const text = normalize(body);

  if (!text) return null;

  const id = String(threadID || "default");
  const now = Date.now();
  const lastReply = THREAD_COOLDOWN.get(id) || 0;

  if (now - lastReply < COOLDOWN_MS) {
    return null;
  }

  const matched = findGroups(text);
  let reply;

  if (matched.length) {
    const group = matched[
      Math.floor(Math.random() * matched.length)
    ];

    reply = chooseReply(group.replies, id);
  } else {
    reply = chooseReply(fallbackReplies, id);
  }

  if (!reply) return null;

  THREAD_COOLDOWN.set(id, now);

  try {
    rememberBanatReply(id, reply);
  } catch (error) {}

  return reply;
}

function clearBanatCooldown(threadID) {
  if (threadID === undefined) {
    THREAD_COOLDOWN.clear();
    return;
  }

  THREAD_COOLDOWN.delete(String(threadID));
}

module.exports = {
  groups,
  findGroups,
  getTriggerReply,
  getBanatConversationReply,
  clearBanatCooldown
};
