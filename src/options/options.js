const $ = (id) => document.getElementById(id);

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

// Written out in full so Tailwind's scanner can see the class names.
const STATUS = {
  '': 'text-muted',
  ok: 'text-ok',
  error: 'text-danger'
};

function setStatus(el, message, kind = '') {
  el.textContent = message;
  el.className = `status ${STATUS[kind] ?? STATUS['']}`;
}

/* ------------------------------------------------------------------ */
/* Token                                                               */
/* ------------------------------------------------------------------ */

$('toggle-token').addEventListener('click', () => {
  const input = $('token');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  $('toggle-token').textContent = hidden ? 'Hide' : 'Show';
});

$('connect').addEventListener('click', async () => {
  const token = $('token').value.trim();
  const el = $('token-status');

  if (!token) {
    setStatus(el, 'Paste your API key first.', 'error');
    return;
  }

  $('connect').disabled = true;
  setStatus(el, 'Checking…');
  try {
    const { self } = await send('saveToken', { token });
    const where = self && self.workspace ? ` in ${self.workspace}` : '';
    setStatus(el, `Connected as ${self ? self.name : 'this connection'}${where}.`, 'ok');
    $('token').value = '';
    $('token').placeholder = '•••••••• saved';
    await listDatabases();
  } catch (e) {
    setStatus(el, e.message, 'error');
  } finally {
    $('connect').disabled = false;
  }
});

$('disconnect').addEventListener('click', async () => {
  await send('disconnect');
  $('token').value = '';
  $('token').placeholder = 'ntn_...';
  $('db-list').innerHTML = '';
  setStatus($('token-status'), 'Disconnected.', '');
});

/* ------------------------------------------------------------------ */
/* Databases                                                           */
/* ------------------------------------------------------------------ */

const ROW = 'border-line flex justify-between gap-3 border-t py-2 text-[13px]';

function listRow(text, muted = false) {
  const li = document.createElement('li');
  li.className = muted ? `${ROW} text-muted` : ROW;
  li.textContent = text;
  return li;
}

async function listDatabases() {
  const list = $('db-list');
  list.replaceChildren(listRow('Checking…', true));
  try {
    const { databases } = await send('refreshDatabases', {});

    if (!databases.length) {
      list.replaceChildren(listRow('No databases shared with this connection yet.', true));
      return;
    }

    list.replaceChildren(
      ...databases.map((db) => {
        const li = document.createElement('li');
        li.className = ROW;
        const name = document.createElement('span');
        name.textContent = `${db.icon ? db.icon + ' ' : ''}${db.title}`;
        const count = document.createElement('span');
        count.className = 'text-muted text-xs whitespace-nowrap';
        count.textContent = `${Object.keys(db.properties || {}).length} properties`;
        li.append(name, count);
        return li;
      })
    );
  } catch (e) {
    list.replaceChildren(listRow(e.message, true));
  }
}

$('refresh').addEventListener('click', listDatabases);

/* ------------------------------------------------------------------ */
/* Preferences                                                         */
/* ------------------------------------------------------------------ */

const PREF_INPUTS = {
  includeAbstract: 'pref-abstract',
  includeBibtexBlock: 'pref-bibtex-block',
  rewriteCiteKey: 'pref-citekey',
  checkDuplicates: 'pref-duplicates',
  quoteCreatesPage: 'pref-quote-clips'
};

async function persistPrefs() {
  const prefs = {};
  for (const [key, id] of Object.entries(PREF_INPUTS)) prefs[key] = $(id).checked;
  prefs.pageIcon = $('pref-icon').value.trim();
  prefs.quoteHeading = $('pref-quote-heading').value.trim() || 'Quotes';
  await send('savePrefs', { prefs });
  setStatus($('prefs-status'), 'Saved.', 'ok');
  setTimeout(() => setStatus($('prefs-status'), ''), 1500);
}

for (const id of [...Object.values(PREF_INPUTS), 'pref-icon', 'pref-quote-heading']) {
  $(id).addEventListener('change', persistPrefs);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

(async function boot() {
  const init = await send('init').catch(() => null);
  if (!init) return;

  const prefs = init.prefs || {};
  for (const [key, id] of Object.entries(PREF_INPUTS)) $(id).checked = prefs[key] !== false;
  $('pref-icon').value = prefs.pageIcon || '';
  $('pref-quote-heading').value = prefs.quoteHeading || 'Quotes';

  if (init.connected) {
    $('token').placeholder = '•••••••• saved';
    const where = init.self && init.self.workspace ? ` in ${init.self.workspace}` : '';
    setStatus(
      $('token-status'),
      `Connected as ${init.self ? init.self.name : 'this connection'}${where}.`,
      'ok'
    );
    await listDatabases();
  }
})();
