/* =====================================================================
   FinTrack Lab 3 - js/app.js
   THE INTERFACE: reads the page, listens for events, and draws the
   tracker from the store. The flow is always one way:

       user event -> store changes -> store fires "change" -> render()

   so no handler ever edits the page directly after changing data.

   Contents
     1. Helpers (element builder, money and date formatting)
     2. State
     3. Budgets from the Chapter 02 ledger
     4. Rendering
     5. The form: suggestions, live validation, currency, submit, edit
     6. Statement import (drag and drop, progress, preview)
     7. Table actions, filters, export, reset
     8. Start-up
===================================================================== */
"use strict";

(function (FT) {
    const { model, insights, services } = FT;
    const { CATEGORIES, categoryLabel, dates } = model;

    const root = document.getElementById("tracker");
    if (!root) return;                         // the page has no tracker: nothing to do


    /* =================================================================
       1. HELPERS
    ================================================================= */
    const $ = (selector, scope = document) => scope.querySelector(selector);

    /**
     * Builds an element. Text is always added as text nodes (never as HTML),
     * so a description such as <img onerror=...> is shown, not run.
     */
    function h(tag, props = {}, ...children) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === null || value === undefined || value === false) continue;
            if (key === "class") el.className = value;
            else if (key === "dataset") Object.assign(el.dataset, value);
            else if (key === "style") for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
            else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
            else el.setAttribute(key, value === true ? "" : value);
        }
        el.append(...children.flat(Infinity)
            .filter((c) => c !== null && c !== undefined && c !== false && c !== "")
            .map((c) => (c instanceof Node ? c : String(c))));
        return el;
    }

    const inrWhole = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
    const inrPaise = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
    const money = (paise) => (paise % 100 === 0 ? inrWhole : inrPaise).format(paise / 100);
    const signedMoney = (tx) => `${tx.type === "income" ? "+" : "−"}${money(tx.paise)}`;
    const percent = (fraction) => `${Math.round(fraction * 100)}%`;

    const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
    const fmtDay = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });
    const fmtFull = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
    const fmtMonth = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
    const day = (iso) => fmtDay.format(asDate(iso));
    const fullDate = (iso) => fmtFull.format(asDate(iso));
    const monthName = (key) => (key === "all" ? "All months" : fmtMonth.format(asDate(`${key}-01`)));

    const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

    function debounce(fn, ms) {
        let timer;
        return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    }


    /* =================================================================
       2. STATE
       Everything the interface needs to remember, in one object.
       The transactions themselves live only in the store.
    ================================================================= */
    const store = new model.TransactionStore();
    const categoriser = new FT.Categoriser();

    const state = {
        month: null,                                  // "2026-11" or "all"
        filters: { query: "", categories: new Set(), type: "all", sort: "date-desc" },
        limit: 50,                                    // rows shown before "Show more"
        editingId: null,
        categoryTouched: false,                       // true once the user picks a category themselves
        allowDuplicate: null,                         // the entry the user confirmed is not a duplicate
        rate: { currency: "INR", token: 0, controller: null, promise: null, result: null },
        importController: null,
        pendingImport: null,                          // { result, fileName } waiting for "Add"
        undo: null
    };

    const el = {
        month: $("#trk-month"), saveState: $("#trk-save"), stats: $("#trk-stats"),
        form: $("#trk-form"), errors: $("#trk-errors"), formTitle: $("#trk-form-title"),
        desc: $("#trk-desc"), known: $("#trk-known"), amount: $("#trk-amount"), currency: $("#trk-currency"),
        rate: $("#trk-rate"), date: $("#trk-date"), category: $("#trk-category"), suggest: $("#trk-cat-hint"),
        submit: $("#trk-submit"), cancel: $("#trk-cancel"),
        drop: $("#trk-drop"), file: $("#trk-file"), progress: $("#trk-progress"), progressBar: $("#trk-progress-bar"),
        progressText: $("#trk-progress-text"), importCancel: $("#trk-import-cancel"), preview: $("#trk-preview"),
        budgetSub: $("#trk-budget-sub"), budget: $("#trk-budget"), insights: $("#trk-insights"),
        search: $("#trk-search"), typeFilter: $("#trk-type-filter"), sort: $("#trk-sort"), chips: $("#trk-chips"),
        clearFilters: $("#trk-clear-filters"), count: $("#trk-count"), rows: $("#trk-rows"), empty: $("#trk-empty"),
        more: $("#trk-more"), exportBtn: $("#trk-export"), resetBtn: $("#trk-reset"), clearBtn: $("#trk-clear"),
        toast: $("#trk-toast"),
        ledger: $(".ledger-form"), receipt: $(".receipt ol"), alerts: $(".alerts")
    };


    /* =================================================================
       3. BUDGETS: read from the Chapter 02 ledger (radio groups b1..b7),
       so changing a budget there updates the tracker's budget check.
    ================================================================= */
    function readBudgets() {
        const budgets = new Map();
        for (const [id, meta] of CATEGORIES) {
            const checked = el.ledger?.querySelector(`input[name="b${meta.ledger}"]:checked`);
            budgets.set(id, checked ? Math.round(Number(checked.value) * 100) : 0);
        }
        return budgets;
    }


    /* =================================================================
       4. RENDERING
    ================================================================= */
    function render() {
        const all = store.all();
        categoriser.learnFrom(all);

        const months = insights.listMonths(all);
        if (state.month !== "all" && !months.includes(state.month)) state.month = months[0] ?? "all";
        const scoped = state.month === "all" ? all : all.filter((t) => dates.monthKey(t.date) === state.month);

        renderMonthPicker(months);
        renderStats(scoped);
        renderBudget(all);
        renderInsights(all, scoped);
        renderTable(all);
        renderReceipt(all);
        renderAlerts(all);
        renderKnownDescriptions(all);
        el.saveState.textContent = store.storageOK
            ? "✓ Saved in this browser"
            : "⚠ Not saved: this browser blocks storage, so changes last until you close the tab";
        el.saveState.classList.toggle("is-warn", !store.storageOK);
    }

    function renderMonthPicker(months) {
        el.month.replaceChildren(
            ...months.map((key) => h("option", { value: key }, monthName(key))),
            h("option", { value: "all" }, "All months")
        );
        el.month.value = state.month;
    }

    function renderStats(txs) {
        const s = insights.summarise(txs);
        const tile = (label, value, note, cls) =>
            h("div", { class: cls }, h("dt", {}, label), h("dd", { class: "big" }, value), note && h("dd", { class: "note" }, note));
        el.stats.replaceChildren(
            tile("Money in", money(s.income), monthName(state.month)),
            tile("Money out", money(s.expenses), plural(s.count, "transaction"), "is-spend"),
            tile(s.net >= 0 ? "Left over" : "Overspent by", money(Math.abs(s.net)), s.net >= 0 ? "Income minus spending" : "Spending is above income", s.net < 0 ? "is-spend" : ""),
            tile("Savings rate", s.savingsRate === null ? "—" : percent(s.savingsRate), s.savingsRate === null ? "No income recorded" : "Share of income kept"),
            tile("Categories used", `${s.categoriesUsed} of ${CATEGORIES.size}`, "Distinct spending categories")
        );
    }

    function renderBudget(all) {
        if (state.month === "all") {
            el.budgetSub.textContent = "Choose a single month above to compare it with your budgets.";
            el.budget.replaceChildren();
            return;
        }
        const report = insights.budgetReport(all, readBudgets(), state.month);
        el.budgetSub.textContent = report.isCurrent
            ? `${monthName(state.month)}, day ${report.daysGone} of ${report.totalDays}. Budgets come from the ledger in Chapter 02: change one there and this table follows.`
            : `${monthName(state.month)} is finished, so the forecast is simply what was spent. Budgets come from the Chapter 02 ledger.`;

        const statusText = (r) => ({
            over: `Over by ${money(r.spent - r.budget)}`,
            "heading-over": `Heading over by ${money(r.forecast - r.budget)}`,
            close: `${percent(r.spent / r.budget)} used`,
            ok: r.budget ? "On track" : "No budget"
        })[r.status];

        const rows = report.rows.map((r) => {
            const usedPct = r.budget ? Math.min(r.spent / r.budget, 1.5) : 0;
            const forecastPct = r.budget ? Math.min(r.forecast / r.budget, 1.5) : 0;
            return h("tr", { class: `is-${r.status}` },
                h("th", { scope: "row" }, r.label),
                h("td", { class: "num", "data-label": "Spent" }, money(r.spent)),
                h("td", { class: "num", "data-label": "Budget" }, r.budget ? money(r.budget) : "—"),
                h("td", { class: "num", "data-label": report.isCurrent ? "Forecast" : "Final" }, money(r.forecast), r.due ? h("small", {}, `incl. ${money(r.due)} still due`) : null),
                h("td", { class: "trk-status-cell" },
                    h("span", { class: "trk-meter", "aria-hidden": "true", style: { "--used": usedPct, "--forecast": forecastPct } }),
                    h("span", { class: "trk-status" }, r.status === "over" || r.status === "heading-over" ? "▲ " : "", statusText(r)))
            );
        });

        const t = report.totals;
        el.budget.replaceChildren(
            h("div", { class: "trk-table-wrap" },
                h("table", { class: "trk-table trk-budget-table" },
                    h("caption", { class: "vh" }, `Budget check for ${monthName(state.month)}`),
                    h("thead", {}, h("tr", {},
                        h("th", { scope: "col" }, "Category"), h("th", { scope: "col", class: "num" }, "Spent"),
                        h("th", { scope: "col", class: "num" }, "Budget"), h("th", { scope: "col", class: "num" }, report.isCurrent ? "Month-end forecast" : "Final"),
                        h("th", { scope: "col" }, "Status"))),
                    h("tbody", {}, rows),
                    h("tfoot", {}, h("tr", {},
                        h("th", { scope: "row" }, "Total"), h("td", { class: "num", "data-label": "Spent" }, money(t.spent)),
                        h("td", { class: "num", "data-label": "Budget" }, money(t.budget)), h("td", { class: "num", "data-label": report.isCurrent ? "Forecast" : "Final" }, money(t.forecast)),
                        h("td", { class: "trk-status-cell" }, t.forecast > t.budget ? `▲ Forecast ${money(t.forecast - t.budget)} over` : `Forecast ${money(t.budget - t.forecast)} under`)))
                )
            ),
            report.stillDue.length
                ? h("p", { class: "trk-due" }, "Still due this month: ",
                    report.stillDue.map((r, i) => [i ? ", " : "", h("strong", {}, r.description), ` ${money(r.typical)} on ${day(r.nextDate)}`]), ".")
                : null
        );
    }

    function insightCard(title, ...body) {
        return h("article", { class: "trk-insight" }, h("h4", {}, title), ...body);
    }

    function renderInsights(all, scoped) {
        const scopeName = state.month === "all" ? "across all months" : `in ${monthName(state.month)}`;

        // 1. monthly commitments (always from the full history: a pattern needs months of data)
        const recurring = insights.detectRecurring(all);
        const committed = recurring.reduce((total, r) => total + r.typical, 0);
        const card1 = insightCard("Monthly commitments",
            recurring.length
                ? [h("p", { class: "trk-lead" }, h("strong", {}, money(committed)), " a month is spoken for before you spend anything."),
                   h("ul", { class: "trk-mini" }, recurring.map((r) =>
                       h("li", {}, h("span", {}, r.description, h("small", {}, `${categoryLabel(r.category)} · next about ${day(r.nextDate)}`)), h("b", {}, money(r.typical)))))]
                : h("p", { class: "trk-calm" }, "No repeating monthly payments yet. They appear after three similar payments about a month apart."));

        // 2. unusual spending
        const unusual = insights.detectUnusual(all, { onlyMonth: state.month });
        const card2 = insightCard("Unusual spending",
            unusual.length
                ? h("ul", { class: "trk-mini" }, unusual.slice(0, 4).map(({ tx, typical, times }) =>
                    h("li", { class: "is-warn" },
                        h("span", {}, tx.description, h("small", {}, `${day(tx.date)} · ${times.toFixed(1)}× a usual ${categoryLabel(tx.category)} spend (${money(Math.round(typical / 100) * 100)})`)),
                        h("b", {}, money(tx.paise)))))
                : h("p", { class: "trk-calm" }, `✓ Nothing out of the ordinary ${scopeName}.`));

        // 3. possible double charges, each with a one-click fix
        const pairs = insights.findDuplicates(scoped);
        const card3 = insightCard("Possible double charges",
            pairs.length
                ? h("ul", { class: "trk-mini" }, pairs.map(([first, copy]) =>
                    h("li", { class: "is-warn" },
                        h("span", {}, copy.description, h("small", {}, `${money(copy.paise)} recorded twice (${day(first.date)}${first.date === copy.date ? "" : ` and ${day(copy.date)}`})`)),
                        h("button", { type: "button", class: "trk-link", dataset: { action: "delete", id: copy.id }, "aria-label": `Delete copy: the second ${copy.description} of ${money(copy.paise)}` }, "Delete copy"))))
                : h("p", { class: "trk-calm" }, `✓ No repeated charges ${scopeName}.`));

        // 4. where the money went (category bars + biggest merchants)
        const totals = [...insights.totalsByCategory(scoped)].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const spent = totals.reduce((s, [, v]) => s + v, 0);
        const top = insights.topMerchants(scoped, 3);
        const card4 = insightCard("Where it went",
            spent
                ? [h("ul", { class: "trk-bars" }, totals.map(([id, paise]) =>
                      h("li", { style: { "--share": paise / totals[0][1], "--c": `var(--cat${CATEGORIES.get(id).ledger})` } },
                          h("span", {}, categoryLabel(id)), h("b", {}, `${money(paise)} · ${percent(paise / spent)}`)))),
                   h("p", { class: "trk-small" }, "Most money went to: ",
                       top.map((m, i) => [i ? ", " : "", h("strong", {}, m.description), ` (${money(m.total)}, ${plural(m.count, "payment")})`]), ".")]
                : h("p", { class: "trk-calm" }, `No spending recorded ${scopeName}.`));

        el.insights.replaceChildren(card1, card2, card3, card4);
    }

    function renderTable(all) {
        const matches = insights.filterTransactions(all, { ...state.filters, month: state.month });
        const shown = matches.slice(0, state.limit);

        el.rows.replaceChildren(...shown.map((tx) => {
            const auto = tx.source === "import" && tx.categorySource !== "user";
            return h("tr", { class: tx.id === state.editingId ? "is-editing" : "", dataset: { id: tx.id } },
                h("td", { "data-label": "Date" }, h("time", { datetime: tx.date }, fullDate(tx.date))),
                h("td", { "data-label": "Description" }, tx.description,
                    tx.foreign ? h("small", {}, `${tx.foreign.currency} ${tx.foreign.amount.toLocaleString("en-IN")} at ₹${tx.foreign.rate}`) : null),
                h("td", { "data-label": "Category" }, categoryLabel(tx.category),
                    auto ? h("span", { class: "trk-badge", title: "Chosen automatically on import. Edit the row to correct it; FinTrack will learn." }, tx.categorySource === "default" ? "check" : "auto") : null),
                h("td", { "data-label": "Amount", class: `num ${tx.type === "income" ? "in" : "outgo"}` }, signedMoney(tx)),
                h("td", { class: "trk-actions" },
                    h("button", { type: "button", class: "trk-link", dataset: { action: "edit", id: tx.id }, "aria-label": `Edit ${tx.description}, ${fullDate(tx.date)}` }, "Edit"),
                    h("button", { type: "button", class: "trk-link is-danger", dataset: { action: "delete", id: tx.id }, "aria-label": `Delete ${tx.description}, ${fullDate(tx.date)}` }, "Delete"))
            );
        }));

        const out = matches.filter((t) => t.type === "expense").reduce((s, t) => s + t.paise, 0);
        const into = matches.filter((t) => t.type === "income").reduce((s, t) => s + t.paise, 0);
        el.count.textContent = matches.length
            ? `Showing ${shown.length} of ${plural(matches.length, "transaction")} · out ${money(out)} · in ${money(into)}`
            : "No transactions match";
        el.empty.hidden = matches.length > 0;
        el.more.hidden = matches.length <= state.limit;
        el.more.textContent = `Show ${Math.min(50, matches.length - state.limit)} more`;

        const filtering = state.filters.query || state.filters.categories.size || state.filters.type !== "all";
        el.clearFilters.disabled = !filtering;
    }

    /** Chapter 02's receipt now shows the six latest real entries. */
    function renderReceipt(all) {
        if (!el.receipt) return;
        el.receipt.replaceChildren(...all.slice(0, 6).map((tx) =>
            h("li", {},
                h("time", { datetime: tx.date }, day(tx.date).toUpperCase()),
                h("span", {}, tx.description, h("small", {}, categoryLabel(tx.category))),
                h("b", { class: tx.type === "income" ? "in" : "outgo" }, signedMoney(tx).replace("−", "-")))));
    }

    /** Chapter 02's "payment alerts" box lists double charges in the latest month. */
    function renderAlerts(all) {
        if (!el.alerts) return;
        const latest = insights.listMonths(all)[0];
        const pairs = latest ? insights.findDuplicates(all.filter((t) => dates.monthKey(t.date) === latest)) : [];
        // an empty list keeps Lab 2's CSS message ("No failed or pending payments") working
        el.alerts.replaceChildren(...pairs.map(([, copy]) =>
            h("li", {}, `Possible double charge: ${copy.description}, ${money(copy.paise)} on ${day(copy.date)}. `, h("a", { href: "#trk-insights-title" }, "Review"))));
    }

    /** Autocomplete for the description box: the 40 most recent distinct descriptions. */
    function renderKnownDescriptions(all) {
        const distinct = [...new Set(all.map((t) => t.description))].slice(0, 40);
        el.known.replaceChildren(...distinct.map((d) => h("option", { value: d })));
    }


    /* ---------- messages ("toast") with an optional action, e.g. Undo ---------- */
    let toastTimer;
    function toast(message, { action, onAction, ms = 6000, tone = "info", focus = false } = {}) {
        clearTimeout(toastTimer);
        const button = action ? h("button", { type: "button", class: "trk-link", onclick: () => { hideToast(); onAction(); } }, action) : null;
        el.toast.replaceChildren(h("span", {}, message), button);
        el.toast.dataset.tone = tone;
        el.toast.classList.add("is-on");
        if (focus && button) button.focus();
        toastTimer = setTimeout(hideToast, ms);
    }
    function hideToast() { el.toast.classList.remove("is-on"); }
    // keep the message open while the user is reading or using it
    el.toast.addEventListener("pointerenter", () => clearTimeout(toastTimer));
    el.toast.addEventListener("focusin", () => clearTimeout(toastTimer));
    el.toast.addEventListener("pointerleave", () => { toastTimer = setTimeout(hideToast, 3000); });


    /* =================================================================
       5. THE FORM
    ================================================================= */
    const FIELDS = ["description", "amount", "date", "category", "type"];
    const FIELD_ORDER = ["type", "description", "amount", "date", "category"];
    const fieldInput = { description: el.desc, amount: el.amount, date: el.date, category: el.category };

    function fillStaticOptions() {
        el.category.replaceChildren(h("option", { value: "" }, "Choose…"),
            ...[...CATEGORIES].map(([id, meta]) => h("option", { value: id }, meta.label)));
        el.currency.replaceChildren(...[...services.CURRENCIES].map(([code, name]) => h("option", { value: code }, `${code} · ${name}`)));
        el.chips.replaceChildren(h("legend", {}, "Categories"),
            ...[...CATEGORIES, [model.INCOME, { label: "Income" }]].map(([id, meta]) =>
                h("label", { class: "trk-chip" }, h("input", { type: "checkbox", value: id }), meta.label)));
        const today = dates.todayISO();
        el.date.max = today;
        el.date.value = today;
    }

    const currentType = () => el.form.elements.type.value;

    function setFieldError(name, message) {
        const input = fieldInput[name];
        const box = $(`#trk-${name}-err`);
        if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
        if (box) box.textContent = message ?? "";
    }

    function clearErrors() {
        FIELDS.forEach((f) => setFieldError(f, null));
        el.errors.hidden = true;
        el.errors.replaceChildren();
    }

    /** Shows every problem: beside its field, and as a list at the top that takes focus. */
    function showErrors(unordered) {
        // list problems in the order the fields appear, so the summary reads top to bottom
        const errors = new Map([...unordered].sort(([a], [b]) => FIELD_ORDER.indexOf(a) - FIELD_ORDER.indexOf(b)));
        for (const [field, message] of errors) setFieldError(field, message);
        el.errors.replaceChildren(
            h("p", {}, errors.size === 1 ? "One thing needs fixing:" : `${errors.size} things need fixing:`),
            h("ul", {}, [...errors].map(([field, message]) =>
                h("li", {}, h("a", { href: `#${fieldInput[field]?.id ?? "trk-desc"}` }, message)))));
        el.errors.hidden = false;
        el.errors.focus();
    }

    /** The amount box accepts "1,200", "₹ 450" and "12.5"; a minus sign or words are refused. */
    function readAmount() {
        const raw = el.amount.value.trim();
        if (!raw) return { error: "Enter an amount." };
        const value = services.parseAmount(raw);
        if (Number.isNaN(value)) return { error: `“${raw}” is not an amount. Use digits, for example 1,250 or 99.50.` };
        if (value < 0) return { error: "Enter the amount without a minus sign, and choose Money out or Money in above." };
        return { value };
    }

    /** Builds the candidate transaction from the form, or a Map of errors. */
    function readForm() {
        const errors = new Map();
        const amount = readAmount();
        if (amount.error) errors.set("amount", amount.error);
        const input = {
            description: el.desc.value,
            amount: amount.value ?? 0,
            date: el.date.value,
            type: currentType(),
            category: el.category.value,
            categorySource: "user",                   // the user saw and confirmed this category
            source: "manual"
        };
        try {
            const tx = model.createTransaction(input);
            return errors.size ? { errors } : { input, tx };
        } catch (error) {
            if (!(error instanceof model.ValidationError)) throw error;
            for (const [field, message] of error.errors) if (!errors.has(field)) errors.set(field, message);
            return { errors };
        }
    }

    /** Validates one field when the user leaves it (not while they are still typing). */
    function validateField(name) {
        const result = readForm();
        setFieldError(name, result.errors?.get(name) ?? null);
    }

    /* ---------- category suggestion (the enhancement, in the form) ---------- */
    function updateSuggestion() {
        if (currentType() === "income") { el.suggest.textContent = ""; return; }
        const text = el.desc.value.trim();
        if (text.length < 3) { el.suggest.textContent = ""; return; }
        const s = categoriser.suggest(text);
        const label = categoryLabel(s.category);
        if (!state.categoryTouched) {
            el.category.value = s.source === "default" ? "" : s.category;
            el.suggest.textContent = s.source === "default"
                ? "No suggestion yet: please choose."
                : `Suggested ${label}, because ${s.reason}.`;
            if (s.source !== "default") setFieldError("category", null);
        } else if (s.source !== "default" && s.category !== el.category.value) {
            el.suggest.textContent = `FinTrack would suggest ${label} (${s.reason}).`;
        } else {
            el.suggest.textContent = "";
        }
    }

    function syncTypeUI() {
        const income = currentType() === "income";
        el.category.disabled = income;
        if (income) { el.category.value = ""; setFieldError("category", null); el.suggest.textContent = "Money in is recorded as Income."; }
        else updateSuggestion();
    }

    /* ---------- foreign currency: live rate (asynchronous) ---------- */
    function showRate(kind, message, { retry = false } = {}) {
        el.rate.dataset.state = kind;
        el.rate.replaceChildren(message);
        if (retry) el.rate.append(" ", h("button", { type: "button", class: "trk-link", onclick: () => ensureRate(el.currency.value, { force: true }).catch(() => {}) }, "Try again"));
    }

    function describeRate(result, currency) {
        const amount = readAmount();
        const converted = amount.value ? ` ${amount.value.toLocaleString("en-IN")} ${currency} ≈ ${money(Math.round(amount.value * result.rate * 100))}.` : "";
        const when = result.date ? ` (ECB reference rate for ${fullDate(result.date)})` : "";
        if (result.origin === "stale") {
            const hoursOld = Math.round(result.ageMs / 3_600_000);
            return ["stale", `⚠ Offline, so using the rate saved ${hoursOld < 48 ? `${hoursOld} hours` : `${Math.round(hoursOld / 24)} days`} ago: 1 ${currency} = ₹${result.rate.toFixed(2)}.${converted}`];
        }
        return ["ok", `1 ${currency} = ₹${result.rate.toFixed(2)}${when}.${converted}`];
    }

    /**
     * Gets the rate for `currency`, reusing a request already in flight.
     * A newer request cancels an older one, and a token check makes sure a
     * slow old reply can never overwrite the message for a newer currency.
     */
    function ensureRate(currency, { force = false } = {}) {
        const r = state.rate;
        if (!force && r.currency === currency && r.result) return Promise.resolve(r.result);
        if (!force && r.currency === currency && r.promise) return r.promise;

        r.controller?.abort();
        const controller = new AbortController();
        const token = ++r.token;
        Object.assign(r, { currency, controller, result: null });
        if (currency === "INR") { r.promise = null; showRate("idle", ""); return Promise.resolve({ rate: 1 }); }

        showRate("loading", `Fetching today’s ${currency} → INR rate…`);
        r.promise = services.fetchRate(currency, { signal: controller.signal })
            .then((result) => {
                if (token !== r.token) return result;              // a newer request has taken over
                r.result = result;
                const [kind, text] = describeRate(result, currency);
                showRate(kind, text);
                return result;
            })
            .catch((error) => {
                if (token === r.token && !services.isAbort(error)) {
                    const why = { timeout: "the service did not answer in 6 seconds", offline: "you seem to be offline", "bad-data": "the reply was not a valid rate" }[error.kind] ?? error.message.replace(/\.$/, "");
                    showRate("error", `Could not get a ${currency} rate: ${why}. Enter the amount in INR instead, or`, { retry: true });
                }
                throw error;
            })
            .finally(() => { if (token === r.token) r.promise = null; });
        return r.promise;
    }

    const refreshRateText = debounce(() => {
        const r = state.rate;
        if (r.result && r.currency === el.currency.value && el.currency.value !== "INR") {
            const [kind, text] = describeRate(r.result, r.currency);
            showRate(kind, text);
        }
    }, 200);

    /* ---------- submit ---------- */
    async function onSubmit(event) {
        event.preventDefault();
        if (el.submit.disabled) return;               // a submit is already running (double click / double Enter)
        clearErrors();

        const currency = el.currency.value;
        const result = readForm();
        if (result.errors) { showErrors(result.errors); return; }
        let { input } = result;

        // convert a foreign amount to rupees: wait for the rate without freezing the page
        if (currency !== "INR") {
            setBusy(true, "Converting…");
            try {
                const rate = await ensureRate(currency);
                const original = input.amount;
                input = { ...input, amount: Math.round(original * rate.rate * 100) / 100, foreign: { currency, amount: original, rate: rate.rate } };
            } catch (error) {
                setBusy(false);
                if (services.isAbort(error)) return;
                showErrors(new Map([["amount", `The ${currency} amount could not be converted (no exchange rate). Switch the currency to INR and enter the rupee amount, or try again.`]]));
                return;
            }
            setBusy(false);
        }

        // reliability: warn before saving what looks like the same payment twice
        const candidate = model.createTransaction(input);
        const signature = `${candidate.date}|${candidate.merchant}|${candidate.paise}|${candidate.type}`;
        const repeat = insights.findDuplicateOf({ ...candidate, id: state.editingId }, store.all());
        if (repeat && state.allowDuplicate !== signature) {
            showDuplicateWarning(repeat, signature);
            return;
        }
        state.allowDuplicate = null;

        try {
            if (state.editingId) {
                const saved = store.update(state.editingId, { foreign: null, ...input });
                toast(`Saved changes to “${saved.description}”.`);
                endEdit();
            } else {
                const saved = store.add(input);
                const elsewhere = state.month !== "all" && dates.monthKey(saved.date) !== state.month;
                toast(`Added “${saved.description}” (${signedMoney(saved)}) to ${categoryLabel(saved.category)}.`,
                    elsewhere ? { action: `View ${monthName(dates.monthKey(saved.date))}`, onAction: () => setMonth(dates.monthKey(saved.date)) } : {});
                resetForm({ keepDate: true });
            }
        } catch (error) {
            if (error instanceof model.ValidationError) showErrors(error.errors);
            else toast(error.message, { tone: "error" });
        }
    }

    function showDuplicateWarning(repeat, signature) {
        el.errors.replaceChildren(
            h("p", {}, `This looks like a repeat of “${repeat.description}”, ${money(repeat.paise)} on ${fullDate(repeat.date)}.`),
            h("div", { class: "button-row" },
                h("button", { type: "button", class: "btn", onclick: () => { state.allowDuplicate = signature; el.form.requestSubmit(); } }, "Add it anyway"),
                h("button", { type: "button", class: "btn secondary", onclick: () => { clearErrors(); el.desc.focus(); } }, "Don’t add")));
        el.errors.hidden = false;
        el.errors.focus();
    }

    function setBusy(busy, label) {
        el.submit.disabled = busy;
        el.submit.setAttribute("aria-busy", String(busy));
        el.submit.textContent = busy ? label : (state.editingId ? "Save changes" : "Add transaction");
    }

    function resetForm({ keepDate = false } = {}) {
        const keptDate = el.date.value;
        const keptType = currentType();
        el.form.reset();
        if (keepDate) el.date.value = keptDate; else el.date.value = dates.todayISO();
        el.form.elements.type.value = keptType;
        state.categoryTouched = false;
        state.allowDuplicate = null;
        el.suggest.textContent = "";
        showRate("idle", "");
        state.rate.controller?.abort();
        Object.assign(state.rate, { currency: "INR", result: null, promise: null, token: state.rate.token + 1 });
        clearErrors();
        syncTypeUI();
        el.desc.focus();
    }

    function startEdit(id) {
        const tx = store.get(id);
        if (!tx) return;
        state.editingId = id;
        resetForm();
        el.form.elements.type.value = tx.type;
        el.desc.value = tx.description;
        el.amount.value = (tx.paise / 100).toFixed(tx.paise % 100 ? 2 : 0);
        el.date.value = tx.date;
        syncTypeUI();
        if (tx.type === "expense") el.category.value = tx.category;
        state.categoryTouched = true;
        el.suggest.textContent = tx.foreign ? `Originally ${tx.foreign.currency} ${tx.foreign.amount}; edit the rupee amount here.` : "";
        el.formTitle.textContent = "Edit transaction";
        el.submit.textContent = "Save changes";
        el.cancel.hidden = false;
        el.form.classList.add("is-editing");
        render();                                    // highlights the row being edited
        el.form.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
        el.desc.focus({ preventScroll: true });
    }

    function endEdit() {
        state.editingId = null;
        el.formTitle.textContent = "Record a transaction";
        el.cancel.hidden = true;
        el.form.classList.remove("is-editing");
        resetForm({ keepDate: false });
        render();
    }


    /* =================================================================
       6. STATEMENT IMPORT
    ================================================================= */
    async function startImport(file) {
        state.importController?.abort();                 // a newer file replaces an import still running
        const controller = new AbortController();
        state.importController = controller;
        state.pendingImport = null;
        el.preview.hidden = true;
        el.progress.hidden = false;
        el.progressBar.value = 0;
        el.progressText.textContent = `Reading ${file?.name ?? "file"}…`;

        try {
            const result = await services.readStatement(file, {
                signal: controller.signal,
                existing: store.all(),
                categoriser,
                onProgress: (fraction, rows) => {
                    el.progressBar.value = fraction;
                    el.progressText.textContent = `Checked ${plural(rows, "row")} (${percent(fraction)})`;
                }
            });
            if (state.importController !== controller) return;
            state.pendingImport = { result, fileName: file.name };
            renderPreview();
        } catch (error) {
            if (state.importController !== controller) return;
            if (services.isAbort(error)) toast("Import cancelled. Nothing was added.");
            else renderImportError(error, file);
        } finally {
            if (state.importController === controller) {
                state.importController = null;
                el.progress.hidden = true;
            }
            el.file.value = "";                          // allows choosing the same file again
        }
    }

    function renderImportError(error, file) {
        el.preview.replaceChildren(
            h("p", { class: "trk-preview-head is-error", role: "alert" }, h("strong", {}, `${file?.name ?? "The file"} could not be imported. `), error.message),
            h("div", { class: "button-row" }, h("button", { type: "button", class: "btn secondary", onclick: discardImport }, "Close")));
        el.preview.hidden = false;
    }

    function renderPreview() {
        const { result, fileName } = state.pendingImport;
        const { ready, rejected, duplicates, rows, ms, slices } = result;
        const out = ready.filter((t) => t.type === "expense").reduce((s, t) => s + t.paise, 0);
        const into = ready.filter((t) => t.type === "income").reduce((s, t) => s + t.paise, 0);
        const auto = ready.filter((t) => t.type === "expense" && t.categorySource !== "user");
        const unsure = auto.filter((t) => t.categorySource === "default").length;
        const list = (items, text) => h("ul", { class: "trk-issues" }, items.slice(0, 25).map(text), items.length > 25 ? h("li", {}, `…and ${items.length - 25} more`) : null);

        el.preview.replaceChildren(
            h("p", { class: "trk-preview-head", role: "status" }, h("strong", {}, fileName), ` · ${plural(rows, "row")} checked in ${ms} ms${slices ? `, in ${slices + 1} slices so the page stayed usable` : ""}.`),
            h("ul", { class: "trk-outcome" },
                h("li", { class: "is-ok" }, `✓ ${plural(ready.length, "transaction")} ready: out ${money(out)}, in ${money(into)}.`),
                auto.length ? h("li", {}, `✱ ${auto.length} categorised automatically${unsure ? `; ${unsure} had no match and went to Everything else (marked “check”)` : ""}.`) : null,
                result.allSpending ? h("li", {}, "✱ The file has no minus signs, so every amount was read as money out.") : null,
                duplicates.length ? h("li", {}, `↺ ${plural(duplicates.length, "row")} already recorded, so ${duplicates.length === 1 ? "it" : "they"} will be skipped.`) : null,
                rejected.length ? h("li", { class: "is-warn" }, `⚠ ${plural(rejected.length, "row")} could not be used.`) : null),
            rejected.length ? h("details", {}, h("summary", {}, "Why rows were skipped"), list(rejected, (r) => h("li", {}, `Line ${r.line}: ${r.reason}`))) : null,
            duplicates.length ? h("details", {}, h("summary", {}, "Rows already recorded"), list(duplicates, (d) => h("li", {}, `Line ${d.line}: ${d.tx.description}, ${money(d.tx.paise)} on ${fullDate(d.tx.date)}`))) : null,
            h("div", { class: "button-row" },
                ready.length ? h("button", { type: "button", class: "btn", onclick: confirmImport }, `Add ${plural(ready.length, "transaction")}`) : null,
                h("button", { type: "button", class: "btn secondary", onclick: discardImport }, ready.length ? "Discard" : "Close")));
        el.preview.hidden = false;
        el.preview.querySelector(".btn").focus();
    }

    function confirmImport() {
        const { result, fileName } = state.pendingImport ?? {};
        if (!result) return;
        // the store may have changed while the preview was open: drop anything now recorded
        const existing = new Set(store.all().map((t) => `${t.date}|${t.merchant}|${t.paise}|${t.type}`));
        const fresh = result.ready.filter((t) => !existing.has(`${t.date}|${t.merchant}|${t.paise}|${t.type}`));
        store.addMany(fresh);
        state.pendingImport = null;
        el.preview.hidden = true;
        const newest = fresh.map((t) => t.date).sort().at(-1);
        if (newest) state.month = dates.monthKey(newest);
        state.limit = 50;
        render();
        toast(`Added ${plural(fresh.length, "transaction")} from ${fileName}.`);
    }

    function discardImport() {
        state.pendingImport = null;
        el.preview.hidden = true;
        el.preview.replaceChildren();
        el.drop.focus();
    }


    /* =================================================================
       7. TABLE ACTIONS, FILTERS, EXPORT, RESET
    ================================================================= */
    function deleteTransaction(id) {
        const tx = store.remove(id);
        if (!tx) return;
        if (state.editingId === id) endEdit();
        toast(`Deleted “${tx.description}” (${signedMoney(tx)}).`, {
            action: "Undo", ms: 8000, focus: true,
            onAction: () => { store.restore(tx); toast(`Restored “${tx.description}”.`); }
        });
    }

    function setMonth(key) {
        const apply = () => { state.month = key; state.limit = 50; render(); };
        // a short cross-fade between months where the browser supports view transitions
        if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
            document.startViewTransition(apply);
        } else {
            apply();
        }
    }

    function clearAllFilters() {
        state.filters = { query: "", categories: new Set(), type: "all", sort: el.sort.value };
        el.search.value = "";
        el.typeFilter.value = "all";
        el.chips.querySelectorAll("input").forEach((box) => { box.checked = false; });
        state.limit = 50;
        render();
    }

    /** A cell is quoted when needed; text starting with = + - @ is defused so a spreadsheet will not run it as a formula. */
    function csvCell(value) {
        let text = String(value);
        if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    function exportCsv() {
        const txs = insights.filterTransactions(store.all(), { ...state.filters, month: state.month });
        if (!txs.length) { toast("There is nothing to export with these filters.", { tone: "error" }); return; }
        const lines = [["Date", "Description", "Category", "Amount"].join(",")];
        for (const t of txs) {
            const amount = ((t.type === "income" ? 1 : -1) * t.paise / 100).toFixed(2);
            lines.push([t.date, csvCell(t.description), csvCell(categoryLabel(t.category)), amount].join(","));
        }
        const blob = new Blob([`﻿${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = h("a", { href: url, download: `fintrack-${state.month}.csv` });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast(`Exported ${plural(txs.length, "transaction")}. Re-importing the file is safe: every row is detected as already recorded.`);
    }

    /** Dangerous buttons need a second click within 4 seconds. */
    function confirmTwice(button, label, run) {
        if (button.dataset.armed) {
            delete button.dataset.armed;
            button.textContent = label;
            run();
            return;
        }
        button.dataset.armed = "true";
        button.textContent = "Click again to confirm";
        setTimeout(() => { delete button.dataset.armed; button.textContent = label; }, 4000);
    }


    /* =================================================================
       8. EVENTS AND START-UP
    ================================================================= */
    function bindEvents() {
        // every store change redraws the tracker (one place, one direction)
        store.addEventListener("change", render);

        el.month.addEventListener("change", () => setMonth(el.month.value));

        // budgets: the ledger in Chapter 02 is a plain HTML form
        el.ledger?.addEventListener("change", render);
        el.ledger?.addEventListener("reset", () => setTimeout(render));   // reset fires before the radios change

        // form
        el.form.addEventListener("submit", onSubmit);
        el.desc.addEventListener("input", updateSuggestion);
        el.category.addEventListener("change", () => { state.categoryTouched = el.category.value !== ""; updateSuggestion(); validateField("category"); });
        el.form.addEventListener("change", (e) => { if (e.target.name === "type") syncTypeUI(); });
        el.currency.addEventListener("change", () => ensureRate(el.currency.value).catch(() => {}));
        el.amount.addEventListener("input", () => { refreshRateText(); if (el.amount.getAttribute("aria-invalid") === "true") validateField("amount"); });
        for (const [name, input] of Object.entries(fieldInput)) {
            input.addEventListener("blur", () => { if (input.value || input.getAttribute("aria-invalid") === "true") validateField(name); });
        }
        el.desc.addEventListener("input", () => { if (el.desc.getAttribute("aria-invalid") === "true") validateField("description"); });
        el.date.addEventListener("change", () => validateField("date"));
        el.cancel.addEventListener("click", endEdit);
        el.form.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.editingId) { e.preventDefault(); endEdit(); } });
        // links in the error summary move focus to their field
        el.errors.addEventListener("click", (e) => {
            const link = e.target.closest("a[href^='#']");
            if (link) { e.preventDefault(); $(link.getAttribute("href"))?.focus(); }
        });

        // import: file picker, drag and drop, cancel
        el.file.addEventListener("change", () => { if (el.file.files[0]) startImport(el.file.files[0]); });
        el.importCancel.addEventListener("click", () => state.importController?.abort());
        for (const type of ["dragenter", "dragover"]) {
            el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.add("is-over"); });
        }
        for (const type of ["dragleave", "drop"]) {
            el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.remove("is-over"); });
        }
        el.drop.addEventListener("drop", (e) => {
            const files = [...(e.dataTransfer?.files ?? [])];
            if (!files.length) { toast("That was not a file. Drop a .csv statement.", { tone: "error" }); return; }
            if (files.length > 1) toast(`${files.length} files were dropped; importing only “${files[0].name}”.`);
            startImport(files[0]);
        });
        // a file dropped anywhere else must not make the browser navigate away from the page
        window.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
        window.addEventListener("drop", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });

        // table: one listener for every row (event delegation), including the duplicate card's button
        root.addEventListener("click", (e) => {
            const button = e.target.closest("button[data-action]");
            if (!button) return;
            if (button.dataset.action === "edit") startEdit(button.dataset.id);
            if (button.dataset.action === "delete") deleteTransaction(button.dataset.id);
        });
        el.more.addEventListener("click", () => { state.limit += 50; render(); });

        // filters
        const applySearch = debounce(() => { state.filters.query = el.search.value; state.limit = 50; render(); }, 150);
        el.search.addEventListener("input", applySearch);
        el.typeFilter.addEventListener("change", () => { state.filters.type = el.typeFilter.value; state.limit = 50; render(); });
        el.sort.addEventListener("change", () => { state.filters.sort = el.sort.value; render(); });
        el.chips.addEventListener("change", (e) => {
            const box = e.target;
            if (box.checked) state.filters.categories.add(box.value); else state.filters.categories.delete(box.value);
            state.limit = 50;
            render();
        });
        el.clearFilters.addEventListener("click", clearAllFilters);
        el.empty.querySelector("button")?.addEventListener("click", clearAllFilters);

        // data actions
        el.exportBtn.addEventListener("click", exportCsv);
        el.resetBtn.addEventListener("click", () => confirmTwice(el.resetBtn, "Restore demo data", () => {
            store.replaceAll(model.demoTransactions(), "reset");
            state.month = null;
            toast("The demo data is back. Your own entries were removed.");
        }));
        el.clearBtn.addEventListener("click", () => confirmTwice(el.clearBtn, "Delete all", () => {
            const backup = store.all();
            store.replaceAll([], "clear");
            toast(`Deleted ${plural(backup.length, "transaction")}.`, { action: "Undo", ms: 10000, onAction: () => store.replaceAll(backup, "restore") });
        }));
    }

    function start() {
        fillStaticOptions();
        const loaded = store.load();
        if (loaded.fresh) store.replaceAll(model.demoTransactions(), "seed");
        bindEvents();
        render();
        syncTypeUI();
        if (loaded.corrupt) toast("The saved data could not be read, so the demo data was restored.", { tone: "error", ms: 9000 });
        else if (loaded.skipped) toast(`${plural(loaded.skipped, "saved record")} ${loaded.skipped === 1 ? "was" : "were"} damaged and left out.`, { tone: "error", ms: 9000 });
        if (!store.storageOK) toast("This browser is not letting FinTrack save. Your entries will last until the tab is closed.", { tone: "error", ms: 9000 });
        root.classList.add("is-ready");
    }

    start();

    // exposed for testing in the browser console (and the automated tests)
    FT.app = { store, categoriser, state, render };
})(window.FinTrack);
