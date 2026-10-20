// Abi Game 28 – Raum- und Rennserver (WebSocket, Node.js).
// Der Server hält die Lobby-Regeln (Plätze, Timer, Countdown, Abstimmung, Rechte), leitet die Auto-Daten weiter,
// prüft die Checkpoint-Reihenfolge und rechnet Platzierung und Ergebnis. Das Spiel fährt lokal (besitzer-gesteuert).
// Start: node server.js   (Port über Umgebungsvariable PORT, Standard 8787)
'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const SLOT_COUNT = 10;
const BOT_RESERVE_SLOTS = 2;   // so viele Plätze bleiben für Menschen frei (wie im Spiel)
const BOT_PREFIX = 'bot_';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Enum-Werte wie im Spiel (Models.cs)
const SlotType = { Empty: 0, Human: 1, Bot: 2, Locked: 3 };
const Phase = { Waiting: 0, Countdown: 1, MapDecided: 2, LoadingRace: 3, InRace: 4, Results: 5, Closed: 6 };

// Standardwerte; das Spiel schickt beim Verbinden seine eigenen (ServiceConfig) und überschreibt sie.
const DEFAULTS = {
  lobbyTimerSeconds: 60, autoStartMinHumans: 3, publicAutoStartMinHumans: 2, lateJoinMinSeconds: 10,
  countdownSeconds: 5, raceLoadTimeoutSeconds: 30, resultsReturnSeconds: 10, finishTimeoutSeconds: 30,
  kickBanSeconds: 300, publicLaps: 3, crownCoins: 10, privateCrownMinHumans: 3,
  maxStateRate: 30, raceCountdownSeconds: 3, sceneReadyTimeoutSeconds: 25,
  itemBoxRespawnSeconds: 7
};

const MAX_ITEM_BOXES = 64;

const now = () => Date.now() / 1000;
const rooms = new Map();      // code -> Room
const reserved = new Set();   // reservierte Raumcodes (Raum erstellen, Code vorab zeigen)
let nextClientId = 1;

function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }

function randomCode() {
  for (let tries = 0; tries < 200; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code) && !reserved.has(code)) return code;
  }
  return null;
}

function isValidCode(code) {
  return typeof code === 'string' && code.length === 4 && [...code].every((c) => CODE_CHARS.includes(c));
}

// ====================================================================== Raum
class Room {
  constructor(code, isPublic, settings, cfg, maps, mapLaps) {
    this.code = code;
    this.isPublic = isPublic;
    this.cfg = cfg;
    this.maps = maps && maps.length ? maps : [];
    this.hostPlayerId = '';
    this.modeId = settings.modeId || 'race';
    this.maxPlayers = Math.max(2, Math.min(SLOT_COUNT, settings.maxPlayers || SLOT_COUNT));
    this.laps = Math.max(1, Math.min(5, settings.laps || 2));   // wird nach der Kartenwahl auf die Runden der Map gesetzt
    this.mapLaps = mapLaps && typeof mapLaps === 'object' ? mapLaps : {};   // Runden je Map (kommen aus den Map-Daten des Spiels)
    this.mapCount = Math.max(1, Math.min(3, settings.mapCount | 0 || 1));   // wie viele Maps hintereinander gefahren werden
    this.seriesIndex = 0;                                                  // wie viele davon schon gefahren sind
    this.botLevel = Math.max(0, Math.min(3, settings.botLevel | 0));   // 0 aus, 1 leicht, 2 schwer, 3 ultra (Bots selbst kommen online später)
    this.botsEnabled = this.botLevel > 0;
    this.botPool = [];   // Namen und Autos für die Bots (schickt das Spiel)
    this.phase = Phase.Waiting;
    this.lobbyEndTime = 0;
    this.countdownEndTime = 0;
    this.resultsEndTime = 0;
    this.chosenMapId = '';
    this.phaseUntil = 0;
    this.loadStart = 0;
    this.slots = [];
    for (let i = 0; i < SLOT_COUNT; i++) this.slots.push(this.emptySlot(i, i >= this.maxPlayers));
    this.revision = 0;
    this.clients = new Map();   // playerId -> Client
    this.bans = new Map();      // playerId -> bis wann
    this.race = null;
    this.results = new Map();   // playerId -> ResultRow
    this.finishDeadline = 0;
    this.leftFinished = new Map();   // Spieler, die im Ziel waren und den Raum verlassen haben
  }

  emptySlot(index, locked) {
    return {
      index, type: locked ? SlotType.Locked : SlotType.Empty, playerId: '', displayName: '', ready: false,
      connected: true, returning: false, car: { carId: '', paintId: 'blue', patternId: 'none', materialId: 'lacquer', hornId: 'horn_2', teacherId: 'teacher_1', teacherSkinId: '', stickers: ['', '', '', ''], animationMask: 0 },
      voteMapId: ''
    };
  }

  humans() { return this.slots.filter((s) => s.type === SlotType.Human); }
  bots() { return this.slots.filter((s) => s.type === SlotType.Bot); }

  setBotPool(pool) {
    if (!Array.isArray(pool)) return;
    this.botPool = pool.slice(0, 12).map((e) => ({ name: sanitizeName(e && e.name), car: sanitizeCar(e && e.car) })).filter((e) => e.car);
  }

  // Wie im Spiel: freie Plätze hinter dem letzten Menschen mit Bots füllen, zwei Plätze bleiben frei
  rebalanceBots() {
    if (this.phase !== Phase.Waiting) return;
    const humans = this.humans().length;
    const desired = this.botLevel > 0 ? Math.max(0, this.maxPlayers - BOT_RESERVE_SLOTS - humans) : 0;
    const bots = this.bots();
    for (let i = bots.length - 1; i >= desired; i--) Object.assign(bots[i], this.emptySlot(bots[i].index, false));
    let lastHuman = -1;
    this.slots.forEach((slot, i) => { if (slot.type === SlotType.Human) lastHuman = i; });
    let count = Math.min(bots.length, desired);
    for (let i = lastHuman + 1; i < this.maxPlayers && count < desired; i++) {
      const slot = this.slots[i];
      if (slot.type !== SlotType.Empty) continue;
      slot.type = SlotType.Bot;
      slot.playerId = BOT_PREFIX + i;
      slot.ready = true;
      count++;
    }
    this.bots().forEach((slot, k) => {
      const entry = this.botPool.length ? this.botPool[k % this.botPool.length] : null;
      slot.displayName = entry ? entry.name : 'Bot ' + (k + 1);
      if (entry) slot.car = entry.car;
      slot.ready = true;
    });
  }

  slotById(id) {
    if (typeof id === 'string' && id.startsWith(BOT_PREFIX)) return this.slots[Number(id.slice(BOT_PREFIX.length))];
    return this.slotOf(id);
  }
  slotOf(playerId) { return this.slots.find((s) => s.type === SlotType.Human && s.playerId === playerId); }
  isHost(playerId) { return !this.isPublic && this.hostPlayerId === playerId; }
  minHumans() { return this.isPublic ? this.cfg.publicAutoStartMinHumans : this.cfg.autoStartMinHumans; }

  uniqueName(wanted) {
    let name = wanted || 'Spieler';
    let suffix = 2;
    while (this.slots.some((s) => s.type !== SlotType.Empty && s.type !== SlotType.Locked && s.displayName === name)) {
      name = `${wanted} (${suffix++})`;
    }
    return name;
  }

  addHuman(client, car) {
    if (this.humans().length >= this.maxPlayers) return null;
    const target = this.slots.find((s, i) => i < this.maxPlayers && s.type !== SlotType.Human);
    if (!target) return null;
    Object.assign(target, this.emptySlot(target.index, false));
    target.type = SlotType.Human;
    target.playerId = client.playerId;
    target.displayName = this.uniqueName(client.name);
    if (car) target.car = car;
    this.clients.set(client.playerId, client);
    client.room = this;
    this.rebalanceBots();
    return target;
  }

  removeHuman(playerId, reason) {
    const slot = this.slotOf(playerId);
    if (slot && this.phase === Phase.InRace && this.race && this.race.progress[playerId] && this.race.progress[playerId].finished) {
      this.leftFinished.set(playerId, this.makeRow(playerId, slot.displayName, slot.car, this.race.progress[playerId], this.results.get(playerId), false));
    }
    if (slot) Object.assign(slot, this.emptySlot(slot.index, false));
    const client = this.clients.get(playerId);
    this.clients.delete(playerId);
    if (client) client.room = null;
    if (this.humans().length === 0) { this.close(); return; }
    if (this.hostPlayerId === playerId && !this.isPublic) {
      this.hostPlayerId = this.humans()[0].playerId;
      this.notice('Der Gastgeber hat den Raum verlassen. Neuer Gastgeber: ' + this.humans()[0].displayName);
    }
    this.rebalanceBots();
    this.afterPlayerLeft(playerId);
    this.broadcastLobby();
    log(`Raum ${this.code}: ${playerId} weg (${reason || 'verlassen'}), ${this.humans().length} übrig`);
  }

  afterPlayerLeft(playerId) {
    if (this.phase === Phase.InRace && this.race) {
      if (this.race.botHost === playerId) {
        this.race.botHost = '';
        this.broadcast({ t: 'bots_gone' });   // die Bot-Autos bleiben nicht als Hindernisse stehen
      }
      delete this.race.progress[playerId];
      this.tryFinishRace();
      this.broadcastStandings();
    }
    if (this.phase === Phase.Waiting && this.humans().length < this.minHumans() && this.lobbyEndTime > 0 && this.humans().length < 2) {
      this.lobbyEndTime = 0;
    }
  }

  close() {
    this.phase = Phase.Closed;
    rooms.delete(this.code);
    log(`Raum ${this.code} geschlossen`);
  }

  // ---------------------------------------------------------------- Senden
  snapshotFor(playerId) {
    return {
      roomCode: this.isPublic ? '' : this.code,
      isPublic: this.isPublic,
      hostPlayerId: this.isPublic ? '' : this.hostPlayerId,
      localPlayerId: playerId,
      modeId: this.modeId,
      maxPlayers: this.maxPlayers,
      laps: this.laps,
      mapCount: this.mapCount,
      seriesIndex: this.seriesIndex,
      botsEnabled: this.botsEnabled,
      botLevel: this.botLevel,
      phase: this.phase,
      lobbyEndTime: this.lobbyEndTime,
      countdownEndTime: this.countdownEndTime,
      resultsEndTime: this.resultsEndTime,
      chosenMapId: this.chosenMapId,
      tieBreakWheel: false,
      wheelResultIndex: 0,
      wheelOptions: [],
      slots: this.slots,
      revision: this.revision
    };
  }

  broadcastLobby() {
    this.revision++;
    for (const [playerId, client] of this.clients) {
      client.send({ t: 'lobby', serverTime: now(), lobby: this.snapshotFor(playerId) });
    }
  }

  broadcast(message, exceptId) {
    for (const [playerId, client] of this.clients) {
      if (playerId !== exceptId) client.send(message);
    }
  }

  notice(text) { this.broadcast({ t: 'notice', text }); }

  // ---------------------------------------------------------------- Regeln
  allHumansReady() {
    const humans = this.humans();
    return humans.length > 0 && humans.every((s) => s.ready);
  }

  onHumanJoined() {
    if (this.phase !== Phase.Waiting) return;
    const t = now();
    if (this.lobbyEndTime <= 0 && this.humans().length >= this.minHumans()) {
      this.lobbyEndTime = t + this.cfg.lobbyTimerSeconds;
    } else if (this.lobbyEndTime > 0 && this.lobbyEndTime - t < this.cfg.lateJoinMinSeconds) {
      this.lobbyEndTime = t + this.cfg.lateJoinMinSeconds;
    }
  }

  decideMap() {
    const votes = this.humans().map((s) => s.voteMapId).filter((v) => v && this.maps.includes(v));
    const counts = new Map();
    for (const v of votes) counts.set(v, (counts.get(v) || 0) + 1);
    let best = 0;
    for (const c of counts.values()) best = Math.max(best, c);
    const top = [...counts.entries()].filter(([, c]) => c === best).map(([m]) => m);
    const pool = top.length ? top : this.maps;
    this.chosenMapId = pool.length ? pool[Math.floor(Math.random() * pool.length)] : '';
    const mapLaps = this.mapLaps[this.chosenMapId] | 0;
    if (mapLaps > 0) this.laps = Math.max(1, Math.min(5, mapLaps));
    log(`Raum ${this.code}: Karte '${this.chosenMapId}' (${votes.length} Stimmen, ${this.laps} Runden)`);
  }

  backToWaiting() {
    if (this.seriesIndex >= this.mapCount) this.seriesIndex = 0;   // Serie zu Ende: nächste Runde der Lobby beginnt neu
    this.phase = Phase.Waiting;
    this.chosenMapId = '';
    this.lobbyEndTime = 0;
    this.countdownEndTime = 0;
    this.resultsEndTime = 0;
    this.race = null;
    this.results = new Map();
    this.leftFinished = new Map();
    this.finishDeadline = 0;
    for (const s of this.slots) { s.voteMapId = ''; s.returning = false; s.ready = s.type === SlotType.Bot; }
    this.rebalanceBots();
    if (this.humans().length >= this.minHumans()) this.lobbyEndTime = now() + this.cfg.lobbyTimerSeconds;
  }

  tick() {
    const t = now();
    let dirty = false;
    // Bans abräumen
    for (const [id, until] of this.bans) if (t > until) this.bans.delete(id);

    if (this.phase === Phase.Waiting) {
      // Start, sobald alle Anwesenden bereit sind (auch mit weniger Spielern als Plätzen, auch ohne laufenden Timer) oder der Timer abläuft
      if (this.allHumansReady() || (this.lobbyEndTime > 0 && t >= this.lobbyEndTime)) {
        this.phase = Phase.Countdown;
        this.countdownEndTime = t + this.cfg.countdownSeconds;
        dirty = true;
      }
    } else if (this.phase === Phase.Countdown && t >= this.countdownEndTime) {
      this.decideMap();
      this.phase = Phase.MapDecided;
      this.phaseUntil = t + 1.2;
      dirty = true;
    } else if (this.phase === Phase.MapDecided && t >= this.phaseUntil) {
      this.phase = Phase.LoadingRace;
      this.loadStart = t;
      this.race = { startTime: 0, highest: 0, loaded: new Set(), progress: {}, finished: new Set() };
      dirty = true;
    } else if (this.phase === Phase.LoadingRace) {
      const humans = this.humans();
      const everyone = humans.every((s) => this.race.loaded.has(s.playerId));
      if (this.race.loaded.size === 0 && t - this.loadStart > this.cfg.raceLoadTimeoutSeconds * 2) {
        // Niemand ist fertig geworden: zurück in die Lobby statt ewig zu warten
        this.notice('Das Laden hat zu lange gedauert. Zurück in die Lobby.');
        this.backToWaiting();
        this.broadcastLobby();
        return;
      }
      if (everyone || (this.race.loaded.size > 0 && t - this.loadStart > this.cfg.raceLoadTimeoutSeconds)) {
        // Wer nicht fertig geladen hat, fährt nicht mit
        for (const s of humans) if (!this.race.loaded.has(s.playerId)) this.kickInternal(s.playerId, 'Karte nicht rechtzeitig geladen');
        this.startRace();
        dirty = true;
      }
    } else if (this.phase === Phase.InRace) {
      if (!this.race.started && t - this.race.goTime > this.cfg.sceneReadyTimeoutSeconds) this.beginCountdown();
      if (this.finishDeadline > 0 && t >= this.finishDeadline) this.finishRace();
      else this.broadcastRanks();
    } else if (this.phase === Phase.Results) {
      if (t >= this.resultsEndTime) { this.backToWaiting(); dirty = true; }
    }
    if (dirty) this.broadcastLobby();
  }

  kickInternal(playerId, text) {
    const client = this.clients.get(playerId);
    if (client) client.send({ t: 'kicked', text });
    this.removeHuman(playerId, 'entfernt');
  }

  // ---------------------------------------------------------------- Rennen
  // Alle haben die Karte geladen: Phase "Rennen". Die Szene wird aber erst nach dem Ladebalken aktiv, deshalb
  // startet die Ampel erst, wenn jeder "Szene da" meldet (oder nach einer Zeitgrenze).
  startRace() {
    this.phase = Phase.InRace;
    this.race.startTime = 0;
    this.race.started = false;
    this.race.sceneReady = new Set();
    this.race.goTime = now();
    this.race.boxes = new Map();   // Itembox-Nummer -> Zeit, ab der sie wieder da ist
    for (const s of this.humans()) {
      this.race.progress[s.playerId] = { lap: 1, next: 1, passed: 0, lastTime: 0, finished: false, finishTime: -1 };
    }
    // Der erste Mensch lässt die Bots auf seinem Gerät fahren; der Server verteilt sie
    const first = this.humans()[0];
    this.race.botHost = this.bots().length && first ? first.playerId : '';
    for (const b of this.bots()) {
      this.race.progress[b.playerId] = { lap: 1, next: 1, passed: 0, lastTime: 0, finished: false, finishTime: -1 };
    }
    this.broadcast({ t: 'go', serverTime: now(), botHost: this.race.botHost });
    log(`Raum ${this.code}: Rennen wird geladen (${this.humans().length} Spieler, Karte ${this.chosenMapId})`);
  }

  onSceneReady(playerId, client) {
    if (this.phase !== Phase.InRace || !this.race) return;
    this.race.sceneReady.add(playerId);
    if (this.race.started) {
      // Nachzügler: die Ampel läuft für alle anderen schon; er startet sofort
      client.send({ t: 'start', serverTime: now(), late: true });
      return;
    }
    if (this.humans().every((s) => this.race.sceneReady.has(s.playerId))) this.beginCountdown();
  }

  beginCountdown() {
    if (!this.race || this.race.started) return;
    this.race.started = true;
    // Die Rennzeit zählt ab GO (nach der Startampel)
    this.race.startTime = now() + this.cfg.raceCountdownSeconds;
    for (const [id, client] of this.clients) {
      if (this.race.sceneReady.has(id)) client.send({ t: 'start', serverTime: now(), late: false });
    }
    log(`Raum ${this.code}: Startampel läuft (${this.race.sceneReady.size} bereit)`);
  }

  onMapLoaded(playerId, highest) {
    if (this.phase !== Phase.LoadingRace || !this.race) return;
    this.race.loaded.add(playerId);
    if (highest > 0) this.race.highest = Math.max(this.race.highest, highest);
  }

  onCheckpoint(playerId, idx) {
    if (this.phase !== Phase.InRace || !this.race || !this.race.started) return false;
    const p = this.race.progress[playerId];
    if (!p || p.finished || idx !== p.next) return false;   // falsche Reihenfolge oder doppelt
    const t = now() - this.race.startTime;
    // Plausibilität: nicht schneller als 0,5 s zwischen zwei Checkpoints
    if (p.lastTime > 0 && t - p.lastTime < 0.5) return false;
    p.lastTime = t;
    if (idx === 0) {
      p.lap++;
      p.passed = 0;
      p.next = 1;
      if (p.lap > this.laps) {
        p.finished = true;
        p.finishTime = t;
        this.race.finished.add(playerId);
        if (!playerId.startsWith(BOT_PREFIX) && this.finishDeadline === 0) this.finishDeadline = now() + this.cfg.finishTimeoutSeconds;
        this.broadcastStandings();
      }
    } else {
      p.passed = idx;
      p.next = this.race.highest > 0 && idx >= this.race.highest ? 0 : idx + 1;
    }
    return true;
  }

  rankList() {
    const list = Object.entries(this.race.progress).map(([id, p]) => ({ id, ...p }));
    list.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.lap !== b.lap) return b.lap - a.lap;
      if (a.passed !== b.passed) return b.passed - a.passed;
      return a.lastTime - b.lastTime;
    });
    return list;
  }

  broadcastRanks() {
    if (!this.race) return;
    const list = this.rankList();
    const places = new Array(SLOT_COUNT).fill(0);   // Platz je Sitz (0 = nicht im Rennen)
    list.forEach((p, i) => { const s = this.slotById(p.id); if (s) places[s.index] = i + 1; });
    this.broadcast({ t: 'ranks', places });
  }

  onResultSubmitted(playerId, row) {
    if (this.phase !== Phase.InRace && this.phase !== Phase.Results) return;
    if (!this.race) return;
    this.results.set(playerId, row);
    this.tryFinishRace();
    this.broadcastStandings();
  }

  tryFinishRace() {
    if (this.phase !== Phase.InRace || !this.race) return;
    const humans = this.humans();
    if (humans.length === 0) return;
    if (humans.every((s) => this.results.has(s.playerId))) this.finishRace();
  }

  // Eine Ergebniszeile; final=false: wer noch fährt, bekommt "fährt noch"
  makeRow(playerId, name, car, p, sent, final, isBot = false) {
    const finished = !!(p && p.finished);
    let total = -1;
    if (finished) {
      // Gemeldete Zeit nur übernehmen, wenn sie zur Server-Zeit passt
      total = sent && sent.totalTime > 0 && Math.abs(sent.totalTime - p.finishTime) < 3 ? sent.totalTime : p.finishTime;
    }
    return {
      place: 0, playerId, playerName: name, isLocal: false, isBot, car,
      carDisplayName: sent ? sent.carDisplayName : '', totalTime: total, bestLap: sent ? sent.bestLap : -1,
      newPersonalBest: false, coinsEarned: 0, coinsCollected: sent ? Math.max(0, Math.min(sent.coinsCollected | 0, 99)) : 0,
      didNotFinish: !finished, stillDriving: !finished && !final
    };
  }

  rankRows(rows) {
    rows.sort((a, b) => (a.didNotFinish - b.didNotFinish) || (a.totalTime - b.totalTime));
    const trial = this.modeId === 'time_trial';
    rows.forEach((r, i) => {
      r.place = r.didNotFinish ? 0 : i + 1;
      // Krone: Platz 1 gegen mindestens einen Gegner (Bots zählen als Gegner), nie im Zeitfahren; dazu die eingesammelten Münzen
      const crownAllowed = this.isPublic || rows.filter((x) => !x.isBot).length >= this.cfg.privateCrownMinHumans;
      r.crown = !trial && crownAllowed && i === 0 && rows.length > 1 && !r.didNotFinish && !r.isBot;
      r.coinsEarned = r.didNotFinish || r.isBot ? 0 : (r.crown ? this.cfg.crownCoins : 0) + r.coinsCollected;
    });
    return rows;
  }

  currentRows(final) {
    const rows = [];
    const present = new Set();
    for (const s of this.humans()) {
      present.add(s.playerId);
      rows.push(this.makeRow(s.playerId, s.displayName, s.car, this.race.progress[s.playerId], this.results.get(s.playerId), final));
    }
    for (const b of this.bots()) rows.push(this.makeRow(b.playerId, b.displayName, b.car, this.race.progress[b.playerId], null, final, true));
    // Wer schon im Ziel war und die Lobby verlassen hat, bleibt in der Liste
    for (const [id, row] of this.leftFinished) if (!present.has(id)) rows.push({ ...row });
    return this.rankRows(rows);
  }

  sendResults(type, final) {
    const t = now();
    const rows = this.currentRows(final);
    for (const [playerId, client] of this.clients) {
      const perClient = rows.map((r) => ({ ...r, isLocal: r.playerId === playerId }));
      client.send({ t: type, results: { resultId: this.code + '-' + Math.floor(this.race.goTime || t), mapId: this.chosenMapId, laps: this.laps, final, rows: perClient } });
    }
  }

  // Zwischenstand an alle (jemand ist ins Ziel gekommen, hat Daten gemeldet oder ist gegangen)
  broadcastStandings() {
    if (this.phase !== Phase.InRace || !this.race) return;
    this.sendResults('standings', false);
  }

  finishRace() {
    if (this.phase !== Phase.InRace) return;
    const t = now();
    this.phase = Phase.Results;
    this.seriesIndex += 1;
    this.resultsEndTime = t + this.cfg.resultsReturnSeconds;
    for (const s of this.humans()) s.returning = true;
    this.sendResults('final', true);
    this.broadcastLobby();
    log(`Raum ${this.code}: Ergebnis an ${this.clients.size} Spieler`);
  }
}

// ====================================================================== Verbindung
class Client {
  constructor(ws) {
    this.id = nextClientId++;
    this.ws = ws;
    this.playerId = '';
    this.name = 'Spieler';
    this.room = null;
    this.cfg = { ...DEFAULTS };
    this.lastReaction = 0;
    this.lastState = 0;
  }

  send(message) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  ack(id, ok, error, text, value) {
    if (id === undefined) return;
    this.send({ t: 'ack', id, ok, error: error || '', text: text || '', value: value === undefined ? 0 : value, code: '' });
  }

  ackCode(id, code) { this.send({ t: 'ack', id, ok: true, error: '', text: '', value: 0, code }); }
}

// Fehlernamen wie ServiceError im Spiel
const Err = {
  NotAllowed: 'NotAllowed', NotFound: 'NotFound', RoomFull: 'RoomFull', Gone: 'Gone', InRace: 'InRace',
  TooLate: 'TooLate', RateLimited: 'RateLimited', Unknown: 'Unknown'
};

function sanitizeName(name) {
  const text = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
  return text || 'Spieler';
}

function sanitizeCar(car) {
  if (!car || typeof car !== 'object') return null;
  const s = (v, d) => (typeof v === 'string' ? v.slice(0, 40) : d);
  return {
    carId: s(car.carId, ''), paintId: s(car.paintId, 'blue'), patternId: s(car.patternId, 'none'),
    materialId: s(car.materialId, 'lacquer'), hornId: s(car.hornId, 'horn_2'),
    teacherId: s(car.teacherId, 'teacher_1'), teacherSkinId: s(car.teacherSkinId, ''),
    stickers: Array.isArray(car.stickers) ? [0, 1, 2, 3].map((i) => s(car.stickers[i], '')) : ['', '', '', ''],
    animationMask: Number.isInteger(car.animationMask) ? (car.animationMask & 7) : 0
  };
}

function hostOnly(client, id) {
  const room = client.room;
  if (!room) { client.ack(id, false, Err.Gone, ''); return null; }
  if (!room.isHost(client.playerId)) { client.ack(id, false, Err.NotAllowed, ''); return null; }
  return room;
}

function joinRoom(client, room, car, id) {
  if (room.bans.has(client.playerId)) { client.ack(id, false, Err.NotAllowed, 'Du wurdest aus diesem Raum entfernt.'); return false; }
  if (room.phase !== Phase.Waiting && room.phase !== Phase.Results) { client.ack(id, false, Err.InRace, ''); return false; }
  if (room.humans().length >= room.maxPlayers) { client.ack(id, false, Err.RoomFull, '', SLOT_COUNT); return false; }
  const slot = room.addHuman(client, sanitizeCar(car));
  if (!slot) { client.ack(id, false, Err.RoomFull, ''); return false; }
  room.onHumanJoined();
  room.broadcastLobby();   // erst der Zustand, dann die Bestätigung: das Menü braucht den Zustand beim Öffnen der Lobby
  client.ack(id, true);
  log(`Raum ${room.code}: ${slot.displayName} beigetreten (${room.humans().length}/${room.maxPlayers})`);
  return true;
}

const handlers = {
  hello(client, m) {
    client.playerId = String(m.playerId || '').slice(0, 64) || 'p' + client.id;
    client.name = sanitizeName(m.name);
    if (m.cfg && typeof m.cfg === 'object') client.cfg = { ...DEFAULTS, ...m.cfg };
    // Doppelte Anmeldung derselben Kennung: die alte Verbindung entfernen
    for (const room of rooms.values()) {
      const old = room.clients.get(client.playerId);
      if (old && old !== client) room.removeHuman(client.playerId, 'neue Verbindung');
    }
    client.send({ t: 'hello', serverTime: now(), playerId: client.playerId });
    client.ack(m.id, true);
  },

  reserve(client, m) {
    const code = randomCode();
    if (!code) return client.ack(m.id, false, Err.Unknown, '');
    reserved.add(code);
    setTimeout(() => reserved.delete(code), 10 * 60 * 1000);
    client.ackCode(m.id, code);
  },

  release(client, m) { reserved.delete(String(m.code || '')); client.ack(m.id, true); },

  create(client, m) {
    if (client.room) client.room.removeHuman(client.playerId, 'neuer Raum');
    const settings = m.settings || {};
    let code = isValidCode(settings.reservedCode) && !rooms.has(settings.reservedCode) ? settings.reservedCode : randomCode();
    if (!code) return client.ack(m.id, false, Err.Unknown, '');
    reserved.delete(code);
    const room = new Room(code, false, settings, client.cfg, m.maps, m.mapLaps);
    room.hostPlayerId = client.playerId;
    rooms.set(code, room);
    room.setBotPool(m.botPool);
    room.addHuman(client, sanitizeCar(m.car));
    // Zeitrennen: allein, kein Timer – gestartet wird mit "Los geht's!" (Bereit) in der eigenen Lobby
    room.broadcastLobby();
    client.ack(m.id, true);
    log(`Raum ${code} erstellt von ${client.name} (${room.modeId})`);
  },

  quick(client, m) {
    if (client.room) client.room.removeHuman(client.playerId, 'Schnelles Spiel');
    const open = [...rooms.values()].filter((r) => r.isPublic && r.phase === Phase.Waiting && r.humans().length < r.maxPlayers);
    open.sort((a, b) => b.humans().length - a.humans().length);
    let room = open[0];
    if (!room) {
      const level = Math.max(0, Math.min(3, m.botLevel | 0));
      room = new Room(randomCode(), true, { laps: client.cfg.publicLaps, maxPlayers: SLOT_COUNT, botLevel: level }, client.cfg, m.maps, m.mapLaps);
      rooms.set(room.code, room);
      room.setBotPool(m.botPool);
    }
    joinRoom(client, room, m.car, m.id);
  },

  join(client, m) {
    const code = String(m.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!isValidCode(code) || !room) return client.ack(m.id, false, Err.NotFound, '');
    if (room.phase === Phase.Closed) return client.ack(m.id, false, Err.Gone, '');
    if (client.room === room) return client.ack(m.id, true);
    if (client.room) client.room.removeHuman(client.playerId, 'anderer Raum');
    joinRoom(client, room, m.car, m.id);
  },

  leave(client, m) {
    if (client.room) client.room.removeHuman(client.playerId, 'verlassen');
    client.ack(m.id, true);
  },

  ready(client, m) {
    const room = client.room;
    const slot = room && room.slotOf(client.playerId);
    if (!slot || room.phase !== Phase.Waiting) return client.ack(m.id, false, Err.TooLate, '');
    slot.ready = !!m.ready;
    client.ack(m.id, true);
    room.broadcastLobby();
  },

  car(client, m) {
    const room = client.room;
    const slot = room && room.slotOf(client.playerId);
    if (!slot) return client.ack(m.id, false, Err.Gone, '');
    if (room.phase !== Phase.Waiting) return client.ack(m.id, false, Err.TooLate, '');
    const car = sanitizeCar(m.car);
    if (car) slot.car = car;
    client.ack(m.id, true);
    room.broadcastLobby();
  },

  vote(client, m) {
    const room = client.room;
    const slot = room && room.slotOf(client.playerId);
    if (!slot) return client.ack(m.id, false, Err.Gone, '');
    if (room.phase !== Phase.Waiting) return client.ack(m.id, false, Err.TooLate, '');
    const mapId = String(m.mapId || '');
    slot.voteMapId = mapId === '__random__' || room.maps.includes(mapId) ? mapId : '';
    client.ack(m.id, true);
    room.broadcastLobby();
  },

  react(client, m) {
    const room = client.room;
    const slot = room && room.slotOf(client.playerId);
    if (!slot) return client.ack(m.id, false, Err.Gone, '');
    const t = now();
    if (t - client.lastReaction < 2) return client.ack(m.id, false, Err.RateLimited, '');
    client.lastReaction = t;
    room.broadcast({ t: 'reaction', slot: slot.index, icon: m.icon | 0, phrase: String(m.phrase || '').slice(0, 60) });
    client.ack(m.id, true);
  },

  kick(client, m) {
    const room = hostOnly(client, m.id);
    if (!room) return;
    const target = String(m.playerId || '');
    if (target === client.playerId || !room.slotOf(target)) return client.ack(m.id, false, Err.NotFound, '');
    room.bans.set(target, now() + client.cfg.kickBanSeconds);
    room.kickInternal(target, 'Der Gastgeber hat dich aus dem Raum entfernt.');
    client.ack(m.id, true);
  },

  mapcount(client, m) {
    const room = hostOnly(client, m.id);
    if (!room) return;
    if (room.phase !== Phase.Waiting) return client.ack(m.id, false, Err.TooLate, '');
    if (room.seriesIndex > 0) return client.ack(m.id, false, Err.TooLate, '');   // mitten in der Serie bleibt die Anzahl
    room.mapCount = Math.max(1, Math.min(3, m.count | 0 || 1));
    client.ack(m.id, true);
    room.broadcastLobby();
  },

  bots(client, m) { client.ack(m.id, true); },

  botlevel(client, m) {
    const room = hostOnly(client, m.id);
    if (!room) return;
    if (room.phase !== Phase.Waiting) return client.ack(m.id, false, Err.TooLate, '');
    room.botLevel = Math.max(0, Math.min(3, m.level | 0));
    room.botsEnabled = room.botLevel > 0;
    room.setBotPool(m.botPool);
    room.rebalanceBots();
    client.ack(m.id, true);
    room.broadcastLobby();
  },

  mode(client, m) {
    const room = hostOnly(client, m.id);
    if (!room) return;
    if (room.phase !== Phase.Waiting) return client.ack(m.id, false, Err.TooLate, '');
    room.modeId = String(m.modeId || 'race').slice(0, 30);
    client.ack(m.id, true);
    room.broadcastLobby();
  },

  start_timer(client, m) {
    const room = hostOnly(client, m.id);
    if (!room) return;
    if (room.lobbyEndTime > 0 || room.phase !== Phase.Waiting) return client.ack(m.id, false, Err.NotAllowed, '');
    room.lobbyEndTime = now() + client.cfg.lobbyTimerSeconds;
    client.ack(m.id, true);
    room.broadcastLobby();
  },

  map_loaded(client, m) {
    const room = client.room;
    if (!room) return;
    room.onMapLoaded(client.playerId, m.highest | 0);
  },

  // Bot-Auto-Daten vom Bot-Gastgeber: an die anderen weiterleiten (wie ein Spieler-Auto)
  bs(client, m) {
    const room = client.room;
    if (!room || room.phase !== Phase.InRace || !room.race || room.race.botHost !== client.playerId) return;
    const slot = room.slots[m.i | 0];
    if (!slot || slot.type !== SlotType.Bot || !Array.isArray(m.a) || m.a.length < 10) return;
    room.broadcast({ t: 's', i: slot.index, a: m.a.slice(0, 12) }, client.playerId);
  },

  // Checkpoint eines Bots (vom Bot-Gastgeber gemeldet)
  bcp(client, m) {
    const room = client.room;
    if (!room || room.phase !== Phase.InRace || !room.race || room.race.botHost !== client.playerId) return;
    const slot = room.slots[m.slot | 0];
    if (!slot || slot.type !== SlotType.Bot) return;
    room.onCheckpoint(slot.playerId, m.idx | 0);
  },

  race_ready(client, m) {
    const room = client.room;
    if (room) room.onSceneReady(client.playerId, client);
  },

  cp(client, m) {
    const room = client.room;
    if (!room) return;
    room.onCheckpoint(client.playerId, m.idx | 0);
  },

  // Auto-Daten: sofort an die anderen im Raum weiterleiten (Rate begrenzt)
  s(client, m) {
    const room = client.room;
    if (!room || room.phase !== Phase.InRace) return;
    const slot = room.slotOf(client.playerId);
    if (!slot || !Array.isArray(m.a) || m.a.length < 10) return;
    const t = now();
    if (t - client.lastState < 1 / client.cfg.maxStateRate) return;
    client.lastState = t;
    room.broadcast({ t: 's', i: slot.index, a: m.a.slice(0, 12) }, client.playerId);
  },

  // Effekt-Ereignisse (Boost, Aufprall, Respawn …): nur der Typ geht rum, die Effekte spielen lokal
  fx(client, m) {
    const room = client.room;
    const slot = room && room.slotOf(client.playerId);
    if (!slot || room.phase !== Phase.InRace) return;
    room.broadcast({ t: 'fx', i: slot.index, k: String(m.k || '').slice(0, 20), v: Number(m.v) || 0 }, client.playerId);
  },

  // Itembox: wer zuerst kommt, bekommt sie; sie ist dann für alle weg und kommt nach itemBoxRespawnSeconds wieder (nie im Zeitfahren)
  box(client, m) {
    const room = client.room;
    const slot = room && room.slotOf(client.playerId);
    if (!slot || room.phase !== Phase.InRace || !room.race || !room.race.boxes || room.modeId === 'time_trial') return;
    const index = m.b | 0;
    if (index < 0 || index >= MAX_ITEM_BOXES) return;
    const t = now();
    if ((room.race.boxes.get(index) || 0) > t) return;   // schon weg: ein anderer war schneller
    const until = t + Math.max(1, Number(room.cfg.itemBoxRespawnSeconds) || DEFAULTS.itemBoxRespawnSeconds);
    room.race.boxes.set(index, until);
    room.broadcast({ t: 'box', b: index, i: slot.index, until });
  },

  // Angriffs-Item (Papierflieger, Schulglocke): Start an die anderen weiterleiten; jedes Gerät rechnet Flug und Treffer selbst nach
  ie(client, m) {
    const room = client.room;
    const slot = room && room.slotOf(client.playerId);
    if (!slot || room.phase !== Phase.InRace || room.modeId === 'time_trial') return;
    const v3 = (a) => (Array.isArray(a) && a.length >= 3 ? a.slice(0, 3).map((x) => Number(x) || 0) : [0, 0, 0]);
    room.broadcast({ t: 'ie', i: slot.index, k: String(m.k || '').slice(0, 12), p: v3(m.p), d: v3(m.d) }, client.playerId);
  },

  results(client, m) {
    const room = client.room;
    if (!room) return;
    const r = m.row || {};
    room.onResultSubmitted(client.playerId, {
      totalTime: Number(r.totalTime) || -1, bestLap: Number(r.bestLap) || -1, coinsCollected: r.coinsCollected | 0,
      carDisplayName: String(r.carDisplayName || '').slice(0, 40)
    });
  },

  return_lobby(client, m) {
    const room = client.room;
    const slot = room && room.slotOf(client.playerId);
    if (slot) { slot.returning = false; room.broadcastLobby(); }
    client.ack(m.id, !!slot, slot ? '' : Err.Gone, '');
  },

  ping(client, m) { client.send({ t: 'pong', serverTime: now(), id: m.id }); }
};

// ====================================================================== Start
const server = http.createServer((req, res) => {
  // Weck-Anfrage des Spiels: einfach "ok" zurückgeben
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end(`Abi Game 28 Server ok, Räume: ${rooms.size}`);
});
const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });

// Schutz vor Missbrauch (der Server ist öffentlich): Grenzen für Verbindungen insgesamt und pro Adresse
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 300;
const MAX_PER_IP = Number(process.env.MAX_PER_IP) || 12;
const perIp = new Map();

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (wss.clients.size > MAX_CLIENTS || (perIp.get(ip) || 0) >= MAX_PER_IP) {
    ws.close(1013, 'Server ausgelastet');
    return;
  }
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  ws.on('close', () => { const left = (perIp.get(ip) || 1) - 1; if (left <= 0) perIp.delete(ip); else perIp.set(ip, left); });
  const client = new Client(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t !== 'hello' && !client.playerId) return;   // erst anmelden
    const handler = handlers[m.t];
    if (!handler) return;
    try { handler(client, m); } catch (error) { log('Fehler in', m.t, error); client.ack(m.id, false, Err.Unknown, ''); }
  });
  ws.on('close', () => { if (client.room) client.room.removeHuman(client.playerId, 'Verbindung getrennt'); });
  ws.on('error', () => {});
});

// Verbindungs-Check: alle 15 s ein Ping; wer nicht antwortet, wird entfernt (Handy ohne Netz, Tab eingefroren). Hält auch Leitungen offen.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* Verbindung schon weg */ }
  }
}, 15000);

setInterval(() => { for (const room of [...rooms.values()]) { try { room.tick(); } catch (error) { log('Tick-Fehler', error); } } }, 100);

server.listen(PORT, () => log(`Server läuft auf Port ${PORT}`));

// Sauber beenden (Hosting-Anbieter schicken beim Neustart SIGTERM)
process.on('SIGTERM', () => {
  log('SIGTERM: Server wird beendet');
  for (const client of wss.clients) client.close(1001, 'Server startet neu');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});

