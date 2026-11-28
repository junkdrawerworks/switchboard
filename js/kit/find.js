// The tag apps' search ("Do I have…"): Larder's shelves and jars, Frostbite's freezers, Mothball's totes. No DOM here.
// Every word typed is found somewhere in the texts, in any order, ignoring case, accents, apostrophes (straight or
// curly, as a phone's keyboard types them) and commas: "ground cumin " finds "Cumin, ground"; "jalapeno" finds
// "Jalapeño"; "za’atar" and "zaatar" find "Za'atar"; "2 lb" finds the bag. A word is never found across two texts (a
// name and a note are searched apart), and nothing typed finds everything.
export const fold = t => String(t ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019'`]/g, '').toLowerCase().replace(/,/g, ' ');
export const words = q => fold(q).split(/\s+/).filter(Boolean);
export function found(q, ...texts) {
  const w = words(q), hay = texts.flat().map(fold).join('\n');
  return w.every(x => hay.includes(x));
}
