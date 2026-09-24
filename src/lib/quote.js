/**
 * Saving a highlighted passage onto the paper's existing Notion page.
 *
 * The link back into the source uses a scroll-to-text fragment (`#:~:text=`),
 * which the browser resolves by searching the rendered text. That works on
 * pages that have no anchor worth linking to, which is most of them.
 */

import { richText } from './mapping.js';

/** Notion renders a quote fine at this length; a whole page of text is not a quote. */
const MAX_QUOTE = 8000;

/** Past this, a directive holding the entire passage makes an unusable URL. */
const FRAGMENT_LIMIT = 300;

export const DEFAULT_QUOTE_HEADING = 'Quotes';

/** Tidy a DOM selection into something worth storing. */
export function normalizeQuote(text) {
  return String(text == null ? '' : text)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_QUOTE);
}

/**
 * Percent-encode one side of a text directive. `-`, `,` and `&` are all
 * reserved by the fragment syntax; encodeURIComponent leaves `-` alone.
 */
function encodeDirective(s) {
  return encodeURIComponent(s).replace(/-/g, '%2D');
}

/**
 * A `:~:text=` directive for the passage. Long selections use the spec's
 * `start,end` form, which asks the browser to match the first and last few
 * words and take everything between them.
 */
export function buildTextFragment(text) {
  const flat = normalizeQuote(text).replace(/\s+/g, ' ');
  if (!flat) return '';
  if (flat.length <= FRAGMENT_LIMIT) return `:~:text=${encodeDirective(flat)}`;

  const words = flat.split(' ').filter(Boolean);
  const head = words.slice(0, 6).join(' ');
  const tail = words.slice(-6).join(' ');
  if (!tail || tail === head) return `:~:text=${encodeDirective(head)}`;
  return `:~:text=${encodeDirective(head)},${encodeDirective(tail)}`;
}

/**
 * Chrome resolves text fragments by searching rendered HTML, and its PDF
 * viewer does no such thing — a directive there produces a link that looks
 * like it should jump and silently doesn't.
 */
const isPdf = (url) => /\.pdf($|[?#])/i.test(url) || /\/pdf\//i.test(url);

/** The page URL, pointed at the passage where the viewer can manage it. */
export function quoteUrl(url, text) {
  const base = String(url == null ? '' : url);
  const directive = isPdf(base) ? '' : buildTextFragment(text);
  if (!base || !directive) return base;

  const hashAt = base.indexOf('#');
  const path = hashAt === -1 ? base : base.slice(0, hashAt);
  // Any existing element anchor is kept: the fragment directive is a separate
  // part of the hash, and the anchor may be what makes the page load correctly.
  const anchor = hashAt === -1 ? '' : base.slice(hashAt + 1).split(':~:')[0];
  return `${path}#${anchor}${directive}`;
}

/** The passage, with a line underneath linking back to where it was read. */
export function quoteBlocks({ text, url, section }) {
  const passage = normalizeQuote(text);
  if (!passage) return [];

  const link = quoteUrl(url, passage);
  const caption = [];
  if (link) {
    // Without a directive the link only reaches the document, so say so rather
    // than promising a jump that will not happen.
    const label = link.includes(':~:') ? 'Jump to this passage' : 'Open the source';
    caption.push({ type: 'text', text: { content: label, link: { url: link } } });
  }
  if (section) {
    caption.push({ type: 'text', text: { content: ` · ${section}`, link: null } });
  }

  const quote = { rich_text: richText(passage) };
  if (caption.length) {
    quote.children = [
      { object: 'block', type: 'paragraph', paragraph: { rich_text: caption, color: 'gray' } }
    ];
  }
  return [{ object: 'block', type: 'quote', quote }];
}

export function quoteHeadingBlock(text = DEFAULT_QUOTE_HEADING) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: richText(text) } };
}

const isHeading = (block) => Boolean(block) && /^heading_[123]$/.test(block.type);

function plainText(block) {
  const body = block && block[block.type];
  return ((body && body.rich_text) || [])
    .map((t) => t.plain_text || '')
    .join('')
    .trim();
}

/**
 * Where a new quote belongs among a page's blocks. Quotes go at the end of the
 * existing quotes section rather than the end of the page, so they stay
 * together even once notes have been written below them.
 */
export function findQuoteAnchor(children, headingText = DEFAULT_QUOTE_HEADING) {
  const blocks = Array.isArray(children) ? children : [];
  const wanted = String(headingText || DEFAULT_QUOTE_HEADING)
    .trim()
    .toLowerCase();

  const start = blocks.findIndex((b) => isHeading(b) && plainText(b).toLowerCase() === wanted);
  if (start === -1) return { hasHeading: false, after: null };

  // The section runs until the next heading of any level.
  let end = start;
  for (let i = start + 1; i < blocks.length && !isHeading(blocks[i]); i++) end = i;
  return { hasHeading: true, after: blocks[end].id || null };
}
