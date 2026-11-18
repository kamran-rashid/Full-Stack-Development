/* FinTrack Pocket - automated test suite (Playwright, Chromium).
   Runs the five required test cases from the brief, the error-handling cases,
   and responsive/accessibility checks. Screenshots are saved to ../evidence.

   Setup (once):  npm install playwright axe-core && npx playwright install chromium
   Run:           node tests/test-suite.mjs            (from the Classroom_Task_1 folder)
*/
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_FILE = pathToFileURL(path.join(HERE, '..', 'index.html')).href;
const URL = process.env.POCKET_URL || URL_FILE;
const EV = path.join(HERE, '..', 'evidence') + path.sep;
const GEO = { latitude: 12.9343, longitude: 77.6060, accuracy: 25 };
const results = [];
let current = '';
const ok = (cond, name, extra = '') => { results.push({ test: current, name, pass: !!cond }); console.log(cond ? '  ✓' : '  ✗', name, cond ? '' : extra); };
const section = (t) => { current = t; console.log('\n' + t); };
const shot = (page, name, opts = {}) => page.screenshot({ path: EV + name, ...opts });
const ready = (page) => page.waitForSelector('body.ready');
const idbAll = (page, store) => page.evaluate((s) => new Promise((res, rej) => { const r = indexedDB.open('fintrack-pocket'); r.onsuccess = () => { const q = r.result.transaction(s).objectStore(s).getAll(); q.onsuccess = () => { res(q.result); r.result.close(); }; q.onerror = rej; }; r.onerror = rej; }), store);

async function addExpense(page, amount, note, category = 'food') {
  await page.fill('#amount', String(amount)); await page.fill('#note', note); await page.selectOption('#category', category);
  await page.click('#save');
  await page.waitForFunction((n) => Pocket.app.state.expenses.some(e => e.note === n), note);
}
async function saveSettings(page, { name, theme, budget }) {
  await page.click('#open-settings');
  if (name !== undefined) await page.fill('#pref-name', name);
  if (theme) await page.check(`#theme-${theme}`);
  if (budget !== undefined) await page.fill('#pref-budget', String(budget));
  await page.click('#settings-save');
}

const browser = await chromium.launch();

/* ---------------- TEST 1: close and reopen the browser ---------------- */
section('Test 1 - Close and reopen the browser (Local Storage + IndexedDB persist, Session Storage does not)');
const profile = fs.mkdtempSync('/tmp/pocket-profile-');
let pctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 860 }, geolocation: GEO, permissions: ['geolocation'] });
let page = pctx.pages()[0] || await pctx.newPage();
await page.goto(URL); await ready(page);
await shot(page, '01-first-visit.png');
await saveSettings(page, { name: 'Kamran', theme: 'dark', budget: 12000 });
await addExpense(page, 240, 'Canteen lunch');
await page.click('#tab-insights'); await page.click('#analyse');
await page.waitForFunction(() => /Last analysed/.test(document.querySelector('#analysis-when').textContent));
await page.fill('#amount', '75'); await page.fill('#note', 'Half-typed chai'); await page.waitForTimeout(400);   // a draft in Session Storage
const before = await page.evaluate(() => ({ tab: Pocket.store.tab.get().tabId, draft: Pocket.store.tab.get().draft }));
ok(before.draft?.note === 'Half-typed chai', 'draft is in Session Storage before closing');
await page.reload(); await ready(page);
ok(await page.inputValue('#note') === 'Half-typed chai' && await page.isVisible('#draft-tag'), 'a reload restores the draft (same tab session)');
await shot(page, '02-before-closing-browser.png');
await pctx.close();                                                      // the whole browser closes

pctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 860 }, geolocation: GEO, permissions: ['geolocation'] });
page = pctx.pages()[0] || await pctx.newPage();
await page.goto(URL); await ready(page);
const after = await page.evaluate(() => ({ greeting: document.querySelector('#greeting').textContent, theme: document.documentElement.dataset.theme, prefs: Pocket.app.state.prefs, n: Pocket.app.state.expenses.length, analysis: !!Pocket.app.state.lastAnalysis, tab: Pocket.store.tab.get().tabId, draft: Pocket.store.tab.get().draft, note: document.querySelector('#note').value }));
ok(/Welcome back, Kamran/.test(after.greeting), 'Local Storage: name remembered ("Welcome back, Kamran")', after.greeting);
ok(after.theme === 'dark' && after.prefs.monthlyBudget === 12000, 'Local Storage: dark theme and ₹12,000 budget remembered');
ok(after.prefs.visits === 2, 'Local Storage: visit counter is 2');
ok(after.n === 1, 'IndexedDB: the expense is still there');
ok(after.analysis && /Last analysed/.test(await page.innerText('#analysis-when')), 'IndexedDB: the last analysis is shown again automatically');
ok(!after.draft && after.note === '' && after.tab !== before.tab, 'Session Storage: the draft and tab session are gone (new session)');
await page.click('#tab-insights');
await shot(page, '03-after-reopening-browser.png');
await pctx.close();

/* ---------------- TEST 2: two tabs ---------------- */
section('Test 2 - Two tabs (Session Storage is per tab; Local Storage and IndexedDB are shared)');
let ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, geolocation: GEO, permissions: ['geolocation'] });
const A = await ctx.newPage(); await A.goto(URL); await ready(A);
await A.click('#load-sample'); await A.waitForTimeout(300);
await A.click('#tab-insights');
await A.selectOption('#stress-size', '100000');
await A.fill('#note', 'Draft only in tab A'); await A.waitForTimeout(400);
const B = await ctx.newPage(); await B.goto(URL); await ready(B);
const sa = await A.evaluate(() => Pocket.store.tab.get()), sb = await B.evaluate(() => Pocket.store.tab.get());
ok(sa.tabId !== sb.tabId, `different tab ids (${sa.tabId} vs ${sb.tabId})`);
ok(sa.view === 'insights' && sb.view === 'diary', 'each tab keeps its own view');
ok(sa.draft?.note === 'Draft only in tab A' && !sb.draft, 'the draft exists only in tab A');
ok(sa.activity.length > sb.activity.length, `activity logs differ (${sa.activity.length} vs ${sb.activity.length})`);
ok(await B.evaluate(() => Pocket.app.state.expenses.length) === 40, 'IndexedDB is shared: tab B sees the 40 sample expenses');
await saveSettings(B, { budget: 9000 });
await A.waitForFunction(() => Pocket.app.state.prefs.monthlyBudget === 9000, null, { timeout: 5000 });
ok(/another tab/.test(await A.innerText('#toast')), 'Local Storage "storage" event: tab A picks up the new budget from tab B at once');
await shot(A, '04-tab-A.png'); await shot(B, '05-tab-B.png');
await ctx.close();

/* ---------------- TEST 3: IndexedDB add / update / delete ---------------- */
section('Test 3 - IndexedDB: add, retrieve, update, delete');
ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, geolocation: GEO, permissions: ['geolocation'] });
page = await ctx.newPage(); await page.goto(URL); await ready(page);
await addExpense(page, 180, 'Metro to college', 'transport');
let rows = await idbAll(page, 'expenses');
ok(rows.length === 1 && rows[0].amount === 18000 && rows[0].location?.lat === 12.9343, 'ADD: record stored (amount in paise, with location)');
await shot(page, '06-idb-add.png');
await page.click('button[data-action=edit]');
await page.fill('#amount', '210'); await page.fill('#note', 'Metro + auto to college'); await page.click('#save');
await page.waitForFunction(() => Pocket.app.state.expenses[0].amount === 21000);
rows = await idbAll(page, 'expenses');
ok(rows.length === 1 && rows[0].amount === 21000 && rows[0].note === 'Metro + auto to college' && rows[0].updatedAt > rows[0].createdAt, 'UPDATE: same id, new amount and note, updatedAt changed');
await shot(page, '07-idb-update.png');
await page.reload(); await ready(page);
ok(await page.evaluate(() => document.querySelector('#diary').textContent.includes('Metro + auto to college')), 'RETRIEVE: listed again automatically after reload');
await page.click('button[data-action=delete]');
await page.waitForTimeout(200);
ok((await idbAll(page, 'expenses')).length === 0, 'DELETE: record removed from IndexedDB');
await shot(page, '08-idb-delete-undo.png');
await page.click('#toast button');
await page.waitForTimeout(200);
ok((await idbAll(page, 'expenses')).length === 1, 'UNDO: record put back');
// places + the byPlace index
await page.click('#tab-near'); await page.fill('#place-name', 'College'); await page.click('#place-form button');
await page.waitForFunction(() => Pocket.app.state.places.length === 1);
let exp = await idbAll(page, 'expenses');
ok(exp[0].placeId === (await idbAll(page, 'places'))[0].id, 'saving a place labels the earlier expense recorded there');
await page.click('button[data-action=delete-place]'); await page.waitForTimeout(200);
exp = await idbAll(page, 'expenses');
ok((await idbAll(page, 'places')).length === 0 && exp[0].placeId === null && exp[0].location, 'deleting the place unlinks it (found via the byPlace index) but keeps coordinates');
await ctx.close();

/* ---------------- TEST 4: location denied, and other location failures ---------------- */
section('Test 4 - Location permission denied (and unavailable, timeout, unsupported)');
ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });             // no permission granted
await ctx.clearPermissions();
page = await ctx.newPage(); await page.goto(URL); await ready(page);
await page.fill('#amount', '60'); await page.fill('#note', 'Chai'); await page.click('#save');
await page.waitForFunction(() => Pocket.app.state.expenses.length === 1, null, { timeout: 15000 });
ok(/permission is turned off/.test(await page.innerText('#location-hint')) && (await idbAll(page, 'expenses'))[0].location === null, 'the expense is still saved, without a location, with an explanation');
ok(/Location is blocked/.test(await page.innerText('#notices')), 'a notice explains what still works');
ok(/Geolocation blocked/.test(await page.innerText('#api-status')), 'the status line shows Geolocation blocked');
await shot(page, '09-location-denied-form.png');
await page.click('#tab-near'); await page.click('#find-near');
await page.waitForFunction(() => /permission/.test(document.querySelector('#near-status').textContent));
await shot(page, '10-location-denied-near-me.png');
ok(true, '"Near me" shows the denied message instead of crashing');
await ctx.close();
for (const [code, kind, re] of [[2, 'unavailable', /could not find its position/], [3, 'timeout', /took too long/]]) {
  ctx = await browser.newContext();
  await ctx.addInitScript((c) => { navigator.geolocation.getCurrentPosition = (ok, err) => setTimeout(() => err({ code: c, message: 'test' }), 50); }, code);
  page = await ctx.newPage(); await page.goto(URL); await ready(page);
  await page.click('#tab-near'); await page.click('#find-near');
  await page.waitForFunction((r) => new RegExp(r).test(document.querySelector('#near-status').textContent), re.source);
  ok(true, `position ${kind}: explained ("${re.source.replace(/\\/g, '')}")`);
  await ctx.close();
}
ctx = await browser.newContext();
await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'geolocation', { get: () => undefined }); delete Navigator.prototype.geolocation; });
page = await ctx.newPage(); await page.goto(URL); await ready(page);
await page.click('#tab-near'); await page.click('#find-near');
await page.waitForTimeout(300);
ok(/cannot share a location/.test(await page.innerText('#near-status')), 'no Geolocation API at all: explained');
await ctx.close();

/* ---------------- TEST 5: large dataset in a Web Worker ---------------- */
section('Test 5 - Large dataset in a Web Worker while the page stays responsive');
ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, geolocation: GEO, permissions: ['geolocation'] });
page = await ctx.newPage(); await page.goto(URL); await ready(page);
await page.click('#tab-insights');
await page.selectOption('#stress-size', '1000000');
await page.click('#stress-worker');
await page.waitForSelector('#stress-progress:not([hidden])');
let taps = 0; const t0 = Date.now();
while (!(await page.evaluate(() => document.querySelector('#stress-result').textContent.length > 0)) && Date.now() - t0 < 60000) {
  await page.click('#tap'); taps++; await page.waitForTimeout(100);
}
const counted = Number(await page.innerText('#taps'));
const workerRes = await page.innerText('#stress-result');
const workerFreeze = Number(workerRes.match(/LONGEST PAGE FREEZE\s*([\d,]+)/i)?.[1].replace(/,/g, ''));
const workerTime = workerRes.match(/TIME\s*([\d,]+) ms/i)?.[1];
console.log(`     1,000,000 records in the worker: ${workerTime} ms, longest freeze ${workerFreeze} ms, taps counted during the run ${counted}/${taps}`);
ok(workerFreeze < 100, `worker: the page never froze for more than 100 ms (${workerFreeze} ms)`);
ok(counted === taps && taps > 3, `worker: every tap during the run was handled (${counted}/${taps})`);
await shot(page, '11-worker-1-million.png', { fullPage: true });
// cancel
await page.click('#stress-worker'); await page.waitForTimeout(150); await page.click('#stress-cancel');
await page.waitForFunction(() => /Cancelled/.test(document.querySelector('#stress-result').textContent));
ok(true, 'cancel: the worker is stopped and replaced');
// same work on the main thread, for comparison
await page.selectOption('#stress-size', '300000');
await page.evaluate(() => { document.querySelector('#taps').textContent = '0'; });
await page.click('#stress-main');
await page.waitForFunction(() => /MAIN THREAD/i.test(document.querySelector('#stress-result').textContent), null, { timeout: 60000 });
const mainRes = await page.innerText('#stress-result');
const mainFreeze = Number(mainRes.match(/LONGEST PAGE FREEZE\s*([\d,]+)/i)?.[1].replace(/,/g, ''));
console.log(`     300,000 records on the main thread: longest freeze ${mainFreeze} ms`);
ok(mainFreeze > 200, `main thread comparison: the page froze for ${mainFreeze} ms`);
await shot(page, '12-main-thread-freeze.png');
await ctx.close();

/* ---------------- Error handling: storage ---------------- */
section('Error handling - storage unavailable or damaged');
ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.addInitScript(() => { indexedDB.open = () => { throw new DOMException('blocked for the test', 'SecurityError'); }; });
page = await ctx.newPage(); await page.goto(URL); await ready(page);
ok(/Records will only last/.test(await page.innerText('#notices')) && /IndexedDB memory only/.test(await page.innerText('#api-status')), 'IndexedDB unavailable: notice shown, memory-only mode');
await addExpense(page, 99, 'Still works in memory');
ok(true, 'IndexedDB unavailable: expenses can still be added for this tab');
await shot(page, '13-indexeddb-unavailable.png');
await ctx.close();
ctx = await browser.newContext();
await ctx.addInitScript(() => { const block = () => { throw new DOMException('denied', 'SecurityError'); }; Storage.prototype.setItem = block; Storage.prototype.getItem = block; });
page = await ctx.newPage(); await page.goto(URL); await ready(page);
ok(/blocking Local Storage/.test(await page.innerText('#notices')) && /blocking Session Storage/.test(await page.innerText('#notices')), 'Local and Session Storage blocked: notices shown, app still runs');
await shot(page, '14-storage-blocked.png');
await ctx.close();
ctx = await browser.newContext();
await ctx.addInitScript(() => { if (!sessionStorage.getItem('x')) { localStorage.setItem('pocket.prefs.v1', '{not json'); sessionStorage.setItem('x', '1'); } });
page = await ctx.newPage(); await page.goto(URL); await ready(page);
ok(/could not be read/.test(await page.innerText('#notices')) && await page.evaluate(() => Pocket.app.state.prefs.monthlyBudget === 15000), 'damaged settings JSON: defaults used, notice shown');
await ctx.close();
ctx = await browser.newContext();
await ctx.addInitScript(() => { const real = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'pocket.prefs.v1' && v.includes('"name":"Q"')) throw new DOMException('full', 'QuotaExceededError'); return real.call(this, k, v); }; });
page = await ctx.newPage(); await page.goto(URL); await ready(page);
await saveSettings(page, { name: 'Q' });
ok(/storage is full/.test(await page.innerText('#notices')), 'Local Storage full (QuotaExceededError): explained');
await ctx.close();

/* ---------------- Responsive + accessibility ---------------- */
section('Responsive layout and accessibility');
const axeSrc = fs.readFileSync(path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
for (const [label, opts, file] of [['desktop light', { viewport: { width: 1280, height: 860 } }, '15-desktop.png'], ['tablet 768', { viewport: { width: 768, height: 1024 } }, '16-tablet-768.png'], ['phone 390 dark', { viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, '17-phone-390-dark.png'], ['320 px', { viewport: { width: 320, height: 640 } }, null]]) {
  ctx = await browser.newContext({ ...opts, geolocation: GEO, permissions: ['geolocation'] });
  page = await ctx.newPage(); await page.goto(URL); await ready(page);
  await page.click('#load-sample'); await page.waitForTimeout(300);
  for (const v of ['near', 'insights', 'diary']) { await page.click(`#tab-${v}`); if (v === 'near') { await page.click('#find-near'); await page.waitForTimeout(400); } if (v === 'insights') { await page.click('#analyse'); await page.waitForTimeout(400); }
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label}: no sideways scroll on ${v}`); }
  await page.addScriptTag({ content: axeSrc });
  const v = await page.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] })).violations.map(x => `${x.id}: ${x.nodes.length} ${x.nodes[0].target}`));
  ok(v.length === 0, `${label}: axe-core 0 accessibility violations`, JSON.stringify(v));
  if (file) await shot(page, file, label.startsWith('phone') ? {} : { fullPage: false });
  await ctx.close();
}

fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify(results, null, 1));
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
await browser.close();
