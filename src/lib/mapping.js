/**
 * Maps the clipped fields onto whatever properties a given Notion database
 * happens to have. Notion databases are user-defined, so nothing here assumes
 * a fixed schema: fields are auto-matched by name + type and the user can
 * override any of it in the popup.
 */

/** The data this extension can write. Order is also auto-match priority. */
export const CLIP_FIELDS = [
  {
    id: 'title',
    label: 'Title',
    required: true,
    types: ['title'],
    names: ['title', 'name', 'paper', 'article', 'reference']
  },
  {
    id: 'url',
    label: 'URL',
    types: ['url', 'rich_text'],
    names: ['url', 'link', 'weblink', 'sourceurl', 'source', 'address', 'permalink']
  },
  {
    id: 'doi',
    label: 'DOI',
    types: ['rich_text', 'url', 'select'],
    names: ['doi', 'digitalobjectidentifier', 'identifier']
  },
  {
    id: 'bibtex',
    label: 'BibTeX',
    types: ['rich_text'],
    names: ['bibtex', 'bib', 'bibtexentry', 'citation', 'cite', 'citekey']
  },
  {
    id: 'authors',
    label: 'Authors',
    types: ['multi_select', 'rich_text', 'select'],
    names: ['authors', 'author', 'creators', 'creator', 'by']
  },
  {
    id: 'year',
    label: 'Year',
    types: ['number', 'select', 'rich_text', 'date'],
    names: ['year', 'published', 'publicationyear', 'pubyear', 'datepublished']
  },
  {
    id: 'journal',
    label: 'Journal / Venue',
    types: ['select', 'multi_select', 'rich_text'],
    names: ['journal', 'venue', 'publication', 'conference', 'publisher', 'source', 'proceedings', 'in']
  },
  {
    id: 'abstract',
    label: 'Abstract',
    types: ['rich_text'],
    names: ['abstract', 'summary', 'description', 'notes', 'note']
  },
  {
    id: 'pdf',
    label: 'PDF link',
    types: ['url', 'files', 'rich_text'],
    names: ['pdf', 'pdfurl', 'fulltext', 'file', 'files', 'attachment', 'attachments']
  },
  {
    id: 'entryType',
    label: 'Entry type',
    types: ['select', 'multi_select', 'rich_text'],
    names: ['type', 'entrytype', 'itemtype', 'kind', 'category', 'format']
  },
  {
    id: 'clippedAt',
    label: 'Date clipped',
    types: ['date'],
    names: ['clipped', 'dateclipped', 'dateadded', 'added', 'created', 'date', 'savedon']
  },
  {
    id: 'citeKey',
    label: 'Cite key',
    types: ['rich_text', 'select'],
    names: ['citekey', 'citationkey', 'key', 'bibkey', 'slug']
  }
];

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Database properties in a flat, comparable shape. */
export function listProperties(database) {
  return Object.entries(database.properties || {}).map(([name, def]) => ({
    name,
    type: def.type,
    id: def.id
  }));
}

/**
 * Best-effort assignment of fields to properties.
 * Each property is used at most once; exact name matches beat partial ones.
 */
export function autoMap(database) {
  const props = listProperties(database);
  const taken = new Set();
  const map = {};

  const claim = (field, prop) => {
    map[field.id] = { name: prop.name, type: prop.type };
    taken.add(prop.name);
  };

  // The title property is structural — there is exactly one and it must be set.
  const titleProp = props.find((p) => p.type === 'title');
  if (titleProp) claim(CLIP_FIELDS[0], titleProp);

  for (const field of CLIP_FIELDS) {
    if (map[field.id]) continue;
    const candidates = props.filter((p) => !taken.has(p.name) && field.types.includes(p.type));
    if (!candidates.length) continue;

    const exact = candidates.find((p) => field.names.includes(norm(p.name)));
    if (exact) {
      claim(field, exact);
      continue;
    }

    const partial = candidates.find((p) => {
      const n = norm(p.name);
      return field.names.some((cand) => cand.length >= 3 && (n.includes(cand) || cand.includes(n)));
    });
    if (partial) claim(field, partial);
  }

  return map;
}

/** Drop mappings that no longer match the live schema (renamed/deleted props). */
export function reconcileMap(savedMap, database) {
  const props = listProperties(database);
  const byName = new Map(props.map((p) => [p.name, p]));
  const out = {};
  for (const [fieldId, prop] of Object.entries(savedMap || {})) {
    if (!prop || !prop.name) continue;
    const live = byName.get(prop.name);
    const field = CLIP_FIELDS.find((f) => f.id === fieldId);
    if (live && field && field.types.includes(live.type)) {
      out[fieldId] = { name: live.name, type: live.type };
    }
  }
  if (!out.title) {
    const titleProp = props.find((p) => p.type === 'title');
    if (titleProp) out.title = { name: titleProp.name, type: titleProp.type };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Value conversion                                                    */
/* ------------------------------------------------------------------ */

const MAX_TEXT = 2000; // Notion's per-rich-text-object character limit.

export function richText(value, { link } = {}) {
  const s = String(value == null ? '' : value);
  if (!s) return [];
  const chunks = [];
  for (let i = 0; i < s.length && chunks.length < 100; i += MAX_TEXT) {
    chunks.push(s.slice(i, i + MAX_TEXT));
  }
  return chunks.map((content) => ({
    type: 'text',
    text: { content, link: link ? { url: link } : null }
  }));
}

function safeUrl(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

const selectName = (v) => String(v).replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

/** Convert one clip value into a Notion property value of the given type. */
function toPropertyValue(type, value, fieldId) {
  const isList = Array.isArray(value);
  const asText = isList ? value.join(', ') : String(value == null ? '' : value);
  if (!asText.trim() && type !== 'checkbox') return null;

  switch (type) {
    case 'title':
      return { title: richText(asText.slice(0, MAX_TEXT)) };

    case 'rich_text':
      return { rich_text: richText(asText) };

    case 'url':
      return { url: safeUrl(asText) };

    case 'number': {
      const n = Number(String(asText).replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? { number: n } : null;
    }

    case 'select': {
      const name = selectName(isList ? value[0] : asText);
      return name ? { select: { name } } : null;
    }

    case 'multi_select': {
      const items = (isList ? value : [asText]).map(selectName).filter(Boolean).slice(0, 100);
      return items.length ? { multi_select: items.map((name) => ({ name })) } : null;
    }

    case 'date': {
      if (fieldId === 'year' && /^\d{4}$/.test(asText.trim())) {
        return { date: { start: `${asText.trim()}-01-01` } };
      }
      const d = new Date(asText);
      return Number.isNaN(d.getTime()) ? null : { date: { start: d.toISOString() } };
    }

    case 'files': {
      const url = safeUrl(asText);
      return url ? { files: [{ type: 'external', name: 'PDF', external: { url } }] } : null;
    }

    case 'checkbox':
      return { checkbox: Boolean(value) };

    default:
      return null; // formula, rollup, status, people, relation: not writable here
  }
}

/** Build the `properties` payload for POST /v1/pages. */
export function buildProperties(values, propertyMap) {
  const properties = {};
  for (const field of CLIP_FIELDS) {
    const prop = propertyMap[field.id];
    if (!prop) continue;
    const value = values[field.id];
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;

    const converted = toPropertyValue(prop.type, value, field.id);
    if (converted) properties[prop.name] = converted;
  }
  return properties;
}

/* ------------------------------------------------------------------ */
/* Page body                                                           */
/* ------------------------------------------------------------------ */

/**
 * Blocks written into the page body. The BibTeX always lands here as a code
 * block, even when it also goes into a property, so it stays copy-pasteable
 * and is never truncated by property limits.
 */
export function buildChildren(values, { includeAbstract = true, includeBibtex = true } = {}) {
  const children = [];

  const meta = [];
  if (values.authors && values.authors.length) meta.push(`${values.authors.join(', ')}`);
  if (values.journal) meta.push(values.journal);
  if (values.year) meta.push(String(values.year));
  if (meta.length) {
    children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText(meta.join(' · ')) }
    });
  }

  const links = [];
  if (values.doi) links.push({ label: `DOI: ${values.doi}`, url: `https://doi.org/${values.doi}` });
  if (values.pdf) links.push({ label: 'PDF', url: values.pdf });
  for (const link of links) {
    const url = safeUrl(link.url);
    if (!url) continue;
    children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText(link.label, { link: url }) }
    });
  }

  if (includeAbstract && values.abstract) {
    children.push(heading('Abstract'));
    for (const chunk of splitParagraphs(values.abstract)) {
      children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(chunk) } });
    }
  }

  if (includeBibtex && values.bibtex) {
    children.push(heading('BibTeX'));
    for (const chunk of splitParagraphs(values.bibtex)) {
      children.push({
        object: 'block',
        type: 'code',
        // Notion has no BibTeX lexer; LaTeX is the closest it offers.
        code: { language: 'latex', rich_text: richText(chunk) }
      });
    }
  }

  return children;
}

function heading(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: richText(text) }
  };
}

/** Split long text so no single block exceeds Notion's rich-text limit. */
function splitParagraphs(text) {
  const s = String(text);
  if (s.length <= MAX_TEXT) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += MAX_TEXT) out.push(s.slice(i, i + MAX_TEXT));
  return out;
}
