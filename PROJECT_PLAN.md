# Thingiverse "Already Downloaded" Flagger — Project Plan

A Tampermonkey userscript for Chrome that flags any Thingiverse thing you've
already downloaded, by matching the thing's ID against a single local folder
(and its subfolders) of downloaded files.

## Confirmed decisions

- **Local file access:** File System Access API (FSA). The user grants one root
  folder via `showDirectoryPicker()`; the directory handle is persisted in
  IndexedDB and reused. No companion app or server.
- **ID source:** the Thingiverse thing ID can appear in **file names** (e.g.
  `Articulated_Dragon_-_4734271.zip`, `4734271.stl`) — matched by reading
  directory entry names only.
  - **Revised in v0.6.0:** the *standard* Thingiverse download names its folder
    and files by **title**, so the ID is not in any name; it survives only in the
    bundled `README.txt` (`... on Thingiverse: https://www.thingiverse.com/thing:<id>`).
    The scanner therefore also opens `README.txt` files (opt-in, on by default)
    and extracts the ID from that URL. This is a deliberate exception to the
    original "never opens file contents" rule — bounded to README.txt, which is
    tiny and ~one per download, so the names-only fast path still dominates.

---

## 1. Goal

When browsing thingiverse.com, visually flag things you already own locally:

- On a **thing page** (`/thing:<id>`): a badge near the title.
- On **listing/search/grid/collection pages**: a small badge on every card
  whose thing is already downloaded.

The flag must appear quickly and the script must stay responsive even when the
local folder holds **thousands of files nested many levels deep**.

---

## 2. Core constraint and the central idea

A userscript cannot scan a disk on every page load — and walking thousands of
nested files is far too slow to do repeatedly. The whole design rests on one
separation:

> **Scan rarely, look up constantly.**

The expensive recursive folder walk happens **once** (and incrementally
thereafter), producing a compact **index of thing IDs** that lives in IndexedDB.
Every page load just loads that index into an in-memory `Set` and does O(1)
lookups. Page loads never touch the filesystem.

A second key win comes from the ID-in-filename decision: directory iteration via
FSA yields **entry names cheaply**. We **never call `getFile()`** (the slow part
that materializes a `File` object), because the ID is in the name. This alone
removes the dominant cost of FSA traversal.

---

## 3. Architecture

Four components, all inside the single userscript:

1. **Settings UI** — a modal injected into the page, opened from the Tampermonkey
   menu (`GM_registerMenuCommand`). Folder selection, filename pattern, toggles,
   "Rescan now", and scan status.
2. **Scanner** — recursively walks the chosen directory handle, extracts thing
   IDs from entry names, and writes the index + a lightweight manifest to
   IndexedDB. Runs in a **Web Worker** so the page never freezes.
3. **Index store (IndexedDB)** — the persisted directory handle, the set of known
   thing IDs, a path→metadata manifest for incremental rescans, and settings.
4. **Page decorator** — on each Thingiverse page, loads the ID set into memory,
   finds thing IDs present on the page, and adds badges. Uses a debounced
   `MutationObserver` for lazy-loaded cards.

### Data flow

```
First run:  pick folder → Worker scans tree → build ID set + manifest → IndexedDB
Page load:  load ID set from IndexedDB (one read) → scan DOM for thing IDs → badge
Rescan:     Worker re-walks tree → diff against manifest → patch ID set in IndexedDB
```

---

## 4. Settings screen

Opened via the Tampermonkey menu command "Thingiverse Downloads — Settings".

Contents:

- **Choose folder** button → `showDirectoryPicker()`. Shows the selected folder
  name and a permission status indicator.
- **Filename ID pattern** — a configurable regex (default `(?:thing[:_-]?)?(\d{5,9})`)
  with a live tester so the user can paste a sample filename and confirm the ID
  is extracted. Numeric, 5–9 digits, to avoid false positives.
- **Enable/disable flagging** toggle.
- **Badge style** — choose label text/color and corner placement.
- **Rescan now** button, plus read-only status: last scan time, files seen,
  unique IDs indexed, and scan duration.
- **Automatic rescan** — off / on focus / interval (e.g. every N hours), with a
  cooldown so it never runs on consecutive page loads.

All settings persist via `GM_setValue`; the folder handle and index live in
IndexedDB (handles can't go through `GM_setValue`).

### Permission UX note

Chrome persists the directory handle, but a persisted handle's **read
permission must be re-granted with a user gesture** each browser session. The
script calls `handle.queryPermission()` on load; if not `granted`, it shows a
small one-click "Reconnect folder" prompt rather than silently failing. Until
reconnected, the script uses the last cached index (still useful, possibly
slightly stale).

---

## 5. ID extraction and page matching

**From local files:** apply the configured regex to each directory entry's
`name`. Store every captured ID in the set. (Folder names can optionally be
matched too, behind a toggle, for people who name folders by ID.)

**On the page:** thing IDs are reliably available in links. Rather than scrape
visible text, read `href` attributes matching `/thing:(\d+)` — robust across
listing, search, collection, "liked", and maker pages. The thing page itself
gets its ID from the URL.

Decoration rules:

- Mark every processed element with a `data-tdf-checked` attribute so it is
  never reprocessed.
- Inject a single shared CSS class for the badge (one stylesheet, not inline
  styles per node).

---

## 6. Performance strategy (deep trees, thousands of files)

This is the heart of the project. Strategies, in order of impact:

### 6.1 Separate scanning from lookups
Page loads do **zero** filesystem work. They read one IndexedDB record (the ID
set), build an in-memory `Set<string>`, and look up. Tens of thousands of IDs in
a `Set` is a few MB of memory and sub-millisecond lookups.

### 6.2 Names only — never open files
Because the ID is in the filename, traversal uses the async directory iterator
(`for await (const entry of dirHandle.values())`) and reads `entry.name` only.
We **never call `getFile()`**, eliminating the biggest per-file cost in FSA.

### 6.3 Scan in a Web Worker, chunked
The recursive walk runs in a Worker (FSA handles are structured-cloneable, so
the directory handle can be posted to the worker). This keeps the main thread —
and the page the user is browsing — completely responsive. The worker streams
progress back for the settings UI.

### 6.4 Incremental rescans, not full rescans
Persist a **manifest**: `path → { size, lastModified }` for each file. On
rescan, walk the tree and diff:

- New/changed entries → re-extract and add IDs.
- Missing entries → remove their IDs (only if no other file maps to that ID).

A full walk still visits directories, but it does no file opens and no
re-parsing of unchanged names, so it's bounded by directory enumeration speed.

> **Honest limitation:** FSA does not expose directory modification times, so we
> cannot cheaply skip unchanged subtrees, and there is no native folder "watch".
> We mitigate by (a) only rescanning on demand or on a cooldown-gated schedule,
> never per page load, and (b) keeping the walk cheap (names only, in a worker).

### 6.5 Bounded concurrency
Directory enumeration fans out with a small concurrency cap (e.g. 8 in-flight
`values()` iterators) to use the disk efficiently without thrashing. A simple
work queue prevents unbounded recursion from spawning thousands of pending
promises at once.

### 6.6 Efficient DOM decoration
- One `MutationObserver`, **debounced** (e.g. 150 ms), to absorb lazy-loaded
  grids and infinite scroll.
- Process new cards inside `requestIdleCallback` in batches.
- Skip already-marked nodes via the `data-tdf-checked` attribute.
- Read all hrefs first, then write all badges (avoid layout thrashing by not
  interleaving reads and writes).

### 6.7 Fast startup
The ID set is cached in IndexedDB as a single serialized array, so page-load
hydration is one read + one `new Set(array)` — no per-record cursor iteration.

---

## 7. Storage schema (IndexedDB, one database)

- `config` — directory handle, settings mirror.
- `idIndex` — single record: `{ ids: number[], builtAt, fileCount }`. Loaded
  whole on page load.
- `manifest` — `path → { size, lastModified, id }` for incremental diffing.
- `idRefCount` (optional) — `id → count` so removing one file doesn't drop an ID
  still backed by another file.

---

## 8. Edge cases

- **Same ID in multiple files/folders** → reference counting (8 above) keeps the
  flag until the last copy is removed.
- **False-positive numbers in filenames** → digit-count bounds + configurable
  regex + live tester in settings.
- **Folder moved/renamed on disk** → handle becomes invalid; detect on scan and
  prompt re-selection.
- **Very large trees** → progress UI, cancellable scan, and the worker keeps the
  UI alive.
- **Thingiverse markup changes** → matching keys off `/thing:<id>` href patterns
  (stable) rather than fragile CSS selectors.
- **SPA/soft navigations** → re-run the decorator on history changes, not just
  initial load.

---

## 9. Implementation phases

1. **Skeleton** — userscript metadata block, `@match https://www.thingiverse.com/*`,
   menu command, settings modal shell, IndexedDB setup.
2. **Folder + permissions** — `showDirectoryPicker()`, persist handle, query/
   request permission, reconnect flow.
3. **Scanner v1 (main thread)** — recursive name-only walk, regex extraction,
   write `idIndex`. Validate correctness on a real folder.
4. **Page decorator** — href scan, badge on thing pages and listing cards,
   MutationObserver.
5. **Move scan to Web Worker** + progress reporting + cancel.
6. **Incremental rescan** — manifest diffing, ref counting, auto-rescan policy.
7. **Polish** — badge styling options, settings tester, status panel, error
   states.

## 10. Testing

- **Correctness:** seed a folder with known IDs at varying depths; confirm each
  flags and that non-downloaded things do not.
- **Performance:** generate a synthetic tree (e.g. 20k files, 6 levels deep);
  measure full scan time, incremental rescan time, page-load hydration time, and
  listing-page decoration time. Targets: page-load hydration < 50 ms; listing
  decoration imperceptible; full scan runs without freezing the page.
- **Regression:** snapshot the regex against a list of real Thingiverse download
  filenames.

## 11. Tech summary

- Tampermonkey userscript (`==UserScript==` header, `@grant
  GM_registerMenuCommand`, `GM_setValue`, `GM_getValue`).
- File System Access API for folder access.
- IndexedDB for the handle, index, and manifest.
- Web Worker for scanning.
- Vanilla JS + one injected stylesheet; no external runtime dependencies.
