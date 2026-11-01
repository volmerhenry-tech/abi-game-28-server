'use strict';
// Chat mit Wortfilter (seit 30.10.2026). Der Server prüft jede Nachricht, bevor sie an die anderen geht:
// - Schimpfwörter und harte Beleidigungen werden durch Sternchen ersetzt (auch mit Zahlen statt Buchstaben, gestreckt „fiiick“ oder getrennt „h u r e“),
// - Links und lange Zahlenfolgen (Telefonnummern) werden entfernt,
// - höchstens 80 Zeichen, keine Steuerzeichen, nicht zu schnell hintereinander.
// Die Liste der harten Wörter teilt er mit den Club-Namen (classes.js). Das Spiel hat eine Kopie für den Offline-Betrieb (ChatFilter.cs) – beide gleich halten.

const Classes = require('./classes');

const MAX_LENGTH = 80;
// Zusätzlich im Chat (milder, in Club-Namen erlaubt wäre das ohnehin nicht)
const CHAT_WORDS = ['scheiss', 'scheis', 'shit', 'arsch', 'behindert', 'opfer', 'idiot', 'penner', 'wixer', 'pisser', 'bastard', 'pussy', 'porn',
  'sex', 'penis', 'titten', 'nutte', 'schlampe', 'killyourself', 'stfu', 'fresse', 'depp', 'trottel', 'kacke', 'dumpfbacke', 'loser', 'noob'];
// Wörter, die ein gesperrtes Wort enthalten, aber harmlos sind
const ALLOWED = ['mongolei', 'mongolisch', 'opferfest', 'sexta', 'sextett', 'arschbombe', 'marsch', 'abmarsch', 'barsch', 'harsch', 'essex'];

const collapse = (text) => text.replace(/(.)\1+/g, '$1');
const WORDS = [...new Set([...Classes.BLOCKED, ...CHAT_WORDS].map((w) => Classes.normalizeName(w)).filter((w) => w.length >= 3))];

function isBadToken(token) {
  const flat = Classes.normalizeName(token);
  if (!flat) return false;
  if (ALLOWED.some((a) => flat.startsWith(a))) return false;
  const squeezed = collapse(flat);
  // Gestreckte Schreibweise („fiiick“) nur bei längeren Wörtern vergleichen, sonst träfe „nig“ auch „night“
  return WORDS.some((w) => {
    const short = collapse(w);
    return flat.includes(w) || squeezed === short || (short === w && short.length >= 4 && squeezed.startsWith(short)) || (short.length >= 5 && squeezed.includes(short));
  });
}

/** Nachricht säubern. Gibt den Text zurück, den alle sehen (leer = nichts übrig). */
function clean(text) {
  let s = String(text || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH);
  // Links
  s = s.replace(/(https?:\/\/\S+|www\.\S+|\b[\w-]+\.(de|com|net|org|io|gg|tk|ru|xyz|me|tv|app|link)\b\S*)/gi, '***');
  // Telefonnummern und andere lange Zahlenfolgen
  s = s.replace(/\+?\d[\d\s\-/().]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 6 ? '***' : m));
  // Einzeln getrennte Buchstaben zusammenziehen („h u r e“, „f.i.c.k“), damit der Filter sie erkennt
  s = s.replace(/(?:(?<![\p{L}\p{N}])[\p{L}\p{N}@$!|][\s.\-_*+]+){2,}[\p{L}\p{N}@$!|](?![\p{L}\p{N}])/gu, (m) => {
    const joined = m.replace(/[\s.\-_*+]+/g, '');
    return isBadToken(joined) ? '*'.repeat(Math.min(joined.length, 8)) : m;
  });
  s = s.split(' ').map((token) => (isBadToken(token) ? '*'.repeat(Math.min(Math.max(token.length, 3), 8)) : token)).join(' ');
  return s.trim();
}

/** Darf der Spieler jetzt schreiben? Höchstens eine Nachricht pro 1,5 s und 6 in 20 s. */
function allow(client, nowSeconds) {
  const list = (client.chatTimes || []).filter((t) => nowSeconds - t < 20);
  if (list.length >= 6 || (list.length && nowSeconds - list[list.length - 1] < 1.5)) {
    client.chatTimes = list;
    return false;
  }
  list.push(nowSeconds);
  client.chatTimes = list;
  return true;
}

module.exports = { clean, allow, isBadToken, MAX_LENGTH };
