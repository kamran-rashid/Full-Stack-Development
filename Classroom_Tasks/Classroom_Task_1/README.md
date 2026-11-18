# FinTrack Pocket: an expense diary that remembers where your money went (CSC413-8, Classroom Task 1)

**Student:** Md Kamran S Rashid · **Register no.:** 2340236 · **Class:** 8 BSc CS (Hons), CHRIST (Deemed to be University)
**Task:** Web APIs: Local Storage, Session Storage, IndexedDB, Geolocation and Web Workers
**Technology:** HTML, CSS and plain JavaScript. No frameworks, no libraries, no build step, no external requests.

## How to run

**Quickest:** double-click `index.html` and open it in Chrome or Edge. Everything works, including the Web Worker (see section 2.5).

**Recommended for the demo:** serve the folder so the browser treats it as a normal site:

```bash
cd Classroom_Tasks/Classroom_Task_1
python -m http.server 8000
# open http://localhost:8000
```

Location works on `localhost` and on a file opened from disk. On another device over the network it needs `https://`, because browsers only share a location with secure pages.

```
Classroom_Task_1/
  index.html          the app (one page, three views: Diary, Near me, Insights)
  styles.css          FinTrack design language, light/dark, responsive
  js/store.js         Local Storage (settings) + Session Storage (this tab)
  js/db.js            IndexedDB (expenses, places, last analysis) + in-memory fallback
  js/geo.js           Geolocation, distances, saved-place matching
  js/worker.js        Web Worker: statistics, k-means hotspots, large-dataset generator
  js/app.js           the interface, which ties the five APIs together
  tests/              automated test suite (Playwright) + results.json
  evidence/           17 screenshots of the test cases
```

---

## 1. The problem

Small cash and UPI payments (a canteen lunch, an auto ride, chai) are the ones people forget, and they add up. Most expense apps ask what and how much, but not **where**. Knowing that ₹6,000 a month goes "around College" is more useful than a category total. FinTrack Pocket is a quick expense diary that:

- records each expense with an optional location and labels it with a saved place ("Home", "College");
- shows the month against your budget, with a month-end projection;
- answers "how much have I spent near here?" with a radar of nearby expenses;
- finds your spending **hotspots** with k-means clustering in a background thread;
- remembers your settings, keeps your records offline, and never loses a half-typed entry.

## 2. The five Web APIs

| API | What it holds or does | Where | Mandatory challenge |
|---|---|---|---|
| **Local Storage** | Settings: name, theme, monthly budget, "near me" radius, default category, auto-tag location; visit count and last visit | `js/store.js` (`prefs`) | Remembered after the browser is closed: "Welcome back, Kamran · Visit 2", the dark theme and the budget all come back |
| **Session Storage** | This tab only: half-typed expense (draft), current view, filters, last location fix, activity log, tab id | `js/store.js` (`tab`) | Survives a reload; a second tab starts empty; closing the tab clears it |
| **IndexedDB** | Database `fintrack-pocket` v1: `expenses` (indexes `byDate`, `byCategory`, `byPlace`), `places`, `meta` (the last analysis) | `js/db.js` | Add, retrieve, update and delete expenses and places; bulk writes in one transaction |
| **Geolocation** | Tags an expense with coordinates, matches it to a saved place, "Near me" radar, "Save where I am" | `js/geo.js`, `app.js` | Asks permission only when needed; works without it |
| **Web Workers** | Statistics, median/90th percentile, distances, k-means hotspots; generates and analyses up to 1,000,000 records | `js/worker.js` | 1,000,000 records in about 1.9 s with the page never frozen for more than 17 ms |

### 2.1 Local Storage
`store.prefs` reads one JSON object (`pocket.prefs.v1`), **validates every field** (an unknown theme or a negative budget falls back to the default), and reports whether a save worked. The theme is applied by a tiny script in `<head>` before the first paint, so a dark-mode user never sees a white flash. The `storage` event keeps tabs in sync: change the budget in one tab and every other open tab updates at once.

### 2.2 Session Storage
`store.tab` keeps one object per tab (`pocket.session.v1`). The draft is saved 250 ms after you stop typing and restored after a reload with a "Draft restored" tag. The last location fix is kept **only here**, not in Local Storage: location is sensitive, so it is forgotten when the tab closes. A visit is counted when a new tab session starts, so reloads do not inflate the visit count (Session Storage and Local Storage working together).

### 2.3 IndexedDB
`db.js` wraps IndexedDB's event API in Promises (`req()` for requests, `done()` for transactions, which resolve only after the transaction commits). Amounts are stored as integer **paise** so totals never drift. The `byPlace` index is used for real work: deleting a place finds every expense linked to it and unlinks them in one transaction. If the database cannot open, a `MemoryStore` with the same methods takes over and the user is told that records will only last for this tab.

### 2.4 Geolocation
`geo.locate()` turns `getCurrentPosition` into a Promise, with a 10-second timeout and a 60-second cache. Every failure has a kind and a plain message: `denied`, `unavailable`, `timeout`, `unsupported`, `insecure`. The Permissions API shows the state ("allowed / will ask / blocked") in the status line and updates if the user changes it. Distances use the haversine formula.

### 2.5 Web Workers
`worker.js` converts records into **typed arrays** (columns) and computes totals, category/month/weekday breakdowns, the median and 90th percentile (sorting a `Float64Array`), spending within the radius, and **k-means++** clustering with up to 30 iterations to find hotspots. Progress is posted at most every 50 ms; **Cancel** terminates the worker and starts a fresh one.

*Opening from disk:* Chrome refuses `new Worker("js/worker.js")` on a `file://` page. So `worker.js` is written as one function, `pocketWorker()`. Served over http it runs as the worker file; opened from disk, the page builds the same code into a **Blob URL** worker. The status line says which is in use ("worker.js" or "from Blob"). The same functions also power the "run on the main thread" comparison, so both runs do identical work.

## 3. How the APIs work together

```
            Geolocation ──── position ───────────────┐
                │                                     ▼
       tag + nearest place                     Web Worker
                ▼                     ┌──────► (stats, distances,
            IndexedDB  ── records ────┘           k-means hotspots)
          (expenses,                              │
           places, meta) ◄────── last analysis ───┘
                ▲                                     ▲
                │                                     │
   Session Storage: draft, last fix      Local Storage: budget, radius,
   for this tab only                     default category, auto-tag
```

1. **Geolocation → IndexedDB:** each expense stores where it happened and is labelled with a saved place; saving a new place relabels earlier expenses inside its circle.
2. **IndexedDB + Geolocation + Local Storage → Web Worker:** "Analyse" and "Near me" send the stored records, the current position and the saved budget and radius to the worker.
3. **Web Worker → IndexedDB:** the analysis is saved and shown again automatically on the next visit ("Last analysed 2 h ago").
4. **Session Storage + Local Storage:** a new tab session is what counts as a visit.

## 4. Advanced challenges (Task 2)

| Challenge | How it is met |
|---|---|
| 1. Interaction between at least three APIs | Four flows above; the main one uses four APIs at once (Geolocation, IndexedDB, Local Storage, Web Worker) |
| 2. Automatic retrieval and display | On load: settings and theme applied, "Welcome back" + visit count, records listed, budget meter drawn, last analysis shown, this tab's draft, view and filters restored, last location reused in "Near me" |
| 3. Denied permissions, unavailable data, storage errors | See section 5 |
| 4. Responsive interface | Two columns on desktop, one column under 960 px, compact phone layout under 544 px; tested at 1280, 768, 390 and 320 px with no sideways scrolling |
| 5. A real application, not an API demo | A budgeting diary with a month-end projection, place labels, a "near me" radar and hotspot clustering; the APIs are the plumbing |

## 5. Error handling

| Situation | What the user sees | What still works |
|---|---|---|
| Location **denied** | Message under the form and in "Near me", how to re-enable it, notice at the top, "Geolocation blocked" in the status line | Expense saved without a location; everything else |
| Position **unavailable** / **timeout** | "Your device could not find its position…" / "Finding your position took too long. Try again." | Same |
| No Geolocation API, or an insecure page | "This browser cannot share a location." / "Location only works on a secure page…" | Same |
| **IndexedDB** cannot open (blocked, private mode, upgrade blocked by another tab) | Red notice, "IndexedDB memory only" in the status line | The app runs on an in-memory store for this tab |
| IndexedDB write fails (e.g. **storage full**) | "Saving the expense failed: The browser's storage is full…" | Nothing is half-saved (transactions are all-or-nothing) |
| **Local / Session Storage blocked** | Notices explaining settings or drafts won't be kept | The app runs normally |
| Local Storage **full** (`QuotaExceededError`) | "Your browser's storage is full, so settings could not be saved." | Settings apply for now |
| **Damaged** saved settings (bad JSON or values) | "Your saved settings could not be read, so the defaults are used." | Defaults |
| Worker unavailable / crashed / cancelled | Clear message; Cancel starts a fresh worker | The rest of the app |
| Invalid input (`12abc`, negative, future date, empty note) | Summary of every problem + message per field | |
| Nothing recorded yet | Empty states with a "Load a sample diary" button | |

## 6. Test cases and results (Task 3)

All tests were automated with Playwright in Chromium (`tests/test-suite.mjs`). **Result: 53 checks, 53 passed** (`tests/results.json`). The manual steps below are the same tests done by hand, for the demonstration.

### Test 1: close and reopen the browser
**Steps:** open the app → Settings: name "Kamran", Dark theme, budget ₹12,000 → add an expense → Analyse → type a draft → reload (the draft comes back) → **close the whole browser** → open it again.
**Result:**

| Check | Result |
|---|---|
| Draft restored after a reload (same tab) | Pass |
| "Welcome back, Kamran · Visit 2" | Pass |
| Dark theme and ₹12,000 budget remembered | Pass |
| Expense still listed (IndexedDB) | Pass |
| Last analysis shown again automatically (IndexedDB `meta`) | Pass |
| Draft and tab session gone (new Session Storage) | Pass |

Evidence: `02-before-closing-browser.png`, `03-after-reopening-browser.png`.

### Test 2: the app in two tabs
**Steps:** tab A: load the sample, switch to Insights, type a draft. Open tab B. Change the budget in tab B.
**Result:** different tab ids; tab A stays on Insights while tab B opens on Diary; the draft exists only in tab A; activity logs differ; both tabs see the same 40 records (shared IndexedDB); tab A picks up tab B's new budget **instantly** through the `storage` event. **All pass.** Evidence: `04-tab-A.png`, `05-tab-B.png`.

### Test 3: add, update and delete records in IndexedDB
**Steps:** add ₹180 "Metro to college" → Edit to ₹210 → reload → Delete → Undo → save a place here → delete the place.
**Result:**

| Operation | Checked directly in IndexedDB | Result |
|---|---|---|
| Add | 1 record, `amount: 18000` (paise), location stored | Pass |
| Update | same id, `amount: 21000`, new note, `updatedAt` changed | Pass |
| Retrieve | listed again after a reload | Pass |
| Delete | 0 records | Pass |
| Undo | record back | Pass |
| Place add | earlier expense gets the place's id | Pass |
| Place delete | found via the `byPlace` index, unlinked, coordinates kept | Pass |

Evidence: `06-idb-add.png`, `07-idb-update.png`, `08-idb-delete-undo.png`. (In Chrome DevTools: Application → IndexedDB → fintrack-pocket shows the same records.)

### Test 4: deny location permission
**Steps:** block location for the page (click the icon left of the address bar → Location → Block), then save an expense with "Tag with my location" ticked, and press "Use my location".
**Result:** the expense **is saved, without a location**, with an explanation; a notice says what still works; the status line shows "Geolocation blocked"; "Near me" shows the message instead of failing. The *unavailable*, *timeout* and *no API* cases were also simulated and each shows its own message. **All pass.** Evidence: `09-location-denied-form.png`, `10-location-denied-near-me.png`.

### Test 5: a large dataset in a Web Worker
**Steps:** Insights → Large dataset test → 1,000,000 → "Run in a Web Worker", and keep pressing "Tap me" while it runs. Then compare with 300,000 on "Run on the main thread".

| Run | Records | Time | Longest page freeze | Taps handled during the run |
|---|---|---|---|---|
| Web Worker | 1,000,000 | 1,874 ms | **17 ms** (one normal frame) | **12 of 12** |
| Main thread | 300,000 | ~900 ms | **950 ms** (page frozen) | held back until the work finished |

The heartbeat bar keeps moving during the worker run and stops during the main-thread run. Cancel stops the worker mid-run and starts a fresh one. **All pass.** Evidence: `11-worker-1-million.png`, `12-main-thread-freeze.png`.

### Extra: storage errors, responsiveness, accessibility
- IndexedDB blocked: memory-only mode with a notice, and adding still works (`13-indexeddb-unavailable.png`).
- Local and Session Storage blocked, damaged settings JSON, and Local Storage full: each is explained (`14-storage-blocked.png`).
- No sideways scrolling in any view at 1280, 768, 390 and 320 px, including dark mode on a phone (`15`–`17`).
- **axe-core: 0 accessibility violations** (WCAG 2.1 A/AA + best practice) at every size. Other accessibility features: labelled fields, an error summary that takes focus, tabs that work with the arrow keys, live regions for messages, visible focus and reduced-motion support.

## 7. Screenshots (`evidence/`)

| File | Shows |
|---|---|
| `01-first-visit.png` | First visit: status line for all five APIs |
| `02`, `03` | Before closing the browser / after reopening it |
| `04`, `05` | Two tabs with separate sessions |
| `06`–`08` | IndexedDB add, update, delete with Undo |
| `09`, `10` | Location denied: form and "Near me" |
| `11`, `12` | 1,000,000 records in the worker vs 300,000 on the main thread |
| `13`, `14` | IndexedDB unavailable; storage blocked |
| `15`–`17` | Desktop, tablet, phone (dark) |

## 8. Limitations

- Hotspots use straight-line k-means with k = 5; a city with very spread-out spending may need more or fewer clusters.
- The month-end projection assumes the rest of the month looks like the days so far.
- Duplicating a tab copies its Session Storage (a browser rule); a **new** tab starts empty, which is what the two-tab test uses.
- The sample diary is placed around Bengaluru if no location has been shared yet.
- Data lives in this browser only: there is no account or sync.
- Tested in Chromium only.

## 9. Credits and AI use

All code, the design and the sample data are my own work for this task (the design reuses my FinTrack labs' style). Claude (Anthropic) was used as a development assistant to write and test the code; I reviewed it and can explain and change every part.
