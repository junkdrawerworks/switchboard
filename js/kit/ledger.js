// The ledger: one Google Sheet (Switchboard's Apps Script) that every tag app reads and writes.
// Each app keeps a mirror of its collections in localStorage, so it opens instantly and works with no signal;
// writes go into an outbox and are sent in one batch when the ledger answers.
const jget = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const clone = o => JSON.parse(JSON.stringify(o));

// A setup link from Switchboard: …/#connect=<base64url of {"u":url,"k":key}>. Saves it and tidies the address.
export function takeConnectLink(app, loc = location) {
  const m = /[#&]connect=([A-Za-z0-9_-]+)/.exec(loc.hash || '');
  if (!m) return false;
  try {
    const { u, k } = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(u) || !k) return false;
    jset(app + '.ledger', { url: u, key: k });
    history.replaceState(null, '', loc.pathname + loc.search);
    return true;
  } catch { return false; }
}

export function connectLink(base, url, key) {
  const b = btoa(JSON.stringify({ u: url, k: key })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${base}#connect=${b}`;
}

// Public reads need no key: only collections the ledger lists as public answer (Placard's site).
export async function publicRead(url, app, coll) {
  const r = await fetch(`${url}?op=pub&app=${encodeURIComponent(app)}&coll=${encodeURIComponent(coll)}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'ledger said no');
  return j.docs;
}
export async function publicReport(url, app, coll, doc) {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify({ op: 'report', app, coll, doc }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'ledger said no');
  return j;
}

export class Ledger {
  constructor(app, { demo = null, fetchImpl = null } = {}) {
    this.app = app;
    this.cfg = jget(app + '.ledger') || {};
    this.demo = demo ? new DemoLedger(demo) : null;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.mirror = {};
    this.outbox = this.demo ? [] : (jget(app + '.outbox') || []);
    this.listeners = new Set();
    this.state = this.demo ? 'demo' : (this.connected ? (this.outbox.length ? 'pending' : 'idle') : 'unset');
    this.lastError = '';
  }
  get connected() { return !!(this.demo || (this.cfg.url && this.cfg.key)); }
  setConfig(url, key) {
    this.cfg = { url: String(url).trim(), key: String(key).trim() };
    jset(this.app + '.ledger', this.cfg);
    this.state = 'idle'; this.emit();
  }
  forget() { this.cfg = {}; try { localStorage.removeItem(this.app + '.ledger'); } catch {} this.state = 'unset'; this.emit(); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) try { fn(this); } catch (e) { console.warn(e); } }

  async call(body) {
    if (this.demo) return this.demo.handle(clone(body));
    if (!this.connected) throw new Error('not connected');
    const r = await this.fetch(this.cfg.url, { method: 'POST', body: JSON.stringify({ ...body, key: this.cfg.key }) });
    if (!r.ok) throw new Error('ledger HTTP ' + r.status);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'ledger said no');
    return j;
  }
  async ping() { return this.call({ op: 'ping' }); }

  // ---- the mirror
  m(coll) {
    if (!this.mirror[coll]) this.mirror[coll] = (this.demo ? null : jget(`${this.app}.m.${coll}`)) || { docs: {}, since: 0 };
    return this.mirror[coll];
  }
  save(coll) { if (!this.demo) jset(`${this.app}.m.${coll}`, this.m(coll)); }
  docs(coll) { return Object.values(this.m(coll).docs).filter(d => !d._deleted); }
  doc(coll, id) { const d = this.m(coll).docs[id]; return d && !d._deleted ? d : null; }
  has(coll) { return this.m(coll).since > 0 || Object.keys(this.m(coll).docs).length > 0; }

  put(coll, doc) {
    if (!doc.id) throw new Error('doc needs an id');
    const d = { ...clone(doc), _updated: Date.now() };
    delete d._deleted;
    this.m(coll).docs[d.id] = d; this.save(coll);
    this.queue({ op: 'put', app: this.app, coll, id: d.id, doc: d });
    return d;
  }
  del(coll, id) {
    const mm = this.m(coll);
    mm.docs[id] = { id, _deleted: true, _updated: Date.now() }; this.save(coll);
    this.queue({ op: 'del', app: this.app, coll, id });
  }
  queue(op) {
    this.outbox = this.outbox.filter(o => !(o.coll === op.coll && o.id === op.id)); // only the latest write per doc
    this.outbox.push(op);
    if (!this.demo) jset(this.app + '.outbox', this.outbox);
    this.state = 'pending'; this.emit();
    clearTimeout(this._t); this._t = setTimeout(() => this.flush(), 400);
  }
  get pending() { return this.outbox.length; }

  async flush() {
    if (!this.outbox.length || !this.connected || this._flushing) return;
    this._flushing = true;
    const ops = this.outbox.slice(0, 40);
    try {
      await this.call({ op: 'batch', ops });
      this.outbox = this.outbox.filter(o => !ops.includes(o));
      if (!this.demo) jset(this.app + '.outbox', this.outbox);
      this.state = this.demo ? 'demo' : this.outbox.length ? 'pending' : 'synced'; this.lastError = '';
    } catch (e) {
      this.state = 'offline'; this.lastError = e.message;
    } finally { this._flushing = false; this.emit(); }
    if (this.outbox.length && this.state !== 'offline') this.flush();
  }

  // Brings collections up to date. Docs with a write still in the outbox keep the local copy.
  async sync(colls) {
    if (!this.connected) return false;
    await this.flush();
    try {
      for (const coll of colls) {
        const mm = this.m(coll);
        const j = await this.call({ op: 'list', app: this.app, coll, since: mm.since });
        const waiting = new Set(this.outbox.filter(o => o.coll === coll).map(o => o.id));
        for (const d of j.docs) if (!waiting.has(d.id)) mm.docs[d.id] = d;
        mm.since = (j.time || Date.now()) - 5000; // overlap: a write in the same moment as the list is fetched again, never missed
        this.save(coll);
      }
      this.state = this.demo ? 'demo' : this.outbox.length ? 'pending' : 'synced'; this.lastError = '';
      this.emit();
      return true;
    } catch (e) {
      this.state = 'offline'; this.lastError = e.message; this.emit();
      return false;
    }
  }
  statusText() {
    if (this.demo) return 'Sample data: nothing is kept';
    return ({ demo: 'Sample data — nothing is saved', unset: 'Not connected to the ledger', idle: 'Connected',
      synced: 'Saved', pending: `Saving ${this.outbox.length}…`, offline: `Offline — ${this.outbox.length} waiting` })[this.state] || '';
  }
}

// The same answers as the Apps Script, held in memory: the sample mode and the tests use it.
export class DemoLedger {
  constructor(seed) {
    this.t = 1000;
    this.store = {};
    for (const [name, docs] of Object.entries(seed || {})) for (const d of docs) this.write(name, d);
    this.reports = [];
  }
  write(name, doc) { (this.store[name] ||= {})[doc.id] = { ...doc, _updated: ++this.t }; }
  handle(b) {
    const name = `${b.app}.${b.coll}`;
    const docs = () => Object.values(this.store[name] || {});
    switch (b.op) {
      case 'ping': return { ok: true, version: 'demo', time: this.t };
      case 'list': return { ok: true, time: this.t, docs: docs().filter(d => d._updated > (b.since || 0)) };
      case 'pub': return { ok: true, docs: docs().filter(d => !d._deleted) };
      case 'report': this.reports.push(b.doc); return { ok: true };
      case 'put': this.write(name, { ...b.doc, id: b.id }); return { ok: true };
      case 'del': this.write(name, { id: b.id, _deleted: true }); return { ok: true };
      case 'batch': for (const o of b.ops) this.handle(o); return { ok: true, n: b.ops.length };
      default: return { ok: false, error: 'unknown op ' + b.op };
    }
  }
}
