# Thingiverse Downloaded Flagger

A [Tampermonkey](https://www.tampermonkey.net/) userscript that flags Thingiverse
things you've **already downloaded**. While you browse
[thingiverse.com](https://www.thingiverse.com), every thing whose ID matches a
file in a local folder you pick gets a small **DOWNLOADED** badge — on the thing
page itself and on every card in listing, search, collection, and maker pages.

No companion app, no server, no uploads. The script reads your local folder
directly through the browser's [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API),
and only ever reads file **names** — it never opens file contents.

## How it works

The design rests on one idea: **scan rarely, look up constantly.**

1. **Scan (once, on demand):** you point the script at a single root folder. It
   walks that folder and its subfolders, pulls the Thingiverse thing ID out of
   each file name (e.g. `Articulated_Dragon_-_4734271.zip` → `4734271`), and
   stores the resulting set of IDs in the browser's IndexedDB.
2. **Look up (every page):** on each Thingiverse page the script loads that ID
   set into memory and checks the `/thing:<id>` links on the page. Matches get a
   badge. Page loads never touch the disk, so browsing stays fast even with tens
   of thousands of indexed files.

Because the ID lives in the file name, the folder walk reads directory entry
names only and never materializes file objects — the slow part of filesystem
access is skipped entirely.

## Requirements

- A Chromium-based browser (Chrome, Edge, Brave, etc.). The File System Access
  API and `showDirectoryPicker()` are required; Firefox/Safari do not currently
  support them.
- The [Tampermonkey](https://www.tampermonkey.net/) browser extension.
- Your downloaded Thingiverse files in **one root folder** (subfolders are fine),
  with the thing ID present in each file's name.

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
   and rebuilds the ID index. No need to re-select the folder.

You only need to choose a folder again if you want to point at a **different**
folder, or if you moved/renamed the original one.

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
| **Badge text** | The label shown on flagged things (default `DOWNLOADED`). |
| **Rescan now** | Re-walk the chosen folder and rebuild the index. |

## Privacy

All processing happens locally in your browser. The folder you pick is accessed
through the browser's permission-gated File System Access API, only file/folder
**names** are read, and nothing is ever sent off your machine.

## Project plan

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for the full design, performance
strategy, storage schema, and roadmap.

## License

[MIT](LICENSE)
