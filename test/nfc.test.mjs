// The kit's Web NFC reader (js/kit/nfc.js) with a pretend NDEFReader, without a browser.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A pretend Chrome reader: scan() starts listening (and stops when its signal aborts), tap() delivers a sticker;
// makeReadOnly() locks the sticker against the phone (locked: whether anything was listening then, as Chrome stays on a
// sticker it has just read while a scan is on). With away set, the sticker read has left the phone by the time the lock
// is asked for: as in Chrome, the lock waits for the next sticker to come near (tap), which the scan reads first and
// the lock then locks, unchecked, until its signal calls it off.
let readers = [], locked = [], away = false, waiting = null;
globalThis.window = globalThis;
globalThis.NDEFReader = class {
  async scan({ signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    this.signal = signal; this.listening = true; readers.push(this);
    signal?.addEventListener('abort', () => { this.listening = false; });
  }
  async makeReadOnly({ signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (!away) { locked.push({ listening: !!this.listening }); return; }
    return new Promise((resolve, reject) => {
      waiting = serial => { waiting = null; locked.push({ listening: !!this.listening, serial }); resolve(); };
      signal?.addEventListener('abort', () => { if (!waiting) return; waiting = null; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
  }
};
const enc = s => new TextEncoder().encode(s);
// lockFirst: the lock's answer reaches the page before the reading does (they come back on separate channels)
const tap = (records, serial = '04:a2:19:7c', { lockFirst = false } = {}) => {
  const r = readers.filter(x => x.listening).at(-1);
  assert.ok(r || waiting, 'nothing is listening');
  const read = () => r?.onreading?.({ serialNumber: serial, message: { records } });
  if (lockFirst) { waiting?.(serial); setTimeout(read, 5); return; }
  read();
  waiting?.(serial);
};
const tick = () => new Promise(r => setTimeout(r, 0));
const { readOnce, lockTag, refusedWrite, cancelNfc, explainNfc, sameSticker } = await import('../js/kit/nfc.js');
beforeEach(() => { cancelNfc(); readers = []; locked = []; away = false; waiting = null; });

test('a sticker held to the phone is read, and the reader stops listening', async () => {
  const p = readOnce({ timeout: 2000 });
  await tick();
  tap([{ recordType: 'url', data: enc('https://tag.junkdrawer.works/s/test') }]);
  assert.deepEqual(await p, { serial: '04:a2:19:7c', url: 'https://tag.junkdrawer.works/s/test', blank: false });
  assert.equal(readers[0].listening, false, 'still scanning after the read');
});

test('a blank sticker reads as no link, and a sticker with text first finds its link', async () => {
  let p = readOnce({ timeout: 2000 });
  await tick(); tap([]);
  assert.deepEqual(await p, { serial: '04:a2:19:7c', url: '', blank: true });
  // a factory-blank sticker: Chrome gives one 'empty' record
  p = readOnce({ timeout: 2000 });
  await tick(); tap([{ recordType: 'empty' }]);
  assert.deepEqual(await p, { serial: '04:a2:19:7c', url: '', blank: true });
  p = readOnce({ timeout: 2000 });
  await tick(); tap([{ recordType: 'text', data: enc('hello') }]);
  assert.deepEqual(await p, { serial: '04:a2:19:7c', url: '', blank: false }, 'text with no link reads as blank');
  p = readOnce({ timeout: 2000 });
  await tick(); tap([{ recordType: 'text', data: enc('hello') }, { recordType: 'absolute-url', data: enc('https://example.com/') }]);
  assert.equal((await p).url, 'https://example.com/');
});

test('Lock reads the sticker first, and locks only one its check takes, on the sticker still against the phone', async () => {
  const mine = 'https://tag.junkdrawer.works/h/furnace';
  const check = got => got.url === mine ? '' : `This sticker opens ${got.url || 'nothing'}, not Furnace. Nothing was locked.`;
  // another page's sticker: refused with the check's reason, nothing locked, and the reader stops
  let p = lockTag({ check, timeout: 2000 });
  await tick(); tap([{ recordType: 'url', data: enc('https://tag.junkdrawer.works/h/water-heater') }]);
  await assert.rejects(p, { name: 'WrongTagError', message: 'This sticker opens https://tag.junkdrawer.works/h/water-heater, not Furnace. Nothing was locked.' });
  assert.deepEqual(locked, [], 'locked a sticker the check turned down');
  assert.equal(readers[0].listening, false, 'still scanning after the refusal');
  assert.equal(await explainNfc({ name: 'WrongTagError', message: 'This sticker opens x, not Furnace. Nothing was locked.' }, 'lock'), 'This sticker opens x, not Furnace. Nothing was locked.');
  // its own sticker: locked while the scan is still on (Chrome stays on the sticker), then the scan stops
  p = lockTag({ check, timeout: 2000 });
  await tick(); tap([{ recordType: 'url', data: enc(mine) }]);
  await p;
  assert.deepEqual(locked, [{ listening: true }]);
  assert.equal(readers[1].listening, false, 'still scanning after the lock');
  // no sticker in time, or Stop: nothing locked
  await assert.rejects(lockTag({ check, timeout: 30 }), { name: 'TimeoutError' });
  p = lockTag({ check, timeout: 2000 });
  await tick(); cancelNfc();
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(locked.length, 1);
  assert.ok(readers.every(r => !r.listening));
  // without a check it locks the next sticker, as before
  await lockTag();
  assert.equal(locked.length, 2);
});

// The sticker Lock read has gone from the phone (a quick swipe) before the lock reaches it: Chrome locks whichever
// sticker comes near next, unchecked. Called off after 1.5 s, or caught by the reading of another sticker first.
const MINE = [{ recordType: 'url', data: enc('https://tag.junkdrawer.works/h/furnace') }];
const mineOnly = got => got.url === 'https://tag.junkdrawer.works/h/furnace' ? '' : 'not this page\'s';
// p, or a failure if it's still waiting after ms (a lock left waiting would otherwise end the run with nothing said)
const within = (p, ms = 3500) => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`still waiting after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t)); };
test('a lock waiting for a sticker that left the phone is called off after 1.5 s, with nothing locked', { timeout: 6000 }, async () => {
  away = true;
  const t0 = Date.now();
  const p = lockTag({ check: mineOnly, timeout: 4000 });
  await tick(); tap(MINE, '04:aa');
  await assert.rejects(within(p), { name: 'WrongTagError', message: 'The sticker moved before it was locked. Hold it still against the phone and press Lock sticker again. Nothing was locked.' });
  const took = Date.now() - t0;
  assert.ok(took >= 1400 && took < 3000, `called off after ${took} ms`);
  assert.equal(waiting, null, 'the lock still waits for the next sticker');
  assert.deepEqual(locked, []);
  assert.ok(readers.every(r => !r.listening), 'still scanning');
});

test('another sticker that comes near before the lock lands may be locked instead: said, and not taken as this one', { timeout: 6000 }, async () => {
  away = true;
  const p = lockTag({ check: mineOnly, timeout: 4000 });
  await tick(); tap(MINE, '04:aa');
  await new Promise(r => setTimeout(r, 400));
  tap([{ recordType: 'url', data: enc('https://tag.junkdrawer.works/t/05') }], '04:bb');   // the next sticker in the pile
  await assert.rejects(within(p), { name: 'WrongTagError', message: 'Another sticker came near the phone and may have been locked instead. This page\'s sticker isn\'t marked locked: tap both to check.' });
  assert.deepEqual(locked.map(l => l.serial), ['04:bb']);
  assert.ok(readers.every(r => !r.listening), 'still scanning');
  // the same when the lock's answer gets to the page before that sticker's reading
  const q = lockTag({ check: mineOnly, timeout: 4000 });
  await tick(); tap(MINE, '04:aa');
  await new Promise(r => setTimeout(r, 400));
  tap([{ recordType: 'url', data: enc('https://tag.junkdrawer.works/t/05') }], '04:cc', { lockFirst: true });
  await assert.rejects(within(q), { name: 'WrongTagError', message: /^Another sticker came near the phone/ });
  assert.deepEqual(locked.map(l => l.serial), ['04:bb', '04:cc']);
});

test('the same sticker back against the phone before the lock lands is locked, as asked', { timeout: 6000 }, async () => {
  away = true;
  const p = lockTag({ check: mineOnly, timeout: 4000 });
  await tick(); tap(MINE, '04:aa');
  await new Promise(r => setTimeout(r, 300));
  tap(MINE, '04:aa');
  await within(p);
  assert.deepEqual(locked.map(l => l.serial), ['04:aa']);
});

test('the same sticker by its serial number, or by what it holds when there is none', () => {
  assert.equal(sameSticker({ serial: '04:aa', url: 'a' }, { serial: '04:aa', url: 'b' }), true);
  assert.equal(sameSticker({ serial: '04:aa', url: 'a' }, { serial: '04:bb', url: 'a' }), false);
  assert.equal(sameSticker({ serial: '', url: 'a' }, { serial: '04:bb', url: 'a' }), false);
  assert.equal(sameSticker({ serial: '', url: 'a' }, { serial: '', url: 'a' }), true);
  assert.equal(sameSticker({ serial: '', url: 'a' }, { serial: '', url: '' }), false);
});

test('a write turned down for a sticker that holds something is told apart from one turned down for permission', () => {
  assert.equal(refusedWrite({ name: 'NotAllowedError', message: 'NDEFWriteOptions#overwrite does not allow overwrite.' }), true);
  assert.equal(refusedWrite({ name: 'NotAllowedError', message: '' }), true);
  assert.equal(refusedWrite({ name: 'NotAllowedError', message: 'NFC permission request denied.' }), false);
  assert.equal(refusedWrite({ name: 'NotAllowedError', message: 'Must be handling a user gesture to show a permission request.' }), false);
  assert.equal(refusedWrite({ name: 'NetworkError', message: 'lost' }), false);
});

test('no sticker in time ends as a timeout, not as stopped', async () => {
  await assert.rejects(readOnce({ timeout: 30 }), { name: 'TimeoutError' });
  assert.equal(readers[0].listening, false);
});

test('Stop ends a read as stopped, and a new read replaces the one before it', async () => {
  let p = readOnce({ timeout: 2000 });
  await tick(); cancelNfc();
  await assert.rejects(p, { name: 'AbortError' });
  const first = readOnce({ timeout: 2000 });
  await tick();
  const second = readOnce({ timeout: 2000 });
  await assert.rejects(first, { name: 'AbortError' });
  await tick(); tap([{ recordType: 'url', data: enc('https://tag.junkdrawer.works/t/04') }]);
  assert.equal((await second).url, 'https://tag.junkdrawer.works/t/04');
});

test('stopped while the reader is still starting: stopped, not left waiting', async () => {
  const p = readOnce({ timeout: 5000 });
  cancelNfc();                         // before scan() has answered
  const t0 = Date.now();
  await assert.rejects(p, { name: 'AbortError' });
  assert.ok(Date.now() - t0 < 1000, 'waited for the timeout');
});

// Chrome turns a write on a locked sticker into an IO error (Android's write fails), a NetworkError, as it does one on a
// sticker that left the phone mid-write: the line names both. A NotAllowedError left over isn't taken for a lock.
test('a write that fails as an IO error says the sticker moved away or is locked', async () => {
  globalThis.navigator ||= {};
  const line = 'Couldn\'t write it: the sticker moved away, or it\'s locked. Hold it still and press Write again; if this comes back, it\'s locked: use a blank one.';
  assert.equal(await explainNfc({ name: 'NetworkError', message: 'Failed to write due to an IO error: null' }, 'write'), line);
  assert.equal(await explainNfc({ name: 'NetworkError', message: 'Failed to write because the tag is lost: null' }, 'write'), line);
  assert.doesNotMatch(await explainNfc({ name: 'NotAllowedError', message: '' }, 'write'), /locked/);
  assert.match(await explainNfc({ name: 'NetworkError', message: 'lost' }, 'lock'), /^Couldn't lock the sticker \(lost\)\./);
});

test("what went wrong says where a Pixel's NFC switch and reader are", async () => {
  assert.equal(await explainNfc({ name: 'NotReadableError', message: '' }, 'read'),
    'NFC looks switched off. Turn it on in the phone\'s settings (Connected devices → Connection preferences → NFC).');
  assert.match(await explainNfc({ name: 'TypeError', message: 'odd' }, 'write'), /^Couldn't write the sticker \(odd\)\. Hold it flat against the back of the phone, near the top, and keep it still\.$/);
});
