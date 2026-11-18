/* =====================================================================
   FinTrack Lab 3 - js/insights.js
   DATA PROCESSING: pure functions. Each one takes an array of
   transactions and returns new data; none of them changes its input
   or touches the page, so each can be tested on its own.

     filterTransactions   search + multi-category filter + type + sort
     summarise            totals, savings rate, categories used
     totalsByCategory     Map category -> paise
     listMonths           the months that have data
     detectRecurring      subscriptions and fixed monthly bills
     detectUnusual        spending far above that category's normal
     findDuplicates       the same charge recorded twice
     topMerchants         where the money goes most often
     budgetReport         budget vs actual + a month-end forecast
===================================================================== */
"use strict";

(function (FT) {
    const { CATEGORIES, dates } = FT.model;

    const sum = (list, pick = (x) => x) => list.reduce((total, item) => total + pick(item), 0);

    function median(numbers) {
        if (!numbers.length) return 0;
        const s = [...numbers].sort((a, b) => a - b);
        const mid = s.length >> 1;
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    /** Groups a list into a Map by a key function. */
    function groupBy(list, keyOf) {
        const groups = new Map();
        for (const item of list) {
            const key = keyOf(item);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        }
        return groups;
    }

    /** Same day next month, kept inside short months: 31 Jan -> 28 Feb, 4 Nov -> 4 Dec. */
    function addOneMonth(iso) {
        const [y, m, d] = iso.split("-").map(Number);
        const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
        const nd = Math.min(d, dates.daysInMonth(`${ny}-${String(nm).padStart(2, "0")}`));
        return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
    }

    /** Median and median absolute deviation: "typical value" and "typical distance from it". */
    function robustStats(values) {
        const med = median(values);
        return { med, mad: median(values.map((x) => Math.abs(x - med))) };
    }

    const expensesOf = (txs) => txs.filter((t) => t.type === "expense");


    /* ---------- searching, filtering, sorting ---------- */
    const SORTERS = {
        "date-desc":   FT.model.byDateDesc,
        "date-asc":    (a, b) => -FT.model.byDateDesc(a, b),
        "amount-desc": (a, b) => b.paise - a.paise,
        "amount-asc":  (a, b) => a.paise - b.paise
    };

    /**
     * criteria: { query, categories: Set (empty = all), type: "all"|"expense"|"income",
     *             month: "all"|"2026-11", sort }
     * The query matches the description, the category name or an exact amount ("486").
     */
    function filterTransactions(txs, { query = "", categories = new Set(), type = "all", month = "all", sort = "date-desc" } = {}) {
        const q = query.trim().toLowerCase();
        const amountQuery = /^\d+(\.\d{1,2})?$/.test(q.replace(/[,₹\s]/g, "")) ? Math.round(Number(q.replace(/[,₹\s]/g, "")) * 100) : null;

        return txs
            .filter((t) => month === "all" || dates.monthKey(t.date) === month)
            .filter((t) => type === "all" || t.type === type)
            .filter((t) => categories.size === 0 || categories.has(t.category))
            .filter((t) => !q
                || t.description.toLowerCase().includes(q)
                || FT.model.categoryLabel(t.category).toLowerCase().includes(q)
                || (amountQuery !== null && t.paise === amountQuery))
            .sort(SORTERS[sort] ?? SORTERS["date-desc"]);
    }


    /* ---------- totals ---------- */
    function summarise(txs) {
        const income = sum(txs.filter((t) => t.type === "income"), (t) => t.paise);
        const expenses = sum(expensesOf(txs), (t) => t.paise);
        const categoriesUsed = new Set(expensesOf(txs).map((t) => t.category));   // a Set counts distinct values for free
        return {
            income,
            expenses,
            net: income - expenses,
            savingsRate: income > 0 ? (income - expenses) / income : null,
            count: txs.length,
            categoriesUsed: categoriesUsed.size
        };
    }

    function totalsByCategory(txs) {
        const totals = new Map([...CATEGORIES.keys()].map((id) => [id, 0]));   // every category, in ledger order
        for (const t of expensesOf(txs)) totals.set(t.category, totals.get(t.category) + t.paise);
        return totals;
    }

    /** Months that have at least one transaction, newest first. */
    function listMonths(txs) {
        return [...new Set(txs.map((t) => dates.monthKey(t.date)))].sort().reverse();
    }


    /* ---------- PATTERN 1: recurring payments ----------
       A merchant counts as a monthly commitment when it was paid at least
       3 times, roughly a month apart (25 to 35 days), for roughly the same
       amount each time (within 15% of its typical amount). */
    function detectRecurring(txs) {
        const result = [];
        for (const [merchant, list] of groupBy(expensesOf(txs), (t) => t.merchant)) {
            if (list.length < 3) continue;
            const ordered = [...list].sort((a, b) => (a.date < b.date ? -1 : 1));
            const days = ordered.map((t) => dates.toDayNumber(t.date));
            const gaps = days.slice(1).map((d, i) => d - days[i]);
            const typical = median(ordered.map((t) => t.paise));
            const monthly = gaps.every((g) => g >= 25 && g <= 35);
            const steady = ordered.every((t) => Math.abs(t.paise - typical) <= typical * 0.15);
            if (!monthly || !steady) continue;

            const last = ordered.at(-1);
            result.push({
                merchant,
                description: last.description,
                category: last.category,
                typical,
                count: ordered.length,
                lastDate: last.date,
                nextDate: addOneMonth(last.date)
            });
        }
        return result.sort((a, b) => b.typical - a.typical);
    }


    /* ---------- PATTERN 2: unusual spending ----------
       A spend is unusual when it is far above what is normal FOR ITS OWN
       CATEGORY. "Normal" uses the median and the median absolute deviation
       (MAD) of the other spends in that category, which a single huge
       value cannot drag upwards the way it drags an average.
       Recurring bills are left out: rent is large but expected. */
    function detectUnusual(txs, { onlyMonth = "all", minHistory = 5, threshold = 3.5, minTimes = 2.5, minPaise = 1000_00 } = {}) {
        const recurring = new Set(detectRecurring(txs).map((r) => r.merchant));
        const variable = expensesOf(txs).filter((t) => !recurring.has(t.merchant));
        const flagged = [];

        for (const [, list] of groupBy(variable, (t) => t.category)) {
            if (list.length < minHistory + 1) continue;           // too little history to judge
            // With little history, judge each spend against the OTHERS only (leave-one-out), or one
            // big spend would raise its own "normal". With 50+ spends one value barely moves the
            // median, so the category's statistics are worked out once: O(n log n) instead of O(n^2 log n).
            const shared = list.length >= 50 ? robustStats(list.map((o) => o.paise)) : null;
            for (const t of list) {
                if (onlyMonth !== "all" && dates.monthKey(t.date) !== onlyMonth) continue;
                if (t.paise < minPaise) continue;                  // small amounts are never worth an alert
                const { med, mad } = shared ?? robustStats(list.filter((o) => o !== t).map((o) => o.paise));
                // modified z-score (Iglewicz and Hoaglin). With MAD = 0 fall back to "more than 3x normal".
                const score = mad > 0 ? (0.6745 * (t.paise - med)) / mad : (t.paise > 3 * med ? Infinity : 0);
                // statistically far out AND at least 2.5x normal: a 1.8x gift is not worth an alert
                if (score > threshold && t.paise >= minTimes * med) flagged.push({ tx: t, typical: med, times: t.paise / med });
            }
        }
        return flagged.sort((a, b) => b.times - a.times);
    }


    /* ---------- PATTERN 3: possible double charges ----------
       Same merchant, same amount, at most one day apart. Sorting by date
       first means each transaction only needs comparing with the last one
       seen for its merchant + amount, so the check is O(n log n). */
    function findDuplicates(txs, { maxDays = 1 } = {}) {
        const lastSeen = new Map();                  // "merchant|paise" -> previous transaction
        const pairs = [];
        const ordered = [...expensesOf(txs)].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
        for (const t of ordered) {
            const key = `${t.merchant}|${t.paise}`;
            const prev = lastSeen.get(key);
            if (prev && dates.toDayNumber(t.date) - dates.toDayNumber(prev.date) <= maxDays) pairs.push([prev, t]);
            lastSeen.set(key, t);
        }
        return pairs;
    }

    /** Would this new entry duplicate one already recorded? (used before adding) */
    function findDuplicateOf(candidate, txs, { maxDays = 1 } = {}) {
        const day = dates.toDayNumber(candidate.date);
        return txs.find((t) =>
            t.id !== candidate.id &&
            t.type === candidate.type &&
            t.merchant === candidate.merchant &&
            t.paise === candidate.paise &&
            Math.abs(dates.toDayNumber(t.date) - day) <= maxDays) ?? null;
    }


    /* ---------- where the money goes most ---------- */
    function topMerchants(txs, limit = 5) {
        const byMerchant = new Map();
        for (const t of expensesOf(txs)) {
            const entry = byMerchant.get(t.merchant) ?? { merchant: t.merchant, description: t.description, total: 0, count: 0 };
            entry.total += t.paise;
            entry.count += 1;
            byMerchant.set(t.merchant, entry);
        }
        return [...byMerchant.values()].sort((a, b) => b.total - a.total).slice(0, limit);
    }


    /* ---------- budget vs actual, with a month-end forecast ----------
       A naive forecast ("spent so far / days gone x days in month") is wrong
       for fixed bills: rent paid on the 4th would be projected to happen
       again. So the forecast is split in two:
         fixed     = recurring bills already paid this month
                   + recurring bills still due later this month
                   + one-off unusual spends (a laptop is not bought every week)
         variable  = everything else, projected at the current daily pace */
    function budgetReport(allTxs, budgets, month, today = dates.todayISO()) {
        const monthTxs = expensesOf(allTxs).filter((t) => dates.monthKey(t.date) === month);
        const totalDays = dates.daysInMonth(month);
        const isCurrent = dates.monthKey(today) === month;
        const daysGone = isCurrent ? Number(today.slice(8, 10)) : totalDays;
        const monthEnd = `${month}-${String(totalDays).padStart(2, "0")}`;

        const recurring = detectRecurring(allTxs);
        const recurringKeys = new Set(recurring.map((r) => r.merchant));
        const paidThisMonth = new Set(monthTxs.map((t) => t.merchant));
        const stillDue = isCurrent
            ? recurring.filter((r) => !paidThisMonth.has(r.merchant) && r.nextDate > today && r.nextDate <= monthEnd)
            : [];

        // one-off spends (the unusual ones) happen once: they are not projected forward either
        const oneOffIds = new Set(isCurrent ? detectUnusual(allTxs, { onlyMonth: month }).map((u) => u.tx.id) : []);

        const rows = [...CATEGORIES].map(([id, meta]) => {
            const txs = monthTxs.filter((t) => t.category === id);
            const spent = sum(txs, (t) => t.paise);
            const fixed = sum(txs.filter((t) => recurringKeys.has(t.merchant) || oneOffIds.has(t.id)), (t) => t.paise);
            const due = sum(stillDue.filter((r) => r.category === id), (r) => r.typical);
            const variable = spent - fixed;
            // an estimate, so it is rounded to whole rupees
            const forecast = isCurrent ? Math.round((fixed + due + (variable / daysGone) * totalDays) / 100) * 100 : spent;
            const budget = budgets.get(id) ?? 0;

            let status = "ok";
            if (budget > 0 && spent > budget) status = "over";
            else if (budget > 0 && forecast > budget) status = "heading-over";
            else if (budget > 0 && spent > budget * 0.8) status = "close";

            return { id, label: meta.label, spent, budget, forecast, due, status };
        });

        return {
            month, isCurrent, daysGone, totalDays, rows, stillDue,
            totals: {
                spent: sum(rows, (r) => r.spent),
                budget: sum(rows, (r) => r.budget),
                forecast: sum(rows, (r) => r.forecast)
            }
        };
    }

    FT.insights = {
        filterTransactions, summarise, totalsByCategory, listMonths,
        detectRecurring, detectUnusual, findDuplicates, findDuplicateOf,
        topMerchants, budgetReport, median, groupBy
    };
})(window.FinTrack);
