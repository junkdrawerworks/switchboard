// Tag links. Every sticker holds https://tag.junkdrawer.works/<letter>/<id>; the letter says which app owns it
// and Switchboard's resolver sends the phone there. Kept free of the DOM so it can be unit-tested.
export const TAG_HOST = 'tag.junkdrawer.works';
export const APPS = {
  h: { name: 'Placard', base: 'https://placard.junkdrawer.works/' },
  t: { name: 'Mothball', base: 'https://mothball.junkdrawer.works/' },
  p: { name: 'Larder', base: 'https://larder.junkdrawer.works/' },
  f: { name: 'Frostbite', base: 'https://frostbite.junkdrawer.works/' },
  m: { name: 'Packrat', base: 'https://packrat.junkdrawer.works/' },
  s: { name: 'Switchboard', base: 'https://tag.junkdrawer.works/' },
};

export const tagUrl = (letter, id) => `https://${TAG_HOST}/${letter}/${id}`;

// Reads a tag link back: { letter, id } or null. Accepts http, a trailing slash and any letter case.
export function parseTag(url) {
  const m = /^(?:https?:\/\/)?tag\.junkdrawer\.works\/([a-z])\/([a-z0-9][a-z0-9-]{0,39})\/?$/i.exec(String(url || '').trim());
  return m ? { letter: m[1].toLowerCase(), id: m[2].toLowerCase() } : null;
}

// Where a tag goes: the owning app's page with the id after #. Overrides send one tag somewhere else.
export function resolve(letter, id, overrides = {}) {
  const key = `${letter}/${id}`;
  if (overrides[key]) return overrides[key];
  const app = APPS[letter];
  return app ? `${app.base}#${id}` : null;
}

export function slug(s, max = 32) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

// A short random id (letters and digits, never starting with a dash): 5 characters gives 60 million choices. Never one
// a Sheet would read as a number (all digits, or digits, e, digits: 234e56 is 2.34 x 10^58), which the ledger's first
// version let it keep as one, so it listed back as another id: such an id's first character becomes a letter.
export function newId(len = 5, rnd = Math.random) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';   // 23 letters, then the digits
  let s = '';
  for (let i = 0; i < len; i++) s += abc[Math.floor(rnd() * abc.length)];
  return /^\d+(e\d+)?$/.test(s) ? abc[Math.floor(rnd() * 23)] + s.slice(1) : s;
}

// A unique id from a name: the slug, or the slug with -2, -3 … when it's taken.
export function uniqueSlug(name, taken) {
  const base = slug(name) || newId();
  let id = base, n = 2;
  while (taken.has(id)) id = `${base.slice(0, 29)}-${n++}`;
  return id;
}
