/**
 * Live smoke test against the real metadata services.
 * Not part of `npm test` — it needs network and depends on third-party uptime.
 *
 *   npm run test:live
 */
import { resolveBibtex } from '../src/lib/bib.js';

const CASES = [
  {
    name: 'Crossref DOI',
    meta: { doi: '10.1038/nature12373', title: '', authors: [] },
    expect: (r) => r.source === 'Crossref' && /^@\w+\{/.test(r.bibtex)
  },
  {
    name: 'DOI given as a full URL',
    meta: { doi: 'https://doi.org/10.1145/3292500.3330701', title: '', authors: [] },
    expect: (r) => r.doi === '10.1145/3292500.3330701'
  },
  {
    name: 'arXiv id (no DOI on the page)',
    meta: { arxivId: '1706.03762', title: '', authors: [] },
    expect: (r) => /attention/i.test(r.bibtex) && r.doi.includes('10.48550')
  },
  {
    name: 'PubMed PMID',
    meta: { pmid: '23842501', title: '', authors: [] },
    expect: (r) => Boolean(r.doi)
  },
  {
    name: 'Title-only Crossref search',
    meta: { title: 'Deep Residual Learning for Image Recognition', authors: ['Kaiming He'] },
    expect: (r) => Boolean(r.doi)
  },
  {
    name: 'No identifiers: falls back to page metadata',
    meta: {
      title: 'An Entirely Fictional Paper That Is Not Registered Anywhere 12345',
      authors: ['Jane Doe'],
      year: 2024,
      url: 'https://example.com/paper',
      journal: 'Journal of Nothing'
    },
    expect: (r) => r.source === 'page metadata' && r.bibtex.includes('Doe, Jane')
  }
];

let failed = 0;

for (const c of CASES) {
  const started = Date.now();
  try {
    const result = await resolveBibtex(c.meta);
    const ok = c.expect(result);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  (${Date.now() - started}ms)`);
    console.log(`      source=${result.source} doi=${result.doi || '-'} key=${result.parsed?.key || '-'}`);
    console.log(`      ${result.bibtex.split('\n')[0]}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${c.name}: ${e.message}`);
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
