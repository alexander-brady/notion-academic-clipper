import { extractPageMetadata, extractSelection } from './lib/extract.js';
import { resolveBibtex, parseBibAuthors, normalizeDoi } from './lib/bib.js';
import {
  searchDatabases,
  getDatabase,
  createPage,
  findDuplicate,
  getSelf,
  listChildren,
  appendChildren,
  NotionError
} from './lib/notion.js';
import { autoMap, reconcileMap, buildProperties, buildChildren } from './lib/mapping.js';
import { normalizeQuote, quoteBlocks, quoteHeadingBlock, findQuoteAnchor } from './lib/quote.js';

const DEFAULT_PREFS = {
  includeAbstract: true,
  includeBibtexBlock: true,
  rewriteCiteKey: true,
  checkDuplicates: true,
  pageIcon: '📄',
  quoteHeading: 'Quotes',
  quoteCreatesPage: true
};

const QUOTE_MENU_ID = 'save-highlight';

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function getSettings() {
  const s = await chrome.storage.local.get(['token', 'lastDatabaseId', 'maps', 'prefs']);
  return {
    token: s.token || '',
    lastDatabaseId: s.lastDatabaseId || '',
    maps: s.maps || {},
    prefs: { ...DEFAULT_PREFS, ...(s.prefs || {}) }
  };
}

async function saveMapFor(databaseId, map) {
  const { maps } = await getSettings();
  maps[databaseId] = map;
  await chrome.storage.local.set({ maps, lastDatabaseId: databaseId });
}

/* ------------------------------------------------------------------ */
/* Page scraping                                                       */
/* ------------------------------------------------------------------ */

async function scrapeTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const fallback = {
    title: (tab.title || '').trim(),
    url: tab.url || '',
    doi: '',
    arxivId: '',
    pmid: '',
    authors: [],
    journal: '',
    year: null,
    abstract: '',
    pdfUrl: '',
    publisher: '',
    volume: '',
    issue: '',
    pages: '',
    siteName: ''
  };

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageMetadata
    });
    const meta = injection && injection.result;
    if (!meta) return { meta: fallback, limited: true };
    return { meta: { ...fallback, ...meta }, limited: false };
  } catch (e) {
    // chrome://, the Web Store, and the built-in PDF viewer cannot be scripted.
    // Fall back to the DOI in the URL, which is often all a PDF link carries.
    fallback.doi = normalizeDoi(decodeURIComponent(fallback.url));
    const arxiv = (fallback.url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i) || [])[1];
    if (arxiv) fallback.arxivId = arxiv.replace(/\.pdf$/i, '');
    // A PDF is usually read at a different URL from the page it was clipped
    // from, so the DOI is the only thing that can match the two up.
    if (!fallback.doi && fallback.arxivId) {
      fallback.doi = `10.48550/arXiv.${fallback.arxivId.replace(/v\d+$/i, '')}`;
    }
    return { meta: fallback, limited: true, reason: e.message };
  }
}

/**
 * The highlighted passage, and which section of the page it came from.
 * Chrome refuses to script its built-in PDF viewer, so this comes back empty
 * there and the right-click menu supplies the text instead.
 */
async function readSelection(tabId) {
  const empty = { text: '', section: '', href: '' };
  if (tabId == null) return empty;

  const run = async (target) => {
    const injections = await chrome.scripting.executeScript({ target, func: extractSelection });
    return injections.map((i) => i && i.result).filter(Boolean);
  };

  try {
    const top = await run({ tabId });
    if (top[0] && top[0].text.trim()) return { ...empty, ...top[0] };

    // Nothing in the top frame: the passage may be inside an embedded reader
    // or PDF frame. Frames this extension cannot touch are simply skipped.
    const frames = await run({ tabId, allFrames: true }).catch(() => []);
    const hit = frames.find((r) => r.text && r.text.trim());
    return { ...empty, ...(hit || top[0] || {}) };
  } catch (e) {
    console.warn('[clipper] could not read the selection', e);
    return empty;
  }
}

/* ------------------------------------------------------------------ */
/* Highlights                                                          */
/* ------------------------------------------------------------------ */

function mapFor(database, maps) {
  const saved = maps[database.id];
  return saved && Object.keys(saved).length ? reconcileMap(saved, database) : autoMap(database);
}

/**
 * The page this URL was already clipped to. The last-used database is checked
 * first and then a few others, so a highlight lands on the existing page
 * instead of creating a second one — without querying an entire workspace.
 */
async function findClippedPage(token, databases, maps, preferredId, { doi, url }) {
  const ordered = [...databases].sort((a, b) => (b.id === preferredId) - (a.id === preferredId));
  for (const db of ordered.slice(0, 5)) {
    const map = mapFor(db, maps);
    const hit = await findDuplicate(token, db.id, { doi, url, propertyMap: map });
    if (hit) return { page: hit, database: db, map };
  }
  return null;
}

/** Clip the paper so there is something to attach the highlight to. */
async function clipForQuote({ token, prefs, maps, database, meta }) {
  const map = mapFor(database, maps);
  if (!map.title) throw new Error(`"${database.title}" has no title property to write to.`);

  const bib = await resolveBibtex(meta, { rewriteKey: prefs.rewriteCiteKey }).catch(() => null);
  const parsed = (bib && bib.parsed) || {};
  const fields = parsed.fields || {};
  const bibAuthors = parseBibAuthors(fields.author);

  const values = {
    title: fields.title || meta.title || '(untitled)',
    url: meta.url,
    doi: (bib && bib.doi) || meta.doi || '',
    bibtex: (bib && bib.bibtex) || '',
    authors: bibAuthors.length ? bibAuthors : meta.authors || [],
    year: Number(fields.year) || meta.year || '',
    journal: fields.journal || fields.booktitle || meta.journal || '',
    abstract: (bib && bib.abstract) || meta.abstract || '',
    pdf: meta.pdfUrl || '',
    entryType: parsed.type || '',
    citeKey: parsed.key || '',
    clippedAt: new Date().toISOString()
  };

  const properties = buildProperties(values, map);
  if (!Object.keys(properties).length) {
    throw new Error('Nothing to save — no database property is mapped to a clipped field.');
  }

  const page = await createPage(token, {
    databaseId: database.id,
    properties,
    children: buildChildren(values, {
      includeAbstract: prefs.includeAbstract,
      includeBibtex: prefs.includeBibtexBlock
    }),
    icon: prefs.pageIcon
  });

  await saveMapFor(database.id, map);
  return { ...page, title: values.title };
}

/**
 * Find (or create) the paper's page, then append the passage under the quotes
 * heading. Shared by the popup, the context menu and the keyboard shortcut.
 */
async function addQuote({ tabId, text, section, href }) {
  const { token, lastDatabaseId, maps, prefs } = await getSettings();
  if (!token) throw new Error('Connect to Notion first — open the extension options.');

  const passage = normalizeQuote(text);
  if (!passage) throw new Error('Select some text on the page first.');

  const { meta } = await scrapeTab(tabId);
  const sourceUrl = href || meta.url;

  const databases = await searchDatabases(token);
  if (!databases.length) throw new Error('No database is shared with this connection yet.');

  const found = await findClippedPage(token, databases, maps, lastDatabaseId, {
    doi: meta.doi,
    url: meta.url
  });

  let target = found && found.page;
  let created = false;

  if (!target) {
    if (!prefs.quoteCreatesPage) {
      throw new Error('This paper is not in Notion yet. Clip the page first, then save the highlight.');
    }
    const database = databases.find((d) => d.id === lastDatabaseId) || databases[0];
    target = await clipForQuote({ token, prefs, maps, database, meta });
    created = true;
  }

  // A page that was just created has no quotes section yet, so one is added.
  const existing = created ? [] : await listChildren(token, target.id).catch(() => []);
  const anchor = findQuoteAnchor(existing, prefs.quoteHeading);

  const blocks = [
    ...(anchor.hasHeading ? [] : [quoteHeadingBlock(prefs.quoteHeading)]),
    ...quoteBlocks({ text: passage, url: sourceUrl, section })
  ];

  await appendChildren(token, target.id, blocks, anchor.after);
  return { page: target, created, heading: prefs.quoteHeading };
}

/* ------------------------------------------------------------------ */
/* Triggers that have no UI of their own                               */
/* ------------------------------------------------------------------ */

async function flashBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    // Best effort: the worker may be torn down before this runs, and the
    // badge is also cleared the next time the popup opens.
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 5000);
  } catch {
    /* the badge is cosmetic */
  }
}

/**
 * The context-menu and keyboard paths have nowhere to show a result, so the
 * outcome is badged and kept for the popup to report next time it opens.
 */
async function quoteFromTab(tab, info) {
  if (!tab || tab.id == null) return;
  try {
    const selection = await readSelection(tab.id);

    // Chrome refuses to run scripts in its built-in PDF viewer, so the passage
    // cannot be read from the document. The context-menu event carries the
    // selected text itself, which is the only way in on those pages.
    const menuText = (info && info.selectionText) || '';
    const text = selection.text.trim() || menuText;

    if (!text.trim()) {
      // Nothing worked, so record exactly which routes were tried: this is the
      // only visibility there is when the trigger has no window of its own.
      console.warn('[clipper] no selection available', {
        url: tab.url,
        fromPage: JSON.stringify(selection.text),
        fromMenu: JSON.stringify(menuText)
      });
      throw new Error('Chrome reported no selected text for this page. Select the passage, then try again.');
    }

    const result = await addQuote({
      tabId: tab.id,
      text,
      section: selection.section,
      href: selection.href || (info && info.pageUrl) || tab.url || ''
    });
    await chrome.storage.local.set({
      lastQuote: {
        ok: true,
        created: result.created,
        title: result.page.title || '',
        url: result.page.url || ''
      }
    });
    await flashBadge('✓', '#188038');
  } catch (e) {
    await chrome.storage.local.set({ lastQuote: { ok: false, error: e.message } });
    await flashBadge('!', '#d93025');
  }
}

/* ------------------------------------------------------------------ */
/* Message router                                                      */
/* ------------------------------------------------------------------ */

const handlers = {
  async init() {
    // Whatever the badge was reporting has now been delivered to the popup.
    const { lastQuote } = await chrome.storage.local.get('lastQuote');
    await chrome.storage.local.remove('lastQuote');
    chrome.action.setBadgeText({ text: '' }).catch(() => {});

    const { token, lastDatabaseId, prefs } = await getSettings();
    if (!token) return { connected: false, prefs, lastQuote: lastQuote || null };

    const [databases, self] = await Promise.all([searchDatabases(token), getSelf(token).catch(() => null)]);
    return { connected: true, databases, lastDatabaseId, prefs, self, lastQuote: lastQuote || null };
  },

  async refreshDatabases({ query }) {
    const { token } = await getSettings();
    return { databases: await searchDatabases(token, query || '') };
  },

  async scrape({ tabId }) {
    return scrapeTab(tabId);
  },

  /** Resolve the BibTeX entry and enrich the metadata with what it tells us. */
  async bibtex({ meta }) {
    const { prefs } = await getSettings();
    const result = await resolveBibtex(meta, { rewriteKey: prefs.rewriteCiteKey });

    const fields = (result.parsed && result.parsed.fields) || {};
    const bibAuthors = parseBibAuthors(fields.author);

    return {
      bibtex: result.bibtex,
      doi: result.doi || meta.doi || '',
      source: result.source,
      citeKey: (result.parsed && result.parsed.key) || '',
      entryType: (result.parsed && result.parsed.type) || '',
      // Prefer the registered record over page scraping, which often picks up
      // truncated author lists or the site name as the journal.
      enriched: {
        title: fields.title || meta.title,
        authors: bibAuthors.length ? bibAuthors : meta.authors,
        journal: fields.journal || fields.booktitle || meta.journal,
        year: Number(fields.year) || meta.year,
        volume: fields.volume || meta.volume,
        issue: fields.number || meta.issue,
        pages: fields.pages || meta.pages,
        publisher: fields.publisher || meta.publisher,
        abstract: result.abstract
      }
    };
  },

  /** Schema + property mapping for one database. */
  async database({ databaseId }) {
    const { token, maps } = await getSettings();
    const db = await getDatabase(token, databaseId);
    const saved = maps[databaseId];
    const map = saved && Object.keys(saved).length ? reconcileMap(saved, db) : autoMap(db);
    return { database: db, map };
  },

  async checkDuplicate({ databaseId, doi, url, map }) {
    const { token, prefs } = await getSettings();
    if (!prefs.checkDuplicates) return { duplicate: null };
    const duplicate = await findDuplicate(token, databaseId, { doi, url, propertyMap: map });
    return { duplicate };
  },

  async save({ databaseId, values, map, remember = true }) {
    const { token, prefs } = await getSettings();

    const properties = buildProperties(values, map);
    if (!Object.keys(properties).length) {
      throw new Error('Nothing to save — no database property is mapped to a clipped field.');
    }

    const children = buildChildren(values, {
      includeAbstract: prefs.includeAbstract,
      includeBibtex: prefs.includeBibtexBlock
    });

    const page = await createPage(token, {
      databaseId,
      properties,
      children,
      icon: prefs.pageIcon
    });

    if (remember) await saveMapFor(databaseId, map);
    return { page };
  },

  async savePrefs({ prefs }) {
    const current = await getSettings();
    await chrome.storage.local.set({ prefs: { ...current.prefs, ...prefs } });
    return { prefs: { ...current.prefs, ...prefs } };
  },

  async saveToken({ token }) {
    const trimmed = String(token || '').trim();
    if (!trimmed) {
      await chrome.storage.local.remove('token');
      return { connected: false };
    }
    // Validate before storing so a bad paste is caught in the options page.
    const self = await getSelf(trimmed);
    await chrome.storage.local.set({ token: trimmed });
    return { connected: true, self };
  },

  async disconnect() {
    await chrome.storage.local.remove(['token', 'lastDatabaseId', 'maps']);
    return { connected: false };
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown request: ${msg && msg.type}` });
    return false;
  }

  Promise.resolve(handler(msg.payload || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => {
      console.error(`[clipper] ${msg.type} failed`, e);
      sendResponse({
        ok: false,
        error: e instanceof NotionError ? e.message : e.message || String(e),
        code: e.code
      });
    });

  return true; // keep the message channel open for the async response
});

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function registerContextMenu() {
  // Menus do not survive a worker restart reliably, and onInstalled only fires
  // once, so this runs on every worker start. removeAll first, because
  // creating an id that already exists throws.
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      chrome.contextMenus.create(
        { id: QUOTE_MENU_ID, title: 'Save highlight to Notion', contexts: ['selection'] },
        () => void chrome.runtime.lastError
      );
    });
  } catch (e) {
    console.error('[clipper] could not create the context menu', e);
  }
}

registerContextMenu();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  registerContextMenu();
  if (reason === 'install') await chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(registerContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === QUOTE_MENU_ID) quoteFromTab(tab, info);
});
