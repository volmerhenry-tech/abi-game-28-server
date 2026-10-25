// Selbsttest: Geht der Bot-Gastgeber mitten im Rennen, fährt ein anderer Spieler die Bots weiter (letzte Stelle, Runde, Checkpoint).
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
(async () => {
  const cfg = { lobbyTimerSeconds: 30, countdownSeconds: 1, raceLoadTimeoutSeconds: 5, resultsReturnSeconds: 2, finishTimeoutSeconds: 4, raceCountdownSeconds: 0 };
  const a = client(), b = client(), c = client(); await Promise.all([a.ready, b.ready, c.ready]);
  await a.call('hello', { playerId: 'ha', name: 'Anna', cfg }); await b.call('hello', { playerId: 'hb', name: 'Ben', cfg }); await c.call('hello', { playerId: 'hc', name: 'Cem', cfg });
  const code = (await a.call('reserve', {})).code;
  const pool = [{ name: 'Kreide-Kai', car: car('red') }, { name: 'Turbo-Tina', car: car('green') }];
  await a.call('create', { settings: { modeId: 'race', maxPlayers: 6, laps: 2, botLevel: 2, reservedCode: code }, car: car('x'), maps: ['m'], botPool: pool });
  await b.call('join', { code, car: car('y') }); await c.call('join', { code, car: car('z') }); await sleep(200);
  const bot = a.lobby.slots.find((s) => s.type === 2);
  check(!!bot, 'Raum hat einen Bot');
  for (const x of [a, b, c]) await x.call('ready', { ready: true });
  await until(() => a.lobby.phase === 3, 8000);
  for (const x of [a, b, c]) x.send('map_loaded', { highest: 2 });
  await until(() => a.got.go && b.got.go && c.got.go, 5000);
  check(a.got.go.botHost === 'ha', 'Anna fährt die Bots');
  for (const x of [a, b, c]) x.send('race_ready', {});
  await until(() => a.got.start && b.got.start && c.got.start, 4000);
  a.send('bs', { i: bot.index, a: [11, 2, 33, 0, 0.7071, 0, 0.7071, 5, 0, 0] });
  await sleep(200);
  a.send('bcp', { slot: bot.index, idx: 1 });
  await sleep(300);
  a.ws.close();
  check(await until(() => b.got.bot_host && c.got.bot_host, 4000), 'Übergabe an alle gemeldet');
  const msg = b.got.bot_host;
  check(msg.botHost === 'hb' || msg.botHost === 'hc', 'Neuer Bot-Fahrer ist ein verbliebener Spieler: ' + msg.botHost);
  const info = (msg.bots || []).find((x) => x.i === bot.index);
  check(info && info.a[0] === 11 && info.a[2] === 33, 'Letzte Stelle des Bots wird mitgeschickt');
  check(info && info.passed === 1 && info.lap === 1 && !info.finished, 'Runde und Checkpoint des Bots werden mitgeschickt');
  check(!b.all.some((m) => m.t === 'bots_gone') && !c.all.some((m) => m.t === 'bots_gone'), 'Bots verschwinden nicht');
  const host = msg.botHost === 'hb' ? b : c, other = host === b ? c : b;
  host.send('bs', { i: bot.index, a: [12, 2, 34, 0, 0, 0, 1, 0, 0, 0] });
  check(await until(() => other.all.some((m) => m.t === 's' && m.i === bot.index && m.a[0] === 12), 3000), 'Der neue Bot-Fahrer darf die Bot-Daten schicken');
  await sleep(700);   // der Server nimmt Checkpoints höchstens alle 0,5 s an
  host.send('bcp', { slot: bot.index, idx: 2 });
  await sleep(300);
  // Alle weg bis auf einen: der übernimmt wieder; geht auch der, ist der Raum zu
  host.ws.close();
  check(await until(() => other.all.filter((m) => m.t === 'bot_host').length >= 2, 3000), 'Zweite Übergabe an den letzten Spieler');
  check(other.got.bot_host.bots.find((x) => x.i === bot.index).passed === 2, 'Fortschritt bleibt bei der zweiten Übergabe');
  other.ws.close();
  console.log(failed ? `\n${failed} Fehler` : '\nAlles in Ordnung'); process.exit(failed ? 1 : 0);
})();
