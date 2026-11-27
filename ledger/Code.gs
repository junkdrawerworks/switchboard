// Switchboard ledger: the Google Sheet behind the tag apps (Placard, Mothball, Larder, Frostbite, Packrat),
// published as an Apps Script web app. Every other tab in the sheet is one collection, named app.collection;
// each row is one record: id, when it last changed, whether it was deleted, and the record itself as JSON.
//
// Setup (once): put this file in the sheet's Extensions > Apps Script, run setup(), then Deploy > New deployment >
// Web app, Execute as: Me, Who has access: Anyone. Every request except the public ones carries the key that
// setup() writes on the About tab.
const VERSION = '1.0';
const PUBLIC_READ = ['placard.site'];                 // anyone may read these (the rental's tenant pages)
const PUBLIC_REPORT = { 'placard.reports': 30 };      // anyone may add to these, at most this many an hour
const HEAD = ['id', 'updated', 'deleted', 'json'];

function setup() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
    props.setProperty('KEY', key);
  }
  const ss = SpreadsheetApp.getActive();
  const about = ss.getSheetByName('About') || ss.insertSheet('About', 0);
  about.getRange('A1:B5').setValues([
    ['Switchboard ledger', 'v' + VERSION],
    ['Key', key],
    ['Reports go to', Session.getEffectiveUser().getEmail()],
    ['Tabs', 'Each other tab is one collection (app.collection). Edit cells only in the json column, and keep it valid JSON.'],
    ['Set up', new Date()],
  ]);
  about.setColumnWidth(1, 160); about.setColumnWidth(2, 420);
  MailApp.getRemainingDailyQuota(); // asks for the mail permission now, so the first report can email you
  Logger.log('Key: ' + key);
}

function doGet(e) { return out(handle(e.parameter || {})); }
function doPost(e) {
  let body;
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out({ ok: false, error: 'bad json' }); }
  return out(handle(body));
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function handle(q) {
  try {
    const op = q.op || 'ping';
    const name = q.app && q.coll ? String(q.app) + '.' + String(q.coll) : '';
    if (op === 'ping' && !q.key) return { ok: true, app: 'switchboard-ledger', version: VERSION };
    if (op === 'pub') {
      if (PUBLIC_READ.indexOf(name) < 0) return { ok: false, error: 'not public' };
      return { ok: true, docs: list(name, 0, null).filter(function (d) { return !d._deleted; }) };
    }
    if (op === 'report') return report(name, q.doc);
    const key = PropertiesService.getScriptProperties().getProperty('KEY');
    if (!key || q.key !== key) return { ok: false, error: 'bad key' };
    switch (op) {
      case 'ping': return { ok: true, version: VERSION, time: Date.now() };
      case 'list': return { ok: true, time: Date.now(), docs: list(checkName(name), Number(q.since) || 0, q.match || null) };
      case 'get': { const d = getDoc(checkName(name), String(q.id)); return { ok: true, doc: d }; }
      case 'put': return locked(function () { return write({ op: 'put', app: q.app, coll: q.coll, id: q.id, doc: q.doc }); });
      case 'del': return locked(function () { return write({ op: 'del', app: q.app, coll: q.coll, id: q.id }); });
      case 'add': return locked(function () { return write({ op: 'add', app: q.app, coll: q.coll, doc: q.doc }); });
      case 'batch':
        if (!Array.isArray(q.ops) || q.ops.length > 100) return { ok: false, error: 'batch needs 1-100 ops' };
        return locked(function () { return { ok: true, results: q.ops.map(write) }; });
      default: return { ok: false, error: 'unknown op ' + op };
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function checkName(name) {
  if (!/^[a-z0-9-]{1,30}\.[a-z0-9-]{1,30}$/.test(name)) throw new Error('bad app or coll');
  return name;
}
function locked(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function tab(name, create) {
  const ss = SpreadsheetApp.getActive();
  let s = ss.getSheetByName(name);
  if (!s && create) {
    s = ss.insertSheet(name);
    // Plain text, so a Sheet keeps ids such as 01 (a tote number) as typed instead of turning them into the number 1
    s.getRange('A:A').setNumberFormat('@');
    s.getRange('D:D').setNumberFormat('@');
    s.getRange(1, 1, 1, 4).setValues([HEAD]).setFontWeight('bold');
    s.setFrozenRows(1);
    s.setColumnWidth(4, 600);
  }
  return s;
}
// The same for one row's id and json cells, before writing them: covers tabs made before the column format was set.
function asText(s, row) {
  s.getRange(row, 1).setNumberFormat('@');
  s.getRange(row, 4).setNumberFormat('@');
}
function rows(s) {
  const n = s.getLastRow() - 1;
  return n > 0 ? s.getRange(2, 1, n, 4).getValues() : [];
}
function parse(r) {
  let d;
  try { d = JSON.parse(r[3] || '{}'); } catch (e) { d = { _bad: String(r[3]).slice(0, 200) }; }
  d.id = String(r[0]);
  d._updated = Number(r[1]) || 0;
  if (r[2] === true || r[2] === 'TRUE') d._deleted = true;
  return d;
}

function list(name, since, match) {
  const s = tab(name, false);
  if (!s) return [];
  return rows(s).filter(function (r) { return r[0] !== '' && (Number(r[1]) || 0) > since; }).map(parse).filter(function (d) {
    if (!match || d._deleted) return true;
    for (const k in match) if (d[k] !== match[k]) return false;
    return true;
  });
}
function getDoc(name, id) {
  const s = tab(name, false);
  if (!s) return null;
  const r = rows(s).filter(function (r) { return String(r[0]) === id; })[0];
  return r ? parse(r) : null;
}

// One write: put (replace the record), del (mark it deleted) or add (a new record, id made up if missing).
function write(o) {
  const name = checkName(String(o.app) + '.' + String(o.coll));
  let id = o.id != null ? String(o.id) : (o.doc && o.doc.id ? String(o.doc.id) : '');
  if (o.op === 'add' && !id) id = Utilities.getUuid().slice(0, 8);
  if (!/^[A-Za-z0-9_.:-]{1,60}$/.test(id)) throw new Error('bad id ' + id);
  const s = tab(name, true);
  const now = Date.now();
  let json = '';
  if (o.op !== 'del') {
    const doc = Object.assign({}, o.doc || {});
    delete doc.id; delete doc._updated; delete doc._deleted;
    json = JSON.stringify(doc);
    if (json.length > 45000) throw new Error('record too big');
  }
  const ids = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  const at = ids.indexOf(id);
  const row = [id, now, o.op === 'del', o.op === 'del' ? '' : json];
  if (at >= 0) { asText(s, at + 2); s.getRange(at + 2, 1, 1, 4).setValues([row]); }
  else { asText(s, s.getLastRow() + 1); s.appendRow(row); }
  return { ok: true, id: id, updated: now };
}

// A tenant's or a visitor's note from a public page: kept short, counted per hour, and emailed to you.
function report(name, doc) {
  const max = PUBLIC_REPORT[name];
  if (!max) return { ok: false, error: 'not public' };
  doc = doc || {};
  if (doc.website) return { ok: true }; // the hidden field only robots fill in
  const cache = CacheService.getScriptCache();
  const k = 'rep:' + name + ':' + new Date().getHours();
  const n = Number(cache.get(k) || 0);
  if (n >= max) return { ok: false, error: 'too many reports this hour; try later or call' };
  cache.put(k, String(n + 1), 3600);
  const clean = {};
  ['system', 'systemName', 'kind', 'name', 'contact', 'text'].forEach(function (f) { if (doc[f]) clean[f] = String(doc[f]).slice(0, f === 'text' ? 2000 : 120); });
  if (!clean.text) return { ok: false, error: 'empty report' };
  clean.at = new Date().toISOString();
  clean.status = 'new';
  locked(function () { return write({ op: 'add', app: name.split('.')[0], coll: name.split('.')[1], doc: clean }); });
  try {
    const to = SpreadsheetApp.getActive().getSheetByName('About').getRange('B3').getValue();
    if (to) MailApp.sendEmail(String(to), 'House manual: ' + (clean.kind || 'note') + ' — ' + (clean.systemName || clean.system || 'general'),
      [clean.text, '', 'From: ' + (clean.name || '(no name)') + ' ' + (clean.contact || ''), 'System: ' + (clean.systemName || clean.system || '-'), 'At: ' + clean.at].join('\n'));
  } catch (e) { /* the report is saved even if the email fails */ }
  return { ok: true };
}
