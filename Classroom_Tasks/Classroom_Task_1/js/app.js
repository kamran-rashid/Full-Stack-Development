/* =====================================================================
   FinTrack Pocket - js/app.js
   The interface. It ties the five Web APIs together:

     Local Storage    settings, visit count, theme          (store.js)
     Session Storage  this tab's draft, view, filters, log  (store.js)
     IndexedDB        expenses, saved places, last analysis (db.js)
     Geolocation      tag expenses, "near me", saved places (geo.js)
     Web Workers      analysis and the large-dataset test   (worker.js)

   Where they meet:
     Geolocation -> IndexedDB      each expense can carry where it happened,
                                   and is labelled with a saved place
     IndexedDB + Geolocation +     the worker analyses the stored records
     Local Storage -> Web Worker   around the current position, using the
                                   budget and radius from the settings
     Web Worker -> IndexedDB       the result is stored and shown again on
                                   the next visit
     Session Storage               keeps the half-typed expense and the last
                                   position for this tab only
===================================================================== */
"use strict";

(function (P) {
    const { store, geo } = P;
    const CATS = store.CATEGORIES;
    const CAT_LABEL = { food: "Food & drink", transport: "Transport", groceries: "Groceries", shopping: "Shopping", bills: "Bills", fun: "Fun", other: "Other" };
    const DEFAULT_ORIGIN = { lat: 12.9343, lon: 77.6060, label: "Bengaluru (sample)" };   // used only when no location is shared


    /* =================================================================
       1. HELPERS
    ================================================================= */
    const $ = (sel) => document.querySelector(sel);

    /** Builds an element; text is always inserted as text, never as HTML. */
    function h(tag, props = {}, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v === null || v === undefined || v === false) continue;
            if (k === "class") el.className = v;
            else if (k === "dataset") Object.assign(el.dataset, v);
            else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
            else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? "" : v);
        }
        el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== "").map((c) => (c instanceof Node ? c : String(c))));
        return el;
    }
    function svg(tag, attrs = {}) {
        const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        return el;
    }

    const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
    const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
    const money = (paise) => (Math.round(paise) % 100 === 0 ? inr : inr2).format(Math.round(paise) / 100);
    const int = (n) => Math.round(n).toLocaleString("en-IN");
    const fmtDay = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    const fmtMonth = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
    const fmtTime = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" });
    const dayLabel = (iso) => fmtDay.format(new Date(`${iso}T00:00:00Z`));
    const monthLabel = (key) => fmtMonth.format(new Date(`${key}-01T00:00:00Z`));
    const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

    function ago(iso) {
        const s = (Date.now() - Date.parse(iso)) / 1000;
        if (s < 60) return "just now";
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400) return `${Math.round(s / 3600)} h ago`;
        return `${Math.round(s / 86400)} days ago`;
    }

    function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

    let toastTimer;
    function toast(message, { action, onAction, ms = 5000 } = {}) {
        clearTimeout(toastTimer);
        const t = $("#toast");
        t.replaceChildren(h("span", {}, message));
        if (action) t.append(h("button", { type: "button", class: "link", onclick: () => { t.classList.remove("on"); onAction(); } }, action));
        t.classList.add("on");
        toastTimer = setTimeout(() => t.classList.remove("on"), ms);
    }

    /** A lasting message at the top of the page; one per key, so repeats replace each other. */
    function notice(key, message, tone = "warn") {
        const box = $("#notices");
        box.querySelector(`[data-key="${key}"]`)?.remove();
        if (!message) return;
        box.append(h("p", { class: `notice ${tone}`, dataset: { key } }, message,
            h("button", { type: "button", class: "link", "aria-label": "Dismiss this message", onclick: (e) => e.target.closest(".notice").remove() }, "Dismiss")));
    }


    /* =================================================================
       2. STATE
    ================================================================= */
    const state = {
        prefs: null,
        db: null,
        expenses: [],
        places: [],
        lastAnalysis: null,
        editingId: null,
        geoState: "unknown",
        worker: null,
        workerMode: "none",
        jobs: new Map(),
        jobSeq: 0
    };


    /* =================================================================
       3. LOCAL STORAGE: settings
    ================================================================= */
    function applyTheme(theme) {
        if (theme === "system") delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = theme;
    }

    function savePrefs(changes) {
        state.prefs = { ...state.prefs, ...changes };
        const r = store.prefs.save(state.prefs);
        if (!r.ok) notice("prefs", r.reason === "full"
            ? "Your browser's storage is full, so settings could not be saved."
            : "This browser is blocking Local Storage, so settings will be forgotten when you close it.");
        return r.ok;
    }

    function renderGreeting() {
        const p = state.prefs;
        const visit = `Visit ${p.visits}`;
        const last = state.previousVisit ? ` · last here ${ago(state.previousVisit)}` : p.visits > 1 ? "" : " · first visit";
        $("#greeting").textContent = p.name ? `Welcome back, ${p.name}. ${visit}${last}` : `${visit}${last}. Add your name in Settings.`;
    }


    /* =================================================================
       4. SESSION STORAGE: this tab
    ================================================================= */
    function logActivity(action) {
        store.tab.log(action);
        renderSession();
    }

    function renderSession() {
        const s = store.tab.get();
        $("#tab-id").textContent = `Tab ${s.tabId}`;
        $("#session-summary").textContent = `Started ${fmtTime.format(new Date(s.startedAt))} · ${s.added} added in this tab${s.lastPosition ? ` · last location ${fmtTime.format(new Date(s.lastPosition.at))}` : ""}`;
        $("#activity").replaceChildren(...[...s.activity].reverse().slice(0, 8).map((a) =>
            h("li", {}, h("time", { datetime: a.at }, fmtTime.format(new Date(a.at))), " ", a.action)));
        if (!s.activity.length) $("#activity").append(h("li", { class: "muted" }, "Nothing yet in this tab."));
        renderStatus();
    }

    // the half-typed expense is saved as you type, and comes back after a reload
    const saveDraft = debounce(() => {
        const f = $("#entry");
        const draft = { amount: f.amount.value, category: f.category.value, note: f.note.value, date: f.date.value, tagLocation: f.tagLocation.checked, editingId: state.editingId };
        const empty = !draft.amount && !draft.note && !state.editingId;
        store.tab.update({ draft: empty ? null : draft });
    }, 250);

    function restoreDraft() {
        const d = store.tab.get().draft;
        if (!d) return false;
        const f = $("#entry");
        if (d.editingId && !state.expenses.some((e) => e.id === d.editingId)) return false;
        if (d.editingId) setEditing(d.editingId, { fromDraft: true });
        f.amount.value = d.amount ?? "";
        if (CATS.includes(d.category)) f.category.value = d.category;
        f.note.value = d.note ?? "";
        if (d.date) f.date.value = d.date;
        f.tagLocation.checked = Boolean(d.tagLocation);
        $("#draft-tag").hidden = false;
        return true;
    }


    /* =================================================================
       5. INDEXEDDB: expenses and places
    ================================================================= */
    async function persist(action, fn) {
        try {
            return await fn();
        } catch (error) {
            notice("db-write", `${action} failed: ${error.message}`, "error");
            throw error;
        }
    }

    function sortExpenses() {
        state.expenses.sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : (a.date < b.date ? 1 : -1)));
    }

    async function saveExpense(record, isNew) {
        await persist(isNew ? "Saving the expense" : "Updating the expense", () => state.db.put("expenses", record));
        const i = state.expenses.findIndex((e) => e.id === record.id);
        if (i === -1) state.expenses.push(record); else state.expenses[i] = record;
        sortExpenses();
    }

    async function deleteExpense(id) {
        const record = state.expenses.find((e) => e.id === id);
        if (!record) return;
        await persist("Deleting the expense", () => state.db.delete("expenses", id));
        state.expenses = state.expenses.filter((e) => e.id !== id);
        if (state.editingId === id) endEdit();
        logActivity(`Deleted “${record.note}” (${money(record.amount)})`);
        renderAll();
        toast(`Deleted “${record.note}”.`, {
            action: "Undo", ms: 8000,
            onAction: async () => { await saveExpense(record, true); logActivity(`Restored “${record.note}”`); renderAll(); }
        });
    }


    /* =================================================================
       6. THE FORM
    ================================================================= */
    function fillSelects() {
        const opts = (withAll) => [withAll ? h("option", { value: "all" }, "All") : null, ...CATS.map((c) => h("option", { value: c }, CAT_LABEL[c]))];
        $("#category").replaceChildren(...opts(false));
        $("#pref-category").replaceChildren(...opts(false));
        $("#filter-category").replaceChildren(...opts(true));
    }

    function setFieldError(name, message) {
        const input = $(`#${name}`);
        input?.setAttribute("aria-invalid", message ? "true" : "false");
        const box = $(`#${name}-err`);
        if (box) box.textContent = message || "";
    }

    function validate() {
        const f = $("#entry");
        const errors = new Map();
        const raw = f.amount.value.trim().replace(/[,₹\s]/g, "");
        const rupees = Number(raw);
        if (!raw) errors.set("amount", "Enter the amount.");
        else if (!/^\d+(\.\d{1,2})?$/.test(raw)) errors.set("amount", `“${f.amount.value.trim()}” is not an amount. Use digits, e.g. 240 or 99.50.`);
        else if (rupees <= 0) errors.set("amount", "The amount must be more than zero.");
        else if (rupees > 1_000_000) errors.set("amount", "That is more than ₹10 lakh. Check for an extra zero.");
        const note = f.note.value.trim().replace(/\s+/g, " ");
        if (!note) errors.set("note", "Say what it was, e.g. “Canteen lunch”.");
        else if (!/[\p{L}\p{N}]/u.test(note)) errors.set("note", "Use at least one letter or number.");
        const date = f.date.value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.set("date", "Choose a date.");
        else if (date > todayISO()) errors.set("date", "That date is in the future.");
        for (const field of ["amount", "note", "date"]) setFieldError(field, errors.get(field));
        return { errors, value: { amount: Math.round(rupees * 100), note, date, category: f.category.value } };
    }

    function setBusy(busy, label) {
        const btn = $("#save");
        btn.disabled = busy;
        btn.textContent = busy ? label : (state.editingId ? "Save changes" : "Save expense");
    }

    async function onSubmit(event) {
        event.preventDefault();
        if ($("#save").disabled) return;
        const { errors, value } = validate();
        const box = $("#entry-errors");
        if (errors.size) {
            box.replaceChildren(h("p", {}, errors.size === 1 ? "One thing to fix:" : `${errors.size} things to fix:`), h("ul", {}, [...errors.values()].map((m) => h("li", {}, m))));
            box.hidden = false;
            box.focus();
            return;
        }
        box.hidden = true;

        const editing = state.editingId ? state.expenses.find((e) => e.id === state.editingId) : null;
        let location = editing?.location ?? null;
        let placeId = editing?.placeId ?? null;

        // GEOLOCATION -> INDEXEDDB: where it happened is stored with the record
        if ($("#tag-location").checked) {
            setBusy(true, "Finding you…");
            $("#location-hint").textContent = "Asking the browser for your location…";
            try {
                const pos = await geo.locate();
                rememberPosition(pos);
                location = { lat: pos.lat, lon: pos.lon, accuracy: pos.accuracy };
                placeId = geo.placeFor(pos, state.places)?.id ?? null;
                $("#location-hint").textContent = "";
            } catch (error) {
                handleGeoError(error, "#location-hint", "The expense was saved without a location.");
            }
            setBusy(false);
        }

        const now = new Date().toISOString();
        const record = editing
            ? { ...editing, ...value, location, placeId, updatedAt: now }
            : { id: newId(), ...value, location, placeId, createdAt: now, updatedAt: now };
        try {
            await saveExpense(record, !editing);
        } catch {
            return;     // the notice already explains it
        }
        const place = state.places.find((p) => p.id === placeId);
        if (editing) {
            logActivity(`Edited “${record.note}”`);
            toast(`Saved changes to “${record.note}”.`);
            endEdit();
        } else {
            store.tab.update({ added: store.tab.get().added + 1 });
            logActivity(`Added “${record.note}” (${money(record.amount)})${place ? ` at ${place.name}` : ""}`);
            toast(`Saved ${money(record.amount)} for “${record.note}”${place ? ` at ${place.name}` : location ? " with your location" : ""}.`);
            resetForm();
        }
        renderAll();
    }

    function resetForm({ keepDraft = false } = {}) {
        const f = $("#entry");
        f.reset();
        f.category.value = state.prefs.defaultCategory;
        f.date.value = todayISO();
        f.date.max = todayISO();
        f.tagLocation.checked = state.prefs.autoTag;
        $("#draft-tag").hidden = true;
        $("#entry-errors").hidden = true;
        ["amount", "note", "date"].forEach((n) => setFieldError(n, null));
        if (!keepDraft) store.tab.update({ draft: null });
    }

    function setEditing(id, { fromDraft = false } = {}) {
        const r = state.expenses.find((e) => e.id === id);
        if (!r) return;
        state.editingId = id;
        const f = $("#entry");
        if (!fromDraft) {
            f.amount.value = (r.amount / 100).toString();
            f.category.value = r.category;
            f.note.value = r.note;
            f.date.value = r.date;
            f.tagLocation.checked = false;
        }
        $("#entry-title").textContent = "Edit expense";
        $("label[for='tag-location']").textContent = r.location ? "Replace the location with where I am now" : "Add where I am now";
        $("#cancel-edit").hidden = false;
        setBusy(false);
        f.classList.add("editing");
        renderDiary();
        if (!fromDraft) { f.scrollIntoView({ block: "nearest" }); f.amount.focus(); }
    }

    function endEdit() {
        state.editingId = null;
        $("#entry-title").textContent = "Add an expense";
        $("label[for='tag-location']").textContent = "Tag with my location";
        $("#cancel-edit").hidden = true;
        $("#entry").classList.remove("editing");
        resetForm();
        setBusy(false);
        renderDiary();
    }


    /* =================================================================
       7. GEOLOCATION
    ================================================================= */
    function rememberPosition(pos) {
        // kept in SESSION storage only: location is sensitive, so it is not written to disk for good
        store.tab.update({ lastPosition: pos });
        logActivity(`Location found (±${pos.accuracy} m)`);
    }

    function handleGeoError(error, where, extra = "") {
        const kind = error.kind || "unavailable";
        $(where).textContent = `${error.message} ${extra}`.trim();
        $(where).dataset.tone = "error";
        if (kind === "denied") {
            state.geoState = "denied";
            notice("geo", "Location is blocked for this page. Everything else still works; expenses are saved without a place and “Near me” uses no position.", "warn");
        }
        logActivity(`Location failed: ${kind}`);
        renderStatus();
    }

    async function watchPermission() {
        const status = await geo.permission();
        state.geoState = geo.supported ? status.state : "unsupported";
        status.addEventListener?.("change", () => { state.geoState = status.state; if (status.state !== "denied") notice("geo", null); renderStatus(); });
        renderStatus();
    }


    /* =================================================================
       8. WEB WORKER
    ================================================================= */
    /**
     * Starts the worker. Served over http(s), it loads js/worker.js. Opened from
     * disk (file://), Chrome refuses a worker file, so the same code is turned into
     * a Blob URL instead. If loading the file fails later, it falls back to the Blob.
     */
    function createWorker({ forceBlob = false } = {}) {
        if (!("Worker" in window)) {
            notice("worker", "This browser has no Web Workers, so analysis cannot run in the background.", "error");
            return;
        }
        let worker = null, mode = "file";
        if (!forceBlob && location.protocol !== "file:") {
            try { worker = new Worker("js/worker.js"); } catch { worker = null; }
        }
        if (!worker) {
            const source = `"use strict";\n${window.pocketWorker.toString()}\nself.PocketAnalysis = pocketWorker(self);\n`;
            worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
            mode = "blob";
        }
        worker.onmessage = (event) => {
            const msg = event.data;
            const job = state.jobs.get(msg.jobId);
            if (!job) return;
            if (msg.type === "progress") job.onProgress?.(msg.phase, msg.fraction);
            else if (msg.type === "result") { state.jobs.delete(msg.jobId); job.resolve(msg.result); }
            else if (msg.type === "error") { state.jobs.delete(msg.jobId); job.reject(new Error(msg.message)); }
        };
        worker.onerror = (event) => {
            event.preventDefault();
            if (mode === "file") {
                // js/worker.js could not be loaded: switch to the Blob worker and resend what was waiting
                worker.terminate();
                createWorker({ forceBlob: true });
                for (const job of state.jobs.values()) state.worker.postMessage(job.message);
                return;
            }
            failAllJobs(new Error(event.message || "The background worker stopped unexpectedly."));
        };
        worker.onmessageerror = () => failAllJobs(new Error("The worker sent data that could not be read."));
        state.worker = worker;
        state.workerMode = mode;
        renderStatus();
    }

    function failAllJobs(error) {
        for (const job of state.jobs.values()) job.reject(error);
        state.jobs.clear();
    }

    /** Sends a job to the worker. Resolves with its result; onProgress(phase, fraction) along the way. */
    function runJob(message, onProgress) {
        return new Promise((resolve, reject) => {
            if (!state.worker) return reject(new Error("Background processing is not available in this browser."));
            const jobId = ++state.jobSeq;
            const full = { ...message, jobId };
            state.jobs.set(jobId, { resolve, reject, onProgress, message: full });
            state.worker.postMessage(full);
        });
    }

    /** Stops whatever the worker is doing by replacing it (a worker cannot be interrupted mid-loop). */
    function cancelWorker() {
        state.worker?.terminate();
        failAllJobs(Object.assign(new Error("Cancelled."), { cancelled: true }));
        createWorker();
    }

    function analysisOptions(origin) {
        return { origin, radiusKm: state.prefs.radiusKm, budget: state.prefs.monthlyBudget * 100, today: todayISO(), k: 5 };
    }


    /* =================================================================
       9. RENDERING
    ================================================================= */
    function renderStatus() {
        const s = store.tab.get();
        const geoText = { granted: "allowed", prompt: "will ask", denied: "blocked", unsupported: "not supported", unknown: "ask on use" }[state.geoState] ?? state.geoState;
        const chip = (api, text, ok = true) => h("li", { class: ok ? "ok" : "bad" }, h("strong", {}, api), " ", text);
        $("#api-status").replaceChildren(
            chip("Local Storage", store.prefs.available ? `settings · visit ${state.prefs.visits}` : "blocked", store.prefs.available),
            chip("Session Storage", store.tab.available ? `tab ${s.tabId} · ${s.activity.length} actions` : "blocked", store.tab.available),
            chip("IndexedDB", state.db?.persistent ? `${state.expenses.length} records · ${state.places.length} places` : "memory only", Boolean(state.db?.persistent)),
            chip("Geolocation", geoText, !["denied", "unsupported"].includes(state.geoState)),
            chip("Web Worker", state.worker ? `ready (${state.workerMode === "blob" ? "from Blob" : "worker.js"})` : "unavailable", Boolean(state.worker))
        );
    }

    function monthTotal(key) {
        return state.expenses.filter((e) => e.date.startsWith(key)).reduce((s, e) => s + e.amount, 0);
    }

    function renderBudget() {
        const key = todayISO().slice(0, 7);
        const spent = monthTotal(key);
        const budget = state.prefs.monthlyBudget * 100;
        const day = Number(todayISO().slice(8, 10));
        const days = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate();
        const forecast = Math.round(spent / day * days);
        const pct = budget ? spent / budget : 0;
        const status = !budget ? "No budget set" : spent > budget ? `Over by ${money(spent - budget)}` : forecast > budget ? `On pace to overspend by ${money(forecast - budget)}` : `${money(budget - spent)} left`;
        $("#budget").replaceChildren(
            h("div", { class: "budget-top" },
                h("div", {}, h("p", { class: "eyebrow" }, `${monthLabel(key)} · budget from your settings`), h("p", { class: "big" }, money(spent), h("span", { class: "of" }, ` of ${money(budget)}`))),
                h("p", { class: `budget-status ${spent > budget || forecast > budget ? "warn" : "ok"}` }, status)),
            h("div", { class: "meter", role: "img", "aria-label": `${Math.round(pct * 100)} percent of the monthly budget used` },
                h("span", { class: "fill", style: { width: `${Math.min(pct, 1) * 100}%` } }),
                h("span", { class: "pace", style: { left: `${Math.min(forecast / (budget || 1), 1) * 100}%` }, title: "Projected month-end" })),
            h("p", { class: "hint small" }, `Projected month-end at today's pace: ${money(forecast)}.`));
    }

    function renderFilters() {
        const s = store.tab.get();
        const months = [...new Set(state.expenses.map((e) => e.date.slice(0, 7)))].sort().reverse();
        $("#filter-month").replaceChildren(h("option", { value: "all" }, "All months"), ...months.map((m) => h("option", { value: m }, monthLabel(m))));
        $("#filter-category").value = s.filters.category;
        $("#filter-month").value = months.includes(s.filters.month) ? s.filters.month : "all";
    }

    function placeName(id) { return state.places.find((p) => p.id === id)?.name; }

    function renderDiary() {
        const { category, month } = store.tab.get().filters;
        const list = state.expenses.filter((e) => (category === "all" || e.category === category) && (month === "all" || e.date.startsWith(month)));
        const groups = new Map();
        for (const e of list) { if (!groups.has(e.date)) groups.set(e.date, []); groups.get(e.date).push(e); }
        const total = list.reduce((s, e) => s + e.amount, 0);
        $("#diary-count").textContent = list.length ? `${list.length} shown · ${money(total)}` : "";

        $("#diary").replaceChildren(...[...groups].map(([date, items]) =>
            h("li", { class: "day" },
                h("h3", {}, dayLabel(date), h("span", {}, money(items.reduce((s, e) => s + e.amount, 0)))),
                h("ul", {}, items.map((e) => {
                    const where = e.placeId && placeName(e.placeId)
                        ? `📍 ${placeName(e.placeId)}`
                        : e.location ? `📍 ${e.location.lat.toFixed(4)}, ${e.location.lon.toFixed(4)} (±${e.location.accuracy} m)` : "No location";
                    return h("li", { class: `entry-row${e.id === state.editingId ? " is-editing" : ""}` },
                        h("span", { class: `dot c-${e.category}`, "aria-hidden": "true" }),
                        h("div", { class: "what" }, h("strong", {}, e.note), h("small", {}, `${CAT_LABEL[e.category]} · ${where}`)),
                        h("strong", { class: "amt" }, money(e.amount)),
                        h("div", { class: "row-actions" },
                            h("button", { type: "button", class: "link", dataset: { action: "edit", id: e.id }, "aria-label": `Edit ${e.note}` }, "Edit"),
                            h("button", { type: "button", class: "link danger", dataset: { action: "delete", id: e.id }, "aria-label": `Delete ${e.note}` }, "Delete")));
                })))));
        const empty = state.expenses.length === 0;
        $("#diary-empty").hidden = !empty;
        if (!empty && !list.length) $("#diary").append(h("li", { class: "muted pad" }, "Nothing matches these filters."));
    }

    function renderPlaces() {
        $("#places").replaceChildren(...state.places.map((p) => {
            const count = state.expenses.filter((e) => e.placeId === p.id).length;
            return h("li", {},
                h("div", {}, h("strong", {}, p.name), h("small", {}, `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} · within ${p.radiusM} m · ${count} expense${count === 1 ? "" : "s"}`)),
                h("button", { type: "button", class: "link danger", dataset: { action: "delete-place", id: p.id }, "aria-label": `Delete place ${p.name}` }, "Delete"));
        }));
        if (!state.places.length) $("#places").append(h("li", { class: "muted" }, "No saved places yet."));
    }

    /** Radar: you in the middle, expenses around you, rings at the radius and half of it. */
    function renderNear(result, origin) {
        $("#near-grid").hidden = false;
        const radar = $("#radar");
        const R = state.prefs.radiusKm;
        const scale = 90 / R;                                   // the radius ring sits at 90 units
        const kx = 111.32 * Math.cos(origin.lat * Math.PI / 180), ky = 110.574;
        radar.replaceChildren(
            svg("circle", { r: 90, class: "ring" }), svg("circle", { r: 45, class: "ring faint" }),
            svg("line", { x1: -100, y1: 0, x2: 100, y2: 0, class: "axis" }), svg("line", { x1: 0, y1: -100, x2: 0, y2: 100, class: "axis" }));
        const t1 = svg("text", { x: 3, y: -93, class: "ring-label" }); t1.textContent = geo.formatDistance(R); radar.append(t1);
        for (const p of state.places) {
            const x = (p.lon - origin.lon) * kx * scale, y = -(p.lat - origin.lat) * ky * scale;
            if (Math.hypot(x, y) > 105) continue;
            radar.append(svg("rect", { x: x - 4, y: y - 4, width: 8, height: 8, class: "place" }));
            const t = svg("text", { x: x + 6, y: y - 6, class: "place-label" }); t.textContent = p.name; radar.append(t);
        }
        const max = Math.max(1, ...state.expenses.map((e) => e.amount));
        for (const e of state.expenses) {
            if (!e.location) continue;
            const x = (e.location.lon - origin.lon) * kx * scale, y = -(e.location.lat - origin.lat) * ky * scale;
            if (Math.hypot(x, y) > 105) continue;
            const c = svg("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: (2.5 + 6 * Math.sqrt(e.amount / max)).toFixed(1), class: `spend c-${e.category}` });
            const title = svg("title"); title.textContent = `${e.note}: ${money(e.amount)}`; c.append(title);
            radar.append(c);
        }
        radar.append(svg("circle", { r: 5, class: "me" }), svg("circle", { r: 11, class: "me-halo" }));

        const near = result.near;
        $("#near-total").replaceChildren(h("span", { class: "big" }, money(near.total)), ` spent within ${geo.formatDistance(R)} of you, across ${near.count} expense${near.count === 1 ? "" : "s"}.`);
        const byId = new Map(state.expenses.map((e) => [e.id, e]));
        $("#near-list").replaceChildren(...near.closest.slice(0, 12).map(({ id, km }) => {
            const e = byId.get(id);
            return e ? h("li", {}, h("span", {}, h("strong", {}, e.note), h("small", {}, `${dayLabel(e.date)} · ${geo.formatDistance(km)} away`)), h("b", {}, money(e.amount))) : null;
        }));
        if (!near.count) $("#near-list").append(h("li", { class: "muted" }, "Nothing recorded within the radius. Change it in Settings, or record an expense here."));
    }

    async function findNear({ fresh = true } = {}) {
        const status = $("#near-status");
        status.dataset.tone = "";
        let origin = store.tab.get().lastPosition;
        if (fresh || !origin) {
            status.textContent = "Asking the browser for your location…";
            $("#find-near").disabled = true;
            try {
                origin = await geo.locate({ maximumAge: 30000 });
                rememberPosition(origin);
            } catch (error) {
                $("#find-near").disabled = false;
                handleGeoError(error, "#near-status");
                $("#near-total").textContent = "";
                $("#near-list").replaceChildren();
                return;
            }
            $("#find-near").disabled = false;
        }
        status.textContent = `Measuring distances in the background…`;
        try {
            // GEOLOCATION + INDEXEDDB records + LOCAL STORAGE radius -> WEB WORKER
            const result = await runJob({ type: "analyse", records: state.expenses, options: analysisOptions(origin) });
            renderNear(result, origin);
            status.textContent = `From your position at ${fmtTime.format(new Date(origin.at))} (±${origin.accuracy} m)${fresh ? "" : ", remembered for this tab"}. Radius ${geo.formatDistance(state.prefs.radiusKm)} (Settings).`;
            if (fresh) logActivity(`Checked spending near me: ${money(result.near.total)}`);
        } catch (error) {
            status.textContent = `The distance calculation failed: ${error.message}`;
            status.dataset.tone = "error";
        }
    }

    /* ---------- analysis results ---------- */
    function bars(items, labelOf, valueOf) {
        const max = Math.max(1, ...items.map(valueOf));
        return h("ul", { class: "bars" }, items.map((it) =>
            h("li", { style: { "--w": (valueOf(it) / max).toFixed(3) } }, h("span", {}, labelOf(it)), h("b", {}, money(valueOf(it))))));
    }

    function renderAnalysis(saved) {
        const box = $("#analysis");
        if (!saved) {
            $("#analysis-when").textContent = state.expenses.length ? "Not analysed yet." : "Add some expenses first.";
            box.replaceChildren();
            return;
        }
        const r = saved.result;
        $("#analysis-when").textContent = `Last analysed ${ago(saved.at)} (${int(r.count)} records, ${r.ms} ms in the worker). Stored in IndexedDB, so it reappears on your next visit.`;
        const m = r.month;
        const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const topDay = r.byWeekday.indexOf(Math.max(...r.byWeekday));
        box.replaceChildren(
            h("dl", { class: "kpis" },
                h("div", {}, h("dt", {}, "Total"), h("dd", {}, money(r.total))),
                h("div", {}, h("dt", {}, "Typical expense"), h("dd", {}, money(r.median)), h("small", {}, "median")),
                h("div", {}, h("dt", {}, "Big expense"), h("dd", {}, money(r.p90)), h("small", {}, "90th percentile")),
                h("div", {}, h("dt", {}, "This month"), h("dd", {}, money(m.spent)), h("small", {}, `forecast ${money(m.forecast)} · budget ${money(m.budget)}`))),
            h("div", { class: "insight-grid" },
                h("section", {}, h("h3", {}, "By category"), bars(r.byCategory, (c) => CAT_LABEL[c.category], (c) => c.total)),
                h("section", {}, h("h3", {}, "By month"), bars(r.byMonth, ([k]) => monthLabel(k).replace(/ \d{4}$/, ""), ([, v]) => v),
                    h("p", { class: "hint small" }, `You spend most on ${weekday[topDay]}s.`)),
                h("section", {}, h("h3", {}, "Spending hotspots"),
                    r.hotspots.length
                        ? h("ol", { class: "spots" }, r.hotspots.map((s) => {
                            const place = geo.placeFor({ lat: s.lat, lon: s.lon }, state.places.map((p) => ({ ...p, radiusM: Math.max(p.radiusM, 400) })));
                            return h("li", {}, h("strong", {}, place ? `Around ${place.name}` : `${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}`),
                                h("small", {}, `${money(s.total)} over ${s.count} · mostly ${CAT_LABEL[s.topCategory]}${s.distanceKm !== undefined ? ` · ${geo.formatDistance(s.distanceKm)} from you` : ""}`));
                        }))
                        : h("p", { class: "hint" }, "Tag expenses with a location to find hotspots."))));
    }

    async function analyseDiary() {
        if (!state.expenses.length) { toast("Add or load some expenses first."); return; }
        const btn = $("#analyse");
        btn.disabled = true;
        btn.textContent = "Working in the background…";
        try {
            const origin = store.tab.get().lastPosition;
            const result = await runJob({ type: "analyse", records: state.expenses, options: analysisOptions(origin) });
            state.lastAnalysis = { key: "lastAnalysis", at: new Date().toISOString(), result };
            // WEB WORKER -> INDEXEDDB: kept, and shown again automatically next time
            await persist("Saving the analysis", () => state.db.put("meta", state.lastAnalysis)).catch(() => {});
            renderAnalysis(state.lastAnalysis);
            logActivity(`Analysed ${result.count} expenses (${result.ms} ms)`);
        } catch (error) {
            $("#analysis-when").textContent = `The analysis failed: ${error.message}`;
        } finally {
            btn.disabled = false;
            btn.textContent = "Analyse in the background";
        }
    }


    /* =================================================================
       10. THE LARGE-DATASET TEST (and the heartbeat that proves responsiveness)
    ================================================================= */
    const beat = { last: performance.now(), frames: [], maxGap: 0, measuring: false };
    function heartbeat(now) {
        const gap = now - beat.last;
        beat.last = now;
        beat.frames.push(now);
        while (beat.frames.length && now - beat.frames[0] > 1000) beat.frames.shift();
        if (beat.measuring) beat.maxGap = Math.max(beat.maxGap, gap);
        $("#beat-dot").style.transform = `translateX(${(Math.sin(now / 300) + 1) * 50}%)`;
        $("#fps").textContent = `Heartbeat: ${beat.frames.length} frames/s${beat.measuring ? ` · longest pause ${Math.round(beat.maxGap)} ms` : ""}`;
        requestAnimationFrame(heartbeat);
    }

    function stressUI(running) {
        $("#stress-worker").disabled = running;
        $("#stress-main").disabled = running;
        $("#stress-cancel").disabled = !running;
        $("#stress-progress").hidden = !running;
    }

    function stressResult(r, mode, wallMs) {
        const perSec = Math.round(r.count / (wallMs / 1000));
        $("#stress-result").replaceChildren(
            h("dl", { class: "kpis" },
                h("div", {}, h("dt", {}, "Records"), h("dd", {}, int(r.count))),
                h("div", {}, h("dt", {}, "Time"), h("dd", {}, `${int(wallMs)} ms`), h("small", {}, `${int(perSec)} records/s`)),
                h("div", {}, h("dt", {}, "Longest page freeze"), h("dd", { class: beat.maxGap > 200 ? "bad" : "good" }, `${int(beat.maxGap)} ms`), h("small", {}, mode)),
                h("div", {}, h("dt", {}, "Hotspots"), h("dd", {}, r.hotspots.length), h("small", {}, `median ${money(r.median)} · p90 ${money(r.p90)}`))),
            h("p", { class: "hint small" }, beat.maxGap > 200
                ? "The page froze: the heartbeat stopped and taps were ignored until the work finished."
                : "The page never froze: the heartbeat kept running and taps were counted during the work."));
    }

    async function runStress(where) {
        const count = Number($("#stress-size").value);
        const origin = store.tab.get().lastPosition || DEFAULT_ORIGIN;
        const options = analysisOptions(origin);
        stressUI(true);
        $("#stress-result").replaceChildren();
        beat.maxGap = 0;
        beat.measuring = true;
        const started = performance.now();
        try {
            let result;
            if (where === "worker") {
                result = await runJob({ type: "stress", count, options }, (phase, fraction) => {
                    $("#stress-bar").value = fraction;
                    $("#stress-phase").textContent = `${phase}: ${Math.round(fraction * 100)}%`;
                });
            } else {
                $("#stress-phase").textContent = "Running on the main thread: the page will freeze until it finishes…";
                await new Promise((r) => setTimeout(r, 60));       // let that message paint first
                const A = window.PocketAnalysis;
                const cols = A.generate(count, origin, Math.floor(Date.parse(`${options.today}T00:00:00Z`) / 86400000), () => {});
                result = A.analyse(cols, options);
            }
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));   // count the frame after the work
            const wall = performance.now() - started;
            beat.measuring = false;
            stressResult(result, where === "worker" ? "in the Web Worker" : "on the main thread", wall);
            logActivity(`Large test: ${int(count)} records ${where === "worker" ? "in worker" : "on main thread"}, longest freeze ${int(beat.maxGap)} ms`);
        } catch (error) {
            beat.measuring = false;
            $("#stress-result").replaceChildren(h("p", { class: "hint" }, error.cancelled ? "Cancelled. The worker was stopped and a fresh one started." : `The test failed: ${error.message}`));
        } finally {
            stressUI(false);
        }
    }


    /* =================================================================
       11. SAMPLE DATA
    ================================================================= */
    async function loadSample() {
        const origin = store.tab.get().lastPosition || DEFAULT_ORIGIN;
        const kx = 111.32 * Math.cos(origin.lat * Math.PI / 180), ky = 110.574;
        const at = (eastKm, northKm) => ({ lat: Number((origin.lat + northKm / ky).toFixed(6)), lon: Number((origin.lon + eastKm / kx).toFixed(6)) });
        const home = { id: newId(), name: "Home", ...at(0.05, -0.04), radiusM: 250 };
        const college = { id: newId(), name: "College", ...at(1.4, 0.9), radiusM: 250 };
        const market = at(-0.8, 1.6);
        const templates = [
            ["Canteen lunch", "food", 90, 160, college], ["Chai and samosa", "food", 30, 60, college], ["Photocopies", "other", 20, 80, college],
            ["Groceries", "groceries", 300, 1400, market], ["Vegetables", "groceries", 80, 260, market], ["Swiggy dinner", "food", 220, 520, home],
            ["Auto to college", "transport", 60, 140, home], ["Metro card recharge", "transport", 200, 500, null], ["Electricity bill", "bills", 900, 1600, home],
            ["Movie night", "fun", 250, 600, null], ["T-shirt", "shopping", 400, 1200, null], ["Mobile recharge", "bills", 239, 299, null]
        ];
        let seed = 42; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const today = new Date(`${todayISO()}T00:00:00Z`);
        const records = [];
        for (let i = 0; i < 40; i++) {
            const [note, category, lo, hi, spot] = templates[Math.floor(r() * templates.length)];
            const d = new Date(today - Math.floor(r() * 60) * 86400000).toISOString().slice(0, 10);
            const base = spot ? (spot.lat ? spot : null) : at((r() - 0.5) * 6, (r() - 0.5) * 6);
            const jitter = () => (r() - 0.5) * 0.0012;
            const location = base ? { lat: Number((base.lat + jitter()).toFixed(6)), lon: Number((base.lon + jitter()).toFixed(6)), accuracy: 20 + Math.floor(r() * 40) } : null;
            const now = new Date().toISOString();
            records.push({ id: newId(), amount: Math.round((lo + r() * (hi - lo)) / 10) * 1000, category, note, date: d, location, placeId: null, createdAt: now, updatedAt: now });
        }
        for (const rec of records) if (rec.location) rec.placeId = geo.placeFor(rec.location, [home, college])?.id ?? null;
        try {
            await persist("Loading the sample", async () => { await state.db.bulkPut("places", [home, college]); await state.db.bulkPut("expenses", records); });
        } catch { return; }
        state.places.push(home, college);
        state.expenses.push(...records);
        sortExpenses();
        logActivity(`Loaded a sample diary (40 expenses around ${store.tab.get().lastPosition ? "you" : DEFAULT_ORIGIN.label})`);
        renderAll();
        toast("Sample diary loaded: 40 expenses and 2 saved places.");
    }


    /* =================================================================
       12. VIEWS (tabs) and SETTINGS
    ================================================================= */
    function showView(view, { focus = false } = {}) {
        for (const tab of document.querySelectorAll("[role=tab]")) {
            const on = tab.dataset.view === view;
            tab.setAttribute("aria-selected", String(on));
            tab.tabIndex = on ? 0 : -1;
            if (on && focus) tab.focus();
            $(`#${tab.getAttribute("aria-controls")}`).hidden = !on;
        }
        store.tab.update({ view });
        if (view === "near" && store.tab.get().lastPosition && !$("#near-list").children.length) findNear({ fresh: false });
    }

    async function openSettings() {
        const p = state.prefs;
        $("#pref-name").value = p.name;
        document.querySelector(`input[name=theme][value=${p.theme}]`).checked = true;
        $("#pref-budget").value = p.monthlyBudget;
        $("#pref-radius").value = String(p.radiusKm);
        $("#pref-category").value = p.defaultCategory;
        $("#pref-autotag").checked = p.autoTag;
        setFieldError("pref-budget", null);
        $("#storage-usage").textContent = "";
        $("#settings").showModal();
        try {
            const { usage, quota } = await navigator.storage.estimate();
            $("#storage-usage").textContent = `This site uses ${(usage / 1024).toFixed(0)} KB of about ${(quota / 1048576).toFixed(0)} MB the browser allows.`;
        } catch { /* estimate() is optional */ }
    }

    function onSettingsClose(event) {
        const dlg = $("#settings");
        if (event.submitter?.value !== "save") return;
        const raw = $("#pref-budget").value.trim().replace(/[,₹\s]/g, "");
        if (!/^\d{1,7}$/.test(raw)) {
            event.preventDefault();
            setFieldError("pref-budget", "Enter a whole number of rupees, e.g. 15000.");
            $("#pref-budget").focus();
            return;
        }
        const ok = savePrefs({
            name: $("#pref-name").value.trim().slice(0, 30),
            theme: document.querySelector("input[name=theme]:checked")?.value || "system",
            monthlyBudget: Number(raw),
            radiusKm: Number($("#pref-radius").value),
            defaultCategory: $("#pref-category").value,
            autoTag: $("#pref-autotag").checked
        });
        applyTheme(state.prefs.theme);
        if (!state.editingId) { $("#category").value = state.prefs.defaultCategory; $("#tag-location").checked = state.prefs.autoTag; }
        renderAll();
        if (ok) toast("Settings saved. They will still be here after you close the browser.");
        logActivity("Changed settings");
        void dlg;
    }

    async function wipeEverything(button) {
        if (!button.dataset.armed) {
            button.dataset.armed = "1";
            button.textContent = "Click again to delete everything";
            setTimeout(() => { delete button.dataset.armed; button.textContent = "Delete all my data"; }, 4000);
            return;
        }
        try {
            await state.db.clear("expenses"); await state.db.clear("places"); await state.db.clear("meta");
        } catch (error) {
            notice("db-write", `Could not clear the database: ${error.message}`, "error");
        }
        store.prefs.clear();
        store.tab.clear();
        location.reload();
    }


    /* =================================================================
       13. EVENTS
    ================================================================= */
    function bind() {
        const form = $("#entry");
        form.addEventListener("submit", onSubmit);
        form.addEventListener("input", saveDraft);
        form.addEventListener("change", saveDraft);
        form.amount.addEventListener("blur", () => { if (form.amount.value) validate(); });
        $("#cancel-edit").addEventListener("click", endEdit);
        form.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.editingId) endEdit(); });

        // one listener for every row button (event delegation)
        document.addEventListener("click", async (e) => {
            const btn = e.target.closest("button[data-action]");
            if (!btn) return;
            const { action, id } = btn.dataset;
            if (action === "edit") setEditing(id);
            if (action === "delete") deleteExpense(id).catch(() => {});
            if (action === "delete-place") deletePlace(id).catch(() => {});
        });

        // tabs: click, and arrow keys as screen-reader users expect
        const tabs = [...document.querySelectorAll("[role=tab]")];
        tabs.forEach((tab, i) => {
            tab.addEventListener("click", () => showView(tab.dataset.view));
            tab.addEventListener("keydown", (e) => {
                const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
                if (step) { e.preventDefault(); showView(tabs[(i + step + tabs.length) % tabs.length].dataset.view, { focus: true }); }
            });
        });

        $("#filter-category").addEventListener("change", (e) => { store.tab.update({ filters: { ...store.tab.get().filters, category: e.target.value } }); renderDiary(); });
        $("#filter-month").addEventListener("change", (e) => { store.tab.update({ filters: { ...store.tab.get().filters, month: e.target.value } }); renderDiary(); });
        $("#load-sample").addEventListener("click", loadSample);
        $("#find-near").addEventListener("click", () => findNear({ fresh: true }));
        $("#place-form").addEventListener("submit", savePlace);
        $("#analyse").addEventListener("click", analyseDiary);
        $("#stress-worker").addEventListener("click", () => runStress("worker"));
        $("#stress-main").addEventListener("click", () => runStress("main"));
        $("#stress-cancel").addEventListener("click", cancelWorker);
        $("#tap").addEventListener("click", () => { $("#taps").textContent = String(Number($("#taps").textContent) + 1); });

        $("#open-settings").addEventListener("click", openSettings);
        $("#settings-form").addEventListener("submit", onSettingsClose);
        $("#wipe").addEventListener("click", (e) => wipeEverything(e.currentTarget));

        // LOCAL STORAGE across tabs: when another tab saves settings, this one follows at once
        store.prefs.onChangeElsewhere((prefs) => {
            state.prefs = prefs;
            applyTheme(prefs.theme);
            renderAll();
            toast("Settings were changed in another tab and applied here.");
        });
    }

    async function savePlace(event) {
        event.preventDefault();
        const name = $("#place-name").value.trim();
        if (!name) { toast("Give the place a name first."); $("#place-name").focus(); return; }
        let pos;
        try {
            pos = await geo.locate({ maximumAge: 30000 });
            rememberPosition(pos);
        } catch (error) {
            handleGeoError(error, "#near-status", "The place was not saved.");
            return;
        }
        const place = { id: newId(), name: name.slice(0, 24), lat: pos.lat, lon: pos.lon, radiusM: Number($("#place-radius").value) };
        // label earlier expenses recorded inside the new place's circle
        const relabel = state.expenses.filter((e) => e.location && !e.placeId && geo.distanceKm(e.location, place) * 1000 <= place.radiusM)
            .map((e) => ({ ...e, placeId: place.id }));
        try {
            await persist("Saving the place", async () => { await state.db.add("places", place); if (relabel.length) await state.db.bulkPut("expenses", relabel); });
        } catch { return; }
        state.places.push(place);
        for (const r of relabel) state.expenses[state.expenses.findIndex((e) => e.id === r.id)] = r;
        $("#place-name").value = "";
        logActivity(`Saved place “${place.name}”`);
        renderAll();
        toast(`Saved “${place.name}”.${relabel.length ? ` ${relabel.length} earlier expense${relabel.length === 1 ? " was" : "s were"} labelled with it.` : ""}`);
    }

    async function deletePlace(id) {
        const place = state.places.find((p) => p.id === id);
        if (!place) return;
        // the byPlace index finds every expense that points at this place
        const linked = await state.db.getAllByIndex("expenses", "byPlace", id);
        const unlinked = linked.map((e) => ({ ...e, placeId: null }));
        await persist("Deleting the place", async () => { await state.db.delete("places", id); if (unlinked.length) await state.db.bulkPut("expenses", unlinked); });
        state.places = state.places.filter((p) => p.id !== id);
        for (const e of state.expenses) if (e.placeId === id) e.placeId = null;
        logActivity(`Deleted place “${place.name}”`);
        renderAll();
        toast(`Deleted “${place.name}”. ${unlinked.length} expense${unlinked.length === 1 ? " keeps its" : "s keep their"} coordinates.`);
    }

    function renderAll() {
        renderGreeting();
        renderStatus();
        renderBudget();
        renderFilters();
        renderDiary();
        renderPlaces();
        renderSession();
        if (!state.lastAnalysis) renderAnalysis(null);
    }


    /* =================================================================
       14. START: everything stored earlier is read back and shown
    ================================================================= */
    async function start() {
        // Local Storage
        const loaded = store.prefs.load();
        state.prefs = loaded.value;
        if (!store.prefs.available) notice("prefs", "This browser is blocking Local Storage, so your settings will not be remembered after you close it.");
        else if (loaded.reason === "corrupt") notice("prefs", "Your saved settings could not be read, so the defaults are used.");
        applyTheme(state.prefs.theme);

        // Session Storage
        const session = store.tab.load();
        if (!store.tab.available) notice("session", "This browser is blocking Session Storage, so drafts are not kept if you reload.");

        // a VISIT is a new tab session: Session Storage tells us whether this load is a
        // reload of the same tab (resumed) or a fresh visit, and Local Storage keeps the count
        state.previousVisit = state.prefs.lastVisit;
        if (!session.resumed) {
            store.tab.log("Opened in this tab");
            savePrefs({ visits: state.prefs.visits + 1, lastVisit: new Date().toISOString() });
        } else {
            state.previousVisit = null;
        }

        // IndexedDB
        const { db, error } = await P.db.connect();
        state.db = db;
        if (error) notice("db", `${error.message} Records will only last until this tab is closed.`, "error");
        try {
            [state.expenses, state.places, state.lastAnalysis] = await Promise.all([db.getAll("expenses"), db.getAll("places"), db.get("meta", "lastAnalysis")]);
        } catch (e) {
            notice("db", `Saved records could not be read: ${e.message}`, "error");
        }
        sortExpenses();

        // the form, the draft and the view this tab was on
        fillSelects();
        resetForm({ keepDraft: true });
        const restored = restoreDraft();
        bind();
        createWorker();
        watchPermission();
        renderAll();
        renderAnalysis(state.lastAnalysis);
        showView(store.tab.get().view);
        requestAnimationFrame(heartbeat);
        if (restored) toast("Your unsaved expense was restored from this tab's session.");
        document.body.classList.add("ready");
    }

    start();
    P.app = { state };        // for testing from the console
})(window.Pocket);
