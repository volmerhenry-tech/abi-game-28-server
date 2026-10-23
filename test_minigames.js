// Test der Minigame-Prüfung ohne Firebase (eigene Uhr). Start: node test_minigames.js
'use strict';
const assert = require('assert');
const C = require('./classes');
const M = require('./minigames');

let clock = Date.UTC(2026, 9, 21, 10);
const svc = new M.MinigameService(new C.MemoryStore(), () => clock);

async function main() {
  // Zu schnell eingereicht → abgelehnt
  let run = svc.start('a', 'lunchbox');
  assert.ok(run.ok);
  clock += 2000;
  let r = await svc.submit('a', 'Anna', '', run.runId, 500, 2);
  assert.strictEqual(r.ok, false, 'zu kurz');

  // Unmöglicher Wert → abgelehnt
  run = svc.start('a', 'quiz');
  clock += 60000;
  r = await svc.submit('a', 'Anna', '', run.runId, 150, 60);
  assert.strictEqual(r.ok, false, 'Quiz höchstens 100');

  // Gemeldete Zeit länger als echte Zeit → abgelehnt
  run = svc.start('a', 'quiz');
  clock += 20000;
  r = await svc.submit('a', 'Anna', '', run.runId, 80, 90);
  assert.strictEqual(r.ok, false);

  // Gültig: Münzen, Bestwert, Platz 1 mit Bonus
  run = svc.start('a', 'quiz');
  clock += 60000;
  r = await svc.submit('a', 'Anna', 'p_7a', run.runId, 80, 58);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.weekRank, 1);
  assert.ok(r.weekBest && r.allTimeBest);
  assert.strictEqual(r.coins, 40 + 50, 'Quiz 80 Punkte = 40 Münzen + Platz-1-Bonus 50');
  // Lauf nur einmal einreichbar
  r = await svc.submit('a', 'Anna', 'p_7a', run.runId, 80, 58);
  assert.strictEqual(r.ok, false);

  // Zweiter Spieler, schlechter; Bonus für Platz 2 (Top 10)
  run = svc.start('b', 'quiz');
  clock += 60000;
  r = await svc.submit('b', 'Ben', 'p_7a', run.runId, 60, 55);
  assert.strictEqual(r.weekRank, 2);
  assert.strictEqual(r.coins, 30 + 30);

  // Weniger ist besser (Spind): 3 Versuche schlägt 5 Versuche
  run = svc.start('a', 'locker');
  clock += 30000;
  await svc.submit('a', 'Anna', '', run.runId, 5 * 1000 + 25, 25);
  run = svc.start('b', 'locker');
  clock += 30000;
  r = await svc.submit('b', 'Ben', '', run.runId, 3 * 1000 + 25, 25);
  assert.strictEqual(r.weekRank, 1, 'weniger Versuche = besser');

  // Bestenliste Schule und Klasse
  let top = await svc.top('a', 'quiz', 'school');
  assert.deepStrictEqual(top.rows.map((x) => x.name), ['Anna', 'Ben']);
  assert.strictEqual(top.personal.bestScore, 80);
  top = await svc.top('a', 'quiz', 'class');
  assert.strictEqual(top.rows.length, 1);
  assert.strictEqual(top.rows[0].score, 70, 'Klassen-Durchschnitt');

  // Tagesgrenze der Münzen
  let total = 0;
  for (let i = 0; i < 20; i++) {
    run = svc.start('c', 'booktower');
    clock += 30000;
    r = await svc.submit('c', 'Cem', '', run.runId, 200, 29);
    total += r.coins - (r.rankBonus || 0);
  }
  assert.strictEqual(total, M.DAILY_COIN_CAP, 'höchstens 400 Münzen am Tag');
  console.log('test_minigames: alles ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
