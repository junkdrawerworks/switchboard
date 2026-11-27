// The ledger's Apps Script (ledger/Code.gs) run in Node against a pretend Google Sheet, and the apps' Ledger class
// (js/kit/ledger.js) talking to it, so the whole round trip is tested without Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fakeGoogle() {
  // What a real Sheet does with a string written into a cell under its Automatic format: one that looks like a number,
  // TRUE/FALSE or a date is stored as that ('01' becomes 1). A cell formatted as plain text ('@') keeps the string.
  const sheetValue = v => {
    if (typeof v !== 'string') return v;
    if (/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v);
    if (/^(true|false)$/i.test(v)) return /^true$/i.test(v);
    const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v) || /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    if (d) return v.includes('-') ? new Date(+d[1], d[2] - 1, +d[3]) : new Date(+d[3], d[1] - 1, +d[2]);
    return v;
  };
  const sheets = {};
  const props = {};
  const mail = [];
  const cache = {};
  const locks = [];                                   // the lock and flush calls, in order
  const makeSheet = name => {
    const data = [];
    const fmt = {}, colFmt = {};                       // number formats: by 'row:col', and whole columns ('A:A')
    const put = (r, c, x) => { data[r - 1] ||= []; data[r - 1][c - 1] = (fmt[`${r}:${c}`] ?? colFmt[c]) === '@' ? x : sheetValue(x); };
    const s = {
      name, data, fmt, colFmt,
      getName: () => name,
      getLastRow: () => data.length,
      getMaxRows: () => Math.max(1000, data.length),
      getRange: (r, c, nr = 1, nc = 1) => {
        if (typeof r === 'string') { // 'A1:B5', 'B3' or a whole column 'A:A'
          const col = /^([A-Z]):\1$/.exec(r);
          if (col) return { setNumberFormat(f) { colFmt[col[1].charCodeAt(0) - 64] = f; return this; } };
          const m = /^([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(r);
          const c0 = m[1].charCodeAt(0) - 64, r0 = +m[2];
          return s.getRange(r0, c0, m[4] ? +m[4] - r0 + 1 : 1, m[3] ? m[3].charCodeAt(0) - 64 - c0 + 1 : 1);
        }
        return {
          setValues: v => { v.forEach((row, i) => row.forEach((x, j) => put(r + i, c + j, x))); return { setFontWeight() {} }; },
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? '')),
          getValue: () => (data[r - 1] || [])[c - 1] ?? '',
          setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fmt[`${r + i}:${c + j}`] = f; return this; },
          setFontWeight() { return this; },
          getSheet: () => s, getRow: () => r, getLastRow: () => r + nr - 1, getColumn: () => c, getLastColumn: () => c + nc - 1,
        };
      },
      appendRow: row => { const r = data.length + 1; row.forEach((x, j) => put(r, j + 1, x)); },
      setFrozenRows() {}, setColumnWidth() {},
    };
    return s;
  };
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
  };
  let uuid = 0;
  const g = {
    SpreadsheetApp: { getActive: () => ss, flush: () => { locks.push('flush'); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() { locks.push('lock'); }, releaseLock() { locks.push('release'); } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    MailApp: { sendEmail: (...a) => mail.push(a), getRemainingDailyQuota: () => 100 },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: { getUuid: () => `0000000${++uuid}-aaaa-bbbb-cccc-dddddddddddd`.slice(-36) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Logger: { log() {} },
    console, JSON, Date, Math, Object, Array, String, Number,
  };
  vm.createContext(g);
  vm.runInContext(readFileSync(new URL('../ledger/Code.gs', import.meta.url), 'utf8'), g);
  return { g, sheets, props, mail, cache, locks };
}

const post = (g, body) => JSON.parse(g.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const get = (g, q) => JSON.parse(g.doGet({ parameter: q }).text);

test('setup writes a key on the About tab, and ping works with and without it', () => {
  const { g, sheets, props } = fakeGoogle();
  g.setup();
  assert.equal(props.KEY.length, 40);
  assert.equal(sheets.About.data[1][1], props.KEY);
  assert.equal(get(g, {}).app, 'switchboard-ledger');
  assert.equal(post(g, { op: 'ping', key: 'nope' }).error, 'bad key');
  assert.equal(post(g, { op: 'ping', key: props.KEY }).ok, true);
});

test('put, list since, replace, delete and batch', () => {
  const { g, props } = fakeGoogle();
  g.setup();
  const key = props.KEY;
  assert.equal(post(g, { key, op: 'put', app: 'larder', coll: 'items', id: 'cumin', doc: { name: 'Cumin', g: 40 } }).ok, true);
  let l = post(g, { key, op: 'list', app: 'larder', coll: 'items', since: 0 });
  assert.deepEqual(l.docs.map(d => [d.id, d.name]), [['cumin', 'Cumin']]);
  const since = l.time;
  post(g, { key, op: 'put', app: 'larder', coll: 'items', id: 'cumin', doc: { name: 'Cumin, ground', g: 35 } });
  l = post(g, { key, op: 'list', app: 'larder', coll: 'items', since: since - 1 });
  assert.equal(l.docs.length, 1); assert.equal(l.docs[0].name, 'Cumin, ground');
  post(g, { key, op: 'batch', ops: [
    { op: 'put', app: 'larder', coll: 'items', id: 'paprika', doc: { name: 'Paprika' } },
    { op: 'del', app: 'larder', coll: 'items', id: 'cumin' },
    { op: 'add', app: 'larder', coll: 'queue', doc: { text: 'Cumin', synced: false } },
  ] });
  l = post(g, { key, op: 'list', app: 'larder', coll: 'items', since: 0 });
  assert.deepEqual(l.docs.map(d => [d.id, !!d._deleted]).sort(), [['cumin', true], ['paprika', false]]);
  const q = post(g, { key, op: 'list', app: 'larder', coll: 'queue', since: 0, match: { synced: false } });
  assert.equal(q.docs.length, 1); assert.equal(q.docs[0].text, 'Cumin');
  assert.equal(post(g, { key, op: 'list', app: 'larder', coll: 'queue', since: 0, match: { synced: true } }).docs.length, 0);
  assert.match(post(g, { key, op: 'put', app: 'Bad Name', coll: 'x', id: 'a', doc: {} }).error, /bad app/);
});

test('tote and pack numbers stay text: 01 is saved twice as one row and lists back as 01', () => {
  const { g, props, sheets } = fakeGoogle();
  g.setup();
  const key = props.KEY;
  post(g, { key, op: 'put', app: 'mothball', coll: 'totes', id: '01', doc: { name: 'Lights' } });
  post(g, { key, op: 'batch', ops: [{ op: 'put', app: 'mothball', coll: 'totes', id: '01', doc: { name: 'Lights and the rink' } }] });
  post(g, { key, op: 'put', app: 'mothball', coll: 'totes', id: '2026-12-01', doc: { name: 'A date-shaped id' } });
  assert.deepEqual(sheets['mothball.totes'].data.slice(1).map(r => r[0]), ['01', '2026-12-01'], 'one row for 01, kept as text');
  const docs = post(g, { key, op: 'list', app: 'mothball', coll: 'totes', since: 0 }).docs;
  assert.deepEqual(docs.map(d => [d.id, d.name]), [['01', 'Lights and the rink'], ['2026-12-01', 'A date-shaped id']]);
  assert.equal(post(g, { key, op: 'get', app: 'mothball', coll: 'totes', id: '01' }).doc.name, 'Lights and the rink');
  // a tab made by the first version of the script, with no column format: each row it writes is made text first
  const old = g.SpreadsheetApp.getActive().insertSheet('packrat.packs');
  old.appendRow(['id', 'updated', 'deleted', 'json']);
  post(g, { key, op: 'put', app: 'packrat', coll: 'packs', id: '07', doc: { label: '5.0 Ah' } });
  post(g, { key, op: 'put', app: 'packrat', coll: 'packs', id: '07', doc: { label: '5.0 Ah #2' } });
  assert.deepEqual(old.data.slice(1).map(r => r[0]), ['07']);
  // a report's made-up id can be all digits too
  const rep = post(g, { key, op: 'add', app: 'placard', coll: 'reports', doc: { text: 'x' } });
  assert.match(rep.id, /^\d+$/, 'the pretend Google makes all-digit ids');
  assert.equal(sheets['placard.reports'].data[1][0], rep.id);
  assert.equal(post(g, { key, op: 'list', app: 'placard', coll: 'reports', since: 0 }).docs[0].id, rep.id);
});

test('only Placard\'s site is public, and public reports are kept, limited and emailed', () => {
  const { g, props, mail } = fakeGoogle();
  g.setup();
  post(g, { key: props.KEY, op: 'put', app: 'placard', coll: 'site', id: 'site', doc: { title: 'House manual' } });
  post(g, { key: props.KEY, op: 'put', app: 'larder', coll: 'items', id: 'x', doc: { name: 'secret' } });
  assert.equal(get(g, { op: 'pub', app: 'placard', coll: 'site' }).docs[0].title, 'House manual');
  assert.equal(get(g, { op: 'pub', app: 'larder', coll: 'items' }).error, 'not public');
  assert.equal(post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { system: 'water-heater', text: 'Drip under the tank', name: 'Pat' } }).ok, true);
  assert.equal(mail.length, 1); assert.match(mail[0][1], /water-heater/);
  assert.equal(post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text: 'spam', website: 'x' } }).ok, true);
  assert.equal(mail.length, 1, 'the robot field is dropped');
  assert.equal(post(g, { op: 'report', app: 'larder', coll: 'items', doc: { text: 'x' } }).error, 'not public');
  for (let i = 0; i < 40; i++) post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text: 'n' + i } });
  assert.match(post(g, { op: 'report', app: 'placard', coll: 'reports', doc: { text: 'one more' } }).error, /too many/);
  const reps = post(g, { key: props.KEY, op: 'list', app: 'placard', coll: 'reports', since: 0 }).docs;
  assert.equal(reps.length, 30);
});

test('the apps\' Ledger class syncs through it, keeps an outbox while offline, and sends it later', async () => {
  globalThis.localStorage = { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } };
  const { Ledger } = await import('../js/kit/ledger.js');
  const { g, props } = fakeGoogle();
  g.setup();
  let up = true;
  const fetchImpl = async (url, o) => {
    if (!up) throw new Error('offline');
    return { ok: true, json: async () => post(g, JSON.parse(o.body)) };
  };
  const a = new Ledger('frostbite', { fetchImpl });
  a.setConfig('https://script.google.com/macros/s/X/exec', props.KEY);
  a.put('items', { id: 'i1', name: 'Chicken thighs', zone: 'z1' });
  await a.flush();
  assert.equal(a.pending, 0);
  const b = new Ledger('frostbite-b', { fetchImpl });
  b.app = 'frostbite';
  b.setConfig('https://script.google.com/macros/s/X/exec', props.KEY);
  await b.sync(['items']);
  assert.equal(b.doc('items', 'i1').name, 'Chicken thighs');
  up = false;
  a.put('items', { id: 'i2', name: 'Peas' });
  a.del('items', 'i1');
  await a.flush();
  assert.equal(a.state, 'offline'); assert.equal(a.pending, 2);
  up = true;
  await a.sync(['items']);
  assert.equal(a.pending, 0);
  await b.sync(['items']);
  assert.equal(b.doc('items', 'i1'), null);
  assert.equal(b.doc('items', 'i2').name, 'Peas');
});
