// ==UserScript==
// @name         Thingiverse Downloaded Flagger
// @namespace    https://github.com/nathanfwray/ThingiverseDownloadedFlagger
// @version      0.6.0
// @description  Flags Thingiverse things you've already downloaded by matching thing IDs in a local folder (File System Access API) — from file names and from the thing URL inside README.txt. Web Worker scan, change reporting, optional auto-rescan, customizable badges.
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
  const DB_VERSION = 2;
  const STORE_KV = 'kv';             // directory handle + small blobs
  const STORE_INDEX = 'idIndex';     // single record: { ids, builtAt, fileCount }
  const STORE_MANIFEST = 'manifest'; // single record: { entries:[{p,i:[ids]}], builtAt } — names-only, for phase 6
  const HANDLE_KEY = 'rootHandle';
  const INDEX_KEY = 'main';
  const MANIFEST_KEY = 'main';

  // Standard Thingiverse downloads keep the thing ID only inside README.txt
  // (e.g. "... on Thingiverse: https://www.thingiverse.com/thing:4570091"),
  // not in the file names. These drive the opt-in README content scan.
  const README_NAME = 'README.txt';                       // matched case-insensitively
  const README_PATTERN = 'thingiverse\\.com/thing:(\\d+)'; // capture group 1 = thing ID

  const DEFAULT_SETTINGS = {
    enabled: true,
    // Numeric ID, 5-9 digits, optionally prefixed by thing / : / _ / -
    filenamePattern: '(?:thing[:_-]?)?(\\d{5,9})',
    matchFolderNames: false,
    scanReadme: true,     // open README.txt files and read the thing: URL inside
    badgeText: 'DOWNLOADED',
    badgeColor: '#1e88e5',
    badgeCorner: 'tl',    // card-badge corner: 'tl' | 'tr' | 'bl' | 'br'
    scanConcurrency: 8,
    autoRescan: 'off',    // 'off' | 'focus' | 'interval'
    autoRescanHours: 6,   // cooldown window for 'interval' (and gate for 'focus')
  };

  // In-memory state for the current page.
  const state = {
    settings: loadSettings(),
    ids: new Set(),       // Set<string> of downloaded thing IDs
    indexMeta: null,      // { builtAt, fileCount }
    scanning: false,
    worker: null,         // active scan Worker, if any
    abortCurrent: null,   // settles the in-flight scan promise when cancelled
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
        if (!db.objectStoreNames.contains(STORE_MANIFEST)) db.createObjectStore(STORE_MANIFEST);
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
  // Scanner: recursive, NAME-ONLY walk, run in a Web Worker (phase 5)
  // ---------------------------------------------------------------------------
  // The recursive walk runs in a Blob-URL Worker so a large tree never freezes
  // the page the user is browsing. The directory handle is structured-cloned
  // into the worker; read permission is granted on the MAIN thread first
  // (requestPermission needs a user gesture and is main-thread only).
  // Fast path: most entries are read by NAME only (no getFile()). The one
  // exception is README.txt — standard Thingiverse downloads store the thing ID
  // only inside it — so when scanReadme is on we open just those small files and
  // pull the ID from the thingiverse.com/thing:<id> URL.
  const WORKER_SRC = `
    'use strict';
    let aborted = false;

    self.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'abort') { aborted = true; return; }
      if (msg.type === 'start') {
        run(msg.rootHandle, msg.settings).catch((err) => {
          const name = (err && err.name) ? err.name + ': ' : '';
          self.postMessage({ type: 'error', message: name + String((err && err.message) || err) });
        });
      }
    };

    function buildRegex(pattern, fallback) {
      try { return new RegExp(pattern, 'g'); }
      catch (e) { return new RegExp(fallback, 'g'); }
    }

    function extractIds(name, re, out) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(name)) !== null) {
        if (m[1]) out.push(m[1]);
        if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
      }
    }

    async function run(rootHandle, settings) {
      const re = buildRegex(settings.filenamePattern, settings.fallbackPattern);
      const readmeRe = settings.scanReadme ? new RegExp(settings.readmePattern, 'gi') : null;
      const readmeName = (settings.readmeName || '').toLowerCase();
      const ids = new Set();
      const manifest = [];           // [{ p: path, i: [ids] }]
      let fileCount = 0;

      const limit = Math.max(1, settings.scanConcurrency | 0);
      const queue = [{ handle: rootHandle, path: '' }];
      let active = 0;

      async function walk(node) {
        for await (const entry of node.handle.values()) {
          if (aborted) return;
          const path = node.path ? node.path + '/' + entry.name : entry.name;
          if (entry.kind === 'file') {
            fileCount++;
            const found = [];
            extractIds(entry.name, re, found);
            // Standard Thingiverse layout: ID lives inside README.txt, not the
            // file names. Open just those (small) files to recover it.
            if (readmeRe && entry.name.toLowerCase() === readmeName) {
              try {
                const text = await (await entry.getFile()).text();
                readmeRe.lastIndex = 0;
                let rm;
                while ((rm = readmeRe.exec(text)) !== null) {
                  if (rm[1]) found.push(rm[1]);
                  if (rm.index === readmeRe.lastIndex) readmeRe.lastIndex++;
                }
              } catch (e) { /* unreadable README — skip, don't fail the scan */ }
            }
            if (found.length) {
              for (const id of found) ids.add(id);
              manifest.push({ p: path, i: found });
            }
            if (fileCount % 500 === 0) {
              self.postMessage({ type: 'progress', fileCount, idCount: ids.size });
            }
          } else if (entry.kind === 'directory') {
            if (settings.matchFolderNames) {
              const found = [];
              extractIds(entry.name, re, found);
              for (const id of found) ids.add(id);
            }
            queue.push({ handle: entry, path });
          }
        }
      }

      // Bounded-concurrency work queue over the directory tree.
      await new Promise((resolve, reject) => {
        const pump = () => {
          if (aborted) return resolve();
          if (queue.length === 0 && active === 0) return resolve();
          while (active < limit && queue.length > 0) {
            const node = queue.shift();
            active++;
            walk(node).catch(reject).finally(() => { active--; pump(); });
          }
        };
        pump();
      });

      if (aborted) { self.postMessage({ type: 'aborted', fileCount }); return; }
      self.postMessage({ type: 'progress', fileCount, idCount: ids.size });
      self.postMessage({ type: 'done', ids: Array.from(ids), fileCount, manifest });
    }
  `;

  function spawnScanWorker() {
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker._objectURL = url; // revoked in cleanup
    return worker;
  }

  // Run one scan in a worker. Resolves { ids:Set, fileCount, manifest, aborted }.
  function scanInWorker(rootHandle, settings, onProgress) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = spawnScanWorker();
      } catch (e) {
        reject(new Error('Could not start scan worker: ' + ((e && e.message) || e)));
        return;
      }
      state.worker = worker;

      const cleanup = () => {
        try { URL.revokeObjectURL(worker._objectURL); } catch (e) { /* noop */ }
        if (state.worker === worker) state.worker = null;
        state.abortCurrent = null;
      };

      // Lets abortScan() settle this promise immediately on a hard terminate.
      state.abortCurrent = () => {
        try { worker.terminate(); } catch (e) { /* noop */ }
        cleanup();
        resolve({ ids: new Set(), fileCount: 0, manifest: [], aborted: true });
      };

      worker.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'progress') {
          if (onProgress) onProgress({ fileCount: m.fileCount, idCount: m.idCount });
        } else if (m.type === 'aborted') {
          worker.terminate(); cleanup();
          resolve({ ids: new Set(), fileCount: m.fileCount, manifest: [], aborted: true });
        } else if (m.type === 'done') {
          worker.terminate(); cleanup();
          resolve({ ids: new Set(m.ids), fileCount: m.fileCount, manifest: m.manifest, aborted: false });
        } else if (m.type === 'error') {
          worker.terminate(); cleanup();
          reject(new Error(m.message || 'Scan worker error'));
        }
      };
      worker.onerror = (e) => {
        worker.terminate(); cleanup();
        reject(new Error((e && e.message) || 'Scan worker failed to run'));
      };

      worker.postMessage({
        type: 'start',
        rootHandle,
        settings: {
          filenamePattern: settings.filenamePattern,
          fallbackPattern: DEFAULT_SETTINGS.filenamePattern,
          matchFolderNames: settings.matchFolderNames,
          scanConcurrency: settings.scanConcurrency,
          scanReadme: settings.scanReadme,
          readmeName: README_NAME,
          readmePattern: README_PATTERN,
        },
      });
    });
  }

  // Cancel an in-flight scan (hard terminate; the existing index is left intact).
  function abortScan() {
    if (state.abortCurrent) {
      state.abortCurrent();
    } else if (state.worker) {
      try { state.worker.terminate(); } catch (e) { /* noop */ }
      state.worker = null;
    }
  }

  // opts.silent: auto-rescan path — never alert(), never prompt for permission
  // (no user gesture available). A non-granted handle just no-ops.
  async function runScan(onProgress, opts) {
    const silent = !!(opts && opts.silent);
    if (state.scanning) return { aborted: true };
    state.scanning = true;
    try {
      const handle = await getStoredHandle();
      if (!handle) { if (!silent) alert('Choose a folder first.'); return { aborted: true }; }
      const status = await checkPermission(handle, !silent);
      if (status !== 'granted') {
        if (!silent) alert('Folder permission was not granted.');
        return { aborted: true };
      }

      // Snapshot the prior manifest before we overwrite it, for change reporting.
      const prevManifest = await idbGet(STORE_MANIFEST, MANIFEST_KEY);

      const result = await scanInWorker(handle, state.settings, onProgress);
      if (result.aborted) return result; // cancelled — keep the previous index

      const builtAt = Date.now();
      const record = { ids: Array.from(result.ids), builtAt, fileCount: result.fileCount };
      await idbPut(STORE_INDEX, INDEX_KEY, record);
      await idbPut(STORE_MANIFEST, MANIFEST_KEY, { entries: result.manifest, builtAt });

      state.ids = result.ids;
      state.indexMeta = { builtAt, fileCount: result.fileCount };
      result.diff = diffManifests(prevManifest, { entries: result.manifest });
      decoratePage(); // refresh badges with new data
      return result;
    } finally {
      state.scanning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Incremental change reporting (phase 6)
  // ---------------------------------------------------------------------------
  // Diff is computed over the names-only manifest. Thing-level add/remove is a
  // set-difference of the IDs each manifest yields, so an ID counts as "removed"
  // only when NO remaining file still produces it — i.e. ref counting falls out
  // of the set diff for free, no separate refcount store needed.
  function idsOfManifest(entries) {
    const s = new Set();
    for (const e of (entries || [])) {
      for (const id of (e.i || [])) s.add(id);
    }
    return s;
  }

  function diffManifests(prev, next) {
    const prevEntries = (prev && prev.entries) || [];
    const nextEntries = (next && next.entries) || [];
    const prevPaths = new Set(prevEntries.map((e) => e.p));
    const nextPaths = new Set(nextEntries.map((e) => e.p));
    let filesAdded = 0, filesRemoved = 0;
    for (const p of nextPaths) if (!prevPaths.has(p)) filesAdded++;
    for (const p of prevPaths) if (!nextPaths.has(p)) filesRemoved++;

    const prevIds = idsOfManifest(prevEntries);
    const nextIds = idsOfManifest(nextEntries);
    let thingsAdded = 0, thingsRemoved = 0;
    for (const id of nextIds) if (!prevIds.has(id)) thingsAdded++;
    for (const id of prevIds) if (!nextIds.has(id)) thingsRemoved++;

    return {
      hadPrevious: !!(prev && prev.entries),
      filesAdded, filesRemoved, thingsAdded, thingsRemoved,
    };
  }

  async function hydrateIndex() {
    const record = await idbGet(STORE_INDEX, INDEX_KEY);
    if (record && Array.isArray(record.ids)) {
      state.ids = new Set(record.ids);
      state.indexMeta = { builtAt: record.builtAt, fileCount: record.fileCount };
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-rescan policy (phase 6)
  // ---------------------------------------------------------------------------
  // FSA exposes no folder-watch and no directory mtimes, so we can't react to
  // disk changes. Instead we rescan on a chosen trigger, gated by a cooldown so
  // it never runs on consecutive page loads. Auto-rescans are silent: they never
  // prompt for permission, so a session that hasn't been reconnected just keeps
  // using the cached index until the user clicks "Reconnect folder".
  function autoRescanCooldownElapsed() {
    const last = state.indexMeta && state.indexMeta.builtAt;
    if (!last) return true; // never scanned → allow
    const hours = Math.max(1 / 60, Number(state.settings.autoRescanHours) || 6);
    return (Date.now() - last) >= hours * 3600 * 1000;
  }

  async function autoRescanTick(trigger) {
    const mode = state.settings.autoRescan;
    if (mode === 'off' || mode !== trigger) return; // trigger must match the chosen mode
    if (state.scanning || !autoRescanCooldownElapsed()) return;
    try {
      const result = await runScan(null, { silent: true });
      if (result && !result.aborted && result.diff) {
        const d = result.diff;
        if (d.thingsAdded || d.thingsRemoved) {
          console.info(`[TDF] auto-rescan: +${d.thingsAdded} new, -${d.thingsRemoved} gone`);
        }
      }
    } catch (e) {
      console.warn('[TDF] auto-rescan failed', e);
    }
  }

  function startAutoRescan() {
    // 'focus' mode: rescan when the tab regains focus (cooldown-gated).
    window.addEventListener('focus', () => autoRescanTick('focus'));
    // 'interval' mode: poll every few minutes; the cooldown decides if it runs.
    setInterval(() => autoRescanTick('interval'), 5 * 60 * 1000);
  }

  // ---------------------------------------------------------------------------
  // Page decoration
  // ---------------------------------------------------------------------------
  const THING_HREF_RE = /\/thing:(\d+)/;
  const CHECKED_ATTR = `data-${NS}-checked`;

  // Defuse anything that could break out of a CSS value (it's the user's own
  // setting, but a stray ; or } would corrupt the whole stylesheet).
  function safeColor(c) {
    c = String(c || '').trim();
    if (!c || /[;{}<>()]/.test(c)) return DEFAULT_SETTINGS.badgeColor;
    return c;
  }

  function cornerCss(corner) {
    switch (corner) {
      case 'tr': return 'top: 6px; right: 6px;';
      case 'bl': return 'bottom: 6px; left: 6px;';
      case 'br': return 'bottom: 6px; right: 6px;';
      case 'tl':
      default:   return 'top: 6px; left: 6px;';
    }
  }

  function buildBadgeCss() {
    const color = safeColor(state.settings.badgeColor);
    return `
      .${NS}-badge {
        display: inline-block;
        background: ${color};
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
        ${cornerCss(state.settings.badgeCorner)}
        background: ${color};
        color: #fff;
        font: 700 10px/1.4 system-ui, sans-serif;
        padding: 2px 6px;
        border-radius: 4px;
        pointer-events: none;
        z-index: 9999;
      }`;
  }

  // Idempotent create + always refresh, so a settings change restyles every
  // existing badge instantly (they key off the shared class).
  function injectStyles() {
    let el = document.getElementById(`${NS}-styles`);
    if (!el) {
      el = document.createElement('style');
      el.id = `${NS}-styles`;
      document.head.appendChild(el);
    }
    el.textContent = buildBadgeCss();
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
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <input type="checkbox" id="${NS}-readme" ${s.scanReadme ? 'checked' : ''}/>
        Read thing ID from README.txt (Thingiverse downloads)
      </label>
      <label style="display:block;margin-bottom:4px;">Badge text</label>
      <input id="${NS}-badge" value="${escapeHtml(s.badgeText)}"
             style="width:100%;box-sizing:border-box;margin-bottom:8px;"/>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <span style="color:#555;">Color</span>
        <input id="${NS}-badge-color" type="color" style="width:36px;height:26px;padding:0;border:none;background:none;"/>
        <input id="${NS}-badge-color-text" style="width:96px;box-sizing:border-box;"/>
        <span style="color:#555;margin-left:6px;">Corner</span>
        <select id="${NS}-badge-corner">
          <option value="tl">Top-left</option>
          <option value="tr">Top-right</option>
          <option value="bl">Bottom-left</option>
          <option value="br">Bottom-right</option>
        </select>
      </div>
      <div style="margin-bottom:12px;color:#555;">
        Preview: <span id="${NS}-badge-preview"></span>
      </div>
      <label style="display:block;margin-bottom:4px;">Automatic rescan</label>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
        <select id="${NS}-auto">
          <option value="off">Off</option>
          <option value="focus">When the tab regains focus</option>
          <option value="interval">Every N hours</option>
        </select>
        <span id="${NS}-auto-hours-wrap">
          <input id="${NS}-auto-hours" type="number" min="1" step="1"
                 style="width:64px;box-sizing:border-box;"/> hours
        </span>
      </div>
      <div id="${NS}-status" style="color:#555;margin-bottom:12px;">${escapeHtml(metaLine)}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="${NS}-rescan" type="button">Rescan now</button>
        <button id="${NS}-cancel" type="button" style="display:none;">Cancel</button>
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
      if (!window.showDirectoryPicker) return; // unsupported-browser notice owns the perm line
      const h = await getStoredHandle();
      if (h) $('folder').textContent = h.name;
      renderPermission(await checkPermission(h, false));
    }
    refreshFolderStatus();

    // Auto-rescan controls: reflect current settings, hide the hours box unless
    // the interval mode is selected.
    $('auto').value = s.autoRescan;
    $('auto-hours').value = s.autoRescanHours;
    const syncAutoUI = () => {
      $('auto-hours-wrap').style.display = ($('auto').value === 'interval') ? '' : 'none';
    };
    $('auto').addEventListener('change', syncAutoUI);
    syncAutoUI();

    // Badge styling controls + live preview. The color picker only speaks
    // #rrggbb, so the text field is the source of truth (accepts names too).
    $('badge-color').value = /^#[0-9a-fA-F]{6}$/.test(s.badgeColor) ? s.badgeColor : DEFAULT_SETTINGS.badgeColor;
    $('badge-color-text').value = s.badgeColor;
    $('badge-corner').value = s.badgeCorner;
    const renderBadgePreview = () => {
      const prev = $('badge-preview');
      prev.className = `${NS}-badge`;
      prev.textContent = $('badge').value || DEFAULT_SETTINGS.badgeText;
      prev.style.marginLeft = '0';
      prev.style.background = safeColor($('badge-color-text').value);
    };
    $('badge').addEventListener('input', renderBadgePreview);
    $('badge-color-text').addEventListener('input', renderBadgePreview);
    $('badge-color').addEventListener('input', () => {
      $('badge-color-text').value = $('badge-color').value;
      renderBadgePreview();
    });
    renderBadgePreview();

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

    // Hard error state: no File System Access API → folder actions can't work.
    if (!window.showDirectoryPicker) {
      ['pick', 'reconnect', 'rescan'].forEach((id) => { $(id).disabled = true; });
      $('perm').textContent = 'This browser lacks the File System Access API (try Chrome/Edge).';
      $('perm').style.color = '#c62828';
      $('perm-dot').style.background = '#c62828';
    }

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
      $('rescan').disabled = true;
      $('cancel').style.display = '';
      let result;
      try {
        result = await runScan((p) => {
          status.textContent = `Scanning… ${p.fileCount} files, ${p.idCount} IDs`;
        });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        status.textContent = /not.?found|no longer|GONE/i.test(msg)
          ? 'Folder not found — it may have been moved or renamed. Click “Choose folder…” to re-select it.'
          : 'Scan failed: ' + msg;
        return;
      } finally {
        $('rescan').disabled = false;
        $('cancel').style.display = 'none';
      }
      refreshFolderStatus();
      if (result && result.aborted) {
        status.textContent = 'Scan cancelled — previous index kept.';
        return;
      }
      const m = state.indexMeta;
      const d = result && result.diff;
      const change = (d && d.hadPrevious && (d.thingsAdded || d.thingsRemoved))
        ? ` · +${d.thingsAdded} new, -${d.thingsRemoved} gone`
        : '';
      status.textContent = m
        ? `Done: ${m.fileCount} files, ${state.ids.size} IDs (${new Date(m.builtAt).toLocaleString()})${change}`
        : 'Scan finished.';
    });

    $('cancel').addEventListener('click', () => {
      abortScan();
      status.textContent = 'Cancelling…';
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
    state.settings.scanReadme = $('readme').checked;
    state.settings.badgeText = $('badge').value || DEFAULT_SETTINGS.badgeText;
    state.settings.badgeColor = safeColor($('badge-color-text').value);
    state.settings.badgeCorner = $('badge-corner').value;
    state.settings.autoRescan = $('auto').value;
    state.settings.autoRescanHours = Math.max(1, parseInt($('auto-hours').value, 10) || DEFAULT_SETTINGS.autoRescanHours);
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
    startAutoRescan();         // optional, cooldown-gated background refresh
  })();
})();
