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

const NOTICE = {
  '': 'border-line bg-sunken text-muted',
  error: 'border-danger text-danger bg-transparent',
  warn: 'border-warn text-warn bg-transparent'
};

function notice(message, kind = '') {
  const el = $('notice');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = `rounded-control border px-2.5 py-2 text-xs ${NOTICE[kind] ?? NOTICE['']}`;
  el.textContent = message;
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
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  let init;
  try {
    init = await send('init');
  } catch (e) {
    showScreen('clip');
    setStatus('Connection problem', 'warn');
    notice(e.message, 'error');
    return;
  }

  if (!init.connected) {
    showScreen('setup');
    return;
  }

  showScreen('clip');
  setStatus('Reading page…', 'busy');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab && tab.id;

  state.databases = init.databases || [];
  renderDatabases(init.lastDatabaseId);

  if (!state.databases.length) {
    setStatus('No databases shared', 'warn');
    notice(
      'This integration cannot see any database yet. In Notion, open the database → ••• → Connections → add your integration.',
      'warn'
    );
  }

  // Scrape and load the database schema at the same time.
  const schemaLoad = loadDatabase($('database').value);
  await loadPage();
  await schemaLoad;
  await checkDuplicate();
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
    row.className = 'mt-1.5 grid grid-cols-[96px_1fr] items-center gap-2';

    const label = document.createElement('span');
    label.className = 'text-muted text-xs';
    label.textContent = field.label;

    const select = document.createElement('select');
    select.className = 'input cursor-pointer px-1.5 py-[5px] text-xs';

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
  notice('');

  try {
    const { page } = await send('save', {
      databaseId: $('database').value,
      values: collectValues(),
      map: state.map
    });

    $('done-title').textContent = $('title').value.trim();
    $('open-page').dataset.url = page.url;
    showScreen('done');
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
  notice('');
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
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('open-page').addEventListener('click', (e) => {
  const url = e.currentTarget.dataset.url;
  if (url) chrome.tabs.create({ url });
  window.close();
});

$('clip-again').addEventListener('click', () => {
  $('save-label').textContent = 'Save to Notion';
  showScreen('clip');
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
});

boot();
