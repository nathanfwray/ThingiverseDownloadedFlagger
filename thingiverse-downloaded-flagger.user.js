// ==UserScript==
// @name         Thingiverse Downloaded Flagger
// @namespace    https://github.com/nathanfwray/ThingiverseDownloadedFlagger
// @version      0.2.0
// @description  Flags Thingiverse things you've already downloaded by matching thing IDs against a local folder (File System Access API). Phase 1 skeleton.
// @author       Nate
// @match        https://www.thingiverse.com/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants & configuration
  // ---------------------------------------------------------------------------
  const NS = 'tdf'; // namespace prefix for DOM/CSS/storage
  const DB_NAME = 'tdf-db';
  const DB_VERSION = 1;
  const STORE_KV = 'kv';          // directory handle + small blobs
  const STORE_INDEX = 'idIndex';  // single record: { ids, builtAt, fileCount }
  const HANDLE_KEY = 'rootHandle';
  const INDEX_KEY = 'main';

  const DEFAULT_SETTINGS = {
    enabled: true,
    // Numeric ID, 5-9 digits, optionally prefixed by thing / : / _ / -
    filenamePattern: '(?:thing[:_-]?)?(\\d{5,9})',
    matchFolderNames: false,
    badgeText: 'DOWNLOADED',
    scanConcurrency: 8,
  };

  // In-memory state for the current page.
  const state = {
    settings: loadSettings(),
    ids: new Set(),     // Set<string> of downloaded thing IDs
    indexMeta: null,    // { builtAt, fileCount }
    scanning: false,
  };

  // ---------------------------------------------------------------------------
  // Settings (GM storage)
  // ---------------------------------------------------------------------------
  function loadSettings() {
    const saved = GM_getValue('settings', null);
    return Object.assign({}, DEFAULT_SETTINGS, saved || {});
  }
  function saveSettings() {
    GM_setValue('settings', state.settings);
  }

  // ---------------------------------------------------------------------------
  // IndexedDB layer (handle + index live here; handles can't go in GM storage)
  // ---------------------------------------------------------------------------
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
        if (!db.objectStoreNames.contains(STORE_INDEX)) db.createObjectStore(STORE_INDEX);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(store, key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------------------------------------------------------------------------
  // Folder handle + permissions
  // ---------------------------------------------------------------------------
  async function getStoredHandle() {
    try {
      return (await idbGet(STORE_KV, HANDLE_KEY)) || null;
    } catch (e) {
      console.warn('[TDF] could not read stored handle', e);
      return null;
    }
  }

  async function pickFolder() {
    if (!window.showDirectoryPicker) {
      alert('Your browser does not support the File System Access API.');
      return null;
    }
    const handle = await window.showDirectoryPicker({ id: 'tdf-root', mode: 'read' });
    await idbPut(STORE_KV, HANDLE_KEY, handle);
    return handle;
  }

  // Returns 'granted' | 'prompt' | 'denied' | 'none'
  async function checkPermission(handle, requestIfNeeded = false) {
    if (!handle) return 'none';
    const opts = { mode: 'read' };
    let status = await handle.queryPermission(opts);
    if (status !== 'granted' && requestIfNeeded) {
      status = await handle.requestPermission(opts); // needs a user gesture
    }
    return status;
  }

  // Human-readable label + color for a permission status.
  function describePermission(status) {
    switch (status) {
      case 'granted': return { text: 'Connected', color: '#2e7d32' };
      case 'prompt':  return { text: 'Needs reconnect', color: '#ef6c00' };
      case 'denied':  return { text: 'Access denied', color: '#c62828' };
      default:        return { text: 'No folder chosen', color: '#999' };
    }
  }

  // ---------------------------------------------------------------------------
  // Scanner: recursive, NAME-ONLY walk (never opens files)
  // ---------------------------------------------------------------------------
  function buildRegex() {
    try {
      return new RegExp(state.settings.filenamePattern, 'g');
    } catch (e) {
      console.warn('[TDF] invalid filename pattern, using default', e);
      return new RegExp(DEFAULT_SETTINGS.filenamePattern, 'g');
    }
  }

  function extractIds(name, re, out) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(name)) !== null) {
      if (m[1]) out.add(m[1]);
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
    }
  }

  // Concurrency-bounded recursive walk. Reads entry.name only.
  async function scanFolder(rootHandle, onProgress) {
    const re = buildRegex();
    const ids = new Set();
    let fileCount = 0;

    const limit = Math.max(1, state.settings.scanConcurrency | 0);
    const queue = [rootHandle];
    let active = 0;

    async function walk(dirHandle) {
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') {
          fileCount++;
          extractIds(entry.name, re, ids);
          if (fileCount % 500 === 0 && onProgress) {
            onProgress({ fileCount, idCount: ids.size });
          }
        } else if (entry.kind === 'directory') {
          if (state.settings.matchFolderNames) extractIds(entry.name, re, ids);
          queue.push(entry);
        }
      }
    }

    // Simple worker pool over the queue.
    await new Promise((resolve, reject) => {
      const pump = () => {
        if (queue.length === 0 && active === 0) return resolve();
        while (active < limit && queue.length > 0) {
          const dir = queue.shift();
          active++;
          walk(dir)
            .catch(reject)
            .finally(() => { active--; pump(); });
        }
      };
      pump();
    });

    if (onProgress) onProgress({ fileCount, idCount: ids.size });
    return { ids, fileCount };
  }

  async function runScan(onProgress) {
    if (state.scanning) return;
    state.scanning = true;
    try {
      const handle = await getStoredHandle();
      if (!handle) { alert('Choose a folder first.'); return; }
      const status = await checkPermission(handle, true);
      if (status !== 'granted') { alert('Folder permission was not granted.'); return; }

      const { ids, fileCount } = await scanFolder(handle, onProgress);
      const record = { ids: Array.from(ids), builtAt: Date.now(), fileCount };
      await idbPut(STORE_INDEX, INDEX_KEY, record);

      state.ids = ids;
      state.indexMeta = { builtAt: record.builtAt, fileCount };
      decoratePage(); // refresh badges with new data
    } finally {
      state.scanning = false;
    }
  }

  async function hydrateIndex() {
    const record = await idbGet(STORE_INDEX, INDEX_KEY);
    if (record && Array.isArray(record.ids)) {
      state.ids = new Set(record.ids);
      state.indexMeta = { builtAt: record.builtAt, fileCount: record.fileCount };
    }
  }

  // ---------------------------------------------------------------------------
  // Page decoration
  // ---------------------------------------------------------------------------
  const THING_HREF_RE = /\/thing:(\d+)/;
  const CHECKED_ATTR = `data-${NS}-checked`;

  function injectStyles() {
    if (document.getElementById(`${NS}-styles`)) return;
    const css = `
      .${NS}-badge {
        display: inline-block;
        background: #1e88e5;
        color: #fff;
        font: 700 10px/1.4 system-ui, sans-serif;
        letter-spacing: .04em;
        padding: 2px 6px;
        border-radius: 4px;
        margin-left: 6px;
        vertical-align: middle;
        z-index: 9999;
      }
      .${NS}-card-badge {
        position: absolute;
        top: 6px;
        left: 6px;
        background: #1e88e5;
        color: #fff;
        font: 700 10px/1.4 system-ui, sans-serif;
        padding: 2px 6px;
        border-radius: 4px;
        pointer-events: none;
        z-index: 9999;
      }`;
    const el = document.createElement('style');
    el.id = `${NS}-styles`;
    el.textContent = css;
    document.head.appendChild(el);
  }

  function makeBadge(cls) {
    const b = document.createElement('span');
    b.className = cls;
    b.textContent = state.settings.badgeText;
    return b;
  }

  // Flag the standalone thing page (URL holds the ID).
  function decorateThingPage() {
    const m = location.pathname.match(THING_HREF_RE);
    if (!m) return;
    if (!state.ids.has(m[1])) return;
    const title = document.querySelector('h1');
    if (title && !title.querySelector(`.${NS}-badge`)) {
      title.appendChild(makeBadge(`${NS}-badge`));
    }
  }

  // Flag listing/search/grid cards via their /thing:<id> links.
  function decorateCards(root = document) {
    const links = root.querySelectorAll(`a[href*="/thing:"]:not([${CHECKED_ATTR}])`);
    // Read phase
    const toBadge = [];
    links.forEach((a) => {
      a.setAttribute(CHECKED_ATTR, '1');
      const m = a.getAttribute('href').match(THING_HREF_RE);
      if (m && state.ids.has(m[1])) toBadge.push(a);
    });
    // Write phase
    toBadge.forEach((a) => {
      const card = a.closest('div') || a;
      const cs = getComputedStyle(card);
      if (cs.position === 'static') card.style.position = 'relative';
      if (!card.querySelector(`.${NS}-card-badge`)) {
        card.appendChild(makeBadge(`${NS}-card-badge`));
      }
    });
  }

  function decoratePage() {
    if (!state.settings.enabled || state.ids.size === 0) return;
    injectStyles();
    decorateThingPage();
    decorateCards(document);
  }

  // Debounced observer for lazy-loaded / infinite-scroll content.
  let debounceTimer = null;
  function startObserver() {
    const obs = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (window.requestIdleCallback) {
          requestIdleCallback(() => decoratePage());
        } else {
          decoratePage();
        }
      }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Re-run on SPA / soft navigations.
  function watchNavigation() {
    let last = location.href;
    const check = () => {
      if (location.href !== last) {
        last = location.href;
        document.querySelectorAll(`[${CHECKED_ATTR}]`).forEach((n) =>
          n.removeAttribute(CHECKED_ATTR));
        decoratePage();
      }
    };
    setInterval(check, 500);
    window.addEventListener('popstate', check);
  }

  // ---------------------------------------------------------------------------
  // Settings UI (modal injected into the page)
  // ---------------------------------------------------------------------------
  function openSettings() {
    if (document.getElementById(`${NS}-modal`)) return;
    injectStyles();

    const overlay = document.createElement('div');
    overlay.id = `${NS}-modal`;
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,.5)',
      zIndex: '100000', display: 'flex', alignItems: 'center',
      justifyContent: 'center', font: '14px system-ui, sans-serif',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#fff', color: '#111', width: '460px', maxWidth: '92vw',
      borderRadius: '10px', padding: '20px', boxShadow: '0 10px 40px rgba(0,0,0,.3)',
    });

    const s = state.settings;
    const meta = state.indexMeta;
    const metaLine = meta
      ? `${meta.fileCount} files scanned, ${state.ids.size} IDs indexed (${new Date(meta.builtAt).toLocaleString()})`
      : 'No index yet — choose a folder and rescan.';

    panel.innerHTML = `
      <h2 style="margin:0 0 12px;font-size:16px;">Thingiverse Downloaded Flagger</h2>
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <input type="checkbox" id="${NS}-enabled" ${s.enabled ? 'checked' : ''}/>
        Enable flagging
      </label>
      <div style="margin-bottom:6px;">
        <button id="${NS}-pick" type="button">Choose folder…</button>
        <button id="${NS}-reconnect" type="button">Reconnect folder</button>
        <span id="${NS}-folder" style="margin-left:8px;color:#555;"></span>
      </div>
      <div style="margin-bottom:10px;display:flex;align-items:center;gap:6px;">
        <span id="${NS}-perm-dot" style="width:9px;height:9px;border-radius:50%;background:#999;display:inline-block;"></span>
        <span id="${NS}-perm" style="color:#555;">Checking access…</span>
      </div>
      <label style="display:block;margin-bottom:4px;">Filename ID pattern (regex)</label>
      <input id="${NS}-pattern" value="${escapeHtml(s.filenamePattern)}"
             style="width:100%;box-sizing:border-box;margin-bottom:4px;"/>
      <div style="margin-bottom:10px;">
        <input id="${NS}-test" placeholder="Paste a sample filename to test…"
               style="width:100%;box-sizing:border-box;"/>
        <small id="${NS}-test-out" style="color:#555;"></small>
      </div>
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <input type="checkbox" id="${NS}-folders" ${s.matchFolderNames ? 'checked' : ''}/>
        Also match IDs in folder names
      </label>
      <label style="display:block;margin-bottom:4px;">Badge text</label>
      <input id="${NS}-badge" value="${escapeHtml(s.badgeText)}"
             style="width:100%;box-sizing:border-box;margin-bottom:12px;"/>
      <div id="${NS}-status" style="color:#555;margin-bottom:12px;">${escapeHtml(metaLine)}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="${NS}-rescan" type="button">Rescan now</button>
        <button id="${NS}-save" type="button">Save</button>
        <button id="${NS}-close" type="button">Close</button>
      </div>`;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const $ = (id) => panel.querySelector(`#${NS}-${id}`);
    const status = $('status');

    // Reflect a permission status in the dot + label.
    function renderPermission(status) {
      const d = describePermission(status);
      $('perm').textContent = d.text;
      $('perm').style.color = d.color;
      $('perm-dot').style.background = d.color;
      // The reconnect button only matters when a re-grant can help.
      $('reconnect').style.display = (status === 'prompt' || status === 'denied') ? '' : 'none';
    }

    // Show current folder name + current permission (query only, no prompt).
    async function refreshFolderStatus() {
      const h = await getStoredHandle();
      if (h) $('folder').textContent = h.name;
      renderPermission(await checkPermission(h, false));
    }
    refreshFolderStatus();

    // Live regex tester.
    const runTest = () => {
      const out = $('test-out');
      try {
        const re = new RegExp($('pattern').value, 'g');
        const found = new Set();
        let m;
        while ((m = re.exec($('test').value)) !== null) {
          if (m[1]) found.add(m[1]);
          if (m.index === re.lastIndex) re.lastIndex++;
        }
        out.textContent = found.size ? `Matched: ${[...found].join(', ')}` : 'No match';
        out.style.color = found.size ? '#2e7d32' : '#999';
      } catch (e) {
        out.textContent = 'Invalid regex';
        out.style.color = '#c62828';
      }
    };
    $('pattern').addEventListener('input', runTest);
    $('test').addEventListener('input', runTest);

    $('pick').addEventListener('click', async () => {
      try {
        const h = await pickFolder();
        if (h) {
          $('folder').textContent = h.name;
          renderPermission(await checkPermission(h, false));
        }
      } catch (e) { /* user cancelled */ }
    });

    // Re-grant read access for the already-chosen folder (needs this click).
    $('reconnect').addEventListener('click', async () => {
      const h = await getStoredHandle();
      if (!h) { alert('Choose a folder first.'); return; }
      renderPermission(await checkPermission(h, true));
    });

    $('rescan').addEventListener('click', async () => {
      // Persist current settings first so the scan uses them.
      applyFormToSettings($);
      status.textContent = 'Scanning…';
      await runScan((p) => { status.textContent = `Scanning… ${p.fileCount} files, ${p.idCount} IDs`; });
      refreshFolderStatus();
      const m = state.indexMeta;
      status.textContent = m
        ? `Done: ${m.fileCount} files, ${state.ids.size} IDs (${new Date(m.builtAt).toLocaleString()})`
        : 'Scan finished.';
    });

    $('save').addEventListener('click', () => {
      applyFormToSettings($);
      decoratePage();
      close();
    });
    $('close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    function close() { overlay.remove(); }
  }

  function applyFormToSettings($) {
    state.settings.enabled = $('enabled').checked;
    state.settings.filenamePattern = $('pattern').value || DEFAULT_SETTINGS.filenamePattern;
    state.settings.matchFolderNames = $('folders').checked;
    state.settings.badgeText = $('badge').value || DEFAULT_SETTINGS.badgeText;
    saveSettings();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  GM_registerMenuCommand('Thingiverse Downloads — Settings', openSettings);

  (async function init() {
    await hydrateIndex();      // one IndexedDB read, builds in-memory Set
    decoratePage();            // flag what's already on the page
    startObserver();           // catch lazy-loaded cards
    watchNavigation();         // re-run on soft navigations
  })();
})();
