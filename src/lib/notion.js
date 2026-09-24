/** Minimal Notion REST client for the parts of the API this extension uses. */

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export class NotionError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'NotionError';
    this.status = status;
    this.code = code;
  }
}

async function request(token, path, { method = 'GET', body } = {}) {
  if (!token) throw new NotionError('No Notion token saved. Open the extension options to connect.');

  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new NotionError(`Could not reach Notion (${e.message}). Check your connection.`);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const code = data && data.code;
    throw new NotionError(friendlyError(res.status, code, data && data.message), {
      status: res.status,
      code
    });
  }
  return data;
}

function friendlyError(status, code, message) {
  if (status === 401) return 'Notion rejected the token. Re-copy the integration secret in options.';
  if (code === 'object_not_found' || status === 404) {
    return 'Notion cannot see that database. Open it in Notion → ••• → Connections → add your integration.';
  }
  if (code === 'validation_error') return `Notion rejected the data: ${message || 'validation error'}`;
  if (status === 429) return 'Rate limited by Notion. Wait a moment and try again.';
  if (status >= 500) return 'Notion is having trouble right now. Try again shortly.';
  return message || `Notion request failed (HTTP ${status}).`;
}

/** Databases the integration has been granted access to. */
export async function searchDatabases(token, query = '') {
  const body = {
    filter: { property: 'object', value: 'database' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 100
  };
  if (query) body.query = query;

  const data = await request(token, '/search', { method: 'POST', body });
  return (data.results || [])
    .filter((db) => !db.archived && !db.in_trash)
    .map((db) => ({
      id: db.id,
      title: plainTitle(db.title) || 'Untitled database',
      icon: iconOf(db.icon),
      url: db.url,
      properties: db.properties
    }));
}

export async function getDatabase(token, databaseId) {
  const db = await request(token, `/databases/${databaseId}`);
  return {
    id: db.id,
    title: plainTitle(db.title) || 'Untitled database',
    icon: iconOf(db.icon),
    url: db.url,
    properties: db.properties
  };
}

export async function getSelf(token) {
  const me = await request(token, '/users/me');
  return {
    name: (me.bot && me.bot.owner && me.bot.owner.user && me.bot.owner.user.name) || me.name || 'Integration',
    workspace: (me.bot && me.bot.workspace_name) || ''
  };
}

/** Find existing pages in the database whose DOI or URL property matches. */
export async function findDuplicate(token, databaseId, { doi, url, propertyMap }) {
  // Only text and url properties support an `equals` filter of this shape;
  // anything else would make Notion reject the whole query.
  const filterable = (prop) => prop && (prop.type === 'rich_text' || prop.type === 'url');

  const or = [];
  if (doi && filterable(propertyMap.doi)) or.push(textFilter(propertyMap.doi, doi));
  if (url && filterable(propertyMap.url)) or.push(textFilter(propertyMap.url, url));
  if (!or.length) return null;

  try {
    const data = await request(token, `/databases/${databaseId}/query`, {
      method: 'POST',
      body: { filter: or.length === 1 ? or[0] : { or }, page_size: 1 }
    });
    const hit = (data.results || [])[0];
    return hit ? { id: hit.id, url: hit.url } : null;
  } catch {
    // A duplicate check is a convenience; never block the clip on it.
    return null;
  }
}

function textFilter(prop, value) {
  const key = prop.type === 'url' ? 'url' : 'rich_text';
  return { property: prop.name, [key]: { equals: value } };
}

export async function createPage(token, { databaseId, properties, children, icon }) {
  const body = {
    parent: { database_id: databaseId },
    properties
  };
  if (children && children.length) body.children = children.slice(0, 100);
  if (icon) body.icon = { type: 'emoji', emoji: icon };

  const page = await request(token, '/pages', { method: 'POST', body });
  return { id: page.id, url: page.url };
}

function plainTitle(richText) {
  return (richText || [])
    .map((t) => t.plain_text || '')
    .join('')
    .trim();
}

function iconOf(icon) {
  if (!icon) return '';
  if (icon.type === 'emoji') return icon.emoji;
  return '';
}
