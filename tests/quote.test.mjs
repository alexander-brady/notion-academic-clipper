import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeQuote,
  buildTextFragment,
  quoteUrl,
  quoteBlocks,
  quoteHeadingBlock,
  findQuoteAnchor
} from '../src/lib/quote.js';

/* ------------------------------------------------------------------ */
/* Tidying a selection                                                 */
/* ------------------------------------------------------------------ */

test('runs of whitespace inside a selection are collapsed', () => {
  assert.equal(normalizeQuote('  the   dominant \t sequence\nmodels  '), 'the dominant sequence\nmodels');
});

test('paragraph breaks survive but blank runs are capped', () => {
  assert.equal(normalizeQuote('one\n\n\n\ntwo'), 'one\n\ntwo');
});

test('a selection of only whitespace is empty', () => {
  assert.equal(normalizeQuote('  \n\t '), '');
  assert.equal(normalizeQuote(null), '');
});

/* ------------------------------------------------------------------ */
/* Text fragments                                                      */
/* ------------------------------------------------------------------ */

test('a short passage becomes one encoded text directive', () => {
  assert.equal(buildTextFragment('Attention is all you need'), ':~:text=Attention%20is%20all%20you%20need');
});

test('characters reserved by the fragment syntax are escaped', () => {
  const frag = buildTextFragment('cost-benefit, risk & reward');
  const body = frag.replace(':~:text=', '');
  assert.ok(!/[-,&]/.test(body), frag);
  assert.ok(body.includes('%2D'), 'hyphen must be percent-encoded');
});

test('a long passage is reduced to its first and last words', () => {
  const long = Array.from({ length: 120 }, (_, i) => 'word' + i).join(' ');
  const [start, end] = buildTextFragment(long).replace(':~:text=', '').split(',');
  assert.ok(start.startsWith('word0%20word1'), start);
  assert.ok(end.endsWith('word119'), end);
});

test('an empty selection produces no directive', () => {
  assert.equal(buildTextFragment('   '), '');
});

/* ------------------------------------------------------------------ */
/* Deep links                                                          */
/* ------------------------------------------------------------------ */

test('the directive is appended to a plain URL', () => {
  assert.equal(
    quoteUrl('https://example.org/paper', 'a passage'),
    'https://example.org/paper#:~:text=a%20passage'
  );
});

test('an existing element anchor is kept alongside the directive', () => {
  assert.equal(
    quoteUrl('https://example.org/paper#sec-methods', 'a passage'),
    'https://example.org/paper#sec-methods:~:text=a%20passage'
  );
});

test('quoting from a text-fragment link does not stack directives', () => {
  assert.equal(
    quoteUrl('https://example.org/p#:~:text=old', 'new passage'),
    'https://example.org/p#:~:text=new%20passage'
  );
});

test('a URL with no quotable text is returned untouched', () => {
  assert.equal(quoteUrl('https://example.org/p', '  '), 'https://example.org/p');
});

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

test('a quote block carries the passage and a link back to it', () => {
  const [block] = quoteBlocks({
    text: 'The dominant sequence transduction models',
    url: 'https://arxiv.org/abs/1706.03762',
    section: 'Introduction'
  });

  assert.equal(block.type, 'quote');
  assert.equal(block.quote.rich_text[0].text.content, 'The dominant sequence transduction models');

  const caption = block.quote.children[0].paragraph;
  assert.equal(caption.color, 'gray');
  assert.match(caption.rich_text[0].text.link.url, /#:~:text=The%20dominant/);
  assert.equal(caption.rich_text[1].text.content, ' · Introduction');
});

test('a quote with no section still links back', () => {
  const [block] = quoteBlocks({ text: 'a passage', url: 'https://example.org/p' });
  assert.equal(block.quote.children[0].paragraph.rich_text.length, 1);
});

test('a passage longer than one rich-text object is split, not truncated', () => {
  const long = 'x'.repeat(4500);
  const [block] = quoteBlocks({ text: long, url: 'https://example.org/p' });
  const joined = block.quote.rich_text.map((t) => t.text.content).join('');
  assert.equal(block.quote.rich_text.length, 3);
  assert.equal(joined.length, 4500);
});

test('an empty selection produces no blocks at all', () => {
  assert.deepEqual(quoteBlocks({ text: '  ', url: 'https://example.org/p' }), []);
});

/* ------------------------------------------------------------------ */
/* Placing the quote on the page                                       */
/* ------------------------------------------------------------------ */

const heading = (id, text, type = 'heading_2') => ({
  id,
  type,
  [type]: { rich_text: [{ plain_text: text }] }
});

const para = (id, text = '') => ({
  id,
  type: 'paragraph',
  paragraph: { rich_text: [{ plain_text: text }] }
});

test('a page with no quotes section needs the heading adding', () => {
  assert.deepEqual(findQuoteAnchor([heading('h1', 'Abstract'), para('p1')]), {
    hasHeading: false,
    after: null
  });
});

test('a new quote goes after the last block of an existing quotes section', () => {
  const blocks = [
    heading('h1', 'Abstract'),
    para('p1'),
    heading('h2', 'Quotes'),
    para('q1'),
    para('q2'),
    heading('h3', 'My notes'),
    para('n1')
  ];
  assert.deepEqual(findQuoteAnchor(blocks), { hasHeading: true, after: 'q2' });
});

test('an empty quotes section anchors on the heading itself', () => {
  const blocks = [heading('h2', 'Quotes'), heading('h3', 'Notes'), para('n1')];
  assert.deepEqual(findQuoteAnchor(blocks), { hasHeading: true, after: 'h2' });
});

test('a quotes section at the end of the page anchors on the last block', () => {
  const blocks = [heading('h1', 'BibTeX'), para('b1'), heading('h2', 'Quotes'), para('q1')];
  assert.deepEqual(findQuoteAnchor(blocks), { hasHeading: true, after: 'q1' });
});

test('the heading is matched regardless of level or case', () => {
  const blocks = [heading('h1', 'quotes', 'heading_1'), para('q1')];
  assert.deepEqual(findQuoteAnchor(blocks), { hasHeading: true, after: 'q1' });
});

test('a renamed heading is what gets looked for', () => {
  const blocks = [heading('h2', 'Quotes'), para('q1'), heading('h3', 'Highlights'), para('x1')];
  assert.deepEqual(findQuoteAnchor(blocks, 'Highlights'), { hasHeading: true, after: 'x1' });
  assert.equal(findQuoteAnchor(blocks, 'Excerpts').hasHeading, false);
});

test('the heading block uses the configured text', () => {
  assert.equal(quoteHeadingBlock('Highlights').heading_2.rich_text[0].text.content, 'Highlights');
  assert.equal(quoteHeadingBlock().heading_2.rich_text[0].text.content, 'Quotes');
});

test('blocks of an unexpected shape are ignored rather than throwing', () => {
  assert.deepEqual(findQuoteAnchor(null), { hasHeading: false, after: null });
  assert.deepEqual(findQuoteAnchor([{ id: 'x', type: 'divider', divider: {} }]), {
    hasHeading: false,
    after: null
  });
});

/* ------------------------------------------------------------------ */
/* PDFs                                                                */
/* ------------------------------------------------------------------ */

test('a PDF gets a plain link: Chrome cannot resolve a text fragment there', () => {
  assert.equal(
    quoteUrl('https://arxiv.org/pdf/1706.03762.pdf', 'a passage'),
    'https://arxiv.org/pdf/1706.03762.pdf'
  );
  assert.equal(
    quoteUrl('https://example.org/paper.pdf?download=1', 'a passage'),
    'https://example.org/paper.pdf?download=1'
  );
});

test('a /pdf/ path counts as a PDF: arXiv serves them with no extension', () => {
  assert.equal(
    quoteUrl('https://arxiv.org/pdf/1706.03762v7', 'a passage'),
    'https://arxiv.org/pdf/1706.03762v7'
  );
});

test('the caption says what the link can actually do', () => {
  const [html] = quoteBlocks({ text: 'a passage', url: 'https://example.org/p' });
  assert.equal(html.quote.children[0].paragraph.rich_text[0].text.content, 'Jump to this passage');

  const [pdf] = quoteBlocks({ text: 'a passage', url: 'https://example.org/p.pdf' });
  assert.equal(pdf.quote.children[0].paragraph.rich_text[0].text.content, 'Open the source');
});
