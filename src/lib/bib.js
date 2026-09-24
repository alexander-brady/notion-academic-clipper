/**
 * DOI resolution and BibTeX retrieval.
 *
 * Runs inside the MV3 service worker: there is no DOM here, so every response
 * is parsed with plain string/regex handling rather than DOMParser.
 */

const TIMEOUT_MS = 12000;

async function fetchText(url, { accept, timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: accept ? { Accept: accept } : undefined
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, { accept: 'application/json', ...opts }));
}

export function normalizeDoi(raw) {
  if (!raw) return '';
  let d = String(raw).trim();
  d = d.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '').replace(/^(doi:|info:doi\/)\s*/i, '');
  const m = d.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9<>+\[\]]+/i);
  return m ? m[0].replace(/[.,;:'")\]>]+$/, '') : '';
}

/* ------------------------------------------------------------------ */
/* BibTeX parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Split an entry into its raw parts, preserving each value exactly as written.
 * Brace protection ({BERT}) and LaTeX escapes must survive re-formatting, so
 * the raw text is kept alongside the cleaned-up version.
 */
function tokenizeEntry(bibtex) {
  if (!bibtex) return null;
  const head = bibtex.match(/@(\w+)\s*\{\s*([^,\s]*)\s*,/);
  if (!head) return null;

  const s = bibtex;
  let i = head.index + head[0].length;
  const fields = [];

  while (i < s.length) {
    const nameMatch = s.slice(i).match(/^\s*([A-Za-z][\w-]*)\s*=\s*/);
    if (!nameMatch) break;
    i += nameMatch[0].length;
    const name = nameMatch[1];

    let raw = '';
    let delim = '';

    if (s[i] === '{') {
      delim = '{';
      let depth = 0;
      const start = i;
      for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      raw = s.slice(start + 1, i - 1);
    } else if (s[i] === '"') {
      delim = '"';
      const start = ++i;
      for (; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
      raw = s.slice(start, i);
      i++;
    } else {
      // A bare value: a number, or a month macro such as `month=July`.
      const start = i;
      while (i < s.length && !/[,}]/.test(s[i])) i++;
      raw = s.slice(start, i).trim();
    }

    fields.push({ name, delim, raw: normalizeRaw(raw) });

    const sep = s.slice(i).match(/^\s*,/);
    if (sep) i += sep[0].length;
    else break;
  }

  return { type: head[1].toLowerCase(), key: head[2], fields };
}

/** Parse a single BibTeX entry into { type, key, fields }. */
export function parseBibtex(bibtex) {
  const tokens = tokenizeEntry(bibtex);
  if (!tokens) return null;
  const fields = {};
  for (const f of tokens.fields) fields[f.name.toLowerCase()] = cleanFieldValue(f.raw);
  return { type: tokens.type, key: tokens.key, fields };
}

/**
 * Re-emit an entry one field per line. Crossref returns everything on a single
 * line, which is unreadable once it lands in a Notion code block.
 */
export function formatBibtex(bibtex) {
  const tokens = tokenizeEntry(bibtex);
  if (!tokens || !tokens.fields.length) return bibtex;

  const pad = Math.max(...tokens.fields.map((f) => f.name.length));
  const lines = tokens.fields.map((f) => {
    let value = f.raw;
    // LaTeX wants an en dash in page ranges written as `--`.
    if (f.name.toLowerCase() === 'pages') value = value.replace(/\s*[–—]\s*/g, '--');
    const wrapped = f.delim === '"' ? `"${value}"` : f.delim === '{' ? `{${value}}` : value;
    return `  ${f.name.padEnd(pad)} = ${wrapped}`;
  });

  return `@${tokens.type}{${tokens.key},\n${lines.join(',\n')}\n}`;
}

function normalizeRaw(raw) {
  return (
    decodeEntities(raw)
      .replace(/\s+/g, ' ')
      // A decoded `&amp;` leaves a bare ampersand, which LaTeX will choke on.
      .replace(/(?<!\\)&/g, '\\&')
      .trim()
  );
}

/** Crossref leaks HTML entities into BibTeX values; BibTeX has no such concept. */
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function cleanFieldValue(v) {
  return String(v)
    .replace(/[{}]/g, '')
    .replace(/\\&/g, '&')
    .replace(/\\_/g, '_')
    .replace(/\\%/g, '%')
    .replace(/\\\$/g, '$')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Doe, Jane and Roe, Richard" -> ["Jane Doe", "Richard Roe"] */
export function parseBibAuthors(authorField) {
  if (!authorField) return [];
  return authorField
    .split(/\s+and\s+/i)
    .map((a) => {
      const t = a.trim();
      if (!t) return '';
      const parts = t.split(',');
      if (parts.length === 2) return `${parts[1].trim()} ${parts[0].trim()}`.trim();
      return t;
    })
    .filter(Boolean);
}

/** Replace the citation key, leaving the rest of the entry untouched. */
export function setCiteKey(bibtex, key) {
  return bibtex.replace(/@(\w+)\s*\{\s*[^,]*,/, (_m, type) => `@${type}{${key},`);
}

export function makeCiteKey({ authors = [], year, title = '' }) {
  const stop = new Set([
    'a',
    'an',
    'the',
    'on',
    'of',
    'in',
    'for',
    'and',
    'or',
    'to',
    'with',
    'is',
    'are',
    'towards',
    'toward',
    'using',
    'via',
    'from',
    'by',
    'at'
  ]);
  const last =
    (authors[0] || '')
      .replace(/,.*$/, '') // "Doe, Jane" -> "Doe"
      .trim()
      .split(/\s+/)
      .pop() || 'unknown';
  const word =
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .find((w) => w.length > 3 && !stop.has(w)) || 'untitled';
  const ascii = (s) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]/g, '');
  return `${ascii(last).toLowerCase()}${year || ''}${ascii(word).toLowerCase()}`;
}

/* ------------------------------------------------------------------ */
/* BibTeX sources                                                      */
/* ------------------------------------------------------------------ */

function looksLikeBibtex(text) {
  return typeof text === 'string' && /^\s*@\w+\s*\{/.test(text);
}

async function bibtexFromDoi(doi) {
  const encoded = encodeURI(doi);

  // Crossref's transform endpoint is fast and gives clean entries, but only
  // covers Crossref-registered DOIs.
  try {
    const text = await fetchText(`https://api.crossref.org/works/${encoded}/transform/application/x-bibtex`);
    if (looksLikeBibtex(text)) return { bibtex: text.trim(), source: 'Crossref' };
  } catch {
    /* fall through to content negotiation */
  }

  // doi.org content negotiation covers DataCite (arXiv, Zenodo, Dryad, ...)
  // and mEDRA as well.
  try {
    const text = await fetchText(`https://doi.org/${encoded}`, {
      accept: 'application/x-bibtex; charset=utf-8'
    });
    if (looksLikeBibtex(text)) return { bibtex: text.trim(), source: 'doi.org' };
  } catch {
    /* fall through */
  }

  return null;
}

async function bibtexFromArxiv(arxivId) {
  const bare = String(arxivId).replace(/v\d+$/, '');

  // Modern arXiv submissions have a DataCite DOI; prefer the registered record.
  const viaDoi = await bibtexFromDoi(`10.48550/arXiv.${bare}`);
  if (viaDoi) return { ...viaDoi, source: 'arXiv (DataCite)', doi: `10.48550/arXiv.${bare}` };

  // Otherwise build the entry from the Atom feed.
  try {
    const xml = await fetchText(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(bare)}&max_results=1`
    );
    const entry = xml.slice(xml.indexOf('<entry'));
    if (!entry || entry.indexOf('<entry') !== 0) return null;

    const pick = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
    };
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
      .map((m) => decodeEntities(m[1]).trim())
      .filter(Boolean);

    const title = pick('title');
    if (!title) return null;
    const published = pick('published');
    const year = (published.match(/^(\d{4})/) || [])[1] || '';
    const primary = (entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [])[1] || '';

    const bibtex = buildBibtex('misc', {
      title,
      author: authors.map(toBibName).join(' and '),
      year,
      eprint: bare,
      archiveprefix: 'arXiv',
      primaryclass: primary,
      doi: `10.48550/arXiv.${bare}`,
      url: `https://arxiv.org/abs/${bare}`,
      abstract: pick('summary')
    });
    return { bibtex, source: 'arXiv API', doi: `10.48550/arXiv.${bare}` };
  } catch {
    return null;
  }
}

async function doiFromPmid(pmid) {
  try {
    const data = await fetchJson(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${encodeURIComponent(pmid)}`
    );
    const rec = data && data.result && data.result[pmid];
    const ids = (rec && rec.articleids) || [];
    const hit = ids.find((x) => String(x.idtype).toLowerCase() === 'doi');
    return hit ? normalizeDoi(hit.value) : '';
  } catch {
    return '';
  }
}

/** Last resort before giving up on a registered record: search Crossref by title. */
async function doiFromTitle(title, authors = []) {
  if (!title || title.length < 15) return '';
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const want = norm(title);

  try {
    const params = new URLSearchParams({
      'query.bibliographic': title,
      rows: '5',
      select: 'DOI,title,author'
    });
    if (authors[0]) params.set('query.author', authors[0]);
    const data = await fetchJson(`https://api.crossref.org/works?${params}`);
    const items = (data && data.message && data.message.items) || [];
    for (const item of items) {
      const got = norm((item.title && item.title[0]) || '');
      if (!got) continue;
      // Require a near-exact title match: a fuzzy hit here would silently
      // attach the wrong paper's BibTeX to the clip.
      if (got === want || dice(got, want) >= 0.92) return normalizeDoi(item.DOI);
    }
  } catch {
    /* offline or rate-limited */
  }
  return '';
}

/** Dice coefficient over character bigrams. */
function dice(a, b) {
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let hits = 0;
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const n of gb.values()) total += n;
  for (const [g, n] of ga) hits += Math.min(n, gb.get(g) || 0);
  return total ? (2 * hits) / total : 0;
}

/* ------------------------------------------------------------------ */
/* Building entries from scratch                                       */
/* ------------------------------------------------------------------ */

/** "Jane Doe" -> "Doe, Jane" (leaves an already-inverted name alone). */
function toBibName(name) {
  const n = String(name).trim();
  if (!n || n.includes(',')) return n;
  const parts = n.split(/\s+/);
  if (parts.length < 2) return n;
  const last = parts.pop();
  return `${last}, ${parts.join(' ')}`;
}

function escapeBib(v) {
  return String(v)
    .replace(/[{}]/g, '')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildBibtex(type, fields, key) {
  const entries = Object.entries(fields).filter(([, v]) => v !== '' && v != null);
  const pad = Math.max(...entries.map(([k]) => k.length), 1);
  const body = entries.map(([k, v]) => `  ${k.padEnd(pad)} = {${escapeBib(v)}}`).join(',\n');
  return `@${type}{${key || 'key'},\n${body}\n}`;
}

function fallbackBibtex(meta) {
  const type = meta.journal ? 'article' : 'misc';
  return buildBibtex(type, {
    title: meta.title,
    author: (meta.authors || []).map(toBibName).join(' and '),
    year: meta.year || '',
    journal: type === 'article' ? meta.journal : '',
    howpublished: type === 'misc' ? meta.siteName : '',
    volume: meta.volume,
    number: meta.issue,
    pages: meta.pages,
    publisher: meta.publisher,
    doi: meta.doi,
    url: meta.url,
    note: `Accessed: ${new Date().toISOString().slice(0, 10)}`
  });
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Resolve the best BibTeX entry available for a page.
 * Always returns an entry — falling back to one built from page metadata —
 * so a clip never fails just because the paper is not registered anywhere.
 */
export async function resolveBibtex(meta, { rewriteKey = true } = {}) {
  let doi = normalizeDoi(meta.doi);
  let result = null;

  if (doi) result = await bibtexFromDoi(doi);

  if (!result && meta.arxivId) {
    const r = await bibtexFromArxiv(meta.arxivId);
    if (r) {
      result = r;
      doi = doi || r.doi || '';
    }
  }

  if (!result && meta.pmid) {
    const pmDoi = await doiFromPmid(meta.pmid);
    if (pmDoi) {
      result = await bibtexFromDoi(pmDoi);
      if (result) doi = pmDoi;
    }
  }

  if (!result && !doi && meta.title) {
    const guessed = await doiFromTitle(meta.title, meta.authors);
    if (guessed) {
      result = await bibtexFromDoi(guessed);
      if (result) doi = guessed;
    }
  }

  let source = 'page metadata';
  let bibtex;
  if (result) {
    bibtex = formatBibtex(result.bibtex);
    source = result.source;
  } else {
    bibtex = fallbackBibtex({ ...meta, doi });
  }

  const parsed = parseBibtex(bibtex);
  const fields = (parsed && parsed.fields) || {};

  if (!doi && fields.doi) doi = normalizeDoi(fields.doi);

  if (rewriteKey) {
    const authors = parseBibAuthors(fields.author);
    const key = makeCiteKey({
      authors: authors.length ? authors : meta.authors,
      year: fields.year || meta.year,
      title: fields.title || meta.title
    });
    bibtex = setCiteKey(bibtex, key);
  }

  return {
    bibtex: bibtex.trim(),
    doi,
    source,
    parsed: parseBibtex(bibtex)
  };
}
