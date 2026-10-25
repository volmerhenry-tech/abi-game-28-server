// Abi Game 28 – Klassen, Clubs und Schulziel (Etappe 3).
// Der Server zählt: nach jedem Online-Rennen (nicht Zeitrennen) bekommen die Klassen der Mitfahrer Punkte.
// Speicher: Firestore (Umgebungsvariable FIREBASE_SERVICE_ACCOUNT = JSON des Dienstkontos) oder – ohne Firebase – im Arbeitsspeicher (lokal, Tests).
'use strict';

const MAX_MEMBERS = 30;
const CHANGE_DAYS = 7;
const GOAL_PER_MEMBER = 10;
const GOAL_MIN = 30;
const GOAL_MAX = 250;
const SCHOOL_PER_PLAYER = 12;
const KICK_MIN_VOTES = 3;
const KICK_BAN_DAYS = 7;
const NAME_MIN = 3;
const NAME_MAX = 20;

// Vorgefertigte Klassen: 5–10 mit a–e, dazu die Oberstufe ohne Buchstaben
const GRADES = ['5', '6', '7', '8', '9', '10'];
const LETTERS = ['a', 'b', 'c', 'd', 'e'];
const UPPER = ['EF', 'Q1', 'Q2'];

// Ränge nach Klassen-Rennen (gleiche Tabelle wie im Spiel, ClassRanks)
const RANKS = [0, 5, 20, 50, 100, 250];

function presetClasses() {
  const list = [];
  for (const g of GRADES) for (const l of LETTERS) list.push({ id: 'p_' + g + l, name: g + l, grade: g });
  for (const u of UPPER) list.push({ id: 'p_' + u, name: u, grade: u });
  return list;
}
const PRESETS = presetClasses();
const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

// ---------------------------------------------------------------------- Zeit (Berlin, wie WeeklyRewards im Spiel)
function berlinDate(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'));
}
const DAY = 86400000;
function ymd(utcMs) { return new Date(utcMs).toISOString().slice(0, 10).replace(/-/g, ''); }
/** Montag der laufenden Woche (yyyyMMdd), Wechsel Montag 0 Uhr Berlin. */
function weekId(ms = Date.now()) {
  const day = berlinDate(ms);
  const weekday = (new Date(day).getUTCDay() + 6) % 7;   // Montag = 0
  return ymd(day - weekday * DAY);
}
/** Zwei-Wochen-Abschnitt des Schulziels: Montag der ersten Woche (gerade Wochennummer seit 1970). */
function schoolPeriodId(ms = Date.now()) {
  const monday = Date.UTC(Number(weekId(ms).slice(0, 4)), Number(weekId(ms).slice(4, 6)) - 1, Number(weekId(ms).slice(6, 8)));
  const index = Math.floor((monday - Date.UTC(1970, 0, 5)) / (7 * DAY));
  return ymd(monday - (index % 2) * 7 * DAY);
}

// ---------------------------------------------------------------------- Regeln
/** Punkte für ein Rennen: allein 1, sonst Mitfahrer × 1,5 aufgerundet (2 → 3, 4 → 6). */
function racePoints(together) { return together <= 0 ? 0 : together === 1 ? 1 : Math.ceil(together * 1.5); }
function weekGoal(members) { return Math.max(GOAL_MIN, Math.min(GOAL_MAX, members * GOAL_PER_MEMBER)); }
function schoolGoal(activePlayers) { return Math.max(1, activePlayers) * SCHOOL_PER_PLAYER; }
function rankIndex(races) { let r = 0; RANKS.forEach((at, i) => { if (races >= at) r = i; }); return r; }
function kickVotesNeeded(activeVoters) { return Math.max(KICK_MIN_VOTES, Math.floor(activeVoters / 2) + 1); }

// Harte Beleidigungen in Club-Namen (später auch im Chat). Vergleich nach Kleinschreibung, Leetspeak und ohne Trennzeichen.
const BLOCKED = ['nigg', 'negger', 'neger', 'kanake', 'kanacke', 'zigeuner', 'schwuchtel', 'spast', 'mongo', 'behindi', 'hurensohn', 'hure', 'fotze', 'wichser',
  'nazi', 'hitler', 'sieg heil', 'faggot', 'retard', 'whore', 'slut', 'cunt', 'bitch', 'fick', 'fuck', 'arschloch', 'missgeburt', 'kys'];
function normalizeName(text) {
  return String(text || '').toLowerCase()
    .replace(/[0]/g, 'o').replace(/[1!|]/g, 'i').replace(/[3]/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/[7]/g, 't')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z]/g, '');
}
function isOffensive(text) {
  const flat = normalizeName(text);
  return BLOCKED.some((w) => flat.includes(w.replace(/[^a-z]/g, '')));
}
function cleanName(text) { return String(text || '').replace(/[^\p{L}\p{N} _.\-!?]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX); }

// ---------------------------------------------------------------------- Speicher
/** Speicher im Arbeitsspeicher (lokal und für Tests). update(fn) läuft wie eine Transaktion: fn bekommt eine Kopie und gibt den neuen Stand zurück. */
class MemoryStore {
  constructor() { this.data = new Map(); }
  key(col, id) { return col + '/' + id; }
  async get(col, id) { const v = this.data.get(this.key(col, id)); return v ? JSON.parse(JSON.stringify(v)) : null; }
  async set(col, id, value) { this.data.set(this.key(col, id), JSON.parse(JSON.stringify(value))); }
  async remove(col, id) { this.data.delete(this.key(col, id)); }
  async list(col) { return [...this.data.entries()].filter(([k]) => k.startsWith(col + '/')).map(([, v]) => JSON.parse(JSON.stringify(v))); }
  /** Mehrere Dokumente zusammen ändern: fn(docs) bekommt {key: wert|null} und gibt {key: neu|null(löschen)|undefined(unverändert)} zurück. */
  async transact(refs, fn) {
    const docs = {};
    for (const [col, id] of refs) docs[col + '/' + id] = await this.get(col, id);
    const result = await fn(docs);
    for (const [key, value] of Object.entries(result.writes || {})) {
      if (value === undefined) continue;
      if (value === null) this.data.delete(key); else this.data.set(key, JSON.parse(JSON.stringify(value)));
    }
    return result.value;
  }
}

/** Firestore über firebase-admin (nur auf dem Server mit Dienstkonto). */
class FirestoreStore {
  constructor(admin) { this.db = admin.firestore(); }
  async get(col, id) { const s = await this.db.collection(col).doc(id).get(); return s.exists ? s.data() : null; }
  async set(col, id, value) { await this.db.collection(col).doc(id).set(value); }
  async remove(col, id) { await this.db.collection(col).doc(id).delete(); }
  async list(col) { const qs = await this.db.collection(col).limit(1000).get(); return qs.docs.map((d) => d.data()); }
  async transact(refs, fn) {
    return this.db.runTransaction(async (tx) => {
      const docs = {};
      const handles = {};
      for (const [col, id] of refs) {
        const ref = this.db.collection(col).doc(id);
        handles[col + '/' + id] = ref;
        const snap = await tx.get(ref);
        docs[col + '/' + id] = snap.exists ? snap.data() : null;
      }
      const result = await fn(docs);
      for (const [key, value] of Object.entries(result.writes || {})) {
        if (value === undefined) continue;
        const ref = handles[key] || this.db.doc(key);
        if (value === null) tx.delete(ref); else tx.set(ref, value);
      }
      return result.value;
    });
  }
}

// ---------------------------------------------------------------------- Dienst
class ClassService {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
  }

  // ------------------------------------------------ Hilfen
  freshClass(id) {
    const preset = PRESET_BY_ID.get(id);
    if (!preset) return null;
    return { id, name: preset.name, kind: 'preset', grade: preset.grade, founderUid: '', createdAt: this.clock(), members: {}, votes: {}, bans: {}, week: { id: weekId(this.clock()), points: 0, reached: false } };
  }

  /** Woche weiterschalten: Punkte, Wochen-Rennen und Stimmen beginnen neu; das Ziel der Vorwoche bleibt zum Abholen gemerkt. */
  roll(cls) {
    const week = weekId(this.clock());
    if (!cls.week || cls.week.id !== week) {
      cls.lastWeek = cls.week && cls.week.reached ? { id: cls.week.id, contributors: Object.keys(cls.members).filter((u) => (cls.members[u].weekRaces || 0) > 0) } : null;
      cls.week = { id: week, points: 0, reached: false };
      for (const m of Object.values(cls.members)) m.weekRaces = 0;
      cls.votes = {};
    }
    const t = this.clock();
    for (const [uid, until] of Object.entries(cls.bans || {})) if (until <= t) delete cls.bans[uid];
    return cls;
  }

  leaderOf(cls) {
    if (cls.kind === 'club' && cls.founderUid && cls.members[cls.founderUid]) return cls.founderUid;
    // Vorgefertigte Klasse (oder Gründer weg): wer am meisten für die Klasse gefahren ist
    let best = '';
    let most = -1;
    for (const [uid, m] of Object.entries(cls.members)) {
      if ((m.totalRaces || 0) > most) { most = m.totalRaces || 0; best = uid; }
    }
    return best;
  }

  publicClass(cls, uid) {
    const members = Object.entries(cls.members).map(([id, m]) => ({
      uid: id, name: m.name || '', totalRaces: m.totalRaces || 0, weekRaces: m.weekRaces || 0, rank: rankIndex(m.totalRaces || 0),
      votes: (cls.votes[id] && cls.votes[id].voters.length) || 0, votedByMe: !!(cls.votes[id] && cls.votes[id].voters.includes(uid))
    })).sort((a, b) => b.totalRaces - a.totalRaces);
    const active = members.filter((m) => m.weekRaces > 0).length;
    return {
      id: cls.id, name: cls.name, kind: cls.kind, grade: cls.grade || '', leaderUid: this.leaderOf(cls), memberCount: members.length, maxMembers: MAX_MEMBERS,
      weekId: cls.week.id, weekPoints: cls.week.points, weekGoal: weekGoal(members.length), weekReached: !!cls.week.reached,
      kickVotesNeeded: kickVotesNeeded(active), members
    };
  }

  // ------------------------------------------------ Lesen
  /** Schulziel mit Abschnittswechsel (alle zwei Wochen); der abgelaufene Abschnitt bleibt zum Abholen gemerkt, wenn er geschafft war. */
  rollSchool(doc) {
    const period = schoolPeriodId(this.clock());
    if (doc && doc.id === period) return doc;
    const last = doc && doc.reached ? { id: doc.id, active: Object.keys(doc.active || {}) } : null;
    return { id: period, points: 0, active: {}, reached: false, last };
  }

  /** Offene Klassenbox: Woche, in der die Klasse ihr Ziel geschafft hat und man selbst mitgefahren ist, noch nicht abgeholt. */
  pendingClassWeek(cls, member, uid) {
    if (!cls || !member) return '';
    const claimed = member.claimedClass || [];
    const weeks = [];
    if (cls.lastWeek && cls.lastWeek.contributors.includes(uid)) weeks.push(cls.lastWeek.id);
    if (cls.week.reached && cls.members[uid] && cls.members[uid].weekRaces > 0) weeks.push(cls.week.id);
    return weeks.find((w) => !claimed.includes(w)) || '';
  }

  pendingSchool(school, member, uid) {
    const claimed = (member && member.claimedSchool) || [];
    const periods = [];
    if (school.last && school.last.active.includes(uid)) periods.push(school.last.id);
    if (school.reached && school.active[uid]) periods.push(school.id);
    return periods.find((p) => !claimed.includes(p)) || '';
  }

  /** Alles für die Klassen-Seite: eigene Klasse, offene Boxen, Schulziel, Liste aller Klassen und Clubs. */
  async state(uid) {
    const member = await this.store.get('classMembers', uid);
    const cls = member && member.classId ? await this.store.get('classes', member.classId) : null;
    if (cls) this.roll(cls);
    const school = this.rollSchool(await this.store.get('school', 'main'));
    const all = await this.store.list('classes');
    const byId = new Map(all.map((c) => [c.id, c]));
    const list = PRESETS.map((p) => {
      const c = byId.get(p.id);
      return { id: p.id, name: p.name, kind: 'preset', grade: p.grade, memberCount: c ? Object.keys(c.members).length : 0 };
    });
    for (const c of all) if (c.kind === 'club') list.push({ id: c.id, name: c.name, kind: 'club', grade: '', memberCount: Object.keys(c.members).length });
    const active = Object.keys(school.active).length;
    return {
      ok: true, serverTime: this.clock(), myClass: cls ? this.publicClass(cls, uid) : null,
      canChangeAt: member && member.lastChangeAt ? member.lastChangeAt + CHANGE_DAYS * DAY : 0,
      classes: list,
      school: { id: school.id, points: school.points, goal: schoolGoal(active), activePlayers: active, reached: !!school.reached, iAmActive: !!school.active[uid] },
      classBoxReady: !!this.pendingClassWeek(cls, member, uid),
      schoolBoxReady: !!this.pendingSchool(school, member, uid)
    };
  }

  // ------------------------------------------------ Mitgliedschaft
  async join(uid, name, classId) {
    const t = this.clock();
    return this.store.transact([['classMembers', uid], ['classes', classId]], async (docs) => {
      const member = docs['classMembers/' + uid] || { uid, classId: '', joinedAt: 0, lastChangeAt: 0 };
      let cls = docs['classes/' + classId] || this.freshClass(classId);
      if (!cls) return fail('NotFound', 'Diese Klasse gibt es nicht.');
      this.roll(cls);
      if (member.classId === classId) return fail('AlreadyMember', 'Da bist du schon drin.');
      if (member.classId) return fail('NotAllowed', 'Verlass erst deine jetzige Klasse.');
      if (member.lastChangeAt && t < member.lastChangeAt + CHANGE_DAYS * DAY) return fail('TooSoon', 'Du kannst die Klasse nur einmal in 7 Tagen wechseln.', { canChangeAt: member.lastChangeAt + CHANGE_DAYS * DAY });
      if ((cls.bans || {})[uid]) return fail('NotAllowed', 'Du wurdest aus dieser Klasse gewählt und kannst erst später wieder beitreten.');
      if (Object.keys(cls.members).length >= MAX_MEMBERS) return fail('Full', 'Die Klasse ist voll (30 Mitglieder).');
      cls.members[uid] = { name: cleanPlayer(name), joinedAt: t, totalRaces: 0, weekRaces: 0 };
      member.classId = classId;
      member.joinedAt = t;
      member.lastChangeAt = t;
      return { value: ok(), writes: { ['classMembers/' + uid]: member, ['classes/' + classId]: cls } };
    });
  }

  async leave(uid) {
    const member = await this.store.get('classMembers', uid);
    if (!member || !member.classId) return fail('NotFound', 'Du bist in keiner Klasse.').value;
    const classId = member.classId;
    return this.store.transact([['classMembers', uid], ['classes', classId]], async (docs) => {
      const m = docs['classMembers/' + uid];
      const cls = docs['classes/' + classId];
      m.classId = '';
      const writes = { ['classMembers/' + uid]: m };
      if (cls) {
        delete cls.members[uid];
        delete cls.votes[uid];
        for (const v of Object.values(cls.votes)) v.voters = v.voters.filter((x) => x !== uid);
        // Leerer Club verschwindet; vorgefertigte Klassen bleiben
        writes['classes/' + classId] = cls.kind === 'club' && Object.keys(cls.members).length === 0 ? null : cls;
      }
      return { value: ok(), writes };
    });
  }

  /** Eigenen Club gründen (Gründer = Anführer, tritt sofort bei). Zählt als Klassenwechsel. */
  async create(uid, playerName, rawName) {
    const name = cleanName(rawName);
    if (name.length < NAME_MIN) return fail('NameShort', 'Der Name braucht mindestens 3 Zeichen.').value;
    if (isOffensive(name)) return fail('NameBlocked', 'Dieser Name geht nicht.').value;
    const all = await this.store.list('classes');
    const lower = name.toLowerCase();
    if (all.some((c) => c.name.toLowerCase() === lower) || PRESETS.some((p) => p.name.toLowerCase() === lower)) return fail('NameTaken', 'Den Namen gibt es schon.').value;
    const t = this.clock();
    const id = 'c_' + t.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    return this.store.transact([['classMembers', uid], ['classes', id]], async (docs) => {
      const member = docs['classMembers/' + uid] || { uid, classId: '', joinedAt: 0, lastChangeAt: 0 };
      if (member.classId) return fail('NotAllowed', 'Verlass erst deine jetzige Klasse.');
      if (member.lastChangeAt && t < member.lastChangeAt + CHANGE_DAYS * DAY) return fail('TooSoon', 'Du kannst die Klasse nur einmal in 7 Tagen wechseln.', { canChangeAt: member.lastChangeAt + CHANGE_DAYS * DAY });
      const cls = { id, name, kind: 'club', grade: '', founderUid: uid, createdAt: t, members: {}, votes: {}, bans: {}, week: { id: weekId(t), points: 0, reached: false } };
      cls.members[uid] = { name: cleanPlayer(playerName), joinedAt: t, totalRaces: 0, weekRaces: 0 };
      member.classId = id;
      member.joinedAt = t;
      member.lastChangeAt = t;
      return { value: ok({ classId: id }), writes: { ['classMembers/' + uid]: member, ['classes/' + id]: cls } };
    });
  }

  /** Stimme zum Rauswerfen (nochmal = zurücknehmen). Nur wer diese Woche für die Klasse gefahren ist, darf abstimmen; Mehrheit dieser Spieler, mindestens 3. */
  async voteKick(uid, targetUid) {
    const member = await this.store.get('classMembers', uid);
    if (!member || !member.classId) return fail('NotFound', 'Du bist in keiner Klasse.').value;
    const classId = member.classId;
    return this.store.transact([['classes', classId], ['classMembers', targetUid]], async (docs) => {
      const cls = this.roll(docs['classes/' + classId]);
      if (!cls.members[targetUid] || targetUid === uid) return fail('NotAllowed', 'Das geht nicht.');
      if (!cls.members[uid] || !(cls.members[uid].weekRaces > 0)) return fail('NotAllowed', 'Abstimmen darf, wer diese Woche für die Klasse gefahren ist.');
      const vote = cls.votes[targetUid] || { voters: [] };
      vote.voters = vote.voters.includes(uid) ? vote.voters.filter((x) => x !== uid) : [...vote.voters, uid];
      cls.votes[targetUid] = vote;
      const active = Object.values(cls.members).filter((m) => m.weekRaces > 0).length;
      const writes = { ['classes/' + classId]: cls };
      let kicked = false;
      if (vote.voters.length >= kickVotesNeeded(active)) {
        delete cls.members[targetUid];
        delete cls.votes[targetUid];
        // Sperre nur für Clubs (Entscheidung 25.10.2026): aus der eigenen Schulklasse Rausgewählte dürfen wieder beitreten
        if (cls.kind === 'club') cls.bans[targetUid] = this.clock() + KICK_BAN_DAYS * DAY;
        if (cls.founderUid === targetUid) cls.founderUid = '';
        const target = docs['classMembers/' + targetUid];
        if (target) {
          target.classId = '';
          target.lastChangeAt = 0;   // Rausgewählt: darf sofort einer anderen Klasse beitreten
          writes['classMembers/' + targetUid] = target;
        }
        kicked = true;
      }
      return { value: ok({ kicked, votes: kicked ? 0 : vote.voters.length }), writes };
    });
  }

  /** Klassenbox bzw. Schulbox abholen (einmal je Woche bzw. Abschnitt). Das Spiel legt die Box dann in "Meine Boxen". */
  async claim(uid, what) {
    const member = await this.store.get('classMembers', uid);
    const refs = [['classMembers', uid], what === 'school' ? ['school', 'main'] : ['classes', (member && member.classId) || '-']];
    return this.store.transact(refs, async (docs) => {
      const m = docs['classMembers/' + uid];
      if (!m) return fail('NotAllowed', 'Gerade keine Box zum Abholen.');
      let pending;
      if (what === 'school') {
        pending = this.pendingSchool(this.rollSchool(docs['school/main']), m, uid);
        if (pending) m.claimedSchool = [...(m.claimedSchool || []), pending].slice(-6);
      } else {
        const cls = docs['classes/' + (m.classId || '-')];
        pending = cls ? this.pendingClassWeek(this.roll(cls), m, uid) : '';
        if (pending) m.claimedClass = [...(m.claimedClass || []), pending].slice(-6);
      }
      if (!pending) return fail('NotAllowed', 'Gerade keine Box zum Abholen.');
      return { value: ok({ claimed: pending }), writes: { ['classMembers/' + uid]: m } };
    });
  }

  // ------------------------------------------------ Zählen
  /** Ein Online-Rennen ist fertig: uids der Menschen, die ins Ziel kamen. Klassen bekommen Punkte (Zusammenfahren zählt mehr), das Schulziel zählt jedes Rennen. */
  async creditRace(uids) {
    const unique = [...new Set(uids.filter(Boolean))];
    if (unique.length === 0) return;
    const byClass = new Map();
    for (const uid of unique) {
      const member = await this.store.get('classMembers', uid);
      if (member && member.classId) {
        if (!byClass.has(member.classId)) byClass.set(member.classId, []);
        byClass.get(member.classId).push(uid);
      }
    }
    for (const [classId, members] of byClass) {
      await this.store.transact([['classes', classId]], async (docs) => {
        const cls = docs['classes/' + classId];
        if (!cls) return { value: null, writes: {} };
        this.roll(cls);
        const present = members.filter((u) => cls.members[u]);
        cls.week.points += racePoints(present.length);
        for (const u of present) {
          cls.members[u].totalRaces = (cls.members[u].totalRaces || 0) + 1;
          cls.members[u].weekRaces = (cls.members[u].weekRaces || 0) + 1;
        }
        if (cls.week.points >= weekGoal(Object.keys(cls.members).length)) cls.week.reached = true;
        return { value: null, writes: { ['classes/' + classId]: cls } };
      });
    }
    await this.store.transact([['school', 'main']], async (docs) => {
      const doc = this.rollSchool(docs['school/main']);
      doc.points += unique.length;
      for (const u of unique) doc.active[u] = true;
      if (doc.points >= schoolGoal(Object.keys(doc.active).length)) doc.reached = true;
      return { value: null, writes: { 'school/main': doc } };
    });
  }
}

function ok(data = {}) { return { ok: true, code: '', message: '', ...data }; }
function fail(code, message, extra = {}) { return { value: { ok: false, code, message, ...extra }, writes: {} }; }
function cleanPlayer(name) { return String(name || '?').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 24) || '?'; }

module.exports = {
  ClassService, MemoryStore, FirestoreStore,
  racePoints, weekGoal, schoolGoal, rankIndex, kickVotesNeeded, isOffensive, cleanName, weekId, schoolPeriodId,
  PRESETS, MAX_MEMBERS, RANKS
};
