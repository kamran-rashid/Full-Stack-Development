/* =====================================================================
   FinTrack Lab 3 - js/model.js
   THE DATA MODEL: categories, the transaction record, validation and
   the transaction store. No DOM code lives in this file.

   Load order (see index.html): model.js -> categoriser.js -> insights.js
   -> services.js -> app.js. Each file adds one part to window.FinTrack.
===================================================================== */
"use strict";

window.FinTrack = window.FinTrack || {};

(function (FT) {

    /* -----------------------------------------------------------------
       1. CATEGORIES (a Map: id -> metadata)
       A Map keeps insertion order (the order of the Chapter 02 ledger)
       and gives O(1) lookup by id. `ledger` is the row number of the
       matching budget in the Chapter 02 ledger (radio groups b1..b7),
       which is how the tracker reads the user's budgets.
    ----------------------------------------------------------------- */
    const CATEGORIES = new Map([
        ["housing",   { label: "Housing",               ledger: 1, keywords: ["rent", "landlord", "society maintenance", "hostel", "pg rent"] }],
        ["groceries", { label: "Groceries",             ledger: 2, keywords: ["supermarket", "grocery", "groceries", "bigbasket", "blinkit", "zepto", "instamart", "dmart", "vegetable", "milk", "fruits", "kirana", "provision store"] }],
        ["shopping",  { label: "Shopping",              ledger: 3, keywords: ["amazon", "flipkart", "myntra", "ajio", "croma", "decathlon", "nykaa", "online shopping", "mall", "clothes", "shoes"] }],
        ["dining",    { label: "Dining out",            ledger: 4, keywords: ["swiggy", "zomato", "restaurant", "cafe", "coffee", "starbucks", "pizza", "dominos", "burger", "lunch", "dinner", "chai", "bakery"] }],
        ["bills",     { label: "Bills & subscriptions", ledger: 5, keywords: ["electricity", "bescom", "water bill", "gas cylinder", "broadband", "wifi", "airtel", "jio", "mobile recharge", "postpaid", "netflix", "spotify", "prime video", "hotstar", "youtube premium", "subscription", "insurance", "icloud"] }],
        ["transport", { label: "Transport",             ledger: 6, keywords: ["metro", "uber", "ola", "rapido", "auto", "petrol", "fuel", "bmtc", "bus", "train", "irctc", "parking", "fastag", "cab"] }],
        ["other",     { label: "Everything else",       ledger: 7, keywords: [] }]
    ]);

    // Income is kept apart: it never counts against a budget.
    const INCOME = "income";
    const INCOME_LABEL = "Income";

    const TYPES = new Set(["expense", "income"]);
    const SOURCES = new Set(["seed", "manual", "import"]);

    // Who chose the category. Only "user" choices teach the categoriser
    // (see categoriser.js), so its own guesses never reinforce themselves.
    const CATEGORY_SOURCES = new Set(["user", "learned", "keyword", "default"]);

    const LIMITS = {
        minAmount: 1,                 // rupees
        maxAmount: 1_00_00_000,       // one crore: anything bigger is almost certainly a typo
        minDescription: 2,
        maxDescription: 60,
        earliestDate: "2000-01-01"
    };

    function categoryLabel(id) {
        if (id === INCOME) return INCOME_LABEL;
        return CATEGORIES.get(id)?.label ?? "Unknown";
    }


    /* -----------------------------------------------------------------
       2. DATES
       Dates are stored as ISO strings ("2026-11-05"). For arithmetic they
       become day numbers counted in UTC, so a time zone or daylight-saving
       change can never move a transaction to another day.
    ----------------------------------------------------------------- */
    const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

    function isRealDate(y, m, d) {
        const t = new Date(Date.UTC(y, m - 1, d));
        return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
    }

    function toDayNumber(iso) {
        const [, y, m, d] = ISO_DATE.exec(iso).map(Number);
        return Date.UTC(y, m - 1, d) / 86_400_000;
    }

    function fromDayNumber(n) {
        return new Date(n * 86_400_000).toISOString().slice(0, 10);
    }

    // "today" in the user's own time zone (not UTC)
    function todayISO() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }

    function monthKey(iso) {
        return iso.slice(0, 7);                       // "2026-11"
    }

    function daysInMonth(key) {
        const [y, m] = key.split("-").map(Number);
        return new Date(Date.UTC(y, m, 0)).getUTCDate();
    }


    /* -----------------------------------------------------------------
       3. MERCHANT KEY
       Bank statements write the same shop in many ways
       ("UPI/492019/SWIGGY", "Swiggy order #4471", "SWIGGY"). The key keeps
       the meaningful words so all of them group together.
    ----------------------------------------------------------------- */
    const NOISE_WORDS = new Set(["upi", "pos", "neft", "imps", "rtgs", "ach", "nach", "ref", "txn", "payment", "paid", "to", "from", "via", "order", "the", "a", "pvt", "ltd", "india", "online", "bill", "subscription", "card", "debit", "credit"]);

    function merchantKey(description) {
        const words = String(description)
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w && !/\d/.test(w) && !NOISE_WORDS.has(w));
        // fall back to the cleaned text when every word was "noise" (e.g. "Online shopping" -> "shopping")
        return words.slice(0, 3).join(" ") || String(description).toLowerCase().trim();
    }


    /* -----------------------------------------------------------------
       4. THE TRANSACTION RECORD + VALIDATION
       Money is stored as an integer number of paise (Rs 12.50 -> 1250), so
       totals never pick up floating-point errors such as 0.1 + 0.2.
    ----------------------------------------------------------------- */
    class ValidationError extends Error {
        /** @param {Map<string,string>} errors field name -> message */
        constructor(errors) {
            super([...errors.values()].join(" "));
            this.name = "ValidationError";
            this.errors = errors;
        }
    }

    function makeId() {
        if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
        return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Check raw input and build a transaction object. Throws ValidationError
     * listing every problem at once (not just the first), so a form can mark
     * all bad fields together.
     *
     * input: { description, amount (rupees) | paise, date, type, category,
     *          categorySource?, source?, foreign?, id?, createdAt? }
     */
    function createTransaction(input, { today = todayISO() } = {}) {
        const errors = new Map();

        // description: trimmed, inner spaces collapsed, must contain a letter or digit
        const description = String(input.description ?? "").trim().replace(/\s+/g, " ");
        if (!description) errors.set("description", "Enter a description.");
        else if (description.length < LIMITS.minDescription) errors.set("description", "The description is too short.");
        else if (description.length > LIMITS.maxDescription) errors.set("description", `Keep the description under ${LIMITS.maxDescription} characters.`);
        else if (!/[\p{L}\p{N}]/u.test(description)) errors.set("description", "The description needs at least one letter or number.");

        // type
        const type = String(input.type ?? "expense");
        if (!TYPES.has(type)) errors.set("type", "Choose expense or income.");

        // amount: either already in paise (stored data) or rupees typed by a person
        let paise = NaN;
        if (input.paise !== undefined) {
            paise = Number(input.paise);
            if (!Number.isInteger(paise)) paise = NaN;
        } else {
            const raw = typeof input.amount === "string" ? input.amount.trim() : input.amount;
            const rupees = raw === "" || raw === null || raw === undefined ? NaN : Number(raw);
            if (Number.isFinite(rupees)) paise = Math.round(rupees * 100);
            if (Number.isFinite(rupees) && Math.abs(rupees * 100 - paise) > 1e-6) {
                errors.set("amount", "Use at most two decimal places (paise).");
            }
        }
        if (!errors.has("amount")) {
            if (!Number.isFinite(paise)) errors.set("amount", "Enter the amount as a number.");
            else if (paise < LIMITS.minAmount * 100) errors.set("amount", "The amount must be at least ₹1.");
            else if (paise > LIMITS.maxAmount * 100) errors.set("amount", "That is more than ₹1 crore. Check for an extra zero.");
        }

        // date: real calendar date, not in the future, not absurdly old
        const date = String(input.date ?? "");
        const m = ISO_DATE.exec(date);
        if (!m) errors.set("date", "Choose a date.");
        else if (!isRealDate(+m[1], +m[2], +m[3])) errors.set("date", `${date} is not a real calendar date.`);
        else if (date > today) errors.set("date", "The date is in the future. Record a payment once it has happened.");
        else if (date < LIMITS.earliestDate) errors.set("date", "The date is too far in the past.");

        // category: income is fixed; an expense needs one of the seven ledger categories
        let category = type === "income" ? INCOME : String(input.category ?? "");
        if (type !== "income" && !CATEGORIES.has(category)) errors.set("category", "Choose a category.");

        // optional: the original foreign-currency amount
        let foreign = null;
        if (input.foreign) {
            const { currency, amount, rate } = input.foreign;
            if (/^[A-Z]{3}$/.test(currency) && amount > 0 && rate > 0) {
                foreign = { currency, amount: Number(amount), rate: Number(rate) };
            }
        }

        if (errors.size) throw new ValidationError(errors);

        const categorySource = CATEGORY_SOURCES.has(input.categorySource) ? input.categorySource : "user";

        return Object.freeze({
            id: input.id || makeId(),
            date,
            description,
            merchant: merchantKey(description),
            type,
            category,
            categorySource: type === "income" ? "user" : categorySource,
            paise,
            foreign,
            source: SOURCES.has(input.source) ? input.source : "manual",
            createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now()
        });
    }

    /** Compares two transactions newest first (ties: the one recorded later first). */
    function byDateDesc(a, b) {
        return a.date === b.date ? b.createdAt - a.createdAt : (a.date < b.date ? 1 : -1);
    }


    /* -----------------------------------------------------------------
       5. THE STORE
       A Map (id -> transaction) is the single source of truth: O(1) get,
       update and delete by id. Every change fires one "change" event, so
       the interface only has to listen in one place. Records are frozen,
       so a change always goes through update(), never by editing in place.
    ----------------------------------------------------------------- */
    const STORAGE_KEY = "fintrack.lab3.transactions.v1";

    class TransactionStore extends EventTarget {
        #items = new Map();
        #storage;
        storageOK = true;           // false when the browser refuses to save (private mode, quota)

        constructor(storage = globalThis.localStorage) {
            super();
            this.#storage = storage;
        }

        get size() { return this.#items.size; }

        get(id) { return this.#items.get(id); }

        /** All transactions as a new array, newest first. */
        all() { return [...this.#items.values()].sort(byDateDesc); }

        add(input) {
            const tx = createTransaction(input);
            this.#items.set(tx.id, tx);
            this.#commit("add", { ids: [tx.id] });
            return tx;
        }

        /** Adds already-validated transactions in one go (one save, one event). */
        addMany(transactions) {
            for (const tx of transactions) this.#items.set(tx.id, tx);
            this.#commit("import", { ids: transactions.map((t) => t.id) });
        }

        update(id, changes) {
            const old = this.#items.get(id);
            if (!old) throw new Error("That transaction no longer exists.");
            // rebuild from the merged fields so the edit is validated exactly like a new entry
            const merged = { ...old, ...changes, id, createdAt: old.createdAt };
            if ("amount" in changes) delete merged.paise;
            const tx = createTransaction(merged);
            this.#items.set(id, tx);
            this.#commit("update", { ids: [id], before: old });
            return tx;
        }

        remove(id) {
            const tx = this.#items.get(id);
            if (!tx) return null;
            this.#items.delete(id);
            this.#commit("remove", { ids: [id], removed: tx });
            return tx;
        }

        /** Puts a removed transaction back (used by Undo). */
        restore(tx) {
            this.#items.set(tx.id, tx);
            this.#commit("restore", { ids: [tx.id] });
        }

        replaceAll(transactions, reason = "reset") {
            this.#items = new Map(transactions.map((t) => [t.id, t]));
            this.#commit(reason, { ids: [] });
        }

        /**
         * Loads saved data. Every stored record is validated again, because
         * localStorage can be edited by hand or left behind by an older version.
         * Returns { loaded, skipped, fresh } where fresh means nothing was saved yet.
         */
        load() {
            let raw = null;
            try {
                raw = this.#storage?.getItem(STORAGE_KEY) ?? null;
            } catch {
                this.storageOK = false;
            }
            if (raw === null) return { loaded: 0, skipped: 0, fresh: true };

            let records;
            try {
                const parsed = JSON.parse(raw);
                if (parsed?.version !== 1 || !Array.isArray(parsed.items)) throw new Error("bad shape");
                records = parsed.items;
            } catch {
                return { loaded: 0, skipped: 0, fresh: true, corrupt: true };
            }

            const valid = [];
            let skipped = 0;
            for (const record of records) {
                try {
                    // stored dates may be "in the future" relative to a wrong system clock: allow them
                    valid.push(createTransaction(record, { today: "9999-12-31" }));
                } catch {
                    skipped++;
                }
            }
            this.#items = new Map(valid.map((t) => [t.id, t]));
            return { loaded: valid.length, skipped, fresh: false };
        }

        #commit(reason, detail) {
            this.#save();
            this.dispatchEvent(new CustomEvent("change", { detail: { reason, ...detail } }));
        }

        #save() {
            try {
                this.#storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items: [...this.#items.values()] }));
                this.storageOK = true;
            } catch {
                this.storageOK = false;     // the app tells the user once; the data still lives in memory
            }
        }
    }


    /* -----------------------------------------------------------------
       6. DEMO DATA
       August to 18 November 2026. The three past months are built from
       templates with a seeded random generator (so every visitor, and every
       screenshot, gets exactly the same data); November is written out.
    ----------------------------------------------------------------- */
    function seededRandom(seed) {                       // mulberry32
        return function () {
            seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function demoTransactions() {
        const rand = seededRandom(2340236);
        const pick = (list) => list[Math.floor(rand() * list.length)];
        const between = (lo, hi, step = 10) => Math.round((lo + rand() * (hi - lo)) / step) * step;
        const rows = [];
        const add = (date, description, rupees, category, type = "expense") =>
            rows.push({ date, description, amount: rupees, category, type, source: "seed", categorySource: "user" });

        // --- August to October: fixed bills + everyday spending from templates (history for the analysis) ---
        const history = [
            { key: "2026-08", lastDay: 31, electricity: 1540, freelance: 0 },
            { key: "2026-09", lastDay: 30, electricity: 1650, freelance: 8000 },
            { key: "2026-10", lastDay: 31, electricity: 1920, freelance: 6500 }
        ];
        const pools = [
            // category, how many per month, descriptions, rupee range
            ["groceries", 5, ["BigBasket order", "Zepto groceries", "Vegetable market", "Milk and fruits", "Supermarket"], [320, 1500]],
            ["dining", 6, ["Swiggy order", "Zomato order", "Third Wave Coffee", "Lunch with friends", "Chai and snacks"], [120, 650]],
            ["shopping", 2, ["Amazon order", "Myntra order", "Decathlon"], [700, 2400]],
            ["transport", 4, ["Uber ride", "Rapido bike taxi", "Auto rickshaw"], [80, 380]],
            ["other", 2, ["Haircut", "Pharmacy", "Birthday gift", "Stationery"], [150, 900]]
        ];

        for (const month of history) {
            const d = (day) => `${month.key}-${String(day).padStart(2, "0")}`;
            add(d(1), "Metro card recharge", 800, "transport");
            add(d(2), "Electricity bill", month.electricity, "bills");
            add(d(4), "Apartment rent", 12000, "housing");
            add(d(5), "Monthly salary", 65000, "income", "income");
            add(d(12), "Netflix subscription", 649, "bills");
            add(d(21), "Spotify Premium", 119, "bills");
            add(d(28), "Cult.fit membership", 1500, "other");
            if (month.freelance) add(d(18), "Freelance project payment", month.freelance, "income", "income");
            for (const [category, count, names, [lo, hi]] of pools) {
                for (let n = 0; n < count; n++) add(d(1 + Math.floor(rand() * month.lastDay)), pick(names), between(lo, hi), category);
            }
        }
        add("2026-10-31", "Online shopping", 3200, "shopping");           // on the Chapter 02 receipt

        // --- November, day by day up to the 18th: written out so the story is exact ---
        // The first five match the Chapter 02 receipt. Three patterns are planted for the
        // analysis to find: the headphones (unusual), the Swiggy order charged twice
        // (duplicate), and Spotify / Cult.fit still due later in the month (forecast).
        [
            ["01", "Metro card recharge", 800, "transport"],
            ["02", "Electricity bill", 1800, "bills"],
            ["02", "Third Wave Coffee", 340, "dining"],
            ["03", "Supermarket", 2150, "groceries"],
            ["04", "Apartment rent", 12000, "housing"],
            ["05", "Monthly salary", 65000, "income", "income"],
            ["06", "Swiggy order", 420, "dining"],
            ["06", "Uber ride", 240, "transport"],
            ["07", "Myntra order", 1299, "shopping"],
            ["08", "Zepto groceries", 460, "groceries"],
            ["09", "Lunch with friends", 650, "dining"],
            ["10", "Haircut", 300, "other"],
            ["10", "Rapido bike taxi", 95, "transport"],
            ["12", "Netflix subscription", 649, "bills"],
            ["12", "Swiggy order", 486, "dining"],
            ["12", "Swiggy order", 486, "dining"],
            ["13", "Vegetable market", 390, "groceries"],
            ["14", "Auto rickshaw", 180, "transport"],
            ["15", "Croma - noise-cancelling headphones", 8999, "shopping"],
            ["15", "Chai and snacks", 120, "dining"],
            ["16", "Milk and fruits", 520, "groceries"],
            ["17", "Freelance project payment", 7000, "income", "income"],
            ["17", "Pharmacy", 260, "other"]
        ].forEach(([dd, description, rupees, category, type]) => add(`2026-11-${dd}`, description, rupees, category, type));

        // deterministic ids and creation times so sorting is stable
        return rows.map((row, n) =>
            createTransaction({ ...row, id: `seed-${String(n + 1).padStart(3, "0")}`, createdAt: n }, { today: "2026-11-18" })
        );
    }


    FT.model = {
        CATEGORIES, INCOME, LIMITS, TYPES,
        categoryLabel, merchantKey,
        createTransaction, ValidationError, byDateDesc,
        TransactionStore, demoTransactions,
        dates: { todayISO, toDayNumber, fromDayNumber, monthKey, daysInMonth, isRealDate }
    };

})(window.FinTrack);
