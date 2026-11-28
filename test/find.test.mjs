// The kit's search (js/kit/find.js): Larder's, Frostbite's and Mothball's "Do I have…" boxes all match this way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, words, found } from '../js/kit/find.js';

test('every word typed, in any order, however a phone typed it', () => {
  assert.equal(found('cumin ', 'Cumin, ground'), true, 'the space a keyboard adds after a suggestion');
  assert.equal(found('ground cumin', 'Cumin, ground'), true, 'words in any order');
  assert.equal(found('Cumin, ground', 'Cumin, ground'), true, 'a comma typed');
  assert.equal(found('CUM', 'Cumin, ground'), true, 'any case, and part of a word');
  assert.equal(found('jalapeno', 'Jalapeño flakes'), true, 'accents');
  assert.equal(found('jalapeño', 'Jalapeno flakes'), true);
  assert.equal(found('za’atar', "Za'atar"), true, "a phone keyboard's curly apostrophe");
  assert.equal(found('zaatar', "Za'atar"), true, 'no apostrophe at all');
  assert.equal(found("shepherd's", 'Shepherd’s pie'), true);
  assert.equal(found('saffron', 'Cumin, ground'), false);
  assert.equal(found('cumin saffron', 'Cumin, ground'), false, 'every word');
});

test('several texts, each searched on its own, and lists of lines', () => {
  assert.equal(found('2 lb', 'Coffee beans', 'Pantry', 'Coffee beans, 2 lb bag'), true, 'a later text');
  assert.equal(found('marinated thighs', 'Chicken thighs', 'Marinated; 2 lb'), true, 'one word in each');
  assert.equal(found('beansp', 'Coffee beans', 'Pantry'), false, 'a word across two texts');
  assert.equal(found('fuses', 'Porch lights', ['Light strings (4)', 'Spare fuses']), true, 'a list of lines');
  assert.equal(found('lights strings', ['Porch lights', 'Light strings (4)']), true);
  assert.equal(found('ham', null, undefined, ''), false, 'texts that are missing');
});

test('nothing typed finds everything', () => {
  for (const q of ['', '   ', null, undefined, ',']) assert.equal(found(q, 'Anything'), true, JSON.stringify(q));
  assert.deepEqual(words(' Ground  cumin, '), ['ground', 'cumin']);
  assert.equal(fold('Crème Brûlée’s'), 'creme brulees');
});
