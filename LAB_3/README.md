# FinTrack: a transaction tracker and spending analyst (CSC413-8, Lab 3)

**Student:** Md Kamran S Rashid · **Register no.:** 2340236 · **Class:** 8 BSc CS (Hons), CHRIST (Deemed to be University)
**Domain:** personal finance (continues the FinTrack site from Labs 1 and 2)
**Technology:** HTML, CSS and plain JavaScript. No frameworks, no libraries, no build step.

Lab 3 adds **Chapter 03, "Where it's going"**: a tracker that records transactions (typed in or imported from a bank statement), checks them against the budgets in the Chapter 02 ledger, forecasts the month end, and finds patterns such as subscriptions, unusual spends and double charges. The rest of the Lab 2 page keeps its content and still works without JavaScript. A visual refresh (section 13) adds an opening film, a refined palette and scroll-driven storytelling.

## How to run

1. Open `index.html` in Chrome (double-click works; nothing needs installing).
2. Scroll to **03 Tracker** in the top bar.
3. To try the importer, drag `data/sample-statement.csv` (26 rows, 5 with deliberate mistakes) or `data/large-statement.csv` (5,498 rows) onto the dashed box.
4. **Restore demo data** (at the bottom of the tracker) puts the starting data back at any time.

The exchange-rate feature needs an internet connection; everything else works offline. The Lab 2 video captions still need the page served over HTTP (`python -m http.server`), because Chrome blocks `.vtt` files on `file://`.

```
LAB_3/
  index.html            the page (Lab 2 + the new Chapter 03 section)
  styles.css            Lab 2 styles + section 14 (tracker) + section 15 (visual refresh)
  js/model.js           data model: categories, transaction record, validation, store, demo data
  js/categoriser.js     the intelligent enhancement: a category assistant that learns
  js/insights.js        data processing: pure functions (filter, totals, patterns, forecast)
  js/services.js        asynchronous work: live exchange rates, statement import
  js/app.js             the interface: events, rendering, form, import, table
  js/motion.js          visual refresh: word splitting, film play/pause, top bar state, scroll-spy
  data/                 two sample bank statements (CSV) for the importer
  evidence/             23 screenshots (listed in section 10)
  assets/               Lab 2 images, video and captions, plus the opening film (opening-loop.webm/.mp4, opening-poster.jpg)
  Lab3_Hardcoded.html   the hardcoded starting version, kept for comparison
  AI_Log.docx           the AI usage log
```

---

## 1. Problem analysis

**The problem.** A student or young earner usually knows their monthly budget but finds out they went over it only at the end of the month. The information that would warn them earlier is already in their bank statement, but a statement is a long, uncategorised list. Three things are hard to see in it:

- **Pace:** "₹2,500 on food by the 18th" means nothing until you compare it with the budget and the days left.
- **Fixed commitments:** rent and subscriptions repeat every month and quietly take part of the income before any choice is made.
- **Mistakes:** a large one-off purchase, or the same order charged twice, is easy to miss among 100 lines.

**Requirements derived from that.**

| # | Requirement | Where it is met |
|---|---|---|
| R1 | Record a transaction quickly, with a sensible category, in rupees or a foreign currency | Form (section 4), category assistant (section 6), live rate (section 5A) |
| R2 | Bring in a whole bank statement without typing it | CSV import (section 5B) |
| R3 | Refuse or explain bad data rather than storing it | Validation in `model.js`, row checks in `services.js` |
| R4 | Compare spending with the budgets the user already set | Budget check, which reads the Chapter 02 ledger |
| R5 | Tell the user where the month is heading, not just where it is | Month-end forecast (section 3) |
| R6 | Point out patterns: commitments, unusual spends, double charges | Insight cards (section 3) |
| R7 | Find, filter, correct and delete entries; keep them between visits | Table, filters, edit, delete with undo, `localStorage` |

**Information to manage.** Each transaction has a date, a description, an amount, a type (money in or out), a category, who chose the category (the user or the assistant), where it came from (demo, typed, imported) and, if foreign, the original currency, amount and rate. Budgets are **not** stored again: they are read from the Chapter 02 ledger so there is one source for each fact.

## 2. Data modelling

| Structure | Kind | Where | Why this structure |
|---|---|---|---|
| Transaction | **Object** (frozen) | `createTransaction()` in `model.js` | One record per payment. Frozen, so it can only change through `store.update()`, which validates again. |
| Amount | integer **paise** | `tx.paise` | ₹12.50 is stored as 1250. Integer maths never drifts (0.1 + 0.2 ≠ 0.3 in floating point). |
| Store | **Map** id → transaction | `TransactionStore` | O(1) get, update and delete by id; keeps insertion order. |
| Lists for processing | **Arrays** | `store.all()`, every function in `insights.js` | `filter`, `map`, `reduce`, `sort` read naturally and do not change the store. |
| Categories | **Map** id → `{label, ledger, keywords}` | `CATEGORIES` | Ordered like the ledger, with O(1) lookup; `ledger` links each category to its budget radios (`b1`–`b7`). |
| Validation errors | **Map** field → message | `ValidationError.errors` | All problems are reported at once, in a known order. |
| Allowed values | **Set** | `TYPES`, `SOURCES`, `CATEGORY_SOURCES`, `NOISE_WORDS` | Membership tests (`has`) in O(1). |
| Category filter | **Set** | `state.filters.categories` | Ticking and unticking a chip is `add`/`delete`; an empty Set means "all". |
| Distinct counts | **Set** | `summarise()`, `listMonths()`, `renderKnownDescriptions()` | A Set removes repeats for free. |
| Duplicate fingerprints | **Set** | `readStatement()` | Checking each imported row against thousands of existing ones is O(1) per row. |
| Totals and groups | **Map** | `totalsByCategory()`, `groupBy()`, `topMerchants()`, `findDuplicates()` | Key → running total, built in one pass. |
| Learned categories | **Map** of **Map**s | `Categoriser.#learned` (merchant → category → count) | Counts votes per merchant. |
| Budgets | **Map** category → paise | `readBudgets()` in `app.js` | Read fresh from the ledger whenever it changes. |

**Supporting change.** Records can be added, edited, deleted (with undo), imported in bulk, exported, restored to the demo data or cleared. Every change goes through the store, which saves to `localStorage` and fires one `change` event; the interface listens to that one event and redraws. Saved data is validated again when it is loaded, so a damaged record is skipped (and the user told) instead of breaking the page.

## 3. Data processing (`js/insights.js`)

All of these are pure functions: they take an array and return new data, so each can be tested alone.

| Function | What it does | Notes |
|---|---|---|
| `filterTransactions` | Search (description, category name or an exact amount such as `486`), multi-category filter, type, month, and four sort orders | Chained `filter` calls, then `sort` |
| `summarise` | Money in, money out, net, savings rate, categories used | `reduce` + a Set |
| `totalsByCategory` | Spending per category | One pass into a Map |
| `detectRecurring` | Monthly commitments: at least 3 payments to the same merchant, 25–35 days apart, within 15% of the usual amount; predicts the next date | Groups by a **merchant key** that strips UPI references and numbers, so `UPI/SWIGGY/4475510` and `Swiggy order` group together |
| `detectUnusual` | Spends far above normal **for their own category**, using the median and median absolute deviation (a "modified z-score" above 3.5) and at least 2.5× the usual amount | The median is not dragged up by the outlier itself, unlike an average. Recurring bills are left out. With 50+ spends the statistics are computed once per category (O(n log n) instead of O(n² log n)). |
| `findDuplicates` | Same merchant and amount at most a day apart | Sorted once, then each row is compared only with the last one seen for its merchant + amount |
| `topMerchants` | Where most money went | Map + sort |
| `budgetReport` | Spent, budget, **month-end forecast** and status per category | See below |

**The forecast.** Dividing "spent so far" by the days gone and multiplying by the days in the month is wrong for fixed costs: rent paid on the 4th would be counted again. The forecast therefore splits spending:

- **fixed** = recurring bills already paid + recurring bills still due this month (e.g. Spotify on the 21st) + one-off unusual spends
- **variable** = everything else, projected at the current daily pace

For the demo data on 18 November this gives Dining out ₹2,502 now and ₹4,170 forecast (budget ₹3,000), so the row says **"Heading over by ₹1,170"** while there is still time to act.

## 4. Interactive functionality and event handling (`js/app.js`)

| Event | Element | Result |
|---|---|---|
| `submit` | Form | Validates, converts currency (async), checks for a duplicate, then adds or saves |
| `input` | Description | Category suggestion updates as you type |
| `input` (debounced 150 ms) | Search | Table filters without re-rendering on every key |
| `blur` | Each field | That field is checked when you leave it (not while you are still typing) |
| `change` | Currency | Starts the rate request; a newer choice cancels an older request |
| `change` / `reset` | **Chapter 02 ledger** | Budget check recalculates from the new budgets |
| `change` | Month picker, type filter, sort, category chips | Redraws the stats, budget check, insights and table |
| `click` (event delegation) | One listener on the whole tracker | Edit and Delete for every row, and "Delete copy" in the duplicates card |
| `dragenter`/`dragover`/`dragleave`/`drop` | Drop zone | Highlight and import; a file dropped elsewhere does not navigate the browser away |
| `keydown` Escape | Form | Cancels editing |
| custom `change` (`CustomEvent`) | The store (an `EventTarget`) | The single place where the interface redraws |

**Incomplete, invalid or unexpected input.**

| Input | What happens |
|---|---|
| Empty form submitted | All problems listed in one summary at the top (focused, in field order), each linking to its field; each field marked `aria-invalid` with its own message |
| `12abc`, `-50`, `12.345`, `₹50,00,00,00,000` | Explained: not a number / no minus sign (choose Money out instead) / at most two decimals / "more than ₹1 crore, check for an extra zero" |
| `1,250` or `₹ 450` | Accepted. The amount box is `type="text"` with `inputmode="decimal"` because a `type="number"` box returns an empty string for these, so "empty" and "wrong" could not be told apart |
| `!!!` as description | Refused: needs a letter or digit |
| A date in the future, 31 February | Refused with the reason |
| `<img onerror=…>` as description | Shown as text. Nothing user-typed is ever inserted as HTML (`textContent` only) |
| The same payment entered twice | "This looks like a repeat of … Add it anyway / Don't add" |
| Double-clicking Add | The button is disabled while a submit runs, so only one entry is added |
| Damaged saved data | Bad records skipped and counted; unreadable storage restores the demo data with a message |
| Storage blocked (private mode, quota) | The tracker keeps working in memory and says changes will not be kept |

## 5. Asynchronous behaviour (`js/services.js`)

### A. Live exchange rate (network)
Choosing USD, EUR, GBP, AED or SGD fetches the European Central Bank reference rate from the free [Frankfurter](https://frankfurter.dev/) API and shows the rupee value as you type. The form stays fully usable while the request runs.

| Situation | Handling |
|---|---|
| Success | `1 USD = ₹93.48 (ECB reference rate for 17 Nov 2026). 15 USD ≈ ₹1,402.20.` Cached for 12 hours. |
| Server error (5xx), network error, timeout (6 s) | One retry after a short back-off; 4xx and bad data are not retried |
| Reply is not JSON, or has the wrong shape / base / an impossible rate | Refused as "not a valid rate"; nothing from another server is trusted unchecked |
| Offline but a rate was saved earlier | Used, with a clear warning: "Offline, so using the rate saved 2 days ago" |
| No rate at all | Error with a **Try again** button; submitting is blocked with advice to enter the rupee amount |
| User switches currency mid-request | The older request is aborted (`AbortController`), and a token check stops a slow old reply overwriting the newer one |

### B. Bank-statement import (large data)
`file.text()` reads the file asynchronously; the rows are then parsed and checked in **time slices of about 12 ms**, yielding to the browser between slices (and at least every 2,000 rows). A progress bar and a **Cancel** button work during the import. The result is a preview (ready / auto-categorised / already recorded / skipped with reasons per line); nothing is added until the user confirms.

The parser follows the CSV rules (quoted fields containing commas, doubled quotes, CRLF, a byte-order mark from Excel), recognises the column names Indian banks use (Narration, Withdrawal Amt, Deposit Amt, Dr/Cr…), and reads `05/11/2026`, `2026-11-05` and `05 Nov 2026` dates and `₹1,23,456.50`, `(250.00)` and `1,200 Dr` amounts. It refuses non-CSV files, empty files, files over 5 MB, binary files, and files with no Date/Description/Amount columns, naming what is missing.

### Evaluation
Measured in Chromium with a 60,000-row statement (`PerformanceObserver` long tasks + a 16 ms timer counting how often the page got a turn):

| | Longest freeze | Timer turns during import | Total time |
|---|---|---|---|
| All rows in one go | **804 ms** (the page could not respond) | 4 | 0.81 s |
| Time-sliced (final) | **no task over 50 ms** | 73 | 1.15 s |

Slicing costs about 40% more total time but the page never freezes, so it is the right trade for something the user watches. The 5,498-row sample imports in about 0.1 s.

**Choices I rejected, and why.** A Web Worker would move the parsing off the main thread completely, but Chrome refuses to start a Worker from a page opened with `file://`, which is how this lab is opened. `scheduler.yield()` was tried first: it puts the import back at the front of the queue, and in testing it starved other timers (including the rate request's 6-second timeout) until the import finished, so a plain `setTimeout(0)` yield is used. The hardcoded version's `setTimeout(700)` "analysis" was removed: it added a delay to work that was synchronous anyway and made nothing non-blocking.

## 6. Intelligent enhancement: a category assistant that learns (`js/categoriser.js`)

**Why it is needed.** A bank statement has no categories. Without help, every imported row would fall into "Everything else" and the budget check would be meaningless; the alternative is choosing a category for every row by hand. It also speeds up typing entries one by one.

**How it works.** For any description it suggests a category, and says why:

1. **Learned:** "Suggested Dining out, because you filed 6 of 6 earlier 'swiggy' entries here" (majority vote of the user's own choices for that merchant).
2. **Keyword:** "because the word 'uber'" (whole-word match; longest keyword first, so "mobile recharge" beats "recharge").
3. **No match:** the form asks the user to choose; an imported row is marked **check** in the table.

When the user edits a category, the assistant learns it immediately (the learned rules are rebuilt from the data, so deleting an entry also forgets what it taught).

**Safeguard against a feedback loop.** It learns only from categories the **user** chose. If it learned from its own guesses, one wrong guess during an import would be copied to every later row from that merchant and would never be corrected. Imported rows it categorised are marked **auto** so the user can see and fix them.

On the sample statement (17 new expense rows, none with a category) it placed 7 from what it had learned (including `UPI/SWIGGY/4475510` → Dining out) and 8 from keywords, all correctly, and flagged the other 2 ("Sharma Tailors", "Movie tickets") for checking rather than guessing.

Two smaller additions that support the same goal of reliability: the **duplicate guard** on every new entry and import, and the **forecast** that understands fixed and one-off costs (section 3).

## 7. JavaScript concepts and where to find them

| Concept | Where |
|---|---|
| Objects, frozen records, classes, private fields (`#items`), getters, `extends EventTarget`, custom `Error` subclasses | `model.js`, `categoriser.js`, `services.js` |
| Arrays: `map`, `filter`, `reduce`, `sort`, `find`, `some`, `every`, `slice`, `flatMap`, `at`, spread | throughout `insights.js` |
| Sets and Maps | section 2 table |
| Destructuring, default parameters, optional chaining `?.`, nullish `??`, template literals, numeric separators | throughout |
| Generators (`function*`) | `csvRows()` streams CSV rows |
| Closures, IIFE modules, higher-order functions (`debounce`, `groupBy`) | every file |
| Event handling: listeners, delegation, `preventDefault`, custom events, drag and drop, keyboard | section 4 |
| Promises, `async`/`await`, `try`/`catch`/`finally`, `AbortController`, `fetch`, `file.text()`, retry with back-off, timeout | `services.js`, `onSubmit()` and `startImport()` in `app.js` |
| DOM: building elements safely (`h()`), `replaceChildren`, `dataset`, CSS custom properties from JS, focus management | `app.js` |
| Web APIs: `localStorage`, `Intl.NumberFormat` (Indian digit grouping), `Intl.DateTimeFormat`, `Blob` + `URL.createObjectURL` (export), `PerformanceObserver` (evaluation) | `model.js`, `app.js`, tests |
| Regular expressions with Unicode (`\p{L}`) | validation and parsing |

## 8. Critical evaluation of AI assistance

AI (Claude) was used as a development assistant. The full prompt log is in `AI_Log.docx`. Two kinds of evaluation were done.

### 8a. The hardcoded starting version (`Lab3_Hardcoded.html`)
The starting point added a small tracker to the Lab 2 page. I kept its idea (an add form, a summary, search, an "analyse" button) and its seed entries (now the Chapter 02 receipt), and changed the rest:

| Limitation found | Why it matters | What I changed |
|---|---|---|
| Descriptions inserted with `innerHTML` | Typing `<img src=x onerror=…>` would run code (cross-site scripting) | All text inserted with `textContent` via a small element builder; tested |
| "Async" analysis was `setTimeout(700)` around synchronous code | Slower, and nothing was actually non-blocking; no real failure case | Two real async operations: a network request with timeout/retry/fallback, and a time-sliced import with cancel |
| Unusual = more than 1.7× the average of **all** expenses | Rent (₹12,000) is flagged every month; small categories never are | Per-category median/MAD with a 2.5× floor; recurring bills excluded |
| No dates on transactions | No months, no forecast, no recurring detection possible | Every record has a validated date |
| Amounts as floats (`step="0.01"`) | Totals drift | Integer paise |
| "Income" offered as a category next to a type select | Contradictory states (an "Income" expense) | Type decides; income has a fixed category |
| Category names differed from the ledger ("Dining" vs "Dining out") and budgets were ignored | No link between plan and spending | Same seven categories; budgets read live from the ledger |
| The category-totals `Map` was built and never used; the `Set` only counted | Concepts present but not doing work | Every Set and Map now drives a feature (section 2) |
| One generic error message; placeholders instead of labels | Hard to fix mistakes; inaccessible | Per-field messages, error summary, labels, `aria-invalid`; axe-core finds 0 issues |
| No edit, delete, persistence or import | A refresh lost everything; "only basic CRUD" would not even be complete | Edit, delete + undo, `localStorage`, CSV import/export |
| Section placed outside any `<section>`, inline `<style>` with fixed colours, minified one-line script, `styles.css` and `assets/` missing from the folder | Broken page structure, no dark mode, unreadable code, unstyled page | A proper Chapter 03 section, styles in `styles.css` using the design tokens (dark, high-contrast and print modes work), readable commented files, assets copied |

### 8b. Mistakes in the AI's own suggestions during this build (caught by testing)

| AI suggestion | Problem found | Fix |
|---|---|---|
| Forecast = spent ÷ days × month length (with recurring bills separated) | Still projected the one-off ₹8,999 headphones forward: Shopping forecast ₹17,163 | One-off unusual spends count as fixed: ₹11,164 |
| Unusual if modified z-score > 3.5 | Flagged a ₹1,070 gift (1.9×) because the "Everything else" category is small and varied | Also require 2.5× the usual amount |
| Next payment = last date + median gap | Rent due "5 Dec" instead of 4 Dec | Add one calendar month |
| `scheduler.yield()` for the import | Starved other timers until the import finished | `setTimeout(0)` (see section 5) |
| Time-only slicing | With a frozen clock (as in automated tests, or some privacy settings) it never yielded | Also yield every 2,000 rows |
| `1fr` grid columns | The form forced the page to 537 px wide on a 320 px phone | `minmax(0, 1fr)` |
| Budget table scrolls sideways on phones | Scroll area not reachable by keyboard (axe) | Card layout on narrow screens |
| Other small ones | "Try again" button printed as `[object HTMLButtonElement]`; a red error border lost to CSS specificity; error summary out of order; a zero amount reported as "not a number" | Fixed and re-tested |

**Justification of the final implementation.** Plain scripts instead of ES modules and time-slicing instead of a Worker both follow from one constraint: the lab is opened by double-clicking `index.html`. Integer paise, frozen records and one store that fires one event keep the data correct and the code easy to follow. Robust statistics (median, MAD) were chosen over averages because personal spending is lumpy, and a single large purchase should not change what counts as normal.

## 9. Testing (Chromium via Playwright)

74 functional checks and 16 motion checks (section 13), 0 failures. The functional checks cover: the seed data and every insight; each validation rule; suggestions (learned, keyword, none); add, XSS, duplicate guard; edit, delete and undo; search, amount search and chip filters; the ledger driving the budget check; persistence, corrupt and partly damaged storage; the sample import (26 rows: 18 ready, 3 already recorded, 5 refused with reasons; quoted commas; credit column); five kinds of bad file; the large import, cancel mid-import and the blocking comparison; export and re-import (all detected as duplicates); the exchange rate with a mocked network (success, 500 with one retry, bad JSON, network failure, stale cache, timeout, the currency-switch race); no horizontal scroll at 1280, 390 and 320 px; and **axe-core 0 violations** (WCAG 2.1 A/AA + best practice) in the tracker in light, dark and phone layouts. The print stylesheet keeps the numbers and hides the controls.

## 10. Evidence (`evidence/`)

| File | Shows |
|---|---|
| `01-tracker-full-desktop.png` | The whole chapter |
| `02-form-budget-check.png`, `03-insights-patterns.png` | Budget check with forecast; commitments, unusual spend, double charge, category bars |
| `04-validation-errors.png` | Error summary and per-field messages |
| `05-category-learned-suggestion.png`, `13-imported-auto-categorised.png` | The enhancement while typing and after an import |
| `06-duplicate-warning.png` | Duplicate guard |
| `07-chapter02-live-receipt.png`, `08-chapter02-payment-alert.png` | Chapter 02 now shows the latest entries and the double charge |
| `09-edit-mode.png`, `10-delete-undo-toast.png`, `11-filter-search-sort.png` | Editing, undo, filtering |
| `12-import-preview-with-errors.png`, `19-large-import-progress.png`, `20-import-cancelled.png` | Import preview with reasons, progress, cancel |
| `14-budget-follows-ch02-ledger.png` | Budget changed in Chapter 02, tracker updated |
| `15`–`18` | Exchange rate: live, offline with a saved rate, error with Try again, loading |
| `21`–`23` | Phone (390 px), dark mode |
| `24-opening-scroll-sequence.png`, `25-phone-opening-sequence.png` | The opening film at six (desktop) and four (phone) scroll positions |
| `26-chapter-entrances.png` | Headings, statement and diagonal wipes arriving |

## 11. Demonstration plan (about 4 minutes)

0. **Opening:** load the page (the curtain lifts), then scroll slowly: the manifesto lights up, the film closes into a window and the masthead turns to ink.
1. **Problem:** the budget check for November: Shopping already over (the headphones), Dining "heading over" by the forecast, Spotify and Cult.fit still due.
2. **Patterns:** commitments (₹16,793 a month), the unusual purchase, the double charge, then "Delete copy" and **Undo**.
3. **Validation:** submit an empty form, then `12abc`, then a future date.
4. **Enhancement:** type "Swiggy order" (learned), "Uber to airport" (keyword), "Sharma Tailors" (no match).
5. **Async 1:** switch currency to USD; turn Wi-Fi off and switch again to show the saved-rate warning or the error and Try again.
6. **Async 2:** drop `sample-statement.csv` (reasons for the 5 bad rows, 3 duplicates), add it, then drop `large-statement.csv` and press Cancel.
7. **Link to Lab 2:** change a budget in the Chapter 02 ledger and show the tracker follow.

## 12. Limitations

- Recurring detection needs three payments about a month apart; a missed month or a fortnightly bill is not detected.
- The forecast assumes the rest of the month looks like the days so far.
- The category assistant matches whole descriptions and keywords; it does not understand new merchant names.
- Data lives in this browser only (`localStorage`); there is no account or sync.
- Exchange rates are ECB reference rates (one per working day), not what a card actually charged.
- The immersive scroll needs CSS scroll-driven animations (Chrome and Edge 115+, Safari 26); other browsers show the same page without the scroll effects.
- Tested in Chromium only. Some styles use `:has()`, which older browsers lack (the page still works, without some highlights).

## 13. Visual refresh: an immersive scroll

**References studied.** [JJETTAS](https://jjettas.com/) opens with a full-screen video. As you scroll, the page holds still on a pinned stage while the picture and the copy change in place, a quote lights up word by word on a dark panel, and sections enter with diagonal edges. [AUGE](https://auge-xp.com/) opens with a wordmark intro and uses one warm off-white paper, near-black type and a single accent. Its type slides up from behind its own line, and every movement eases out slowly. I took those ideas, not the code or assets.

**What changed, in order down the page.**

| Piece | What happens | How |
|---|---|---|
| Intro curtain | "FINTRACK" rises, then the curtain lifts (once per visit) | CSS keyframes; `sessionStorage` skips it on reload |
| Opening film | A full-screen loop of glowing "market lines" with the masthead and the manifesto over it | My own 10-second loop, drawn frame by frame in Python/NumPy, 0.6 MB (WebM + MP4) |
| Pinned stage | The opening is 2.6 screens tall and its stage sticks: the manifesto lights word by word, then the film closes into a rounded window, the stage turns to paper and the masthead turns from ivory to ink | `position: sticky` + a named view timeline (`--opening`) and `animation-range` |
| Glass top bar | Dark glass over the film, paper elsewhere; a jade-brass-vermilion progress line under it | `IntersectionObserver` + `scroll(root)` timeline |
| Headings | Each chapter title rises from behind its own baseline | `overflow: clip` + view timeline |
| Statement | "This month, ₹65,000 came in…" lights up as you read it | the same word-by-word technique |
| Earn · Spend · Save strip | Moves with the scroll instead of on its own | view timeline |
| Spending, Calculator, Footer | Arrive on a diagonal edge that straightens | animated `clip-path` |
| Chapter numbers | Drift slower than the page (parallax) | view timeline on `translate` |
| Stats, panels, cards | Arrive one after another with a long, soft settle | staggered `animation-range` |
| Top bar | Underlines the chapter you are reading | `IntersectionObserver` sets `aria-current` |
| Tracker month switch | Cross-fades instead of snapping | View Transitions API |

**Palette.** The same identity (ivory paper, navy, jade, vermilion, brass), refined: a cleaner ivory (`#f3efe6`), a deeper midnight ink (`#0c1424`), richer jewel accents, a brass glow and a fine paper grain. Every text pair was rechecked: all pass WCAG AA in light and dark mode (e.g. ink on paper 16.0:1, jade text 6.0:1, vermilion text 5.7:1).

**Performance.** All scroll effects are CSS scroll-driven animations that change only `transform`, `opacity` and `clip-path`, so the browser runs them off the main thread. There are no scroll event listeners. JavaScript only splits words once at load and uses `IntersectionObserver` for the film and the top bar. The film plays only while visible, and is paused when the tab is hidden or the user has Data Saver on. Measured while wheel-scrolling the whole page in headless Chromium: 0 long tasks, median frame 16.7 ms (60 fps), 1 frame over 33 ms out of 367.

**Accessibility and fallbacks.**
- **Reduced motion:** no film playback, no curtain, no pinning and no word dimming; the page is the static layout.
- **Film control:** the film has a pause/play button (WCAG 2.2.2), labelled for screen readers with `aria-pressed`.
- **Split words:** the manifesto still reads as one sentence to screen readers and copy-paste.
- **Older browsers:** a browser without scroll-driven animations gets the same static layout.
- **Higher contrast and print:** high-contrast mode never shows dimmed words; print drops the film and prints the masthead in black.
- **Checks:** axe-core finds 0 violations on the whole page with motion on and with reduced motion, and there is no horizontal scroll at 390, 320 and 640 px (200% zoom).

**What I deliberately did not copy.** AUGE hijacks the mouse wheel to drive a horizontal gallery. On a page with forms and a data table, that would fight keyboard and screen-reader users, so native scrolling is kept. I also left out a smooth-scroll library for the same reason: Chrome on Windows already smooths the wheel.

**Mistakes caught while building it.** Chrome would not compute `var()` maths inside `animation-range`, so the manifesto never lit up; each word's range is now set by `motion.js`. A more specific rule stopped "FIN" turning to ink, so it vanished on paper. The sticky top bar pushed the stage down and cut off the masthead, so the film now runs under the glass bar. And the first screenshots were caught mid-way through the page's smooth scroll.

## 14. Credits

Opening film (`opening-loop.webm/.mp4`, `opening-poster.jpg`): drawn by me in Python (NumPy) and encoded with ffmpeg; own work. Exchange rates: [Frankfurter](https://frankfurter.dev/) (European Central Bank reference rates, no key). Demo transactions and sample statements: generated for this lab. Lab 2 media credits are unchanged (see `LAB_2/README.md`).
