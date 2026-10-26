// Abi Game 28 – Minigames: Läufe, Prüfung der Ergebnisse, Wochen-Bestenlisten, Münzen.
// Ablauf: start → runId (Server merkt sich Spiel, Spieler, Startzeit) → submit(runId, score, seconds) → Server prüft Dauer und Grenzen,
// speichert Bestwerte und rechnet die Münzen. Der Client zeigt nur an.
'use strict';

const { weekId } = require('./classes');

// Grenzen und Belohnungen je Spiel (gleiche Werte wie MinigameDefs.cs im Spiel).
// higher: größer ist besser; minSeconds: kürzeste mögliche Dauer eines echten Laufs; maxScore: höchstens erreichbar.
// Länder nennen: Höchstwert = alle × 1000 + Restzeit; Münzen je gefundenem Land (bei „alle 195“ weniger je Land)
function country(total, limitSeconds) {
  return { higher: true, minSeconds: 5, maxSeconds: limitSeconds + 30, maxScore: total * 1000 + 999, coins: (s) => Math.round(Math.floor(s / 1000) * (total > 60 ? 0.35 : 1)) };
}

const GAMES = {
  paperplane: { higher: true, minSeconds: 6, maxSeconds: 600, maxScore: 80, coins: (s) => Math.round(s * 1.2) },
  lunchbox: { higher: true, minSeconds: 8, maxSeconds: 75, maxScore: 3000, coins: (s) => Math.round(s / 25) },
  quiz: { higher: true, minSeconds: 10, maxSeconds: 200, maxScore: 100, coins: (s) => Math.round(s / 2) },
  locker: { higher: false, minSeconds: 4, maxSeconds: 1800, maxScore: 10 * 1000 + 1799, coins: (s) => Math.max(5, 60 - Math.floor(s / 1000) * 5) },
  booktower: { higher: true, minSeconds: 3, maxSeconds: 900, maxScore: 200, coins: (s) => Math.round(s * 1.5) },
  paperball: { higher: true, minSeconds: 8, maxSeconds: 600, maxScore: 450, coins: (s) => Math.round(s / 6) },
  tracing: { higher: true, minSeconds: 3, maxSeconds: 75, maxScore: 110, coins: (s) => Math.round(s / 2) },
  wordle: { higher: false, minSeconds: 5, maxSeconds: 3600, maxScore: 6 * 1000 + 3599, coins: (s) => Math.max(10, 70 - Math.floor(s / 1000) * 10) },
  // Flaggenraten (25.10./26.10.2026): 20 Flaggen, je 5–10 Punkte; zwei Varianten mit eigener Bestenliste
  flags: { higher: true, minSeconds: 10, maxSeconds: 20 * 12 + 60, maxScore: 200, coins: (s) => Math.round(s / 3) },
  flags_type: { higher: true, minSeconds: 10, maxSeconds: 20 * 22 + 60, maxScore: 200, coins: (s) => Math.round(s / 3) },
  // Länder nennen: gefunden × 1000 + übrige Sekunden (nur wenn alle gefunden); je Gebiet eine Bestenliste
  countries_all: country(195, 900),
  countries_europe: country(46, 300),
  countries_asia: country(48, 300),
  countries_africa: country(54, 360),
  countries_namerica: country(23, 180),
  countries_samerica: country(12, 120),
  countries_oceania: country(14, 150),
  countries_states: country(16, 120)
};

const COIN_CAP = 80;                               // höchstens so viele Münzen aus einem Lauf
const DAILY_COIN_CAP = 400;                        // höchstens so viele Münzen pro Tag aus allen Minigames
const RANK_BONUS = [[1, 50], [10, 30], [50, 15], [100, 5]];   // Platzhalter: Wochenplatz → Zusatz-Münzen (einmal je Woche beim ersten Erreichen)
const RUN_TTL_MS = 60 * 60 * 1000;
const MAX_RUNS_PER_USER = 5;

function better(def, a, b) { return def.higher ? a > b : a < b; }
function dayId(ms) { return new Date(ms).toISOString().slice(0, 10); }

class MinigameService {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
    this.runs = new Map();   // runId → { uid, game, startedAt }
  }

  start(uid, game) {
    if (!GAMES[game]) return { ok: false, code: 'Bad', message: 'Unbekanntes Spiel.' };
    const t = this.clock();
    for (const [id, run] of this.runs) if (t - run.startedAt > RUN_TTL_MS) this.runs.delete(id);
    const mine = [...this.runs.entries()].filter(([, r]) => r.uid === uid).sort((a, b) => a[1].startedAt - b[1].startedAt);
    while (mine.length >= MAX_RUNS_PER_USER) this.runs.delete(mine.shift()[0]);
    const runId = t.toString(36) + Math.random().toString(36).slice(2, 10);
    this.runs.set(runId, { uid, game, startedAt: t });
    return { ok: true, runId, serverTime: t };
  }

  /** Ergebnis einreichen. Prüft: Lauf gehört dem Spieler, Dauer passt zur Server-Uhr, Wert in den Grenzen. */
  async submit(uid, name, classId, runId, rawScore, rawSeconds) {
    const run = this.runs.get(String(runId || ''));
    if (!run || run.uid !== uid) return { ok: false, code: 'NotAllowed', message: 'Dieser Lauf ist nicht (mehr) gültig.' };
    this.runs.delete(runId);
    const def = GAMES[run.game];
    const t = this.clock();
    const elapsed = (t - run.startedAt) / 1000;
    const seconds = Number(rawSeconds);
    const score = Number(rawScore);
    if (!Number.isFinite(score) || !Number.isFinite(seconds) || score < 0 || score > def.maxScore) return { ok: false, code: 'NotAllowed', message: 'Ergebnis nicht möglich.' };
    // Gemeldete Spielzeit darf nicht länger als die echte Zeit seit dem Start sein (plus Puffer) und nicht kürzer als die Mindestdauer
    if (elapsed < def.minSeconds || seconds > elapsed + 3 || elapsed > def.maxSeconds + 120) return { ok: false, code: 'NotAllowed', message: 'Ergebnis nicht möglich.' };

    const week = weekId(t);
    const boardCol = 'mg_' + run.game + '_' + week;
    const bestCol = 'mgBest_' + run.game;
    const result = await this.store.transact([[boardCol, uid], [bestCol, uid], ['mgCoins', uid]], async (docs) => {
      const entry = docs[boardCol + '/' + uid];
      const best = docs[bestCol + '/' + uid];
      const wallet = docs['mgCoins/' + uid] || { day: '', coins: 0, rankBonus: {} };
      const writes = {};
      const weekBest = !entry || better(def, score, entry.score);
      if (weekBest) writes[boardCol + '/' + uid] = { uid, name: String(name || '?').slice(0, 24), classId: String(classId || '').slice(0, 40), score, seconds, at: t };
      const allTimeBest = !best || better(def, score, best.score);
      if (allTimeBest) writes[bestCol + '/' + uid] = { uid, score, seconds, at: t, plays: ((best && best.plays) || 0) + 1 };
      else writes[bestCol + '/' + uid] = { ...best, plays: (best.plays || 0) + 1 };
      // Münzen: nach Ergebnis, gedeckelt je Lauf und je Tag
      if (wallet.day !== dayId(t)) { wallet.day = dayId(t); wallet.coins = 0; }
      let coins = Math.max(0, Math.min(COIN_CAP, def.coins(score)));
      coins = Math.min(coins, Math.max(0, DAILY_COIN_CAP - wallet.coins));
      wallet.coins += coins;
      writes['mgCoins/' + uid] = wallet;
      return { value: { coins, weekBest, allTimeBest, wallet }, writes };
    });
    const rank = await this.rankOf(run.game, week, uid);
    // Wochenplatz-Bonus einmal je Woche und Stufe
    let rankBonus = 0;
    const tier = RANK_BONUS.find(([upTo]) => rank > 0 && rank <= upTo);
    if (tier) {
      rankBonus = await this.store.transact([['mgCoins', uid]], async (docs) => {
        const wallet = docs['mgCoins/' + uid] || { day: dayId(t), coins: 0, rankBonus: {} };
        wallet.rankBonus = wallet.rankBonus || {};
        const key = run.game + ':' + week;
        if ((wallet.rankBonus[key] || 9999) <= tier[0]) return { value: 0, writes: {} };
        wallet.rankBonus[key] = tier[0];
        return { value: tier[1], writes: { ['mgCoins/' + uid]: wallet } };
      });
    }
    return { ok: true, coins: result.coins + rankBonus, rankBonus, weekBest: result.weekBest, allTimeBest: result.allTimeBest, weekRank: rank, game: run.game, score };
  }

  async board(game, week) {
    const def = GAMES[game];
    const rows = await this.store.list('mg_' + game + '_' + week);
    rows.sort((a, b) => (def.higher ? b.score - a.score : a.score - b.score) || a.seconds - b.seconds || a.at - b.at);
    return rows;
  }

  async rankOf(game, week, uid) {
    const rows = await this.board(game, week);
    return rows.findIndex((r) => r.uid === uid) + 1;
  }

  /** Bestenliste: scope 'school' (alle), 'class' (Durchschnitt je Klasse), 'personal' (eigene Werte). */
  async top(uid, game, scope, count = 50) {
    const def = GAMES[game];
    if (!def) return { ok: false, code: 'Bad', message: '' };
    const week = weekId(this.clock());
    const rows = await this.board(game, week);
    const myIndex = rows.findIndex((r) => r.uid === uid);
    const best = await this.store.get('mgBest_' + game, uid);
    const personal = { weekScore: myIndex >= 0 ? rows[myIndex].score : -1, weekRank: myIndex + 1, bestScore: best ? best.score : -1, plays: best ? best.plays || 0 : 0 };
    if (scope === 'class') {
      const groups = new Map();
      for (const r of rows) {
        if (!r.classId) continue;
        if (!groups.has(r.classId)) groups.set(r.classId, []);
        groups.get(r.classId).push(r.score);
      }
      const classes = [];
      for (const [id, scores] of groups) {
        const cls = await this.store.get('classes', id);
        classes.push({ name: cls ? cls.name : '?', score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10, players: scores.length, isMine: false, classId: id });
      }
      classes.sort((a, b) => (def.higher ? b.score - a.score : a.score - b.score));
      const myClass = myIndex >= 0 ? rows[myIndex].classId : '';
      return { ok: true, week, personal, rows: classes.slice(0, count).map((c, i) => ({ place: i + 1, name: c.name, score: c.score, players: c.players, isMine: !!myClass && c.classId === myClass })) };
    }
    const list = rows.slice(0, count).map((r, i) => ({ place: i + 1, name: r.name, score: r.score, seconds: r.seconds, players: 1, isMine: r.uid === uid }));
    return { ok: true, week, personal, rows: scope === 'personal' ? list.filter((r) => r.isMine) : list };
  }
}

module.exports = { MinigameService, GAMES, COIN_CAP, DAILY_COIN_CAP };
