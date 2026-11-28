// The kit's Web NFC reader (js/kit/nfc.js) with a pretend NDEFReader, without a browser.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A pretend Chrome reader: scan() starts listening (and stops when its signal aborts), tap() delivers a sticker;
// makeReadOnly() locks the sticker against the phone (locked: whether anything was listening then, as Chrome stays on a
// sticker it has just read while a scan is on).
let readers = [], locked = [];
globalThis.window = globalThis;
globalThis.NDEFReader = class {
  async scan({ signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    this.signal = signal; this.listening = true; readers.push(this);
    signal?.addEventListener('abort', () => { this.listening = false; });
  }
  async makeReadOnly({ signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    locked.push({ listening: !!this.listening });
  }
};
const enc = s => new TextEncoder().encode(s);
const tap = (records, serial = '04:a2:19:7c') => {
  const r = readers.filter(x => x.listening).at(-1);
  assert.ok(r, 'nothing is listening');
  r.onreading?.({ serialNumber: serial, message: { records } });
};
const tick = () => new Promise(r => setTimeout(r, 0));
const { readOnce, lockTag, refusedWrite, cancelNfc, explainNfc } = await import('../js/kit/nfc.js');
beforeEach(() => { cancelNfc(); readers = []; locked = []; });

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

test('a write a locked sticker turns down says it\'s locked', async () => {
  globalThis.navigator ||= {};
  assert.equal(await explainNfc({ name: 'NotAllowedError', message: '' }, 'write'), 'That sticker is locked. Use a blank one.');
});

test("what went wrong says where a Pixel's NFC switch and reader are", async () => {
  assert.equal(await explainNfc({ name: 'NotReadableError', message: '' }, 'read'),
    'NFC looks switched off. Turn it on in the phone\'s settings (Connected devices → Connection preferences → NFC).');
  assert.match(await explainNfc({ name: 'NetworkError', message: 'lost' }, 'write'), /^Couldn't write the sticker \(lost\)\. Hold it flat against the back of the phone, near the top, and keep it still\.$/);
});
