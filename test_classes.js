// Test der Klassen-Regeln ohne Firebase (Speicher im Arbeitsspeicher, eigene Uhr). Start: node test_classes.js
'use strict';
const assert = require('assert');
const C = require('./classes');

const DAY = 86400000;
let clock = Date.UTC(2026, 9, 21, 10);   // Mittwoch
const svc = new C.ClassService(new C.MemoryStore(), () => clock);

async function main() {
  // Regeln
  assert.deepStrictEqual([1, 2, 3, 4].map(C.racePoints), [1, 3, 5, 6], 'allein 1, sonst ×1,5 aufgerundet');
  assert.strictEqual(C.weekGoal(1), 30);
  assert.strictEqual(C.weekGoal(10), 100);
  assert.strictEqual(C.weekGoal(30), 250);
  assert.strictEqual(C.kickVotesNeeded(2), 3);
  assert.strictEqual(C.kickVotesNeeded(10), 6);
  assert.strictEqual(C.PRESETS.length, 6 * 5 + 3, '5a–10e plus EF, Q1, Q2');
  assert.ok(C.PRESETS.some((p) => p.name === 'Q2') && !C.PRESETS.some((p) => p.name === '7f'));
  assert.ok(C.isOffensive('N1gg4 Club') && C.isOffensive('Hu.ren.sohn') && !C.isOffensive('die coolere 7a'));
  assert.strictEqual(C.weekId(Date.UTC(2026, 9, 26, 0, 30)), '20261026', 'Montag 1:30 Berlin = neue Woche');
  assert.strictEqual(C.weekId(Date.UTC(2026, 9, 25, 21, 0)), '20261019', 'Sonntag 23 Uhr Berlin = alte Woche');

  // Beitreten, Wechselsperre
  let r = await svc.join('a', 'Anna', 'p_7a');
  assert.ok(r.ok, JSON.stringify(r));
  r = await svc.join('a', 'Anna', 'p_7b');
  assert.strictEqual(r.code, 'NotAllowed', 'erst verlassen');
  await svc.leave('a');
  r = await svc.join('a', 'Anna', 'p_7b');
  assert.strictEqual(r.code, 'TooSoon', 'nur einmal in 7 Tagen');
  clock += 7 * DAY + 1000;
  r = await svc.join('a', 'Anna', 'p_7a');
  assert.ok(r.ok, 'nach 7 Tagen wieder');

  // Club gründen
  r = await svc.create('b', 'Ben', 'die coolere 7a');
  assert.ok(r.ok, JSON.stringify(r));
  const club = r.classId;
  r = await svc.create('x', 'Xaver', 'DIE COOLERE 7A');
  assert.strictEqual(r.code, 'NameTaken');
  r = await svc.create('x', 'Xaver', 'Hurensohn Gang');
  assert.strictEqual(r.code, 'NameBlocked');
  for (const u of ['c', 'd', 'e', 'f']) assert.ok((await svc.join(u, 'Spieler ' + u, club)).ok);
  let st = await svc.state('b');
  assert.strictEqual(st.myClass.leaderUid, 'b', 'Gründer ist Anführer');
  assert.strictEqual(st.myClass.memberCount, 5);
  assert.strictEqual(st.myClass.weekGoal, 50);

  // Zählen: 3 Mitglieder zusammen = 5 Punkte, Anna aus 7a allein = 1; Schule zählt jedes Rennen
  await svc.creditRace(['b', 'c', 'd', 'a']);
  st = await svc.state('b');
  assert.strictEqual(st.myClass.weekPoints, 5);
  assert.strictEqual((await svc.state('a')).myClass.weekPoints, 1);
  assert.strictEqual(st.school.points, 4);
  assert.strictEqual(st.school.activePlayers, 4);

  // Vote-Kick: nur wer diese Woche gefahren ist; 3 Stimmen nötig (3 aktive → Mehrheit 2, mindestens 3)
  r = await svc.voteKick('e', 'f');
  assert.strictEqual(r.ok, false, 'e ist diese Woche nicht gefahren');
  assert.ok((await svc.voteKick('b', 'f')).ok);
  assert.ok((await svc.voteKick('c', 'f')).ok);
  r = await svc.voteKick('d', 'f');
  assert.ok(r.ok && r.kicked, 'dritte Stimme wirft raus');
  r = await svc.join('f', 'Spieler f', club);
  assert.strictEqual(r.code, 'NotAllowed', 'Rausgewählt: 7 Tage gesperrt');
  assert.ok((await svc.join('f', 'Spieler f', 'p_9c')).ok, 'darf sofort woanders hin');

  // Wochenziel schaffen → Klassenbox nur für Mitfahrer, einmal
  for (let i = 0; i < 9; i++) await svc.creditRace(['b', 'c', 'd']);
  st = await svc.state('b');
  assert.ok(st.myClass.weekReached, 'Ziel geschafft: ' + st.myClass.weekPoints + '/' + st.myClass.weekGoal);
  assert.ok(st.classBoxReady);
  assert.strictEqual((await svc.state('e')).classBoxReady, false, 'e ist nicht mitgefahren');
  assert.ok((await svc.claim('b', 'class')).ok);
  assert.strictEqual((await svc.state('b')).classBoxReady, false, 'nur einmal');
  assert.strictEqual((await svc.claim('b', 'class')).ok, false);

  // Neue Woche: Punkte von vorn, Box der Vorwoche für c noch abholbar
  clock += 7 * DAY;
  st = await svc.state('c');
  assert.strictEqual(st.myClass.weekPoints, 0, 'neue Woche');
  assert.ok(st.classBoxReady, 'Vorwoche noch abholbar');
  assert.ok((await svc.claim('c', 'class')).ok);

  // Anführer geht: der Club bleibt, Anführer ist dann, wer am meisten gefahren ist
  await svc.leave('b');
  st = await svc.state('c');
  assert.ok(['c', 'd'].includes(st.myClass.leaderUid));

  // Club leer → verschwindet
  for (const u of ['c', 'd', 'e']) await svc.leave(u);
  assert.ok(!(await svc.state('a')).classes.some((c) => c.id === club), 'leerer Club ist weg');
  console.log('test_classes: alles ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
