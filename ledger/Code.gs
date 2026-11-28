// Switchboard ledger: the Google Sheet behind the tag apps (Placard, Mothball, Larder, Frostbite, Packrat),
// published as an Apps Script web app. Every other tab in the sheet is one collection, named app.collection;
// each row is one record: id, when it last changed, whether it was deleted, and the record itself as JSON.
//
// Setup (once): put this file in the sheet's Extensions > Apps Script, run setup(), then Deploy > New deployment >
// Web app, Execute as: Me, Who has access: Anyone. Every request except the public ones carries the key that
// setup() writes on the About tab.
const VERSION = '1.1';
const PUBLIC_READ = ['placard.site'];                 // anyone may read these (the rental's tenant pages)
const PUBLIC_REPORT = { 'placard.reports': 30 };      // anyone may add to these, at most this many an hour
// Reports emailed in a day, at most. Gmail lets a script email 100 people a day (1,500 on Workspace), shared by every
// script you run: developers.google.com/apps-script/guides/services/quotas. Past this a report is still kept.
const MAIL_PER_DAY = 20;
const TOO_MANY = 'too many reports this hour; try later or call';
const HEAD = ['id', 'updated', 'deleted', 'json'];
const TAB = /^[a-z0-9-]{1,30}\.[a-z0-9-]{1,30}$/;    // a collection's tab: app.collection
// Collections whose ids are numbers written with two digits (tote 01, pack 07): see mend().
const NUMBERED = ['mothball.totes', 'packrat.packs'];

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
    ['Tabs', 'Change a json cell and the apps pick it up at their next sync; keep it valid JSON. To remove a record, put TRUE in its deleted cell; to bring one back, FALSE. After restoring an earlier version, use Ledger › Send everything to the phones again.'],
    ['Set up', new Date()],
  ]);
  about.getRange('B4').setWrap(true);
  about.setColumnWidth(1, 160); about.setColumnWidth(2, 420);
  MailApp.getRemainingDailyQuota(); // asks for the mail permission now, so the first report can email you
  Logger.log('Key: ' + key);
}

// By GET only the reads anyone may make: ping (the apps' check that the deployment answers) and pub. Everything else
// comes by POST: a GET would put the key in the address, and every value in it arrives as text.
function doGet(e) {
  const q = e.parameter || {};
  if (q.op && q.op !== 'ping' && q.op !== 'pub') return out({ ok: false, error: 'use POST' });
  return out(handle(q));
}
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
      case 'put': return locked(function () { return write({ op: 'put', app: q.app, coll: q.coll, id: q.id, doc: q.doc, ifUpdated: q.ifUpdated }); });
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
  if (!TAB.test(name)) throw new Error('bad app or coll');
  return name;
}
function locked(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  // Google's advice for a sheet: flush before releasing, so the next writer reads every row this one wrote
  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
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

// One record per id: if a tab has two rows for an id (a row copied by hand), the one changed last counts.
function newest(rs) {
  const by = {}, order = [];
  rs.forEach(function (r) {
    const id = String(r[0]);
    if (!(id in by)) order.push(id);
    if (!(id in by) || (Number(r[1]) || 0) >= (Number(by[id][1]) || 0)) by[id] = r;
  });
  return order.map(function (id) { return by[id]; });
}
function list(name, since, match) {
  const s = tab(name, false);
  if (!s) return [];
  return newest(mended(name, s).filter(function (r) { return r[0] !== ''; })).filter(function (r) { return (Number(r[1]) || 0) > since; }).map(parse).filter(function (d) {
    if (!match || d._deleted) return true;
    for (const k in match) if (d[k] !== match[k]) return false;
    return true;
  });
}
function getDoc(name, id) {
  const s = tab(name, false);
  if (!s) return null;
  const r = newest(mended(name, s).filter(function (r) { return String(r[0]) === id; }))[0];
  return r ? parse(r) : null;
}

// Version 1.0 of this script didn't keep ids as text, so a sheet it wrote holds the tote number 01 as the number 1,
// which lists as "1": a device that has only listed it sees no tote 01 and offers to set one up over it. The first
// list of totes or packs once 1.1 is pasted writes each such row back as 01 and stamps it, with a deleted "1" beside
// it, so every phone fetches 01 at its next sync and drops the "1" it listed. (A row with a 01 of its own beside it is
// left as it is.) rows(s), after that.
const oldNumber = function (x) { return typeof x === 'number' && x >= 0 && x <= 9 && x === Math.floor(x); };
function mended(name, s) {
  const rs = rows(s);
  if (NUMBERED.indexOf(name) < 0) return rs;
  const ids = rs.map(function (r) { return r[0]; });
  if (!ids.some(function (x) { return oldNumber(x) && ids.indexOf('0' + x) < 0; })) return rs;
  locked(function () { mend(s); });
  return rows(s);
}
function mend(s) {
  const n = s.getLastRow() - 1;
  if (n < 1) return;
  const ids = s.getRange(2, 1, n, 1).getValues().map(function (r) { return r[0]; });
  const now = Date.now();
  ids.forEach(function (x, i) {
    if (!oldNumber(x) || ids.indexOf('0' + x) >= 0) return;
    asText(s, i + 2); s.getRange(i + 2, 1, 1, 2).setValues([['0' + x, now]]);
    ids[i] = '0' + x;
    if (ids.indexOf(String(x)) < 0) { asText(s, s.getLastRow() + 1); s.appendRow([String(x), now, true, '']); ids.push(String(x)); }
  });
}

// One write: put (replace the record), del (mark it deleted, keeping the record, so FALSE typed into its deleted cell
// brings it back) or add (a new record, id made up if missing). A put with ifUpdated is made only on the version of
// the record it names (its updated time) and only if it isn't deleted; otherwise it changes nothing and answers
// skipped: Home Assistant's "added to the list" mark, so it never brings back an entry Larder took back after Home
// Assistant read it. The same put made again (its answer lost on the way) counts as made and changes nothing.
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
  const cells = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  // the rows holding this record: every row with its id, should a tab have two. Version 1.0 of this script didn't keep
  // ids as text, so a sheet it wrote can hold the tote number 01 as the number 1 (see mend()): with no row for the exact
  // id, a row holding that number is this record. It's written back as text, and the "1" phones listed from it is
  // marked deleted, so they keep one record.
  let at = [], old = '';
  cells.forEach(function (x, i) { if (String(x) === id) at.push(i); });
  if (!at.length && /^\d+$/.test(id)) {
    cells.forEach(function (x, i) { if (typeof x === 'number' && x === Number(id)) at.push(i); });
    if (at.length && String(Number(id)) !== id && cells.indexOf(String(Number(id))) < 0) old = String(Number(id));
  }
  // the record as the sheet has it now: the row changed last
  const named = o.op === 'put' && o.ifUpdated != null;
  const cur = at.length && (o.op === 'del' || named) ? newest(at.map(function (i) { return s.getRange(i + 2, 1, 1, 4).getValues()[0]; }))[0] : null;
  if (named) {
    const live = !!cur && cur[2] !== true && cur[2] !== 'TRUE';
    if (!live || (Number(cur[1]) || 0) !== Number(o.ifUpdated)) {
      return live && String(cur[3]) === json ? { ok: true, id: id, updated: Number(cur[1]) || 0 } : { ok: true, id: id, skipped: true };
    }
  }
  if (o.op === 'del') json = cur && cur[3] !== '' ? String(cur[3]) : '';
  const row = [id, now, o.op === 'del', json];
  at.forEach(function (i) { asText(s, i + 2); s.getRange(i + 2, 1, 1, 4).setValues([row]); });
  if (old) { asText(s, s.getLastRow() + 1); s.appendRow([old, now, true, '']); }
  if (!at.length) { asText(s, s.getLastRow() + 1); s.appendRow(row); }
  return { ok: true, id: id, updated: now };
}

// A change typed into a collection tab by hand: stamp its row's updated time, so a phone that has already synced
// fetches the record again (each sync asks only for rows changed since the last one). Google runs this by itself for
// edits made in the sheet (a simple trigger); the script's own writes don't run it.
function onEdit(e) {
  const r = e && e.range;
  if (!r) return;
  const s = r.getSheet();
  if (!TAB.test(s.getName()) || r.getColumn() > HEAD.length) return;
  const top = Math.max(2, r.getRow());
  const ids = r.getLastRow() >= top ? s.getRange(top, 1, r.getLastRow() - top + 1, 1).getValues() : [];
  let n = ids.length;
  while (n && ids[n - 1][0] === '') n--;                        // not the empty rows under the records
  if (!n) return;
  const now = Date.now();
  const stamps = s.getRange(top, 2, n, 1).getValues().map(function (v, i) { return [ids[i][0] === '' ? v[0] : now]; });
  s.getRange(top, 2, n, 1).setValues(stamps);
}

// The sheet's own menu, Ledger. Each phone fetches only the rows changed since its last sync, so a version of the sheet
// restored from File > Version history (its rows back with their old updated times) reaches no phone: Send everything
// to the phones again stamps every row of every collection tab as changed now, so each phone fetches the restored
// records at its next sync, before an edit there could write its newer copy back. Google runs onOpen by itself.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ledger').addItem('Send everything to the phones again', 'sendAgain').addToUi();
}
function sendAgain() {
  const n = locked(function () {
    const now = Date.now();
    let count = 0;
    SpreadsheetApp.getActive().getSheets().forEach(function (s) {
      const rs = s.getLastRow() - 1;
      if (!TAB.test(s.getName()) || rs < 1) return;
      const ids = s.getRange(2, 1, rs, 1).getValues(), was = s.getRange(2, 2, rs, 1).getValues();
      s.getRange(2, 2, rs, 1).setValues(was.map(function (v, i) { if (ids[i][0] === '') return v; count++; return [now]; }));
    });
    return count;
  });
  SpreadsheetApp.getActive().toast(n + (n === 1 ? ' record goes' : ' records go') + ' to every phone at its next sync.', 'Ledger');
}

// A tenant's or a visitor's note from a public page: kept short, counted per hour, and emailed to you. Only a real one
// counts towards the hour (not an empty one, nor the hidden field only robots fill in). The answer says whether the
// email went (emailed: false when today's share is used up or Google refused it), so the page can say "call". The
// same words from the same page as one in the last hour are kept, marked repeat, but not emailed again: the answer
// says when the first went (firstAt), for a tenant who sent it again thinking it hadn't gone.
function report(name, doc) {
  const max = PUBLIC_REPORT[name];
  if (!max) return { ok: false, error: 'not public' };
  doc = doc || {};
  if (doc.website) return { ok: true }; // the hidden field only robots fill in
  const clean = {};
  ['system', 'kind', 'name', 'contact', 'text'].forEach(function (f) { if (doc[f]) clean[f] = String(doc[f]).slice(0, f === 'text' ? 2000 : 120); });
  if (!clean.text) return { ok: false, error: 'empty report' };
  // Over the hour's share: turned down before waiting for the lock that every phone's save, Pinch and Home Assistant
  // need (anyone can post a report), and counted again under it.
  const cache = CacheService.getScriptCache(), hour = 'rep:' + name + ':' + new Date().getHours();
  const full = function () { return Number(cache.get(hour) || 0) >= max; };
  if (full()) return { ok: false, error: TOO_MANY };
  clean.at = new Date().toISOString();
  clean.status = 'new';
  // the page by its own name in the manual, never the name the report carried (anyone can post one)
  clean.systemName = pageName(name, clean.system);
  const day = clean.at.slice(0, 10);
  const props = PropertiesService.getScriptProperties();
  let mailOk = false, first = '';
  // Counted, kept and given today's email slot under the lock, so two at once can't both take the last one.
  const saved = locked(function () {
    if (full()) return false;
    cache.put(hour, String(Number(cache.get(hour) || 0) + 1), 3600);
    first = sentAt(name, clean);
    if (first) clean.repeat = true;
    write({ op: 'add', app: name.split('.')[0], coll: name.split('.')[1], doc: clean });
    const was = String(props.getProperty('MAILED') || '').split(' '), mailed = was[0] === day ? Number(was[1]) || 0 : 0;
    if (!first && mailed < MAIL_PER_DAY) { mailOk = true; props.setProperty('MAILED', day + ' ' + (mailed + 1)); }
    return true;
  });
  if (!saved) return { ok: false, error: TOO_MANY };
  if (first) return { ok: true, emailed: false, repeat: true, firstAt: first };
  let emailed = false;
  try {
    const to = SpreadsheetApp.getActive().getSheetByName('About').getRange('B3').getValue();
    if (to && mailOk && MailApp.getRemainingDailyQuota() > 0) {
      const kind = KINDS.indexOf(clean.kind) >= 0 ? clean.kind : 'note';
      // a sticker with no page says which sticker, if it's one a sticker can be
      const where = clean.systemName || (STICKER.test(clean.system || '') && FRONT.indexOf(clean.system) < 0
        ? 'general (sticker h/' + clean.system + ', which has no page in the manual)' : 'general');
      MailApp.sendEmail(String(to), 'House manual: ' + kind + ' — ' + (clean.systemName || 'general'),
        [clean.text, '', 'From: ' + (clean.name || '(no name)') + ' ' + (clean.contact || ''), 'System: ' + where, 'At: ' + clean.at].join('\n'));
      emailed = true;
    }
  } catch (e) { /* the report is saved even if the email fails */ }
  return { ok: true, emailed: emailed };
}
const KINDS = ['Problem', 'Service visit', 'Question'];         // the report form's three
const FRONT = ['', 'house', 'home'];                            // the front page
const STICKER = /^[a-z0-9][a-z0-9-]{0,39}$/;                    // what a sticker's id can be
const SITE = { 'placard.reports': 'placard.site' };             // where the pages a report names are
// A page's own name: '' for the front page, a deleted page or an id that isn't a page.
function pageName(name, id) {
  if (!SITE[name] || FRONT.indexOf(String(id || '')) >= 0) return '';
  const d = getDoc(SITE[name], String(id));
  if (!d || d._deleted || d._bad) return '';
  return (typeof d.name === 'string' && d.name.trim() ? d.name.trim() : String(id)).slice(0, 120);
}
// When the same report (same page, same words, any capitals or spacing) was first sent in the last hour, or '': not
// one marked repeat or handled since.
function sentAt(name, clean) {
  const words = function (t) { return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
  const since = Date.now() - 3600e3, text = words(clean.text), page = String(clean.system || '');
  let first = '';
  list(name, 0, null).forEach(function (d) {
    if (d._deleted || d.repeat || d.status === 'handled' || String(d.system || '') !== page || words(d.text) !== text) return;
    if (Date.parse(d.at) >= since && (!first || String(d.at) < first)) first = String(d.at);
  });
  return first;
}
