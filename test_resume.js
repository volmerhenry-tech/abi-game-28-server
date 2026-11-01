// Selbsttest: Verbindung in der Lobby kurz weg -> Platz bleibt frei, "resume" holt ihn zurück; ohne Rückkehr ist er nach der Schonfrist weg.
// Starten mit kurzer Schonfrist: RESUME_GRACE_MS=1500 node server.js, dann node test_resume.js
'use strict';
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:8787';
let failed = 0;
const check = (c, t) => { console.log((c ? 'OK   ' : 'FEHLER ') + t); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client() {
  const ws = new WebSocket(URL); const c = { ws, got: {}, lobby: null, nextId: 1, waiters: new Map() };
  c.ready = new Promise((r) => ws.on('open', r));
  ws.on('message', (d) => { const m = JSON.parse(d); c.got[m.t] = m; if (m.t === 'lobby') c.lobby = m.lobby; if (m.t === 'ack' && c.waiters.has(m.id)) { c.waiters.get(m.id)(m); c.waiters.delete(m.id); } });
  c.call = (t, b) => new Promise((res) => { const id = c.nextId++; c.waiters.set(id, res); ws.send(JSON.stringify({ t, id, ...b })); });
  return c;
}
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; }
const slotOf = (c, id) => c.lobby && c.lobby.slots.find((s) => s.playerId === id);
(async () => {
  const cfg = { lobbyTimerSeconds: 60, countdownSeconds: 1 };
  const car = { carId: '', paintId: 'red', patternId: 'none', materialId: 'lacquer', hornId: 'horn_2', stickers: ['', '', '', ''] };
  const a = client(), b = client(); await Promise.all([a.ready, b.ready]);
  await a.call('hello', { playerId: 'ra', name: 'Anna', cfg }); await b.call('hello', { playerId: 'rb', name: 'Ben', cfg });
  const code = (await a.call('reserve', {})).code;
  await a.call('create', { settings: { modeId: 'race', maxPlayers: 4, laps: 1, reservedCode: code }, car, maps: ['m'] });
  await b.call('join', { code, car });
  await b.call('ready', { ready: true });
  check(await until(() => slotOf(a, 'rb') && slotOf(a, 'rb').ready, 2000), 'Ben ist bereit');

  // Ben verliert die Verbindung: Platz bleibt, aber "nicht verbunden" und nicht mehr bereit
  b.ws.terminate();
  check(await until(() => slotOf(a, 'rb') && slotOf(a, 'rb').connected === false, 2000), 'Bens Platz bleibt frei (Verbindung weg)');
  check(slotOf(a, 'rb') && !slotOf(a, 'rb').ready, 'Ben ist nicht mehr bereit');

  // Ben kommt mit neuer Verbindung zurück
  const b2 = client(); await b2.ready;
  await b2.call('hello', { playerId: 'rb', name: 'Ben', cfg });
  const back = await b2.call('resume', {});
  check(back.ok, 'resume klappt');
  check(await until(() => b2.lobby && b2.lobby.roomCode === code, 2000), 'Ben bekommt den Raum wieder geschickt');
  check(await until(() => slotOf(a, 'rb') && slotOf(a, 'rb').connected !== false, 2000), 'Anna sieht Ben wieder verbunden');
  check(a.lobby.slots.filter((s) => s.type === 2 || s.playerId === 'rb').length >= 1 && a.lobby.slots.filter((s) => s.playerId === 'rb').length === 1, 'Ben hat genau einen Platz');

  // Zweites Mal weg und nicht zurück: nach der Schonfrist ist der Platz frei
  b2.ws.terminate();
  check(await until(() => slotOf(a, 'rb') && slotOf(a, 'rb').connected === false, 2000), 'wieder weg: Platz freigehalten');
  check(await until(() => !slotOf(a, 'rb'), (Number(process.env.RESUME_GRACE_MS) || 20000) + 3000), 'nach der Schonfrist ist Bens Platz weg');
  const b3 = client(); await b3.ready;
  await b3.call('hello', { playerId: 'rb', name: 'Ben', cfg });
  check(!(await b3.call('resume', {})).ok, 'zu spät: resume schlägt fehl');

  for (const c of [a, b3]) c.ws.close();
  console.log(failed ? `${failed} FEHLER` : 'Alles OK');
  process.exit(failed ? 1 : 0);
})();
