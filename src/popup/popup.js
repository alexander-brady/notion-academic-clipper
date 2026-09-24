import { CLIP_FIELDS, listProperties } from '../lib/mapping.js';

const $ = (id) => document.getElementById(id);

const state = {
  tabId: null,
  meta: null,
  database: null,
  databases: [],
  map: {},
  bibtexSource: '',
  citeKey: '',
  entryType: '',
  duplicate: null,
  saving: false,
  selection: null,
  quoteTarget: null
};

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from the extension service worker.'));
      if (!res.ok) return reject(new Error(res.error));
      resolve(res.data);
    });
  });
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */

function showScreen(name) {
  for (const el of document.querySelectorAll('[data-screen]')) el.hidden = el.dataset.screen !== name;
}

// Tailwind scans this file, so these class strings must be written out in full
// rather than assembled at runtime.
const DOT = {
  '': 'bg-muted',
  busy: 'bg-warn animate-pulse',
  ok: 'bg-ok',
  warn: 'bg-danger'
};

// The clip and quote screens each carry their own copy of the status line and
// the notice toast; only one screen is ever visible, so both are written to.
function setStatus(text, kind = '') {
  for (const el of document.querySelectorAll('[data-status-text]')) el.textContent = text;
  for (const el of document.querySelectorAll('[data-status-dot]')) {
    el.className = `size-[7px] flex-none rounded-full ${DOT[kind] ?? DOT['']}`;
  }
}

const NOTICE = { '': '', error: 'notice-error', warn: 'notice-warn' };

const RANK = { '': 0, warn: 1, error: 2 };
let pinned = '';

/**
 * Warnings and errors stay until they are dismissed. Background work finishing
 * afterwards must not quietly wipe the reason something failed, so a notice is
 * only replaced by one at least as serious — or by an explicit clearNotice().
 */
function notice(message, kind = '') {
  if (!message) return;
  if (pinned && (RANK[kind] ?? 0) < RANK[pinned]) return;
  pinned = RANK[kind] ? kind : '';

  for (const el of document.querySelectorAll('[data-notice]')) {
    el.querySelector('[data-notice-text]').textContent = message;
    el.className = `notice ${NOTICE[kind] ?? ''}`.trimEnd();
    el.hidden = false;
  }
}

/** Only ever called from something the user did: the ×, or starting a save. */
function clearNotice() {
  pinned = '';
  for (const el of document.querySelectorAll('[data-notice]')) {
    el.querySelector('[data-notice-text]').textContent = '';
    el.hidden = true;
  }
}

/**
 * The folded-away fields still matter, so the summary line carries the two
 * that decide whether the match is right.
 */
function renderDetailsHint() {
  const doi = $('doi').value.trim();
  const year = $('year').value.trim();
  $('details-hint').textContent = [doi || 'no DOI', year].filter(Boolean).join(' · ');
}

/** Fields the user has typed in are never overwritten by late-arriving data. */
function setValue(id, value) {
  const el = $(id);
  if (el.dataset.dirty === '1') return;
  el.value = value == null ? '' : String(value);
}

for (const id of ['title', 'url', 'doi', 'year', 'authors', 'journal', 'bibtex']) {
  $(id).addEventListener('input', (e) => {
    e.target.dataset.dirty = '1';
    renderDetailsHint();
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  // The clip screen is already on screen: it is the one that ships unhidden in
  // the markup, so the popup opens with its full layout instead of painting an
  // empty box and filling it in once Notion answers.
  const tabQuery = chrome.tabs.query({ active: true, currentWindow: true });
  const initReady = send('init');

  // Asking the page for its selection does not involve Notion, so it runs
  // alongside the init round-trip rather than queued behind it.
  const selectionReady = tabQuery
    .then(([tab]) => (tab && tab.id != null ? send('selection', { tabId: tab.id }) : null))
    .catch(() => null);

  let init;
  try {
    init = await initReady;
  } catch (e) {
    setStatus('Connection problem', 'warn');
    notice(e.message, 'error');
    return;
  }

  const [tab] = await tabQuery;
  state.tabId = tab && tab.id;

  if (!init.connected) {
    showScreen('setup');
    return;
  }

  state.databases = init.databases || [];
  renderDatabases(init.lastDatabaseId);

  // A highlight saved from the context menu or the shortcut has no UI of its
  // own, so its result is reported here the next time the popup opens.
  const last = init.lastQuote;
  if (last && !last.ok) notice(`The last highlight was not saved: ${last.error}`, 'error');

  const selection = await selectionReady;
  if (selection && selection.text.trim()) {
    await bootQuote(selection);
    return;
  }

  // A highlight was attempted but Chrome would not surrender the text. Reopen
  // on the quote screen so the passage can simply be pasted in.
  if (last && !last.ok && last.needsText) {
    await bootQuote({ text: '', section: '', href: last.href || '' }, last.error);
    return;
  }

  if (last && last.ok) {
    notice(last.created ? 'Highlight saved to a newly clipped page.' : 'Highlight saved.', '');
  } else if (selection && selection.error) {
    notice(`Highlights are not available on this page: ${selection.error}`, 'warn');
  }

  if (!state.databases.length) {
    setStatus('No databases shared', 'warn');
    notice(
      'This connection cannot see any database yet. In Notion, open the database → ••• → Connections → add your connection.',
      'warn'
    );
  }

  await loadClip();
}

/** The clip form is only filled in when it is actually going to be shown. */
let clipLoading = null;
function loadClip() {
  if (!clipLoading) {
    clipLoading = (async () => {
      setStatus('Reading page…', 'busy');
      // Scrape and load the database schema at the same time.
      const schemaLoad = loadDatabase($('database').value);
      await loadPage();
      await schemaLoad;
      await checkDuplicate();
    })();
  }
  return clipLoading;
}

/* ------------------------------------------------------------------ */
/* Highlights                                                          */
/* ------------------------------------------------------------------ */

async function bootQuote(selection, why = '') {
  state.selection = selection;
  showScreen('quote');
  $('quote-text').value = selection.text.trim();

  if (selection.section) {
    $('quote-section').textContent = selection.section;
    $('quote-section-row').hidden = false;
  }

  if (!selection.text.trim()) {
    $('quote-hint').hidden = false;
    $('quote-text').focus();
    if (why) notice(why, 'warn');
  }

  setStatus('Finding the paper in Notion…', 'busy');
  try {
    const target = await send('quoteTarget', { tabId: state.tabId });
    state.quoteTarget = target;

    if (target.page) {
      $('quote-target').textContent = `${target.page.title} — in ${target.database.title}`;
      setStatus('Already clipped', 'ok');
    } else {
      $('quote-target').textContent =
        `Not clipped yet. The paper will be added to ${target.database.title} first, ` +
        'then the quote goes on its page.';
      $('quote-save-label').textContent = 'Clip page + save quote';
      setStatus('Not in Notion yet', '');
    }
  } catch (e) {
    $('quote-target').textContent = 'Could not check Notion.';
    setStatus('Lookup failed', 'warn');
    notice(e.message, 'error');
  }
}

async function saveQuote() {
  if (state.saving) return;
  const text = $('quote-text').value.trim();
  if (!text) {
    notice('There is nothing to quote — select some text on the page first.', 'warn');
    return;
  }

  state.saving = true;
  $('quote-save').disabled = true;
  const label = $('quote-save-label').textContent;
  $('quote-save-label').textContent = 'Saving…';
  setStatus('Saving to Notion…', 'busy');
  clearNotice();

  const found = state.quoteTarget && state.quoteTarget.page;
  try {
    const { page, created, heading } = await send('saveQuote', {
      tabId: state.tabId,
      text,
      section: state.selection.section,
      href: state.selection.href,
      pageId: found ? found.id : '',
      pageUrl: found ? found.url : '',
      pageTitle: found ? found.title : ''
    });
    showDone(created ? 'Clipped, with your quote' : `Quote added under ${heading}`, page.title, page.url);
  } catch (e) {
    setStatus('Save failed', 'warn');
    notice(e.message, 'error');
    $('quote-save-label').textContent = label;
  } finally {
    state.saving = false;
    $('quote-save').disabled = false;
  }
}

function showDone(heading, title, url) {
  $('done-heading').textContent = heading;
  $('done-title').textContent = title || '';
  $('open-page').dataset.url = url || '';
  showScreen('done');
}

/* ------------------------------------------------------------------ */
/* Page + BibTeX                                                       */
/* ------------------------------------------------------------------ */

async function loadPage() {
  if (state.tabId == null) {
    setStatus('No active tab', 'warn');
    return;
  }

  let scrape;
  try {
    scrape = await send('scrape', { tabId: state.tabId });
  } catch (e) {
    setStatus('Could not read page', 'warn');
    notice(e.message, 'error');
    return;
  }

  const meta = scrape.meta;
  state.meta = meta;

  setValue('title', meta.title);
  setValue('url', meta.url);
  setValue('doi', meta.doi);
  setValue('year', meta.year || '');
  setValue('authors', (meta.authors || []).join(', '));
  setValue('journal', meta.journal);
  renderDetailsHint();

  if (scrape.limited) {
    notice(
      'This page cannot be read directly (browser-restricted page or PDF viewer), so only the URL and title were captured.',
      'warn'
    );
  }

  await loadBibtex();
}

async function loadBibtex() {
  setStatus('Looking up BibTeX…', 'busy');
  $('bibtex-source').textContent = 'fetching…';

  const meta = {
    ...(state.meta || {}),
    doi: $('doi').value.trim() || (state.meta && state.meta.doi) || '',
    title: $('title').value.trim(),
    authors: splitAuthors($('authors').value)
  };

  try {
    const res = await send('bibtex', { meta });

    state.bibtexSource = res.source;
    state.citeKey = res.citeKey;
    state.entryType = res.entryType;

    setValue('bibtex', res.bibtex);
    if (res.doi) setValue('doi', res.doi);

    const e = res.enriched || {};
    setValue('title', e.title || meta.title);
    setValue('authors', (e.authors || []).join(', '));
    setValue('journal', e.journal || '');
    setValue('year', e.year || '');
    renderDetailsHint();

    $('bibtex-source').textContent = res.source;
    const resolved = res.source !== 'page metadata';
    setStatus(resolved ? `Matched via ${res.source}` : 'Built from page metadata', resolved ? 'ok' : '');
    if (!resolved) {
      $('bibtex-box').open = true;
    }
  } catch (e) {
    $('bibtex-source').textContent = 'failed';
    setStatus('BibTeX lookup failed', 'warn');
    notice(`BibTeX lookup failed: ${e.message}. You can paste an entry manually.`, 'warn');
    $('bibtex-box').open = true;
  }
}

const splitAuthors = (s) =>
  String(s || '')
    .split(/\s*[;,]\s*|\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean);

/* ------------------------------------------------------------------ */
/* Databases + mapping                                                 */
/* ------------------------------------------------------------------ */

function renderDatabases(selectedId) {
  const select = $('database');
  select.innerHTML = '';

  if (!state.databases.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No databases available';
    opt.value = '';
    select.append(opt);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const db of state.databases) {
    const opt = document.createElement('option');
    opt.value = db.id;
    opt.textContent = `${db.icon ? db.icon + ' ' : ''}${db.title}`;
    select.append(opt);
  }
  const exists = state.databases.some((d) => d.id === selectedId);
  select.value = exists ? selectedId : state.databases[0].id;
}

async function loadDatabase(databaseId) {
  if (!databaseId) return;
  $('mapping').textContent = 'Loading schema…';
  try {
    const { database, map } = await send('database', { databaseId });
    state.database = database;
    state.map = map;
    renderMapping();
  } catch (e) {
    $('mapping').textContent = '';
    notice(e.message, 'error');
  }
}

function renderMapping() {
  const container = $('mapping');
  container.innerHTML = '';
  if (!state.database) return;

  const props = listProperties(state.database);
  let mapped = 0;

  for (const field of CLIP_FIELDS) {
    const compatible = props.filter((p) => field.types.includes(p.type));
    const current = state.map[field.id];
    if (!compatible.length && !current) continue;

    const row = document.createElement('div');
    row.className = 'mt-2 grid grid-cols-[92px_1fr] items-center gap-2';

    const label = document.createElement('span');
    label.className = 'text-muted text-[11.5px]';
    label.textContent = field.label;

    const select = document.createElement('select');
    select.className = 'select py-[5px] pr-7 pl-2 text-[11.5px]';

    const skip = document.createElement('option');
    skip.value = '';
    skip.textContent = field.required ? '— required —' : '— skip —';
    select.append(skip);

    for (const p of compatible) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${p.name} (${p.type.replace('_', ' ')})`;
      select.append(opt);
    }

    select.value = current ? current.name : '';
    if (current) mapped++;

    select.addEventListener('change', () => {
      if (!select.value) {
        delete state.map[field.id];
      } else {
        const prop = props.find((p) => p.name === select.value);
        state.map[field.id] = { name: prop.name, type: prop.type };
      }
      renderMappingCount();
      validate();
    });

    row.append(label, select);
    container.append(row);
  }

  renderMappingCount(mapped);
  validate();
}

function renderMappingCount(count) {
  const n = count != null ? count : Object.keys(state.map).length;
  $('mapping-count').textContent = `${n} field${n === 1 ? '' : 's'}`;
}

function validate() {
  const hasTitle = Boolean(state.map.title);
  const saveBtn = $('save');
  saveBtn.disabled = state.saving || !hasTitle || !$('database').value;

  if (state.database && !hasTitle) {
    notice('This database has no title property mapped, so a page cannot be created.', 'error');
  }
  return hasTitle;
}

/* ------------------------------------------------------------------ */
/* Duplicates                                                          */
/* ------------------------------------------------------------------ */

async function checkDuplicate() {
  state.duplicate = null;
  const databaseId = $('database').value;
  if (!databaseId || !state.database) return;

  try {
    const { duplicate } = await send('checkDuplicate', {
      databaseId,
      doi: $('doi').value.trim(),
      url: $('url').value.trim(),
      map: state.map
    });
    if (duplicate) {
      state.duplicate = duplicate;
      notice('This paper looks like it is already in the database.', 'warn');
      $('save-label').textContent = 'Save anyway';
    }
  } catch {
    /* advisory only */
  }
}

/* ------------------------------------------------------------------ */
/* Save                                                                */
/* ------------------------------------------------------------------ */

function collectValues() {
  const year = $('year').value.trim();
  return {
    title: $('title').value.trim() || '(untitled)',
    url: $('url').value.trim(),
    doi: $('doi').value.trim(),
    bibtex: $('bibtex').value.trim(),
    authors: splitAuthors($('authors').value),
    year: year ? Number(year.replace(/\D/g, '')) || year : '',
    journal: $('journal').value.trim(),
    abstract: (state.meta && state.meta.abstract) || '',
    pdf: (state.meta && state.meta.pdfUrl) || '',
    entryType: state.entryType,
    citeKey: state.citeKey,
    clippedAt: new Date().toISOString()
  };
}

async function save() {
  if (!validate() || state.saving) return;

  state.saving = true;
  $('save').disabled = true;
  $('save-label').textContent = 'Saving…';
  setStatus('Saving to Notion…', 'busy');
  clearNotice();

  try {
    const { page } = await send('save', {
      databaseId: $('database').value,
      values: collectValues(),
      map: state.map
    });

    showDone('Saved to Notion', $('title').value.trim(), page.url);
  } catch (e) {
    setStatus('Save failed', 'warn');
    notice(e.message, 'error');
    $('save-label').textContent = 'Try again';
  } finally {
    state.saving = false;
    $('save').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

$('database').addEventListener('change', async () => {
  $('save-label').textContent = 'Save to Notion';
  clearNotice();
  await loadDatabase($('database').value);
  await checkDuplicate();
});

$('reload-dbs').addEventListener('click', async () => {
  const btn = $('reload-dbs');
  btn.classList.add('spin');
  try {
    const { databases } = await send('refreshDatabases', {});
    state.databases = databases;
    renderDatabases($('database').value);
    await loadDatabase($('database').value);
  } catch (e) {
    notice(e.message, 'error');
  } finally {
    btn.classList.remove('spin');
  }
});

$('refetch-bibtex').addEventListener('click', async () => {
  $('bibtex').dataset.dirty = '';
  await loadBibtex();
});

$('copy-bibtex').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('bibtex').value);
  const btn = $('copy-bibtex');
  btn.textContent = 'Copied';
  setTimeout(() => {
    btn.textContent = 'Copy';
  }, 1200);
});

$('save').addEventListener('click', save);
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('quote-save').addEventListener('click', saveQuote);

$('quote-clip').addEventListener('click', async () => {
  showScreen('clip');
  clearNotice();
  await loadClip();
});

$('open-page').addEventListener('click', (e) => {
  const url = e.currentTarget.dataset.url;
  if (url) chrome.tabs.create({ url });
  window.close();
});

$('clip-again').addEventListener('click', async () => {
  $('save-label').textContent = 'Save to Notion';
  showScreen('clip');
  await loadClip();
});

// Both screens carry a settings button and a notice toast.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-settings]')) chrome.runtime.openOptionsPage();
  if (e.target.closest('[data-notice-close]')) clearNotice();
});

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
  const screen = document.querySelector('[data-screen]:not([hidden])');
  if (screen && screen.dataset.screen === 'quote') saveQuote();
  else save();
});

boot();
