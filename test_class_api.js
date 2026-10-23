// Test der Klassen-Schnittstelle (HTTP) gegen einen laufenden Server ohne Firebase.
// Start: node test_class_api.js [url]   (Standard http://localhost:8787)
'use strict';
const assert = require('assert');
const base = process.argv[2] || 'http://localhost:8787';

async function call(body) {
  const res = await fetch(base + '/api/class', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  const anon = await call({ op: 'state' });
  assert.strictEqual(anon.code, 'NotSignedIn', 'ohne Kennung geht nichts');
  let st = await call({ op: 'state', devUid: 'api_a' });
  assert.ok(st.ok && st.classes.length >= 33, 'Liste mit allen vorgefertigten Klassen');
  assert.strictEqual(st.myClass, null);
  let r = await call({ op: 'create', devUid: 'api_a', name: 'Anna', clubName: 'API-Testclub ' + Date.now() % 1000 });
  assert.ok(r.ok, JSON.stringify(r));
  st = await call({ op: 'state', devUid: 'api_a' });
  assert.strictEqual(st.myClass.leaderUid, 'api_a');
  r = await call({ op: 'join', devUid: 'api_b', name: 'Ben', classId: st.myClass.id });
  assert.ok(r.ok, JSON.stringify(r));
  r = await call({ op: 'vote', devUid: 'api_b', targetUid: 'api_a' });
  assert.strictEqual(r.ok, false, 'ohne Rennen in dieser Woche keine Stimme');
  r = await call({ op: 'claim', devUid: 'api_b', what: 'class' });
  assert.strictEqual(r.ok, false);
  r = await call({ op: 'nope', devUid: 'api_b' });
  assert.strictEqual(r.code, 'Bad');
  await call({ op: 'leave', devUid: 'api_b' });
  await call({ op: 'leave', devUid: 'api_a' });
  console.log('test_class_api: alles ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
