import { extractPageMetadata } from './lib/extract.js';
import { resolveBibtex, parseBibAuthors, normalizeDoi } from './lib/bib.js';
import {
  searchDatabases,
  getDatabase,
  createPage,
  findDuplicate,
  getSelf,
  NotionError
} from './lib/notion.js';
import { autoMap, reconcileMap, buildProperties, buildChildren } from './lib/mapping.js';

const DEFAULT_PREFS = {
  includeAbstract: true,
  includeBibtexBlock: true,
  rewriteCiteKey: true,
  checkDuplicates: true,
  pageIcon: '📄'
};

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
    return { meta: fallback, limited: true, reason: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* Message router                                                      */
/* ------------------------------------------------------------------ */

const handlers = {
  async init() {
    const { token, lastDatabaseId, prefs } = await getSettings();
    if (!token) return { connected: false, prefs };

    const [databases, self] = await Promise.all([searchDatabases(token), getSelf(token).catch(() => null)]);
    return { connected: true, databases, lastDatabaseId, prefs, self };
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
        publisher: fields.publisher || meta.publisher
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

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await chrome.runtime.openOptionsPage();
});
