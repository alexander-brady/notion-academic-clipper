import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CLIP_FIELDS } from '../src/lib/mapping.js';

/**
 * The setup page and the README both document the properties a database can
 * have. That list is CLIP_FIELDS, and prose drifts away from code silently, so
 * it is checked here instead.
 */

const options = readFileSync(new URL('../src/options/index.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

const rows = [...options.matchAll(/<tr data-field="([^"]+)">\s*<td class="cell font-medium">([^<]+)</g)].map(
  (m) => ({ id: m[1], name: m[2].trim() })
);

test('the setup page documents every clip field, in order', () => {
  assert.deepEqual(
    rows.map((r) => r.id),
    CLIP_FIELDS.map((f) => f.id)
  );
});

test('each documented property is named the way the popup names it', () => {
  for (const [i, field] of CLIP_FIELDS.entries()) {
    assert.equal(rows[i].name, field.label, `row for "${field.id}"`);
  }
});

test('the README schema table lists every clip field', () => {
  const table = readme.slice(
    readme.indexOf('| Property'),
    readme.indexOf('\n\n', readme.indexOf('| Cite key'))
  );
  for (const field of CLIP_FIELDS) {
    assert.ok(table.includes(`| ${field.label} `), `README is missing "${field.label}"`);
  }
});
