#!/usr/bin/env node
/* Rebuild the `categories` array inside letters.json/letters.js, and the
   per-category standalone exports in categories/*.json, from each letter's
   `category` tag.

     node export-categories.cjs

   Run this after editing letters.json by hand (e.g. adding a letter or
   changing its category) so the category groupings stay in sync.
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'letters.json'), 'utf8'));

const DEFS = [
  { id: 'consonants',     file: 'consonants',           label: 'Consonants',           match: L => L.category === 'consonant' },
  { id: 'vowelSigns',     file: 'vowel-signs',          label: 'Vowel Signs',          match: L => L.category === 'vowelSign' },
  { id: 'prefixes',       file: 'prefix-letters',       label: 'Prefix Letters',       match: L => L.category === 'prefix' },
  { id: 'superscribed',   file: 'superscribed-letters', label: 'Superscribed Letters', match: L => L.category === 'superscribed' },
  { id: 'subscribed',     file: 'subscribed-letters',   label: 'Subscribed Letters',   match: L => L.category === 'subscribed' },
  { id: 'suffixes',       file: 'suffix-letters',       label: 'Suffix Letters',       match: L => L.category === 'suffix' },
  { id: 'secondSuffixes', file: 'second-suffixes',      label: 'Second Suffixes',      match: L => L.category === 'secondSuffix' }
];

function lettersFor(def) {
  return doc.letters.filter(def.match).sort((a, b) => a.order - b.order);
}

/* letters.json: lightweight {id, glyph, roman, available} refs per category */
doc.categories = DEFS.map(def => {
  const letters = lettersFor(def).map(L => ({ id: L.id, glyph: L.glyph, roman: L.roman, available: !!L.available }));
  return { id: def.id, label: def.label, count: letters.length, letters };
});

const json = JSON.stringify(doc, null, 1);
fs.writeFileSync(path.join(ROOT, 'letters.json'), json + '\n');
fs.writeFileSync(path.join(ROOT, 'letters.js'), 'window.LETTERS_DATA = ' + json + '\n;\n');

/* categories/*.json: full standalone per-category documents */
const outDir = path.join(ROOT, 'categories');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const def of DEFS) {
  const out = {
    version: doc.version,
    viewBox: doc.viewBox,
    category: def.id,
    label: def.label,
    letters: lettersFor(def)
  };
  fs.writeFileSync(path.join(outDir, `${def.file}.json`), JSON.stringify(out, null, 1) + '\n');
}

console.log('Wrote letters.json, letters.js, and categories/*.json:');
for (const c of doc.categories) {
  const avail = c.letters.filter(l => l.available).length;
  console.log(` ${c.id}: ${c.count} letter(s), ${avail} traceable`);
}
