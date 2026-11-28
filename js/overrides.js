// OVERRIDES in 404.html sends single stickers somewhere else (a locked Placard sticker pointed at another page, say).
// The resolver is the only thing that applies them, so Check a tag reads the same block from 404.html's text to show
// where a tap really goes: each 'letter/id': 'address' line (either kind of quote), the key in lower case as the
// resolver makes it. A line commented out with // is left out, as it is in the page. test/tags.test.mjs runs 404.html's
// own script beside this and checks the two agree, so a change to the block's shape shows there.
export function readOverrides(html) {
  const block = /var OVERRIDES = \{([\s\S]*?)\};/.exec(String(html || ''));
  if (!block) return {};
  const out = {};
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [, , key, , to] of body.matchAll(/(['"])((?:(?!\1).)*)\1\s*:\s*(['"])((?:(?!\3).)*)\3/g)) out[key.toLowerCase()] = to;
  return out;
}
