// Small DOM helpers shared by the tag apps.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// h('button', { class: 'btn', onclick: fn }, 'Save') builds an element. Strings become text, never HTML.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(9)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

export function mount(el, ...kids) { el.replaceChildren(...kids.flat(9).filter(k => k != null && k !== false)); return el; }

// The toast: one live region (role=status) that is on the page from the start, so even the first thing said in it is
// read out by a screen reader. It stays long enough to read: 1.2 s and 60 ms a character, at least 2.6 s.
let toastTimer;
const toastRegion = () => $('#toast') || document.body.appendChild(h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' }));
if (typeof document !== 'undefined') { if (document.body) toastRegion(); else document.addEventListener('DOMContentLoaded', toastRegion); }
export const toastMs = text => Math.max(2600, 1200 + 60 * String(text).length);
export function toast(text, kind = '') {
  const t = toastRegion();
  t.textContent = text; t.className = 'toast show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), toastMs(text));
}

// A bottom sheet with a form. fields: [{ name, label, type, value, options, placeholder, hint, required }].
// Resolves to the values (an object) or null if cancelled; { __danger: true } for the red button (danger: 'Delete'),
// { __other: true } for a plain one beside it (other: 'Edit').
// check(values), when given, runs on Save before the sheet closes, and may wait (Larder asks a question in a sheet of
// its own). A line it returns (or { line, field }) is said above the buttons, and the sheet stays open with everything
// typed, the focus on that field; { field } alone keeps it open with no line. Nothing, and it closes as before. So a
// Save the app refuses (a number already taken, a weight it can't read, the ledger not heard from yet) loses nothing.
export function sheet({ title, fields = [], body = null, ok = 'Save', danger = null, other = null, check = null }) {
  return new Promise(resolve => {
    const dlg = h('dialog', { class: 'sheet' });
    const form = h('form', { method: 'dialog' });
    const inputs = {};
    for (const f of fields) {
      let input;
      const id = 'f-' + f.name;
      if (f.type === 'select') input = h('select', { id, name: f.name }, (f.options || []).map(o => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return h('option', { value: v, selected: String(v) === String(f.value ?? '') }, l);
      }));
      else if (f.type === 'textarea') { input = h('textarea', { id, name: f.name, rows: f.rows || 3, placeholder: f.placeholder || '' }); input.value = f.value ?? ''; }
      else { input = h('input', { id, name: f.name, type: f.type || 'text', placeholder: f.placeholder || '', inputmode: f.inputmode, step: f.step, min: f.min, list: f.list, autocomplete: 'off', required: f.required }); input.value = f.value ?? ''; }
      inputs[f.name] = input;
      form.append(h('label', { class: 'field', for: id }, h('span', {}, f.label), input, f.hint ? h('small', {}, f.hint) : null));
    }
    if (body) form.append(body);
    const said = h('p', { class: 'msg bad sheet-msg', 'aria-live': 'polite' });
    const bar = h('div', { class: 'sheet-bar' }, said,
      danger ? h('button', { type: 'button', class: 'btn danger ghost', onclick: () => { dlg.close(); resolve({ __danger: true }); } }, danger) : null,
      other ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { dlg.close(); resolve({ __other: true }); } }, other) : null,
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { dlg.close(); resolve(null); } }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn' }, ok));
    form.append(bar);
    let checking = false;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (checking) return;
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.value.trim();
      if (check) {
        checking = true;
        let r;
        try { r = await check(out); } finally { checking = false; }
        if (!dlg.open) return;                       // cancelled while it was checking
        const { line = '', field = null } = typeof r === 'string' ? { line: r } : r || {};
        said.textContent = line;
        if (line || field) { inputs[field]?.focus(); return; }
      }
      dlg.close(); resolve(out);
    });
    dlg.addEventListener('cancel', () => resolve(null));
    dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 50));
    dlg.append(h('h2', {}, title), form);
    document.body.append(dlg);
    dlg.showModal();
    const first = Object.values(inputs)[0];
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  });
}

// A press whose job waits on something first (New tote asks the ledger for the latest): the button is held until then,
// so a second press doesn't open a second sheet.
export async function held(btn, p) {
  if (btn) btn.disabled = true;
  try { return await p; } finally { if (btn) btn.disabled = false; }
}

export function confirmSheet(title, text, ok = 'OK') {
  return sheet({ title, body: h('p', {}, text), ok }).then(v => !!v && !v.__danger);
}

// ---- dates (YYYY-MM-DD strings, local time)
export const today = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// Local midnight of the day. The year is set as written: new Date(26, …) would read year 26 as 1926.
export function parseDay(s) {
  const [y, m, d] = String(s).split('-').map(Number), t = new Date(2000, 0, 1);
  t.setFullYear(y, (m || 1) - 1, d || 1);
  return t;
}
export function monthsSince(day, now = new Date()) {
  if (!day) return null;
  const a = parseDay(day);
  return (now.getFullYear() - a.getFullYear()) * 12 + (now.getMonth() - a.getMonth()) - (now.getDate() < a.getDate() ? 1 : 0);
}
// Whole days from the day to today, counted on the calendar (UTC day numbers from each date's year, month and day), not
// the clock: the spring clock change's 23-hour day would make Mar 1 to Mar 15 read 13. As Frostbite's food.js counts.
const dayNo = t => { const u = new Date(0); u.setUTCFullYear(t.getFullYear(), t.getMonth(), t.getDate()); return u.getTime() / 864e5; };
export function daysSince(day, now = new Date()) {
  if (!day) return null;
  return dayNo(now) - dayNo(parseDay(day));
}
export function ageText(day, now = new Date()) {
  const d = daysSince(day, now);
  if (d == null) return '';
  if (d < 1) return 'today';
  if (d < 14) return d === 1 ? '1 day' : `${d} days`;
  if (d < 61) return `${Math.round(d / 7)} wk`;
  const m = monthsSince(day, now);
  if (m < 24) return `${m} mo`;
  const y = m / 12;
  return `${y.toFixed(y < 10 && m % 12 ? 1 : 0)} yr`;
}
// How long ago, in words that read right from the first day: 'today', 'yesterday', '3 days ago', '5 wk ago', '14 mo ago'.
// (ageText alone gives 'today' under a day, so 'packed ' + ageText + ' ago' read "packed today ago".)
export function agoText(day, now = new Date()) {
  const d = daysSince(day, now);
  if (d == null) return '';
  return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${ageText(day, now)} ago`;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayText(day) { if (!day) return ''; const d = parseDay(day); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
// A moment as 'Nov 27, 6:05 pm', with the year when it isn't this year ('Dec 9, 2025, 6:00 pm').
export function stampText(ms, now = new Date()) {
  const d = new Date(ms), year = d.getFullYear() === now.getFullYear() ? '' : `, ${d.getFullYear()}`;
  return `${MON[d.getMonth()]} ${d.getDate()}${year}, ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`;
}

// ---- the address: #<id> is an item, #/<view> is a screen
// An address that can't be decoded (cut short or mistyped, like #%E0%A4%A) is the home page, not a blank one.
export function route(hash = location.hash) {
  let s;
  try { s = decodeURIComponent(hash.replace(/^#/, '')); } catch { return { view: 'home' }; }
  if (!s) return { view: 'home' };
  if (s.startsWith('/')) { const [view, ...rest] = s.slice(1).split('/'); return { view: view || 'home', arg: rest.join('/') }; }
  return { view: 'item', id: s.toLowerCase() };
}
export const go = h => { if (location.hash !== h) location.hash = h; else window.dispatchEvent(new HashChangeEvent('hashchange')); };

// The way out of an app's sample (?demo), beside "Sample data: nothing is kept" or in Placard's sample note.
export const sampleLink = () => h('a', { class: 'sample-out', href: './' }, 'Leave the sample');

export const buzz = p => { try { navigator.vibrate?.(p); } catch {} };

// QR code as an SVG string (needs js/kit/qrcode.js loaded as a classic script).
export function qrSvg(text, { size = 120, margin = 2 } = {}) {
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), w = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${w}" height="${w}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// Text with one entry per line, with any typed numbering or bullets taken off: "1. ", "2) ", "- ", "* ", "• ". Only
// with a space after, so a line that starts with a number keeps it ("0.5 inch", "-10°F", "2.5 m extension lead").
export const lines = text => String(text || '').split('\n').map(l => l.replace(/^\s*(?:\d+[.)]|[-*•])(?=\s)\s*/, '').trim()).filter(Boolean);
