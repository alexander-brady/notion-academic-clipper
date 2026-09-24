import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBibtex,
  parseBibAuthors,
  makeCiteKey,
  setCiteKey,
  normalizeDoi,
  buildBibtex,
  formatBibtex
} from '../src/lib/bib.js';

import {
  autoMap,
  reconcileMap,
  buildProperties,
  buildChildren,
  richText,
  listProperties
} from '../src/lib/mapping.js';

/* ------------------------------------------------------------------ */
/* DOI                                                                 */
/* ------------------------------------------------------------------ */

test('normalizeDoi strips the many shapes a DOI arrives in', () => {
  const expected = '10.1038/nature12373';
  for (const input of [
    '10.1038/nature12373',
    'https://doi.org/10.1038/nature12373',
    'http://dx.doi.org/10.1038/nature12373',
    'doi:10.1038/nature12373',
    'info:doi/10.1038/nature12373',
    '  DOI: 10.1038/nature12373  ',
    'See 10.1038/nature12373.'
  ]) {
    assert.equal(normalizeDoi(input), expected, `failed for: ${input}`);
  }
});

test('normalizeDoi keeps suffixes that contain punctuation', () => {
  assert.equal(normalizeDoi('10.1002/(SICI)1097-0258'), '10.1002/(SICI)1097-0258');
  assert.equal(normalizeDoi('10.48550/arXiv.1706.03762'), '10.48550/arXiv.1706.03762');
});

test('normalizeDoi rejects non-DOIs', () => {
  assert.equal(normalizeDoi('https://example.com/article/42'), '');
  assert.equal(normalizeDoi(''), '');
  assert.equal(normalizeDoi(null), '');
});

/* ------------------------------------------------------------------ */
/* BibTeX parsing                                                      */
/* ------------------------------------------------------------------ */

const CROSSREF_ENTRY = `@article{Vaswani_2017,
  title={Attention Is All You Need},
  volume={30},
  ISSN={1049-5258},
  url={http://dx.doi.org/10.5555/3295222.3295349},
  DOI={10.5555/3295222.3295349},
  journal={Advances in Neural Information Processing Systems},
  publisher={Curran Associates},
  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
  year={2017},
  pages={5998--6008}
}`;

test('parseBibtex reads type, key and fields', () => {
  const p = parseBibtex(CROSSREF_ENTRY);
  assert.equal(p.type, 'article');
  assert.equal(p.key, 'Vaswani_2017');
  assert.equal(p.fields.title, 'Attention Is All You Need');
  assert.equal(p.fields.year, '2017');
  assert.equal(p.fields.doi, '10.5555/3295222.3295349');
  assert.equal(p.fields.pages, '5998--6008');
});

test('parseBibtex handles nested braces and quoted values', () => {
  const entry = '@inproceedings{k, title = {A {BERT} Study}, booktitle = "Proc. of {ACL}", year = 2019 }';
  const p = parseBibtex(entry);
  assert.equal(p.fields.title, 'A BERT Study');
  assert.equal(p.fields.booktitle, 'Proc. of ACL');
  assert.equal(p.fields.year, '2019');
});

test('parseBibtex survives a trailing comma and escaped ampersands', () => {
  const p = parseBibtex('@misc{k, publisher = {Taylor \\& Francis}, note = {x}, }');
  assert.equal(p.fields.publisher, 'Taylor & Francis');
  assert.equal(p.fields.note, 'x');
});

test('parseBibtex returns null for junk', () => {
  assert.equal(parseBibtex('not a bibtex entry'), null);
  assert.equal(parseBibtex(''), null);
});

test('parseBibAuthors flips "Last, First" and splits on and', () => {
  assert.deepEqual(parseBibAuthors('Vaswani, Ashish and Shazeer, Noam'), ['Ashish Vaswani', 'Noam Shazeer']);
  assert.deepEqual(parseBibAuthors('Jane Doe and Richard Roe'), ['Jane Doe', 'Richard Roe']);
  assert.deepEqual(parseBibAuthors(''), []);
});

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

// Crossref delivers entries exactly like this: one line, HTML entities intact.
const ONE_LINER =
  '@inproceedings{akiba2019optuna, title={Optuna}, booktitle={Knowledge Discovery &amp; Data Mining}, ' +
  'year={2019}, month=July, pages={2623–2631} }';

test('formatBibtex puts one field per line', () => {
  const lines = formatBibtex(ONE_LINER).split('\n');
  assert.equal(lines[0], '@inproceedings{akiba2019optuna,');
  assert.equal(lines.at(-1), '}');
  assert.equal(lines.length, 7); // header + 5 fields + closing brace
  assert.ok(lines.slice(1, -1).every((l) => l.startsWith('  ')));
});

test('formatBibtex decodes HTML entities and re-escapes for LaTeX', () => {
  const out = formatBibtex(ONE_LINER);
  assert.ok(!out.includes('&amp;'), 'entity should be decoded');
  assert.match(out, /Knowledge Discovery \\& Data Mining/);
});

test('formatBibtex does not double-escape an already escaped ampersand', () => {
  const out = formatBibtex('@misc{k, publisher={Taylor \\& Francis}}');
  assert.match(out, /Taylor \\& Francis/);
  assert.ok(!out.includes('\\\\&'));
});

test('formatBibtex normalises page ranges to a LaTeX double dash', () => {
  assert.match(formatBibtex(ONE_LINER), /pages\s+= \{2623--2631\}/);
});

test('formatBibtex preserves brace protection and bare values', () => {
  const out = formatBibtex('@article{k, title={A {BERT} Study}, year=2019}');
  assert.match(out, /title\s+= \{A \{BERT\} Study\}/);
  assert.match(out, /year\s+= 2019/); // bare values stay bare
});

test('formatBibtex round-trips through the parser', () => {
  const parsed = parseBibtex(formatBibtex(ONE_LINER));
  assert.equal(parsed.type, 'inproceedings');
  assert.equal(parsed.key, 'akiba2019optuna');
  assert.equal(parsed.fields.title, 'Optuna');
  assert.equal(parsed.fields.booktitle, 'Knowledge Discovery & Data Mining');
});

test('formatBibtex leaves unparseable input untouched', () => {
  assert.equal(formatBibtex('nonsense'), 'nonsense');
});

/* ------------------------------------------------------------------ */
/* Cite keys                                                           */
/* ------------------------------------------------------------------ */

test('makeCiteKey builds author+year+word and skips stopwords', () => {
  assert.equal(
    makeCiteKey({ authors: ['Ashish Vaswani'], year: 2017, title: 'Attention Is All You Need' }),
    'vaswani2017attention'
  );
  assert.equal(
    makeCiteKey({ authors: ['Doe, Jane'], year: 2020, title: 'On the Origin of Species' }),
    'doe2020origin'
  );
});

test('makeCiteKey strips accents and punctuation', () => {
  assert.equal(
    makeCiteKey({ authors: ['Émile Zola-Durand'], year: 1885, title: 'Germinal Studies' }),
    'zoladurand1885germinal'
  );
});

test('makeCiteKey degrades gracefully with no metadata', () => {
  const key = makeCiteKey({ authors: [], year: null, title: '' });
  assert.equal(key, 'unknownuntitled');
});

test('setCiteKey rewrites only the key', () => {
  const out = setCiteKey(CROSSREF_ENTRY, 'vaswani2017attention');
  assert.match(out, /^@article\{vaswani2017attention,/);
  assert.match(out, /Attention Is All You Need/);
  assert.equal(parseBibtex(out).fields.year, '2017');
});

test('buildBibtex escapes and omits empty fields', () => {
  const entry = buildBibtex('article', { title: 'Cost & Benefit', author: '', year: 2024 }, 'k');
  assert.match(entry, /title\s+= \{Cost \\& Benefit\}/);
  assert.match(entry, /year\s+= \{2024\}/);
  assert.ok(!entry.includes('author'), 'empty fields should be dropped');
  assert.equal(parseBibtex(entry).key, 'k');
});

/* ------------------------------------------------------------------ */
/* Property mapping                                                    */
/* ------------------------------------------------------------------ */

const DB = {
  id: 'db1',
  title: 'Reading list',
  properties: {
    Name: { id: 'title', type: 'title' },
    Link: { id: 'a', type: 'url' },
    DOI: { id: 'b', type: 'rich_text' },
    BibTeX: { id: 'c', type: 'rich_text' },
    Authors: { id: 'd', type: 'multi_select' },
    Year: { id: 'e', type: 'number' },
    Journal: { id: 'f', type: 'select' },
    'Date added': { id: 'g', type: 'date' },
    Status: { id: 'h', type: 'status' },
    Rating: { id: 'i', type: 'number' }
  }
};

test('autoMap matches properties by name and type', () => {
  const map = autoMap(DB);
  assert.deepEqual(map.title, { name: 'Name', type: 'title' });
  assert.deepEqual(map.url, { name: 'Link', type: 'url' });
  assert.deepEqual(map.doi, { name: 'DOI', type: 'rich_text' });
  assert.deepEqual(map.bibtex, { name: 'BibTeX', type: 'rich_text' });
  assert.deepEqual(map.authors, { name: 'Authors', type: 'multi_select' });
  assert.deepEqual(map.year, { name: 'Year', type: 'number' });
  assert.deepEqual(map.journal, { name: 'Journal', type: 'select' });
  assert.deepEqual(map.clippedAt, { name: 'Date added', type: 'date' });
});

test('autoMap never assigns one property to two fields', () => {
  const map = autoMap(DB);
  const used = Object.values(map).map((p) => p.name);
  assert.equal(new Set(used).size, used.length);
});

test('autoMap leaves unwritable property types alone', () => {
  const map = autoMap(DB);
  assert.ok(!Object.values(map).some((p) => p.type === 'status'));
});

test('autoMap finds the title property even when oddly named', () => {
  const map = autoMap({ properties: { 'Paper ✨': { type: 'title' }, Misc: { type: 'rich_text' } } });
  assert.deepEqual(map.title, { name: 'Paper ✨', type: 'title' });
});

test('reconcileMap drops properties that no longer exist', () => {
  const saved = {
    title: { name: 'Name', type: 'title' },
    doi: { name: 'Old DOI', type: 'rich_text' } // renamed or deleted in Notion
  };
  const map = reconcileMap(saved, DB);
  assert.deepEqual(map.title, { name: 'Name', type: 'title' });
  assert.equal(map.doi, undefined);
});

test('reconcileMap adopts the live type when a property is retyped compatibly', () => {
  // Saved as text, since changed to a number in Notion: Year accepts both, so
  // the mapping should heal rather than silently stop writing.
  const map = reconcileMap({ year: { name: 'Year', type: 'rich_text' } }, DB);
  assert.deepEqual(map.year, { name: 'Year', type: 'number' });
});

test('reconcileMap drops a property retyped to something the field cannot write', () => {
  const db = { properties: { Name: { type: 'title' }, BibTeX: { type: 'checkbox' } } };
  const map = reconcileMap({ bibtex: { name: 'BibTeX', type: 'rich_text' } }, db);
  assert.equal(map.bibtex, undefined);
});

test('reconcileMap always restores a title mapping', () => {
  const map = reconcileMap({}, DB);
  assert.deepEqual(map.title, { name: 'Name', type: 'title' });
});

test('listProperties flattens the schema', () => {
  const props = listProperties(DB);
  assert.equal(props.length, 10);
  assert.ok(props.every((p) => p.name && p.type));
});

/* ------------------------------------------------------------------ */
/* Payload building                                                    */
/* ------------------------------------------------------------------ */

const VALUES = {
  title: 'Attention Is All You Need',
  url: 'https://arxiv.org/abs/1706.03762',
  doi: '10.48550/arXiv.1706.03762',
  bibtex: '@misc{vaswani2017attention,\n  title = {Attention Is All You Need}\n}',
  authors: ['Ashish Vaswani', 'Noam Shazeer'],
  year: 2017,
  journal: 'NeurIPS',
  abstract: 'The dominant sequence transduction models...',
  clippedAt: '2026-09-24T10:00:00.000Z'
};

test('buildProperties converts each type correctly', () => {
  const props = buildProperties(VALUES, autoMap(DB));

  assert.equal(props.Name.title[0].text.content, VALUES.title);
  assert.equal(props.Link.url, VALUES.url);
  assert.equal(props.DOI.rich_text[0].text.content, VALUES.doi);
  assert.deepEqual(props.Authors.multi_select, [{ name: 'Ashish Vaswani' }, { name: 'Noam Shazeer' }]);
  assert.equal(props.Year.number, 2017);
  assert.deepEqual(props.Journal.select, { name: 'NeurIPS' });
  assert.equal(props['Date added'].date.start, VALUES.clippedAt);
});

test('buildProperties skips empty values and unmapped fields', () => {
  const props = buildProperties({ ...VALUES, doi: '', journal: '', authors: [] }, autoMap(DB));
  assert.ok(!('DOI' in props));
  assert.ok(!('Journal' in props));
  assert.ok(!('Authors' in props));
  assert.ok('Name' in props);
});

test('buildProperties rejects an invalid URL rather than sending it', () => {
  const props = buildProperties({ ...VALUES, url: 'not a url' }, autoMap(DB));
  assert.equal(props.Link.url, null);
});

test('buildProperties chunks rich text at Notion 2000-char limit', () => {
  const long = 'x'.repeat(5000);
  const props = buildProperties({ ...VALUES, bibtex: long }, autoMap(DB));
  const chunks = props.BibTeX.rich_text;
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.text.content.length <= 2000));
  assert.equal(chunks.map((c) => c.text.content).join(''), long);
});

test('buildProperties strips commas from select values', () => {
  const props = buildProperties({ ...VALUES, authors: ['Doe, Jane'] }, autoMap(DB));
  assert.deepEqual(props.Authors.multi_select, [{ name: 'Doe Jane' }]);
});

test('buildProperties coerces a year into a date property', () => {
  const db = { properties: { Name: { type: 'title' }, Year: { type: 'date' } } };
  const props = buildProperties({ title: 't', year: 2017 }, autoMap(db));
  assert.equal(props.Year.date.start, '2017-01-01');
});

test('buildProperties returns nothing when no field is mapped', () => {
  assert.deepEqual(buildProperties(VALUES, {}), {});
});

/* ------------------------------------------------------------------ */
/* Page body                                                           */
/* ------------------------------------------------------------------ */

test('buildChildren writes the BibTeX as a code block', () => {
  const blocks = buildChildren(VALUES);
  const code = blocks.find((b) => b.type === 'code');
  assert.ok(code, 'expected a code block');
  assert.equal(code.code.language, 'latex');
  assert.equal(code.code.rich_text[0].text.content, VALUES.bibtex);
});

test('buildChildren links the DOI', () => {
  const blocks = buildChildren(VALUES);
  const doiBlock = blocks.find((b) => b.paragraph && /^DOI:/.test(b.paragraph.rich_text[0].text.content));
  assert.equal(doiBlock.paragraph.rich_text[0].text.link.url, `https://doi.org/${VALUES.doi}`);
});

test('buildChildren honours the include flags', () => {
  const blocks = buildChildren(VALUES, { includeAbstract: false, includeBibtex: false });
  assert.ok(!blocks.some((b) => b.type === 'code'));
  assert.ok(!blocks.some((b) => b.type === 'heading_2'));
});

test('buildChildren splits over-long text across blocks', () => {
  const blocks = buildChildren({ ...VALUES, bibtex: 'y'.repeat(4500) });
  const codeBlocks = blocks.filter((b) => b.type === 'code');
  assert.equal(codeBlocks.length, 3);
});

test('buildChildren copes with an empty clip', () => {
  assert.deepEqual(buildChildren({}), []);
});

test('richText returns an empty array for empty input', () => {
  assert.deepEqual(richText(''), []);
  assert.deepEqual(richText(null), []);
});
