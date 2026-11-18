/* =====================================================================
   FinTrack Pocket - js/store.js
   WEB STORAGE: Local Storage (preferences that survive closing the
   browser) and Session Storage (this tab's draft, view, filters and
   activity, gone when the tab closes).

   Both are wrapped so the app never crashes when storage is blocked
   (some privacy settings), full (QuotaExceededError) or holds damaged
   JSON. Every read is validated; every write reports success or failure.
===================================================================== */
"use strict";

window.Pocket = window.Pocket || {};

(function (P) {

    /** Returns the storage object, or null if the browser refuses to let us use it. */
    function probe(kind) {
        try {
            const storage = window[kind];
            const key = "__pocket_probe__";
            storage.setItem(key, key);
            storage.removeItem(key);
            return storage;
        } catch {
            return null;          // SecurityError (storage disabled) or QuotaExceededError (full)
        }
    }

    const local = probe("localStorage");
    const session = probe("sessionStorage");

    function read(storage, key) {
        if (!storage) return { ok: false, reason: "unavailable", value: null };
        try {
            const raw = storage.getItem(key);
            if (raw === null) return { ok: true, fresh: true, value: null };
            return { ok: true, value: JSON.parse(raw) };
        } catch {
            return { ok: false, reason: "corrupt", value: null };
        }
    }

    function write(storage, key, value) {
        if (!storage) return { ok: false, reason: "unavailable" };
        try {
            storage.setItem(key, JSON.stringify(value));
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: error?.name === "QuotaExceededError" ? "full" : "error" };
        }
    }


    /* -----------------------------------------------------------------
       1. PREFERENCES (Local Storage): kept after the browser is closed
    ----------------------------------------------------------------- */
    const PREFS_KEY = "pocket.prefs.v1";
    const CATEGORIES = ["food", "transport", "groceries", "shopping", "bills", "fun", "other"];
    const DEFAULT_PREFS = Object.freeze({
        name: "",                 // shown as "Welcome back, <name>"
        theme: "system",          // system | light | dark
        monthlyBudget: 15000,     // rupees
        radiusKm: 1,              // "near me" radius
        defaultCategory: "food",
        autoTag: true,            // tag new expenses with the current location
        visits: 0,                // how many times the app was opened (shows persistence)
        lastVisit: null
    });

    /** Keeps only valid values; anything odd falls back to the default for that field. */
    function cleanPrefs(raw) {
        const p = { ...DEFAULT_PREFS };
        if (!raw || typeof raw !== "object") return p;
        if (typeof raw.name === "string") p.name = raw.name.trim().slice(0, 30);
        if (["system", "light", "dark"].includes(raw.theme)) p.theme = raw.theme;
        if (Number.isFinite(raw.monthlyBudget) && raw.monthlyBudget >= 0 && raw.monthlyBudget <= 10_000_000) p.monthlyBudget = Math.round(raw.monthlyBudget);
        if ([0.25, 0.5, 1, 2, 5, 10].includes(raw.radiusKm)) p.radiusKm = raw.radiusKm;
        if (CATEGORIES.includes(raw.defaultCategory)) p.defaultCategory = raw.defaultCategory;
        if (typeof raw.autoTag === "boolean") p.autoTag = raw.autoTag;
        if (Number.isInteger(raw.visits) && raw.visits >= 0) p.visits = raw.visits;
        if (typeof raw.lastVisit === "string") p.lastVisit = raw.lastVisit;
        return p;
    }

    const prefs = {
        available: Boolean(local),
        /** { value, ok, fresh, reason } */
        load() {
            const r = read(local, PREFS_KEY);
            return { ...r, value: cleanPrefs(r.value) };
        },
        save(value) {
            return write(local, PREFS_KEY, cleanPrefs(value));
        },
        clear() {
            try { local?.removeItem(PREFS_KEY); } catch { /* nothing to do */ }
        },
        /** Fires when ANOTHER tab changes the preferences (the "storage" event). */
        onChangeElsewhere(callback) {
            window.addEventListener("storage", (event) => {
                if (event.storageArea === local && event.key === PREFS_KEY) callback(cleanPrefs(safeParse(event.newValue)));
            });
        },
        KEY: PREFS_KEY
    };

    function safeParse(text) {
        try { return JSON.parse(text); } catch { return null; }
    }


    /* -----------------------------------------------------------------
       2. THIS TAB'S SESSION (Session Storage): one per tab, survives a
          reload, cleared when the tab is closed. Each tab gets its own.
    ----------------------------------------------------------------- */
    const SESSION_KEY = "pocket.session.v1";
    const MAX_ACTIVITY = 25;

    function newSession() {
        return {
            tabId: Math.random().toString(36).slice(2, 7).toUpperCase(),
            startedAt: new Date().toISOString(),
            view: "diary",
            filters: { category: "all", month: "all" },
            draft: null,               // the half-typed expense
            lastPosition: null,        // last fix, kept only for this tab (location is sensitive)
            activity: [],              // what happened in this tab
            added: 0
        };
    }

    function cleanSession(raw) {
        const s = newSession();
        if (!raw || typeof raw !== "object") return s;
        if (typeof raw.tabId === "string") s.tabId = raw.tabId.slice(0, 8);
        if (typeof raw.startedAt === "string") s.startedAt = raw.startedAt;
        if (["diary", "near", "insights"].includes(raw.view)) s.view = raw.view;
        if (raw.filters && typeof raw.filters === "object") {
            if (raw.filters.category === "all" || CATEGORIES.includes(raw.filters.category)) s.filters.category = raw.filters.category;
            if (raw.filters.month === "all" || /^\d{4}-\d{2}$/.test(raw.filters.month)) s.filters.month = raw.filters.month;
        }
        if (raw.draft && typeof raw.draft === "object") s.draft = raw.draft;
        if (raw.lastPosition && Number.isFinite(raw.lastPosition.lat) && Number.isFinite(raw.lastPosition.lon)) s.lastPosition = raw.lastPosition;
        if (Array.isArray(raw.activity)) s.activity = raw.activity.slice(-MAX_ACTIVITY);
        if (Number.isInteger(raw.added)) s.added = raw.added;
        return s;
    }

    let current = null;

    const tab = {
        available: Boolean(session),
        /** Loads this tab's session, or starts a new one. { value, resumed } */
        load() {
            const r = read(session, SESSION_KEY);
            current = cleanSession(r.value);
            const resumed = Boolean(r.value);
            if (!resumed) write(session, SESSION_KEY, current);
            return { value: current, resumed, ok: r.ok, reason: r.reason };
        },
        get() { return current; },
        update(changes) {
            current = { ...current, ...changes };
            return write(session, SESSION_KEY, current);
        },
        log(action) {
            const entry = { at: new Date().toISOString(), action };
            current = { ...current, activity: [...current.activity, entry].slice(-MAX_ACTIVITY) };
            return write(session, SESSION_KEY, current);
        },
        clear() {
            try { session?.removeItem(SESSION_KEY); } catch { /* nothing to do */ }
            current = newSession();
        },
        KEY: SESSION_KEY
    };

    P.store = { prefs, tab, CATEGORIES, DEFAULT_PREFS };
})(window.Pocket);
