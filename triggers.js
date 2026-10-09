"use strict";

// PURE ASAR BANAT GENERATOR
// 5,000 unique casual Tagalog/Taglish replies
// No AI API. No external packages.

const openers = [
"HAHAHA", "Pre", "Tol", "Beh", "Hoy",
"Gagi", "Ulol", "Luh", "Eto na naman", "Ikaw na naman",
"Ay nako", "Grabe ka", "Teka", "Pucha", "Hala",
"Sus", "Aba", "Lakas mo", "Sige na", "Wow ah"
];

const subjects = [
"ka talaga", "mo talaga", "mong loko ka",
"mong ewan", "mong kulit", "mong sabaw",
"mong pasaway", "mong baliw", "mong gulo",
"mong istorbo", "mong epal", "mong kulit mo",
"mong walang preno", "mong makulit", "mong papansin",
"mong makapal mukha", "mong feelingero",
"mong bida-bida", "mong puro satsat", "mong angas",
"mong tahol", "mong sabik sa gulo", "mong salot sa GC",
"mong walang pahinga", "mong walang tigil",
"mong hindi nauubusan", "mong pasikat",
"mong nagmamagaling", "mong puro dada",
"mong sakit sa ulo"
];

const actions = [
"nagsasalita ka na naman",
"nagpaparamdam ka na naman",
"nagkalat ka na naman",
"nanggugulo ka na naman",
"nagpapansin ka na naman",
"naghahanap ka na naman ng away",
"nag-iingay ka na naman",
"sumasawsaw ka na naman",
"nagpapatawa ka na naman",
"nagpapakitang-gilas ka na naman",
"nang-aasar ka na naman",
"nagmamarunong ka na naman",
"nagpaparinig ka na naman",
"nagmamagaling ka na naman",
"nagpaparamdam kahit walang nagtatanong",
"nagdadaldal kahit walang nagtatanong",
"nanghihingi na naman ng pansin",
"gumagawa na naman ng eksena",
"nagsisimula na naman ng gulo",
"nagpapakilala na naman ang topak mo",
"nagpapakita na naman ang kulit mo",
"bumubungad na naman mukha mo",
"nagpapalakas na naman ng loob",
"nagpapasikat na naman sa GC",
"nagmumukhang ewan na naman",
"nagpapahirap na naman sa pagbabasa",
"nang-iistorbo na naman ng tahimik",
"naghahanap na naman ng kakampi",
"nagpapahaba na naman ng usapan",
"nagsasayang na naman ng oras"
];

const endings = [
"wala ka bang ibang libangan?",
"sino bang nagtanong sa'yo?",
"hindi ka ba napapagod sa sarili mo?",
"pahinga mo rin yang bibig mo.",
"ikaw na naman ang salot dito.",
"tahimik ka muna, sumasakit ulo ko.",
"ano na naman pinaglalaban mo?",
"wala ka na namang magawa sa buhay?",
"sino ka na naman dito?",
"may topak ka na naman ata.",
"hindi ka talaga nauubusan ng kalokohan.",
"sana matapos na episode mo.",
"puro ka na lang ganyan.",
"ikaw talaga pinakamakulit sa lahat.",
"wala ka bang off button?",
"parang wala kang balak tumino.",
"ano bang problema mo sa mundo?",
"hindi ka ba pinapatulog sa bahay?",
"may sariling mundo ka talaga.",
"tigil mo na yan, nakakaumay ka.",
"sige pa, kulang pa kalat mo.",
"parang araw-araw ka na lang may topak.",
"hindi ka na nahiya oh.",
"puro ka ingay, wala ka nang ginawa.",
"bakit ba ang kulit mo?",
"sana maubos na yang energy mo.",
"ikaw na naman ang dahilan ng gulo.",
"wala ka bang ibang alam gawin?",
"hindi ka talaga tinatablan ng hiya.",
"sige, ilabas mo na lahat ng kalokohan mo."
];

const replies = [];
const seen = new Set();

outer:
for (const opener of openers) {
for (const subject of subjects) {
for (const action of actions) {
for (const ending of endings) {
const reply =
"${opener}, ${subject} ${action}, ${ending}";

    if (!seen.has(reply)) {
      seen.add(reply);
      replies.push(reply);
    }

    if (replies.length >= 5000) {
      break outer;
    }
  }
}

}
}

module.exports = replies;
