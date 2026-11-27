// The sticker panel every item screen uses: shows the tag link and writes it (and, where asked, locks it).
import { h, buzz, confirmSheet, dayText } from './ui.js';
import { nfcSupported, writeUrl, lockTag, explainNfc, cancelNfc } from './nfc.js';

// Each sticker's panel state, by its link. A page draws a new panel after a save or a sync, and the new one carries on
// from the old: "Written. Tap it with the phone to check…" stays, a write in progress keeps its Stop button.
const panels = new Map();

// tagged and locked are the days (YYYY-MM-DD) the app saved when this sticker was written and locked. In the sample
// (sample: true) Write still writes a real sticker, which is handy for trying the phone's reader, but Lock is off: it
// can't be undone, and the sample's pages aren't the real ones.
export function nfcPanel(url, { label = 'Write sticker', lock = false, onWritten = null, onLocked = null, note = '', tagged = null, locked = null, sample = false } = {}) {
  const st = panels.get(url) || { said: ['', ''], busy: '', spare: false };
  panels.set(url, st);
  const msg = st.msg = h('p', { class: 'msg', 'aria-live': 'polite' });
  const say = (t, k = '') => { st.said = [t, k]; st.msg.textContent = t; st.msg.className = 'msg ' + k; };
  const btns = st.btns = h('div', { class: 'btns' });
  const labels = () => st.btns.querySelectorAll('button').forEach(b => { b.textContent = st.busy === b.dataset.what ? 'Stop' : b.dataset.label; });
  const run = async (what, fn, done) => {
    if (st.busy) { cancelNfc(); return false; }
    st.busy = what; labels();
    say('Hold the sticker flat against the back of the phone, near the top, and keep it still.', 'wait');
    try { await fn(); buzz(80); say(done, 'ok'); }
    catch (e) { buzz([40, 60, 40]); say(await explainNfc(e, what), e.name === 'AbortError' ? '' : 'bad'); return false; }
    finally { st.busy = ''; labels(); }
    return true;
  };
  btns.append(h('button', { type: 'button', class: 'btn', 'data-what': 'write', 'data-label': label, onclick: async () => {
    if (await run('write', () => writeUrl(url), lock && !sample ? 'Written. Tap it with the phone to check, then lock it.' : 'Written. Tap it with the phone to check it opens this page.')) onWritten?.();
  } }, label));
  if (lock) btns.append(h('button', { type: 'button', class: 'btn ghost', 'data-what': 'lock', 'data-label': 'Lock sticker', disabled: sample, onclick: async () => {
    if (sample) return;
    if (!st.busy && !await confirmSheet('Lock this sticker?', 'Locking is permanent: nobody can rewrite it, you included. Do it only after a tap opens the right page. The link can still be pointed elsewhere from Switchboard.', 'Lock it')) return;
    if (await run('lock', () => lockTag(), 'Locked. It will open this page for good.')) { st.spare = false; onLocked?.(); }
  } }, 'Lock sticker'));
  labels();
  if (!nfcSupported()) {
    btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
    say('Writing stickers needs Chrome on an Android phone. Any NFC writer app can write the link above instead.', 'wait');
  } else say(...st.said);
  // A locked sticker can't be written again, so Write and Lock wait behind "Replace or make a spare": a new blank
  // sticker for the same page (the app saves it as written, not locked, until that one is locked too).
  const state = locked ? `Locked ${dayText(locked)}. To send it somewhere else, use Switchboard.`
    : tagged ? `Written ${dayText(tagged)}${lock ? ', not locked yet' : ''}.` : lock ? 'Not written yet.' : '';
  const spare = h('div', {}, h('p', { class: 'msg' }, 'Use a new blank sticker. The old one, wherever it is, keeps opening this page.'), btns);
  const hidden = locked && !st.spare && !st.busy;
  const more = hidden ? h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => { st.spare = true; more.replaceWith(spare); say(''); } }, 'Replace or make a spare')) : null;
  return h('div', { class: 'nfc' },
    h('span', { class: 'tape-cap' }, 'Sticker'),
    h('code', { class: 'url' }, url),
    state ? h('p', { class: 'msg state' }, state) : null,
    note ? h('p', { class: 'msg' }, note) : null,
    sample ? h('p', { class: 'msg sample' }, 'This writes a real sticker with the sample\'s link.') : null,
    sample && lock ? h('p', { class: 'msg sample' }, 'Locking is off in the sample: it can\'t be undone.') : null,
    locked ? (hidden ? more : spare) : btns,
    msg);
}
