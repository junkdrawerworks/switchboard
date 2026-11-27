// The kit's small helpers (js/kit/ui.js) that need no page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageText, agoText, stampText, route, lines, parseDay, dayText } from '../js/kit/ui.js';

const now = new Date(2026, 10, 27, 15, 0);   // 27 Nov 2026, 3 pm, local time
const day = n => { const d = new Date(2026, 10, 27 - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('how long ago reads right on the first day, the second, the third and a month on', () => {
  assert.equal(agoText(day(0), now), 'today');
  assert.equal(agoText(day(1), now), 'yesterday');
  assert.equal(agoText(day(2), now), '2 days ago');
  assert.equal(agoText(day(31), now), '4 wk ago');
  assert.equal(agoText('2025-09-27', now), '14 mo ago');
  assert.equal(agoText('', now), '');
  assert.equal(ageText(day(0), now), 'today');
  assert.equal(ageText(day(1), now), '1 day');
  assert.equal(ageText(day(2), now), '2 days');
  assert.equal(ageText(day(31), now), '4 wk');
});

test('a time from another year says the year', () => {
  assert.equal(stampText(new Date(2026, 10, 27, 9, 5).getTime(), now), 'Nov 27, 9:05 am');
  assert.equal(stampText(new Date(2025, 11, 9, 18, 0).getTime(), now), 'Dec 9, 2025, 6:00 pm');
});

test('an address that is cut short or mistyped opens the home page', () => {
  assert.deepEqual(route('#%E0%A4%A'), { view: 'home' });
  assert.deepEqual(route('#%'), { view: 'home' });
  assert.deepEqual(route('#04'), { view: 'item', id: '04' });
  assert.deepEqual(route('#Water-Heater'), { view: 'item', id: 'water-heater' });
  assert.deepEqual(route('#/label/01'), { view: 'label', arg: '01' });
  assert.deepEqual(route('#tree%20topper'), { view: 'item', id: 'tree topper' });
  assert.deepEqual(route(''), { view: 'home' });
});

test('lines take off typed numbering and bullets, and keep a number the line starts with', () => {
  assert.deepEqual(lines('1. Turn it off\n2) Wait a minute\n- Call\n* Text\n• Email\n\n  10. Ten  '), ['Turn it off', 'Wait a minute', 'Call', 'Text', 'Email', 'Ten']);
  assert.deepEqual(lines('0.5 inch of water in the pan is normal\n1.5 turns counterclockwise opens it\n-10°F or colder: let the kitchen tap drip\n2.5 m extension lead'),
    ['0.5 inch of water in the pan is normal', '1.5 turns counterclockwise opens it', '-10°F or colder: let the kitchen tap drip', '2.5 m extension lead']);
  assert.deepEqual(lines('- -10°F: drip the tap\n3) 0.5 inch\n12 V supply\n2024 model'), ['-10°F: drip the tap', '0.5 inch', '12 V supply', '2024 model']);
  assert.deepEqual(lines(''), []);
});

test('a day reads in the year written, at local midnight', () => {
  assert.equal(parseDay('0026-11-20').getFullYear(), 26, 'year 26 read as 1926');
  assert.equal(dayText('0026-11-20'), 'Nov 20, 26');
  const d = parseDay('2026-11-27');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 10, 27, 0, 0]);
  assert.equal(parseDay('2026-03-08').getHours(), 0);
  assert.equal(dayText('1999-12-31'), 'Dec 31, 1999');
});
