// The kit's small helpers (js/kit/ui.js) that need no page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageText, agoText, stampText, route } from '../js/kit/ui.js';

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
