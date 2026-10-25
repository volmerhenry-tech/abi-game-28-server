// Selbsttest: Spiel-Modifier (privat wählt der Gastgeber, nur im Modus Rennen; öffentlich würfelt der Server bei der Kartenwahl)
// und die neuen Items Kaugummi/Strafarbeit (werden wie die anderen Angriffs-Items an alle weitergeleitet).
'use strict';
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:8787';
let failed = 0;
const check = (c, t) => { console.log((c ? 'OK   ' : 'FEHLER ') + t); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client() {
  const ws = new WebSocket(URL); const c = { ws, got: {}, all: [], lobby: null, nextId: 1, waiters: new Map() };
  c.ready = new Promise((r) => ws.on('open', r));
  ws.on('message', (d) => { const m = JSON.parse(d); c.got[m.t] = m; c.all.push(m); if (m.t === 'lobby') c.lobby = m.lobby; if (m.t === 'ack' && c.waiters.has(m.id)) { c.waiters.get(m.id)(m); c.waiters.delete(m.id); } });
  c.call = (t, b) => new Promise((res) => { const id = c.nextId++; c.waiters.set(id, res); ws.send(JSON.stringify({ t, id, ...b })); });
  c.send = (t, b) => ws.send(JSON.stringify({ t, ...b }));
  return c;
}
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; }
const car = (p) => ({ carId: 'c', paintId: p, patternId: 'none', materialId: 'lacquer', hornId: 'horn_2', stickers: ['', '', '', ''] });
const cfg = { lobbyTimerSeconds: 30, countdownSeconds: 1, raceLoadTimeoutSeconds: 5, raceCountdownSeconds: 0, publicModifierChance: 1 };

(async () => {
  // ---------------------------------------------------------------- privat
  const a = client(), b = client(); await Promise.all([a.ready, b.ready]);
  await a.call('hello', { playerId: 'ma', name: 'Anna', cfg }); await b.call('hello', { playerId: 'mb', name: 'Ben', cfg });
  const code = (await a.call('reserve', {})).code;
  await a.call('create', { settings: { modeId: 'race', maxPlayers: 4, laps: 1, botLevel: 0, reservedCode: code, modifierId: 'storm' }, car: car('x'), maps: ['m'], botPool: [] });
  await b.call('join', { code, car: car('y') }); await sleep(150);
  check(b.lobby && b.lobby.modifierId === 'storm', 'Modifier aus den Raum-Einstellungen kommt beim Mitspieler an');
  check((await a.call('modifier', { modifierId: 'turbo_insane' })).ok, 'Gastgeber wählt Turbo-Wahnsinn');
  check(await until(() => b.lobby.modifierId === 'turbo_insane', 2000), 'Mitspieler sieht den neuen Modifier');
  check(!(await b.call('modifier', { modifierId: 'darkness' })).ok, 'Mitspieler darf den Modifier nicht ändern');
  await a.call('modifier', { modifierId: 'quatsch' });
  check(await until(() => b.lobby.modifierId === 'none', 2000), 'Unbekannte Id wird zu "none"');
  await a.call('mode', { modeId: 'time_trial' });
  check(!(await a.call('modifier', { modifierId: 'turbo' })).ok, 'Im Zeitfahren gibt es keinen Modifier');
  await a.call('mode', { modeId: 'race' });
  await a.call('modifier', { modifierId: 'low_gravity' });

  // Rennen starten, Items weiterleiten
  await a.call('ready', { ready: true }); await b.call('ready', { ready: true });
  await until(() => a.lobby && a.lobby.phase === 3, 8000);
  check(a.lobby.modifierId === 'low_gravity', 'Privat bleibt der gewählte Modifier bei der Kartenwahl');
  a.send('map_loaded', { highest: 2 }); b.send('map_loaded', { highest: 2 });
  await until(() => a.got.go && b.got.go, 5000);
  a.send('race_ready', {}); b.send('race_ready', {});
  await until(() => a.got.start && b.got.start, 4000);
  a.send('ie', { k: 'gum', p: [1, 2, 3], d: [0, 1, 0] });
  a.send('ie', { k: 'detention', p: [1, 0, 0], d: [0, 0, 0] });
  check(await until(() => b.all.some((m) => m.t === 'ie' && m.k === 'gum') && b.all.some((m) => m.t === 'ie' && m.k === 'detention' && m.p[0] === 1), 2000),
    'Kaugummi und Strafarbeit (mit Ziel-Sitz) kommen beim anderen an');
  a.ws.close(); b.ws.close();

  // ---------------------------------------------------------------- öffentlich
  const c = client(), d = client(); await Promise.all([c.ready, d.ready]);
  await c.call('hello', { playerId: 'mc', name: 'Cem', cfg }); await d.call('hello', { playerId: 'md', name: 'Dana', cfg });
  await c.call('quick', { car: car('x'), maps: ['m'], botPool: [], botLevel: 0 });
  await d.call('quick', { car: car('y'), maps: ['m'], botPool: [], botLevel: 0 });
  await sleep(150);
  check(c.lobby && c.lobby.isPublic && c.lobby.modifierId === 'none', 'Öffentliche Lobby: vor der Kartenwahl noch kein Modifier');
  await c.call('ready', { ready: true }); await d.call('ready', { ready: true });
  await until(() => c.lobby && c.lobby.phase === 3, 8000);
  const rolled = c.lobby.modifierId;
  check(['low_gravity', 'turbo', 'darkness', 'storm', 'boost_rush'].includes(rolled), 'Öffentlich gewürfelt (Chance 1 im Test): ' + rolled);
  check(d.lobby.modifierId === rolled, 'Alle bekommen denselben Modifier');
  c.ws.close(); d.ws.close();

  console.log(failed ? `\n${failed} FEHLER` : '\nAlles OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
