import { CLIP_FIELDS, listProperties } from '../lib/mapping.js';

const $ = (id) => document.getElementById(id);

const state = {
  tabId: null,
  meta: null,
  database: null,
  databases: [],
  databaseId: '',
  map: {},
  bibtexSource: '',
  citeKey: '',
  entryType: '',
  duplicate: null,
  saving: false
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

function setStatus(text, kind = '') {
  $('source-line').textContent = text;
  $('status-dot').className = `size-[7px] flex-none rounded-full ${DOT[kind] ?? DOT['']}`;
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

  const el = $('notice');
  $('notice-text').textContent = message;
  el.className = `notice ${NOTICE[kind] ?? ''}`.trimEnd();
  el.hidden = false;
}

/** Only ever called from something the user did: the ×, or starting a save. */
function clearNotice() {
  pinned = '';
  $('notice-text').textContent = '';
  $('notice').hidden = true;
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
  // The clip screen ships unhidden in the markup, so the popup opens with its
  // full layout instead of painting an empty box and filling it in once Notion
  // answers.
  const tabQuery = chrome.tabs.query({ active: true, currentWindow: true });

  let init;
  try {
    init = await send('init');
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

  // Highlights are saved from the right-click menu, which has no window to
  // report into, so the outcome is shown here the next time the popup opens.
  const last = init.lastQuote;
  if (last && !last.ok) notice(`The last highlight was not saved: ${last.error}`, 'error');
  else if (last && last.ok) {
    notice(last.created ? 'Highlight saved to a newly clipped page.' : 'Highlight saved.', '');
  }

  if (!state.databases.length) {
    setStatus('No databases shared', 'warn');
    notice(
      'This connection cannot see any database yet. In Notion, open the database → ••• → Connections → add your connection.',
      'warn'
    );
  }

  setStatus('Reading page…', 'busy');
  // Scrape and load the database schema at the same time.
  const schemaLoad = loadDatabase(state.databaseId);
  await loadPage();
  await schemaLoad;
  await checkDuplicate();
}

function showDone(title, url) {
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
    if (state.meta && e.abstract) state.meta.abstract = e.abstract;
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
  const list = $('db-list');
  list.replaceChildren();

  if (!state.databases.length) {
    state.databaseId = '';
    renderSaveLabel();
    return;
  }

  const exists = state.databases.some((d) => d.id === selectedId);
  state.databaseId = exists ? selectedId : state.databases[0].id;

  for (const db of state.databases) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    item.dataset.id = db.id;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(db.id === state.databaseId));
    item.textContent = `${db.icon ? db.icon + ' ' : ''}${db.title}`;
    item.addEventListener('click', () => chooseDatabase(db.id));
    list.append(item);
  }
  renderSaveLabel();
}

/** The button states where the clip is going, so the choice needs no label. */
function renderSaveLabel() {
  const db = state.databases.find((d) => d.id === state.databaseId);
  if (!db) {
    $('save-label').textContent = state.databases.length ? 'Save to Notion' : 'No database available';
    return;
  }
  $('save-label').textContent = state.duplicate ? `Save anyway to ${db.title}` : `Save to ${db.title}`;
}

function toggleMenu(open) {
  const menu = $('db-menu');
  const next = open === undefined ? menu.hidden : open;
  menu.hidden = !next;
  $('db-toggle').setAttribute('aria-expanded', String(next));
}

async function chooseDatabase(id) {
  toggleMenu(false);
  if (id === state.databaseId) return;

  state.databaseId = id;
  state.duplicate = null;
  for (const item of $('db-list').children) {
    item.setAttribute('aria-checked', String(item.dataset.id === id));
  }
  renderSaveLabel();
  clearNotice();
  await loadDatabase(id);
  await checkDuplicate();
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
  saveBtn.disabled = state.saving || !hasTitle || !state.databaseId;

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
  const databaseId = state.databaseId;
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
      renderSaveLabel();
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
      databaseId: state.databaseId,
      values: collectValues(),
      map: state.map
    });

    showDone($('title').value.trim(), page.url);
  } catch (e) {
    setStatus('Save failed', 'warn');
    notice(e.message, 'error');
    renderSaveLabel();
  } finally {
    state.saving = false;
    $('save').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

$('db-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});

$('reload-dbs').addEventListener('click', async (e) => {
  e.stopPropagation();
  const btn = $('reload-dbs');
  btn.disabled = true;
  btn.textContent = 'Reloading…';
  try {
    const { databases } = await send('refreshDatabases', {});
    state.databases = databases;
    renderDatabases(state.databaseId);
    await loadDatabase(state.databaseId);
  } catch (err) {
    notice(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reload databases';
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

$('open-page').addEventListener('click', (e) => {
  const url = e.currentTarget.dataset.url;
  if (url) chrome.tabs.create({ url });
  window.close();
});

$('clip-again').addEventListener('click', () => {
  state.duplicate = null;
  renderSaveLabel();
  showScreen('clip');
});

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('notice-close').addEventListener('click', clearNotice);

// Dismiss the database menu the way menus are normally dismissed.
document.addEventListener('click', (e) => {
  if (!$('db-menu').hidden && !e.target.closest('#db-menu')) toggleMenu(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('db-menu').hidden) return toggleMenu(false);
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
});

boot();
