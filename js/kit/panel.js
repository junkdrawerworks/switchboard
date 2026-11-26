// The sticker panel every item screen uses: shows the tag link and writes it (and, where asked, locks it).
import { h, buzz, confirmSheet } from './ui.js';
import { nfcSupported, writeUrl, lockTag, explainNfc, cancelNfc } from './nfc.js';

export function nfcPanel(url, { label = 'Write sticker', lock = false, onWritten = null, onLocked = null, note = '' } = {}) {
  const msg = h('p', { class: 'msg', 'aria-live': 'polite' });
  const say = (t, k = '') => { msg.textContent = t; msg.className = 'msg ' + k; };
  const btns = h('div', { class: 'btns' });
  let busy = false;
  const run = async (what, fn, done) => {
    if (busy) { cancelNfc(); return; }
    busy = true; btns.querySelectorAll('button').forEach(b => { if (b.dataset.what === what) b.textContent = 'Stop'; });
    say('Hold the sticker to the top of the phone, flat, and keep it still.', 'wait');
    try { await fn(); buzz(80); say(done, 'ok'); }
    catch (e) { buzz([40, 60, 40]); say(await explainNfc(e, what), e.name === 'AbortError' ? '' : 'bad'); return false; }
    finally { busy = false; btns.querySelectorAll('button').forEach(b => { b.textContent = b.dataset.label; }); }
    return true;
  };
  const writeBtn = h('button', { type: 'button', class: 'btn', 'data-what': 'write', 'data-label': label, onclick: async () => {
    if (await run('write', () => writeUrl(url), lock ? 'Written. Tap it with the phone to check, then lock it.' : 'Written. Tap it with the phone to check it opens this page.')) onWritten?.();
  } }, label);
  btns.append(writeBtn);
  if (lock) btns.append(h('button', { type: 'button', class: 'btn ghost', 'data-what': 'lock', 'data-label': 'Lock sticker', onclick: async () => {
    if (!busy && !await confirmSheet('Lock this sticker?', 'Locking is permanent: nobody can rewrite it, you included. Do it only after a tap opens the right page. The link can still be pointed elsewhere from Switchboard.', 'Lock it')) return;
    if (await run('lock', () => lockTag(), 'Locked. It will open this page for good.')) onLocked?.();
  } }, 'Lock sticker'));
  if (!nfcSupported()) {
    btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
    say('Writing stickers needs Chrome on an Android phone. Any NFC writer app can write the link above instead.', 'wait');
  }
  return h('div', { class: 'nfc' },
    h('span', { class: 'tape-cap' }, 'Sticker'),
    h('code', { class: 'url' }, url),
    note ? h('p', { class: 'msg' }, note) : null,
    btns, msg);
}
