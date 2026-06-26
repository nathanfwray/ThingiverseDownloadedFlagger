# Thingiverse Downloaded Flagger

A [Tampermonkey](https://www.tampermonkey.net/) userscript that flags Thingiverse
things you've **already downloaded**. While you browse
[thingiverse.com](https://www.thingiverse.com), every thing whose ID matches a
file in a local folder you pick gets a small **DOWNLOADED** badge — on the thing
page itself and on every card in listing, search, collection, and maker pages.

No companion app, no server, no uploads. The script reads your local folder
directly through the browser's [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API).
For speed it reads file **names** only — with one deliberate exception: it opens
each `README.txt` (the small text file Thingiverse bundles with every download)
to read the thing ID, because that's where the standard download layout keeps
it. Nothing leaves your machine either way.

**Current version: 0.6.0** — IDs are matched both from file names **and from the
`thingiverse.com/thing:<id>` URL inside `README.txt`**, so a normal Thingiverse
download library (folders/files named by title, ID only in the README) flags
correctly. The folder scan runs in a Web Worker (indexing a large library never
freezes the page, and a scan can be cancelled mid-run with the previous index
kept). Rescans report what changed (e.g. *+12 new, -3 gone*), an optional
**automatic rescan** can refresh the index when the tab regains focus or on an
interval, and the **badge color and corner** are customizable with a live
preview.

## How it works

The design rests on one idea: **scan rarely, look up constantly.**

1. **Scan (once, on demand):** you point the script at a single root folder. It
   walks that folder and its subfolders and collects Thingiverse thing IDs two
   ways, then stores the resulting set in the browser's IndexedDB:
   - from **file names** that contain an ID (e.g. `Articulated_Dragon_-_4734271.zip` → `4734271`), and
   - from the **`thingiverse.com/thing:<id>` URL inside each `README.txt`** — the
     standard Thingiverse download names its folder/files by *title*, so the ID
     survives only in that bundled README. (Toggleable; on by default.)
2. **Look up (every page):** on each Thingiverse page the script loads that ID
   set into memory and checks the `/thing:<id>` links on the page. Matches get a
   badge. Page loads never touch the disk, so browsing stays fast even with tens
   of thousands of indexed files.

The walk reads directory entry **names** only — the fast path — and never
materializes file objects, *except* for `README.txt` files, which are small and
get opened to recover the ID. That keeps the dominant cost (name enumeration)
cheap while still matching a real download library.

## Requirements

- A Chromium-based browser (Chrome, Edge, Brave, etc.). The File System Access
  API and `showDirectoryPicker()` are required; Firefox/Safari do not currently
  support them.
- The [Tampermonkey](https://www.tampermonkey.net/) browser extension.
- Your downloaded Thingiverse files in **one root folder** (subfolders are fine).
  The thing ID is found in each download's bundled `README.txt`, and/or in file
  names that contain the ID — either works.

## Install / Enable

1. Install the **Tampermonkey** extension in your browser.
2. Open the raw script:
   [`thingiverse-downloaded-flagger.user.js`](https://raw.githubusercontent.com/nathanfwray/ThingiverseDownloadedFlagger/main/thingiverse-downloaded-flagger.user.js).
   Tampermonkey will detect the `==UserScript==` header and show its install
   screen — click **Install**.
   - Alternatively: Tampermonkey dashboard → **+** (Create a new script) → paste
     the contents of the file → **File ▸ Save**.
3. Make sure the script is **enabled** in the Tampermonkey dashboard (the toggle
   next to its name) and that Tampermonkey itself is enabled for
   `www.thingiverse.com`.
4. Visit [thingiverse.com](https://www.thingiverse.com). Flagging is on by
   default, but it has nothing to match until you pick a folder and run the first
   scan (below).

## Pick your local folder and run a scan

Everything is driven from the script's settings panel.

1. On any thingiverse.com page, open the **Tampermonkey menu** (click the
   extension icon) and choose **"Thingiverse Downloads — Settings"**.
2. In the panel, click **Choose folder…** and select the root folder that holds
   your downloaded files. The browser will ask for read permission — grant it.
   The panel shows the chosen folder name and a green **Connected** indicator.
3. *(Optional)* Adjust the **Filename ID pattern** (a regex; default
   `(?:thing[:_-]?)?(\d{5,9})`). Paste a sample file name into the test box to
   confirm the ID is extracted correctly. Toggle **"Also match IDs in folder
   names"** if you name folders by thing ID, and change the **Badge text** if you
   like.
4. Click **Rescan now**. The panel reports live progress (files scanned, IDs
   found) and, when finished, the totals and timestamp. Badges then appear on the
   page automatically.

### Rescanning later

The index is a snapshot — it does **not** update on its own when you download new
things. To refresh it after adding (or removing) files:

1. Open **Tampermonkey menu → "Thingiverse Downloads — Settings"**.
2. Click **Rescan now**. The script re-walks the same folder you already picked
   and rebuilds the ID index. No need to re-select the folder. When it finishes,
   the status line reports what changed since the last scan (e.g. *+12 new, -3
   gone*).

You only need to choose a folder again if you want to point at a **different**
folder, or if you moved/renamed the original one.

#### Automatic rescan (optional)

To avoid clicking *Rescan now* by hand, set **Automatic rescan** in the settings
panel to either:

- **When the tab regains focus** — re-indexes when you switch back to a
  Thingiverse tab, or
- **Every N hours** — re-indexes on an interval.

Both are gated by a cooldown (the **hours** value) so a rescan never runs on
consecutive page loads — at most once per window. Automatic rescans are silent
and never pop a permission prompt, so if the session shows **"Needs reconnect"**
they're skipped until you reconnect the folder once (below); the cached index
keeps working in the meantime.

### "Needs reconnect" after restarting the browser

Chrome remembers your folder choice but, for security, requires a fresh click to
re-grant read access at the start of each browsing session. If the settings panel
shows **"Needs reconnect"**, click **Reconnect folder** once. Until you do, the
script keeps using the last cached index (still useful, just possibly slightly
stale).

## Settings reference

| Setting | What it does |
| --- | --- |
| **Enable flagging** | Master on/off for the badges. |
| **Choose folder / Reconnect folder** | Select the root download folder / re-grant read access for the session. |
| **Filename ID pattern** | Regex used to pull the thing ID from each file name. Capture group 1 is the ID. Includes a live tester. |
| **Also match IDs in folder names** | Extract IDs from directory names too, not just files. |
| **Read thing ID from README.txt** | Open each `README.txt` and extract the `thingiverse.com/thing:<id>` URL — needed for standard title-named downloads. On by default. |
| **Badge text** | The label shown on flagged things (default `DOWNLOADED`). |
| **Badge color / corner** | Badge background color (picker or any CSS color) and which corner of a card it sits in, with a live preview. |
| **Automatic rescan** | Off, on tab focus, or every N hours — cooldown-gated, silent, and skipped until the folder is reconnected. |
| **Rescan now** | Re-walk the chosen folder, rebuild the index, and report what changed since the last scan. |

## Privacy

All processing happens locally in your browser. The folder you pick is accessed
through the browser's permission-gated File System Access API. Only file/folder
**names** are read, plus the contents of `README.txt` files (to recover the
thing ID) when that option is enabled. Nothing is ever sent off your machine.

## Project plan

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for the full design, performance
strategy, storage schema, and roadmap.

## License

[MIT](LICENSE)
