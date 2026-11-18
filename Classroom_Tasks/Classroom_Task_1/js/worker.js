/* =====================================================================
   FinTrack Pocket - js/worker.js
   WEB WORKER: the heavy analysis, run off the main thread.

   One file, two uses:
   - Loaded with new Worker("js/worker.js") it IS the worker (when the app
     is served over http:// or https://).
   - Loaded with a <script> tag it only defines pocketWorker(). The page
     then turns that function's source into a Blob and starts the worker
     from it, because Chrome will not start a worker from a file:// URL.
     The same functions also power the "run on the main thread"
     comparison, so both runs do exactly the same work.

   Messages in:  { type: "analyse", jobId, records, options }
                 { type: "stress",  jobId, count,   options }
   Messages out: { type: "progress", jobId, phase, fraction }
                 { type: "result",   jobId, result }
                 { type: "error",    jobId, message }
===================================================================== */
"use strict";

function pocketWorker(scope) {
    const CATS = ["food", "transport", "groceries", "shopping", "bills", "fun", "other"];
    const DAY = 86_400_000;

    /* ---------- columns: typed arrays are compact and fast to loop over ---------- */
    function toColumns(records) {
        const n = records.length;
        const cols = {
            n,
            amount: new Float64Array(n),            // paise
            cat: new Uint8Array(n),
            day: new Int32Array(n),                 // days since 1970 (UTC)
            lat: new Float64Array(n).fill(NaN),
            lon: new Float64Array(n).fill(NaN),
            ids: new Array(n)
        };
        for (let i = 0; i < n; i++) {
            const r = records[i];
            cols.amount[i] = r.amount;
            cols.cat[i] = Math.max(0, CATS.indexOf(r.category));
            cols.day[i] = Math.floor(Date.parse(`${r.date}T00:00:00Z`) / DAY);
            if (r.location) { cols.lat[i] = r.location.lat; cols.lon[i] = r.location.lon; }
            cols.ids[i] = r.id;
        }
        return cols;
    }

    /* ---------- a seeded random generator, so the stress test is repeatable ---------- */
    function rng(seed) {
        return () => {
            seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /**
     * Builds `count` synthetic expenses around `origin`, spread over 12 months,
     * clustered around five "places" (home, college, market, mall, office).
     */
    function generate(count, origin, todayDay, progress) {
        const r = rng(2340236);
        const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
        const centres = [[0, 0, 0.35], [1.8, 1.2, 0.5], [-1.1, 2.4, 0.4], [3.2, -1.5, 0.6], [-2.6, -2.2, 0.45]];   // km east, km north, spread
        const kmLat = 1 / 110.574, kmLon = 1 / (111.32 * Math.cos(origin.lat * Math.PI / 180));
        const typical = [220, 140, 900, 1600, 1800, 600, 400];   // rupees, per category
        const weight = [0.34, 0.2, 0.14, 0.08, 0.05, 0.11, 0.08];
        const cols = { n: count, amount: new Float64Array(count), cat: new Uint8Array(count), day: new Int32Array(count),
            lat: new Float64Array(count), lon: new Float64Array(count), ids: null };
        for (let i = 0; i < count; i++) {
            let u = r(), c = 0;
            while (u > weight[c] && c < 6) { u -= weight[c]; c++; }
            const centre = centres[Math.floor(r() * centres.length)];
            cols.cat[i] = c;
            cols.amount[i] = Math.round(typical[c] * Math.exp(0.6 * gauss()) * 100);
            cols.day[i] = todayDay - Math.floor(r() * 365);
            cols.lat[i] = origin.lat + (centre[1] + gauss() * centre[2]) * kmLat;
            cols.lon[i] = origin.lon + (centre[0] + gauss() * centre[2]) * kmLon;
            if (i % 50000 === 0) progress("Generating records", i / count);
        }
        return cols;
    }

    function distanceKm(aLat, aLon, bLat, bLon) {
        const rad = Math.PI / 180;
        const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
        return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /**
     * Spending hotspots: k-means clustering of the geotagged expenses.
     * k-means++ chooses well-spread starting centres; positions are projected
     * to kilometres around their mean so distances are fair at any latitude.
     */
    function hotspots(cols, k, progress) {
        const idx = [];
        for (let i = 0; i < cols.n; i++) if (!Number.isNaN(cols.lat[i])) idx.push(i);
        const m = idx.length;
        if (m === 0) return [];
        k = Math.min(k, m);

        let meanLat = 0;
        for (const i of idx) meanLat += cols.lat[i];
        meanLat /= m;
        const kx = 111.32 * Math.cos(meanLat * Math.PI / 180), ky = 110.574;
        const x = new Float64Array(m), y = new Float64Array(m);
        for (let j = 0; j < m; j++) { x[j] = cols.lon[idx[j]] * kx; y[j] = cols.lat[idx[j]] * ky; }

        // k-means++ initialisation
        const r = rng(7);
        const cx = new Float64Array(k), cy = new Float64Array(k);
        const d2 = new Float64Array(m).fill(Infinity);
        let first = Math.floor(r() * m);
        cx[0] = x[first]; cy[0] = y[first];
        for (let c = 1; c < k; c++) {
            let total = 0;
            for (let j = 0; j < m; j++) {
                const dx = x[j] - cx[c - 1], dy = y[j] - cy[c - 1];
                const d = dx * dx + dy * dy;
                if (d < d2[j]) d2[j] = d;
                total += d2[j];
            }
            let pick = r() * total, j = 0;
            while (j < m - 1 && (pick -= d2[j]) > 0) j++;
            cx[c] = x[j]; cy[c] = y[j];
        }

        // Lloyd iterations: assign every point to its nearest centre, move centres to the mean
        const label = new Uint8Array(m);
        const sx = new Float64Array(k), sy = new Float64Array(k), cnt = new Float64Array(k);
        const ITER = 30;
        for (let it = 0; it < ITER; it++) {
            let moved = 0;
            sx.fill(0); sy.fill(0); cnt.fill(0);
            for (let j = 0; j < m; j++) {
                let best = 0, bestD = Infinity;
                for (let c = 0; c < k; c++) {
                    const dx = x[j] - cx[c], dy = y[j] - cy[c];
                    const d = dx * dx + dy * dy;
                    if (d < bestD) { bestD = d; best = c; }
                }
                if (label[j] !== best) { moved++; label[j] = best; }
                sx[best] += x[j]; sy[best] += y[j]; cnt[best]++;
            }
            for (let c = 0; c < k; c++) if (cnt[c]) { cx[c] = sx[c] / cnt[c]; cy[c] = sy[c] / cnt[c]; }
            progress("Finding spending hotspots", (it + 1) / ITER);
            if (it > 2 && moved === 0) break;
        }

        // describe each cluster
        const spots = [];
        for (let c = 0; c < k; c++) {
            let total = 0, count = 0, spread = 0;
            const catTotals = new Float64Array(CATS.length);
            for (let j = 0; j < m; j++) {
                if (label[j] !== c) continue;
                const i = idx[j];
                total += cols.amount[i]; count++; catTotals[cols.cat[i]] += cols.amount[i];
                spread += Math.hypot(x[j] - cx[c], y[j] - cy[c]);
            }
            if (!count) continue;
            let top = 0;
            for (let t = 1; t < CATS.length; t++) if (catTotals[t] > catTotals[top]) top = t;
            spots.push({ lat: cy[c] / ky, lon: cx[c] / kx, total, count, topCategory: CATS[top], spreadKm: spread / count });
        }
        return spots.sort((a, b) => b.total - a.total);
    }

    /** All the statistics. `options`: { origin, radiusKm, budget (paise), today (ISO), k } */
    function analyse(cols, options, progress = () => {}) {
        const started = Date.now();
        const n = cols.n;
        const todayDay = Math.floor(Date.parse(`${options.today}T00:00:00Z`) / DAY);
        const monthOf = (d) => new Date(d * DAY).toISOString().slice(0, 7);
        const thisMonth = options.today.slice(0, 7);

        let total = 0, max = 0, maxAt = -1, geotagged = 0;
        const byCat = CATS.map((c) => ({ category: c, total: 0, count: 0 }));
        const byWeekday = new Float64Array(7);
        const byMonth = new Map();
        let monthSpent = 0;
        for (let i = 0; i < n; i++) {
            const a = cols.amount[i];
            total += a;
            if (a > max) { max = a; maxAt = i; }
            byCat[cols.cat[i]].total += a; byCat[cols.cat[i]].count++;
            byWeekday[(cols.day[i] + 4) % 7] += a;              // 1 Jan 1970 was a Thursday
            const key = monthOf(cols.day[i]);
            byMonth.set(key, (byMonth.get(key) ?? 0) + a);
            if (key === thisMonth) monthSpent += a;
            if (!Number.isNaN(cols.lat[i])) geotagged++;
            if (i % 100000 === 0 && i) progress("Totals", i / n);
        }

        // median and 90th percentile need the amounts in order
        progress("Sorting amounts", 0);
        const sorted = Float64Array.from(cols.amount).sort();
        const pct = (p) => (n ? sorted[Math.min(n - 1, Math.floor(p * (n - 1)))] : 0);
        progress("Sorting amounts", 1);

        // this month against the budget, projected at the current daily pace
        const dayOfMonth = Number(options.today.slice(8, 10));
        const [y, mo] = thisMonth.split("-").map(Number);
        const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        const forecast = dayOfMonth ? Math.round(monthSpent / dayOfMonth * daysInMonth) : monthSpent;

        // spending near the user
        let near = null;
        if (options.origin) {
            const o = options.origin;
            const list = [];
            let nearTotal = 0;
            for (let i = 0; i < n; i++) {
                if (Number.isNaN(cols.lat[i])) continue;
                const km = distanceKm(o.lat, o.lon, cols.lat[i], cols.lon[i]);
                if (km <= options.radiusKm) { nearTotal += cols.amount[i]; list.push([km, i]); }
                if (i % 100000 === 0 && i) progress("Measuring distances", i / n);
            }
            list.sort((a, b) => a[0] - b[0]);
            near = {
                radiusKm: options.radiusKm, count: list.length, total: nearTotal,
                closest: cols.ids ? list.slice(0, 50).map(([km, i]) => ({ id: cols.ids[i], km })) : []
            };
        }

        const spots = hotspots(cols, options.k ?? 5, progress);
        if (options.origin) for (const s of spots) s.distanceKm = distanceKm(options.origin.lat, options.origin.lon, s.lat, s.lon);

        const months = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-12);
        return {
            count: n, geotagged, total, mean: n ? total / n : 0,
            median: pct(0.5), p90: pct(0.9), max, maxId: cols.ids && maxAt >= 0 ? cols.ids[maxAt] : null,
            byCategory: byCat.filter((c) => c.count).sort((a, b) => b.total - a.total),
            byWeekday: Array.from(byWeekday),
            byMonth: months,
            month: { key: thisMonth, spent: monthSpent, budget: options.budget, forecast, dayOfMonth, daysInMonth },
            near, hotspots: spots,
            ms: Date.now() - started
        };
    }

    const api = { analyse, generate, toColumns, CATS };

    // Inside a real worker: answer messages. As a normal script: just hand the functions to the page.
    const insideWorker = typeof WorkerGlobalScope !== "undefined" && scope instanceof WorkerGlobalScope;
    if (!insideWorker) return api;

    let lastPost = 0;
    scope.onmessage = (event) => {
        const { type, jobId, records, count, options } = event.data || {};
        const progress = (phase, fraction) => {
            const now = Date.now();
            if (now - lastPost > 50 || fraction >= 1) { lastPost = now; scope.postMessage({ type: "progress", jobId, phase, fraction }); }
        };
        try {
            const started = Date.now();
            let cols;
            if (type === "analyse") cols = toColumns(records || []);
            else if (type === "stress") {
                const todayDay = Math.floor(Date.parse(`${options.today}T00:00:00Z`) / DAY);
                cols = generate(count, options.origin || { lat: 12.9343, lon: 77.6060 }, todayDay, progress);
            } else throw new Error(`Unknown job "${type}".`);
            const result = analyse(cols, options, progress);
            result.totalMs = Date.now() - started;
            scope.postMessage({ type: "result", jobId, result });
        } catch (error) {
            scope.postMessage({ type: "error", jobId, message: error?.message || String(error) });
        }
    };
    return api;
}

// run straight away: inside a worker this wires up onmessage; on a page it exposes the functions
self.PocketAnalysis = pocketWorker(self);
