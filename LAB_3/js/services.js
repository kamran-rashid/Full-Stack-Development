/* =====================================================================
   FinTrack Lab 3 - js/services.js
   ASYNCHRONOUS WORK. Two operations here must never freeze the page:

   A. fetchRate()      a network request for a live exchange rate
                       (timeout, one retry, cache, stale fallback,
                       cancellation, checks on the shape of the reply)

   B. readStatement()  reading and checking a bank-statement CSV that
                       may hold thousands of rows. The file is read with
                       a Promise (file.text()) and the rows are processed
                       in time slices of ~12 ms, handing control back to
                       the browser between slices so typing, scrolling
                       and the Cancel button keep working.

   Why not a Web Worker for B? Chrome refuses to start a Worker from a
   page opened as a file (file://), and this lab is opened by
   double-clicking index.html. Time-slicing works everywhere.
===================================================================== */
"use strict";

(function (FT) {
    const { createTransaction, ValidationError, CATEGORIES, dates } = FT.model;

    /** Error with a machine-readable kind, so the interface can explain what went wrong. */
    class ServiceError extends Error {
        constructor(kind, message) {
            super(message);
            this.name = "ServiceError";
            this.kind = kind;          // "offline" | "timeout" | "http" | "bad-data" | "aborted" | "file" | "columns"
        }
    }

    const isAbort = (error) => error?.name === "AbortError" || error?.kind === "aborted";

    /**
     * Ends the current task so the browser can paint, handle input and run
     * other timers, then continues. setTimeout(0) is used on purpose rather
     * than scheduler.yield(): scheduler.yield() puts the import back at the
     * FRONT of the queue, and in testing it starved other timers (such as the
     * 6-second timeout of an exchange-rate request) until the import ended.
     */
    function yieldToBrowser() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    const wait = (ms, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new ServiceError("aborted", "Cancelled.")); }, { once: true });
    });


    /* =================================================================
       A. EXCHANGE RATES
       Source: Frankfurter (free, no key, CORS enabled), which publishes
       the European Central Bank reference rates once per working day.
    ================================================================= */
    const CURRENCIES = new Map([
        ["INR", "Indian rupee"],
        ["USD", "US dollar"],
        ["EUR", "Euro"],
        ["GBP", "British pound"],
        ["AED", "UAE dirham"],
        ["SGD", "Singapore dollar"]
    ]);
    const RATE_URL = (currency) => `https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=INR`;
    const RATE_CACHE_KEY = "fintrack.lab3.rates.v1";
    const RATE_FRESH_MS = 12 * 60 * 60 * 1000;     // ECB rates change once a day; 12 hours is fresh enough

    function readRateCache() {
        try { return JSON.parse(localStorage.getItem(RATE_CACHE_KEY)) ?? {}; } catch { return {}; }
    }

    function writeRateCache(currency, entry) {
        try {
            const cache = readRateCache();
            cache[currency] = entry;
            localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(cache));
        } catch { /* saving is a bonus; the rate is still returned */ }
    }

    async function requestRate(currency, { signal, timeoutMs }) {
        // one controller per attempt: it is aborted by the timeout OR by the caller
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new ServiceError("timeout", "timeout")), timeoutMs);
        const onCallerAbort = () => controller.abort(new ServiceError("aborted", "Cancelled."));
        signal?.addEventListener("abort", onCallerAbort, { once: true });

        try {
            const response = await fetch(RATE_URL(currency), { signal: controller.signal, cache: "no-store" });
            if (!response.ok) {
                throw new ServiceError("http", `The rate service answered ${response.status}${response.status >= 500 ? " (a server problem)" : ""}.`);
            }
            let data;
            try { data = await response.json(); } catch { throw new ServiceError("bad-data", "The rate service sent something that is not JSON."); }

            // never trust the shape of a reply from another server
            const rate = data?.rates?.INR;
            if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 10_000 || data.base !== currency) {
                throw new ServiceError("bad-data", "The rate service sent an unexpected reply.");
            }
            return { rate, date: String(data.date ?? ""), fetchedAt: Date.now() };
        } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;        // timeout or cancel
            if (error instanceof ServiceError) throw error;
            throw new ServiceError(navigator.onLine === false ? "offline" : "network", "Could not reach the rate service.");
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onCallerAbort);
        }
    }

    /**
     * How many rupees one unit of `currency` is worth.
     * Resolves { rate, date, origin: "live" | "cache" | "stale", ageMs }.
     * Rejects with a ServiceError only when there is no rate at all to use.
     */
    async function fetchRate(currency, { signal, timeoutMs = 6000, retries = 1 } = {}) {
        if (currency === "INR") return { rate: 1, date: "", origin: "live", ageMs: 0 };
        if (!CURRENCIES.has(currency)) throw new ServiceError("bad-data", `${currency} is not supported.`);

        const cached = readRateCache()[currency];
        const age = cached ? Date.now() - cached.fetchedAt : Infinity;
        if (cached && age < RATE_FRESH_MS) return { ...cached, origin: "cache", ageMs: age };

        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const fresh = await requestRate(currency, { signal, timeoutMs });
                writeRateCache(currency, fresh);
                return { ...fresh, origin: "live", ageMs: 0 };
            } catch (error) {
                lastError = error;
                if (isAbort(error)) throw error;                                   // the user moved on: stop quietly
                const worthRetrying = ["timeout", "network"].includes(error.kind) || /answered 5/.test(error.message);
                if (!worthRetrying || attempt === retries) break;
                await wait(800 * (attempt + 1), signal);                            // back off before trying again
            }
        }

        // the network failed: an old rate is better than no rate, if the user is told
        if (cached) return { ...cached, origin: "stale", ageMs: age, warning: lastError.message };
        throw lastError;
    }


    /* =================================================================
       B. BANK-STATEMENT IMPORT (CSV)
    ================================================================= */
    const MAX_FILE_BYTES = 5 * 1024 * 1024;

    // the many names banks give the same column
    const COLUMN_NAMES = {
        date:        ["date", "txn date", "transaction date", "value date", "posting date", "tran date"],
        description: ["description", "narration", "particulars", "details", "remarks", "transaction details", "merchant"],
        amount:      ["amount", "amount (inr)", "amount(inr)", "amt", "transaction amount"],
        debit:       ["debit", "withdrawal", "withdrawal amt", "withdrawal amount", "debit amount", "dr"],
        credit:      ["credit", "deposit", "deposit amt", "deposit amount", "credit amount", "cr"],
        type:        ["type", "dr/cr", "cr/dr", "debit/credit", "transaction type"],
        category:    ["category"]
    };

    /**
     * Splits CSV text into rows, following RFC 4180: quoted fields may hold
     * commas, line breaks and doubled quotes (""). A generator, so the
     * caller can stop after any row and time-slice the work.
     * Yields { cells: string[], line: number }.
     */
    function* csvRows(text) {
        let cells = [], cell = "", quoted = false, line = 1, rowLine = 1;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
                else if (ch === '"') quoted = false;
                else { if (ch === "\n") line++; cell += ch; }
            } else if (ch === '"' && cell === "") quoted = true;
            else if (ch === ",") { cells.push(cell); cell = ""; }
            else if (ch === "\n" || ch === "\r") {
                if (ch === "\r" && text[i + 1] === "\n") i++;
                cells.push(cell);
                yield { cells, line: rowLine, end: i + 1 };
                cells = []; cell = ""; line++; rowLine = line;
            } else cell += ch;
        }
        if (cell !== "" || cells.length) { cells.push(cell); yield { cells, line: rowLine, end: text.length }; }
    }

    function findColumns(header) {
        const names = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));
        const columns = {};
        for (const [field, aliases] of Object.entries(COLUMN_NAMES)) {
            const index = names.findIndex((n) => aliases.includes(n));
            if (index !== -1) columns[field] = index;
        }
        const hasMoney = "amount" in columns || "debit" in columns || "credit" in columns;
        if (!("date" in columns) || !("description" in columns) || !hasMoney) {
            const missing = [!("date" in columns) && "Date", !("description" in columns) && "Description", !hasMoney && "Amount (or Debit/Credit)"].filter(Boolean);
            throw new ServiceError("columns", `The file has no ${missing.join(", ")} column. The first row should be a header such as: Date,Description,Amount.`);
        }
        return columns;
    }

    const MONTHS = new Map(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map((m, i) => [m, i + 1]));

    /** Accepts 2026-11-05, 05/11/2026, 05-11-2026, 05.11.26 and 05 Nov 2026 (day first, as Indian banks write it). */
    function parseDate(raw) {
        const s = raw.trim();
        let y, m, d, match;
        if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [, y, m, d] = match.map(Number);
        else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) [, d, m, y] = match.map(Number);
        else if ((match = /^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-,]*(\d{2}|\d{4})$/.exec(s))) {
            d = Number(match[1]); m = MONTHS.get(match[2].toLowerCase()); y = Number(match[3]);
            if (!m) return null;
        } else return null;
        if (y < 100) y += 2000;
        if (!dates.isRealDate(y, m, d)) return null;
        return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }

    /** "₹1,23,456.50", "Rs. 500", "(250.00)", "-80", "1,200 Dr" -> signed rupees, or NaN. */
    function parseAmount(raw) {
        let s = String(raw ?? "").trim();
        if (!s) return NaN;
        let sign = 1;
        if (/\bdr\.?$/i.test(s)) { sign = -1; s = s.replace(/\bdr\.?$/i, ""); }
        else if (/\bcr\.?$/i.test(s)) s = s.replace(/\bcr\.?$/i, "");
        if (/^\(.*\)$/.test(s)) { sign = -sign; s = s.slice(1, -1); }
        s = s.replace(/(₹|rs\.?|inr)/gi, "").replace(/[,\s]/g, "");
        if (s.startsWith("-")) { sign = -sign; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
        return /^\d+(\.\d+)?$/.test(s) ? sign * Number(s) : NaN;
    }

    /** One CSV row -> the input for createTransaction, or a reason it cannot be used. */
    function rowToInput(cells, columns, categoriser, allSpending) {
        const get = (field) => (columns[field] === undefined ? "" : (cells[columns[field]] ?? "").trim());

        const date = parseDate(get("date"));
        if (!date) return { error: `"${get("date") || "(empty)"}" is not a date this importer understands.` };

        let signed;
        if ("amount" in columns && get("amount") !== "") {
            signed = parseAmount(get("amount"));
            const typeCell = get("type").toLowerCase();
            if (/^(dr|debit|d|withdrawal)$/.test(typeCell)) signed = -Math.abs(signed);
            else if (/^(cr|credit|c|deposit)$/.test(typeCell)) signed = Math.abs(signed);
            else if (allSpending) signed = -Math.abs(signed);      // no minus signs anywhere in the file: every row is spending
        } else {
            const debit = parseAmount(get("debit")), credit = parseAmount(get("credit"));
            if (Number.isFinite(debit) && debit !== 0) signed = -Math.abs(debit);
            else if (Number.isFinite(credit) && credit !== 0) signed = Math.abs(credit);
            else signed = debit === 0 || credit === 0 ? 0 : NaN;
        }
        if (signed === 0) return { error: "the amount is zero." };
        if (!Number.isFinite(signed)) return { error: "the amount is missing or is not a number." };

        const description = get("description");
        const type = signed < 0 ? "expense" : "income";
        let category = "income", categorySource = "user";
        if (type === "expense") {
            const named = get("category").toLowerCase();
            const fromFile = [...CATEGORIES].find(([id, meta]) => id === named || meta.label.toLowerCase() === named);
            if (fromFile) { category = fromFile[0]; categorySource = "user"; }
            else ({ category, source: categorySource } = categoriser.suggest(description));
        }
        return { input: { date, description, amount: Math.abs(signed), type, category, categorySource, source: "import" } };
    }

    /**
     * Reads and checks a statement file without blocking the page.
     * options: { signal, onProgress(fraction), existing: transactions[], categoriser, sliceMs, rowsPerYield }
     * Resolves {
     *   ready:      transactions that passed every check
     *   rejected:   [{ line, reason }]   rows that could not be used, with the reason
     *   duplicates: [{ line, tx }]       rows already recorded (or repeated in the file)
     *   allSpending                      true when unsigned amounts were all read as spending
     *   rows, ms, slices                 statistics for the evaluation
     * }
     */
    async function readStatement(file, { signal, onProgress = () => {}, existing = [], categoriser, sliceMs = 12, rowsPerYield = 2000 } = {}) {
        const started = performance.now();

        // --- checks on the file itself, before reading it ---
        if (!file) throw new ServiceError("file", "No file was chosen.");
        if (!/\.(csv|txt)$/i.test(file.name) && !/csv|text\/plain/.test(file.type)) {
            throw new ServiceError("file", `“${file.name}” is not a CSV file. Export the statement from your bank as CSV.`);
        }
        if (file.size === 0) throw new ServiceError("file", "The file is empty.");
        if (file.size > MAX_FILE_BYTES) throw new ServiceError("file", `The file is ${(file.size / 1048576).toFixed(1)} MB; the limit is 5 MB.`);

        let text = await file.text();                               // asynchronous read
        if (signal?.aborted) throw new ServiceError("aborted", "Import cancelled.");
        text = text.replace(/^﻿/, "");                       // byte-order mark from Excel
        if (/\u0000/.test(text.slice(0, 1000))) throw new ServiceError("file", "This looks like a binary file (for example .xlsx), not CSV text.");

        const rowsIter = csvRows(text);
        let first = rowsIter.next();
        while (!first.done && first.value.cells.every((c) => !c.trim())) first = rowsIter.next();   // skip blank lines before the header
        if (first.done) throw new ServiceError("file", "The file has no rows.");
        const columns = findColumns(first.value.cells);

        // A single Amount column normally uses a sign: -500 spent, +65000 received.
        // Some exports list only spending, with no signs at all. Look at the first
        // 500 rows: if none is negative, treat every row as spending and say so.
        let allSpending = false;
        if ("amount" in columns && !("type" in columns) && !("debit" in columns) && !("credit" in columns)) {
            allSpending = true;
            let looked = 0;
            for (const { cells } of csvRows(text)) {
                if (looked++ > 500) break;
                if (parseAmount(cells[columns.amount]) < 0) { allSpending = false; break; }
            }
        }

        // fingerprints of what is already recorded: a Set makes each check O(1)
        const fingerprint = (t) => `${t.date}|${t.merchant}|${t.paise}|${t.type}`;
        const seen = new Set(existing.map(fingerprint));

        const ready = [], rejected = [], duplicates = [];
        let rows = 0, slices = 0, sliceStart = performance.now();
        const today = dates.todayISO();

        for (const { cells, line, end } of rowsIter) {
            if (cells.every((c) => !c.trim())) continue;            // blank line
            rows++;

            const parsed = rowToInput(cells, columns, categoriser, allSpending);
            if (parsed.error) rejected.push({ line, reason: parsed.error });
            else {
                try {
                    const tx = createTransaction(parsed.input, { today });
                    const key = fingerprint(tx);
                    if (seen.has(key)) duplicates.push({ line, tx });
                    else { seen.add(key); ready.push(tx); }
                } catch (error) {
                    if (!(error instanceof ValidationError)) throw error;
                    rejected.push({ line, reason: [...error.errors.values()].join(" ") });
                }
            }

            // time-slicing: after ~12 ms of work, let the browser breathe
            // (every 2,000 rows as well, in case the clock is coarse or frozen, e.g. by privacy settings)
            if (performance.now() - sliceStart > sliceMs || rows % rowsPerYield === 0) {
                onProgress(end / text.length, rows);
                await yieldToBrowser();
                slices++;
                if (signal?.aborted) throw new ServiceError("aborted", "Import cancelled.");
                sliceStart = performance.now();
            }
        }

        onProgress(1, rows);
        if (rows === 0) throw new ServiceError("file", "The file has a header but no transactions.");
        return { ready, rejected, duplicates, rows, allSpending, ms: Math.round(performance.now() - started), slices };
    }

    FT.services = { fetchRate, readStatement, ServiceError, isAbort, CURRENCIES, parseDate, parseAmount, csvRows, yieldToBrowser };
})(window.FinTrack);
