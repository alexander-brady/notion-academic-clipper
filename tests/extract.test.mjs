import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { extractPageMetadata, extractSelection } from '../src/lib/extract.js';

/**
 * extractPageMetadata is written to be injected into a page, so it reads the
 * `document` and `location` globals. Here we point those at a jsdom instance.
 */
function extractFrom(html, url) {
  const dom = new JSDOM(html, { url });
  const saved = { document: global.document, location: global.location };
  global.document = dom.window.document;
  Object.defineProperty(global, 'location', {
    value: dom.window.location,
    configurable: true,
    writable: true
  });
  try {
    return extractPageMetadata();
  } finally {
    global.document = saved.document;
    Object.defineProperty(global, 'location', { value: saved.location, configurable: true, writable: true });
  }
}

/* ------------------------------------------------------------------ */
/* Highwire meta tags (arXiv, Nature, Springer, IEEE, ACM, ...)        */
/* ------------------------------------------------------------------ */

const ARXIV = `<!doctype html><html><head>
  <title>[1706.03762] Attention Is All You Need</title>
  <meta name="citation_title" content="Attention Is All You Need" />
  <meta name="citation_author" content="Vaswani, Ashish" />
  <meta name="citation_author" content="Shazeer, Noam" />
  <meta name="citation_author" content="Parmar, Niki" />
  <meta name="citation_date" content="2017/06/12" />
  <meta name="citation_online_date" content="2017/06/12" />
  <meta name="citation_pdf_url" content="http://arxiv.org/pdf/1706.03762v7" />
  <meta name="citation_arxiv_id" content="1706.03762" />
  <meta property="og:title" content="Attention Is All You Need" />
</head><body>
  <blockquote class="abstract"><span class="descriptor">Abstract:</span>
    The dominant sequence transduction models are based on complex recurrent networks.
  </blockquote>
</body></html>`;

test('arXiv: reads title, authors, id and PDF link', () => {
  const m = extractFrom(ARXIV, 'https://arxiv.org/abs/1706.03762');
  assert.equal(m.title, 'Attention Is All You Need');
  assert.deepEqual(m.authors, ['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki']);
  assert.equal(m.arxivId, '1706.03762');
  assert.equal(m.year, 2017);
  assert.equal(m.pdfUrl, 'http://arxiv.org/pdf/1706.03762v7');
  assert.match(m.abstract, /^The dominant sequence transduction/);
});

const NATURE = `<!doctype html><html><head>
  <title>Nanometre-scale thermometry in a living cell | Nature</title>
  <meta name="citation_title" content="Nanometre-scale thermometry in a living cell" />
  <meta name="citation_doi" content="10.1038/nature12373" />
  <meta name="citation_journal_title" content="Nature" />
  <meta name="citation_publication_date" content="2013/07/31" />
  <meta name="citation_volume" content="500" />
  <meta name="citation_issue" content="7460" />
  <meta name="citation_firstpage" content="54" />
  <meta name="citation_lastpage" content="58" />
  <meta name="citation_publisher" content="Nature Publishing Group" />
  <meta name="citation_author" content="Kucsko, G." />
  <meta name="dc.identifier" content="doi:10.1038/nature12373" />
  <link rel="canonical" href="https://www.nature.com/articles/nature12373" />
</head><body></body></html>`;

test('Nature: reads DOI, journal, volume/issue/pages and canonical URL', () => {
  const m = extractFrom(NATURE, 'https://www.nature.com/articles/nature12373?utm_source=twitter');
  assert.equal(m.doi, '10.1038/nature12373');
  assert.equal(m.journal, 'Nature');
  assert.equal(m.year, 2013);
  assert.equal(m.volume, '500');
  assert.equal(m.issue, '7460');
  assert.equal(m.pages, '54--58');
  assert.equal(m.url, 'https://www.nature.com/articles/nature12373');
  assert.equal(m.publisher, 'Nature Publishing Group');
});

test('title has the trailing site name trimmed', () => {
  const m = extractFrom(
    '<html><head><title>Some Paper Title - arXiv</title></head><body></body></html>',
    'https://example.org/x'
  );
  assert.equal(m.title, 'Some Paper Title');
});

/* ------------------------------------------------------------------ */
/* DOI discovery beyond meta tags                                      */
/* ------------------------------------------------------------------ */

test('DOI is recovered from the URL when no meta tag carries it', () => {
  const m = extractFrom(
    '<html><head><title>Optuna</title></head><body></body></html>',
    'https://dl.acm.org/doi/10.1145/3292500.3330701'
  );
  assert.equal(m.doi, '10.1145/3292500.3330701');
});

test('DOI is recovered from a doi.org link in the page', () => {
  const m = extractFrom(
    `<html><head><title>Paper</title></head><body>
       <a href="https://doi.org/10.1093/nar/gkab1038">https://doi.org/10.1093/nar/gkab1038</a>
     </body></html>`,
    'https://example.org/article/42'
  );
  assert.equal(m.doi, '10.1093/nar/gkab1038');
});

test('DOI printed as text in the article header is found', () => {
  const m = extractFrom(
    `<html><head><title>Paper</title></head><body>
       <header><span class="doi">DOI: 10.1021/acs.jcim.1c00203</span></header>
     </body></html>`,
    'https://example.org/article/42'
  );
  assert.equal(m.doi, '10.1021/acs.jcim.1c00203');
});

test('a trailing sentence period is not swallowed into the DOI', () => {
  const m = extractFrom(
    `<html><head><meta name="citation_doi" content="10.1038/nature12373." /></head><body></body></html>`,
    'https://example.org/x'
  );
  assert.equal(m.doi, '10.1038/nature12373');
});

test('a DOI written as a full URL in a meta tag is normalised', () => {
  const m = extractFrom(
    `<html><head><meta name="citation_doi" content="https://doi.org/10.1038/nature12373" /></head><body></body></html>`,
    'https://example.org/x'
  );
  assert.equal(m.doi, '10.1038/nature12373');
});

test('a page with no DOI anywhere reports an empty string', () => {
  const m = extractFrom(
    '<html><head><title>A blog post about science</title></head><body><p>No identifiers here.</p></body></html>',
    'https://blog.example.com/post'
  );
  assert.equal(m.doi, '');
  assert.equal(m.arxivId, '');
  assert.equal(m.pmid, '');
});

/* ------------------------------------------------------------------ */
/* PubMed / arXiv identifiers from the URL                             */
/* ------------------------------------------------------------------ */

test('PMID is read from a PubMed URL', () => {
  const m = extractFrom(
    '<html><head><title>Treg induction - PubMed</title></head><body></body></html>',
    'https://pubmed.ncbi.nlm.nih.gov/23842501/'
  );
  assert.equal(m.pmid, '23842501');
});

test('arXiv id is read from an abs URL with a version suffix', () => {
  const m = extractFrom(
    '<html><head><title>x</title></head><body></body></html>',
    'https://arxiv.org/abs/2103.00020v2'
  );
  assert.equal(m.arxivId, '2103.00020v2');
});

test('arXiv id is derived from a DataCite arXiv DOI', () => {
  const m = extractFrom(
    '<html><head><meta name="citation_doi" content="10.48550/arXiv.1706.03762" /></head><body></body></html>',
    'https://example.org/x'
  );
  assert.equal(m.arxivId, '1706.03762');
});

/* ------------------------------------------------------------------ */
/* JSON-LD                                                             */
/* ------------------------------------------------------------------ */

const JSON_LD = `<!doctype html><html><head>
  <title>Site</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "name": "Publisher" },
      {
        "@type": "ScholarlyArticle",
        "name": "A Study of Something",
        "datePublished": "2021-03-04",
        "author": [{ "@type": "Person", "name": "Ada Lovelace" }, { "@type": "Person", "name": "Alan Turing" }],
        "isPartOf": { "name": "Journal of Studies" },
        "abstract": "We studied something carefully.",
        "sameAs": "https://doi.org/10.5555/12345678"
      }
    ]
  }
  </script>
</head><body></body></html>`;

test('JSON-LD supplies title, authors, journal, year and DOI', () => {
  const m = extractFrom(JSON_LD, 'https://example.org/article');
  assert.equal(m.title, 'A Study of Something');
  assert.deepEqual(m.authors, ['Ada Lovelace', 'Alan Turing']);
  assert.equal(m.journal, 'Journal of Studies');
  assert.equal(m.year, 2021);
  assert.equal(m.doi, '10.5555/12345678');
  assert.equal(m.abstract, 'We studied something carefully.');
});

test('malformed JSON-LD does not break extraction', () => {
  const m = extractFrom(
    `<html><head><title>Fine</title><script type="application/ld+json">{not json}</script></head><body></body></html>`,
    'https://example.org/x'
  );
  assert.equal(m.title, 'Fine');
});

/* ------------------------------------------------------------------ */
/* Author handling                                                     */
/* ------------------------------------------------------------------ */

test('a single meta tag holding every author is split apart', () => {
  const m = extractFrom(
    `<html><head><meta name="dc.creator" content="Doe, Jane; Roe, Richard; Smith, Alex" /></head><body></body></html>`,
    'https://example.org/x'
  );
  assert.deepEqual(m.authors, ['Doe, Jane', 'Roe, Richard', 'Smith, Alex']);
});

test('duplicate author tags are collapsed', () => {
  const m = extractFrom(
    `<html><head>
       <meta name="citation_author" content="Jane Doe" />
       <meta name="citation_author" content="jane doe" />
       <meta name="citation_author" content="Richard Roe" />
     </head><body></body></html>`,
    'https://example.org/x'
  );
  assert.deepEqual(m.authors, ['Jane Doe', 'Richard Roe']);
});

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

test('an empty page still returns the full result shape', () => {
  const m = extractFrom('<html><head></head><body></body></html>', 'https://example.org/');
  for (const key of ['title', 'url', 'doi', 'arxivId', 'pmid', 'authors', 'journal', 'year', 'abstract']) {
    assert.ok(key in m, `missing key: ${key}`);
  }
  assert.deepEqual(m.authors, []);
  assert.equal(m.year, null);
  assert.equal(m.url, 'https://example.org/');
});

/* ------------------------------------------------------------------ */
/* Selections                                                          */
/* ------------------------------------------------------------------ */

/** Select the contents of one element, the way a reader drags over a sentence. */
function selectionFrom(html, selector, url = 'https://example.org/paper') {
  const dom = new JSDOM(html, { url });
  const { window } = dom;
  const saved = { document: global.document, window: global.window, Node: global.Node };

  global.document = window.document;
  global.window = window;
  global.Node = window.Node;
  Object.defineProperty(global, 'location', { value: window.location, configurable: true, writable: true });

  const range = window.document.createRange();
  range.selectNodeContents(window.document.querySelector(selector));
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  try {
    return extractSelection();
  } finally {
    Object.assign(global, saved);
  }
}

const ARTICLE = `<!doctype html><html><head><title>Paper</title></head><body>
  <h1>A Study of Something</h1>
  <p id="lead">Lead paragraph.</p>
  <h2>Methods</h2>
  <p id="methods">We measured the thing carefully.</p>
  <h2>Results</h2>
  <p id="results">The thing was measured.</p>
</body></html>`;

test('a selection reports its text and the heading above it', () => {
  const s = selectionFrom(ARTICLE, '#methods');
  assert.equal(s.text, 'We measured the thing carefully.');
  assert.equal(s.section, 'Methods');
  assert.equal(s.href, 'https://example.org/paper');
});

test('the nearest preceding heading wins, not the first or the last', () => {
  assert.equal(selectionFrom(ARTICLE, '#results').section, 'Results');
  assert.equal(selectionFrom(ARTICLE, '#lead').section, 'A Study of Something');
});

test('a page with no headings still yields the passage', () => {
  const s = selectionFrom('<html><body><p id="p">Just text.</p></body></html>', '#p');
  assert.equal(s.text, 'Just text.');
  assert.equal(s.section, '');
});

test('with nothing selected the result is empty but well-formed', () => {
  const dom = new JSDOM('<p>nothing selected</p>', { url: 'https://example.org/x' });
  const saved = { document: global.document, window: global.window };
  global.document = dom.window.document;
  global.window = dom.window;
  Object.defineProperty(global, 'location', {
    value: dom.window.location,
    configurable: true,
    writable: true
  });
  try {
    const s = extractSelection();
    assert.equal(s.text, '');
    assert.equal(s.section, '');
    assert.equal(s.href, 'https://example.org/x');
  } finally {
    Object.assign(global, saved);
  }
});
