import { $, h, mount, toast, buzz } from './kit/ui.js';
import { APPS, parseTag, resolve, tagUrl } from './kit/tags.js';
import { Ledger, connectLink } from './kit/ledger.js';
import { readOnce, explainNfc, nfcSupported, cancelNfc } from './kit/nfc.js';
import { nfcPanel } from './kit/panel.js';
import { readOverrides } from './overrides.js';

const ledger = new Ledger('switchboard');
const appOrder = ['h', 't', 'p', 'f', 'm'];
const blurb = { h: 'The rental house manual', t: 'Seasonal totes', p: 'Consumables and spices', f: 'The freezer', m: 'Makita packs' };

if (location.hash === '#test') { $('#test-ok').hidden = false; history.replaceState(null, '', location.pathname); }

// ---- check a tag
// Where a sticker goes is what the resolver says: its OVERRIDES, read from 404.html (this site's own; with no signal the
// worker's copy), then the app the letter belongs to.
const overrides = fetch('404.html').then(r => r.text()).then(readOverrides).catch(() => ({}));
// Each press is one read. While it listens the button says Stop, and a press stops it. A read that Stop (or a newer
// press) ended says nothing more, so its "Stopped." can't land on top of the next press's "Listening" line.
let reading = 0, presses = 0;
const checkBtn = $('#check-btn');
const idle = () => { reading = 0; checkBtn.textContent = 'Check a tag'; };
checkBtn.addEventListener('click', async () => {
  const msg = $('#check-msg'), out = $('#check-out');
  if (!nfcSupported()) { msg.textContent = 'Reading tags here needs Chrome on an Android phone.'; msg.className = 'msg bad'; return; }
  if (reading) { idle(); cancelNfc(); msg.textContent = 'Stopped.'; msg.className = 'msg'; return; }
  const me = reading = ++presses;
  checkBtn.textContent = 'Stop';
  msg.textContent = 'Listening. Hold the sticker flat against the back of the phone, near the top.'; msg.className = 'msg wait'; out.hidden = true;
  try {
    const { url, serial } = await readOnce();
    const sent = await overrides;
    if (reading !== me) return;
    idle(); buzz(50);
    const t = parseTag(url);
    msg.textContent = ''; out.hidden = false;
    if (!url) mount(out, h('p', {}, 'That sticker is blank.'), h('p', { class: 'muted mono' }, serial));
    else if (!t) mount(out, h('p', {}, 'Not a Switchboard tag. It holds:'), h('code', { class: 'url' }, url));
    else {
      const to = resolve(t.letter, t.id, sent);
      mount(out,
        h('div', { class: 'tape-wrap' }, h('span', { class: 'tape-cap' }, `${t.letter} / ${APPS[t.letter]?.name || 'no app'}`), h('div', { class: 'tape' }, t.id)),
        to ? h('p', {}, 'Goes to ', h('code', {}, to)) : h('p', {}, 'No app owns this letter.'),
        sent[`${t.letter}/${t.id}`] ? h('p', { class: 'muted' }, 'Sent here by OVERRIDES in 404.html.') : null,
        to ? h('div', { class: 'btns' }, h('a', { class: 'btn', href: to }, 'Open')) : null);
    }
  } catch (e) {
    if (reading !== me) return;
    idle();
    const text = await explainNfc(e, 'read');
    if (reading) return; // pressed again while that was worked out
    msg.textContent = text; msg.className = 'msg ' + (e.name === 'AbortError' ? '' : 'bad');
  }
});

// ---- ledger
// What the ledger said when this page last asked (on open, and at Test and save): { version }, or { error } with the
// kit's e.kind: badkey, broken (a sign-in or error page instead of the ledger), offline or error (the ledger said no).
let answer = null;
// The ledger script these apps need: ledger/Code.gs's VERSION (test/ledger.test.mjs checks the two match). An older one
// still answers, but the sheet it writes turns tote and pack numbers 01 to 09 into 1 to 9, so it's amber, not green.
const WANT = '1.1';
const older = v => {
  const a = String(v).split('.').map(Number), b = WANT.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  return false;
};
const OLD_FIX = 'Paste ledger/Code.gs from Switchboard\'s repo over it, Save, then Deploy, Manage deployments, the pencil, Version: New version, Deploy. Until then don\'t save totes or packs numbered 01 to 09.';
const stateLine = e => ({ badkey: 'Wrong key — copy B2 from the sheet\'s About tab again', broken: 'The ledger isn\'t answering — check the deployment',
  error: `The ledger said no (${e.message})` })[e.kind] || 'Offline — can\'t reach the ledger';
const failText = e => ({ badkey: 'The address answered, but the key is wrong. Copy it again from the About tab, cell B2.',
  broken: 'Google answered with a sign-in or error page instead of the ledger. Check the address is the web app\'s (it ends /exec) and the deployment is set to "Anyone", then try again.',
  error: `The ledger said no (${e.message}).` })[e.kind] || 'Google didn\'t answer. Check the phone is online, then try again.';
function renderLedger() {
  const st = $('#ledger-state');
  const [k, text] = !ledger.connected ? ['unset', 'Not connected to the ledger'] : !answer ? ['pending', 'Checking the ledger…']
    : answer.version && older(answer.version) ? ['pending', `Ledger script v${answer.version} is older than these apps need (v${WANT})`]
    : answer.version ? ['synced', `Connected to ledger v${answer.version}`] : [answer.error.kind || 'offline', stateLine(answer.error)];
  st.className = 'sync ' + k; st.textContent = text;
  $('#ledger-forget').hidden = !ledger.connected;
  renderApps();
}
// The saved address and key in the boxes: at load and after Test and save, never under someone typing a new key.
const fillFields = () => { $('#lurl').value = ledger.cfg.url || ''; $('#lkey').value = ledger.cfg.key || ''; };
// A key changed in the sheet, or a deployment changed, shows as soon as Switchboard opens, not at the next save.
async function checkLedger() {
  if (!ledger.connected) return;
  answer = null; renderLedger();
  try { answer = { version: (await ledger.ping()).version }; } catch (e) { answer = { error: e }; }
  renderLedger();
}
$('#ledger-form').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('#lurl').value.trim(), key = $('#lkey').value.trim();
  const msg = $('#ledger-msg');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) { msg.textContent = 'That doesn\'t look like a web app address. It starts https://script.google.com/macros/s/ and ends /exec.'; msg.className = 'msg bad'; return; }
  msg.textContent = 'Testing…'; msg.className = 'msg wait';
  const trial = new Ledger('switchboard-trial');
  trial.cfg = { url, key };
  try {
    const j = await trial.ping();
    ledger.setConfig(url, key); answer = { version: j.version }; fillFields();
    if (older(j.version)) { msg.textContent = `Connected, but the script is v${j.version}. ${OLD_FIX}`; msg.className = 'msg wait'; }
    else { msg.textContent = `Connected to ledger v${j.version}.`; msg.className = 'msg ok'; buzz(60); }
  } catch (err) {
    msg.className = 'msg bad'; msg.textContent = failText(err);
  }
  renderLedger();
});
$('#ledger-forget').addEventListener('click', () => { ledger.forget(); answer = null; fillFields(); renderLedger(); });

function renderApps() {
  const list = $('#app-list');
  mount(list, appOrder.map(l => {
    const a = APPS[l];
    const link = ledger.connected ? connectLink(a.base, ledger.cfg.url, ledger.cfg.key) : null;
    return h('li', {}, h('div', { class: 'row' },
      h('span', { class: 'chip acc' }, l),
      h('span', { class: 'main' }, h('span', { class: 't' }, a.name), h('span', { class: 's' }, blurb[l])),
      link ? h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener' }, 'Connect') : h('span', { class: 'meta' }, 'ledger first')));
  }));
}

// ---- test sticker and letters
mount($('#test-panel'), nfcPanel(tagUrl('s', 'test'), { label: 'Write test sticker' }));
// Each address may break after a dot (placard. / junkdrawer.works), so the table fits a phone instead of cutting it off.
const host = base => base.replace(/^https:\/\/|\/$/g, '').split(/(?<=\.)/).flatMap((part, i) => (i ? [h('wbr'), part] : [part]));
mount($('#route-rows'), Object.entries(APPS).map(([l, a]) => h('tr', {}, h('td', { class: 'm' }, l), h('td', {}, a.name), h('td', { class: 'm' }, host(a.base)))));

ledger.on(renderLedger);
fillFields();
renderLedger();
checkLedger();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.__switchboard = { ledger, toast };
