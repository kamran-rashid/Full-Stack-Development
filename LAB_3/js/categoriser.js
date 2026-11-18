/* =====================================================================
   FinTrack Lab 3 - js/categoriser.js
   THE INTELLIGENT ENHANCEMENT: a category assistant that learns.

   Why it is needed: a bank statement has no categories. Without help,
   every imported row would land in "Everything else" and the budget
   comparison would be meaningless, or the user would have to pick a
   category for every row by hand. The assistant suggests a category
   for each description and gets better from the user's own choices.

   How it decides, in order:
     1. LEARNED  - the user has categorised this merchant before
                   (majority vote of their own choices for that merchant key)
     2. KEYWORD  - a known word appears in the description ("uber" -> Transport)
     3. DEFAULT  - nothing matched: "Everything else", marked for review

   Only categories the USER chose ("user") are learned from. If the
   assistant learned from its own guesses, one wrong guess on import
   would be copied to every later row from that merchant and would
   never be corrected (a feedback loop).
===================================================================== */
"use strict";

(function (FT) {
    const { CATEGORIES, merchantKey } = FT.model;

    class Categoriser {
        /** merchant key -> Map(category -> how many times the user chose it) */
        #learned = new Map();

        /** keyword -> category, longest keywords first so "mobile recharge" beats "recharge" */
        #keywords = [...CATEGORIES]
            .flatMap(([id, meta]) => meta.keywords.map((word) => [word, id]))
            .sort((a, b) => b[0].length - a[0].length);

        /** Rebuilds what was learned from the current transactions. */
        learnFrom(transactions) {
            this.#learned.clear();
            for (const tx of transactions) {
                if (tx.type !== "expense" || tx.categorySource !== "user") continue;
                const votes = this.#learned.get(tx.merchant) ?? new Map();
                votes.set(tx.category, (votes.get(tx.category) ?? 0) + 1);
                this.#learned.set(tx.merchant, votes);
            }
        }

        get knownMerchants() { return this.#learned.size; }

        /**
         * @returns {{category: string, source: "learned"|"keyword"|"default", reason: string, confidence: number}}
         */
        suggest(description) {
            const text = String(description ?? "").toLowerCase();
            const key = merchantKey(text);

            const votes = this.#learned.get(key);
            if (votes) {
                let best = null, bestCount = 0, total = 0;
                for (const [category, count] of votes) {
                    total += count;
                    if (count > bestCount) { best = category; bestCount = count; }
                }
                return {
                    category: best,
                    source: "learned",
                    confidence: bestCount / total,
                    reason: `you filed ${bestCount} of ${total} earlier “${key}” ${total === 1 ? "entry" : "entries"} here`
                };
            }

            // whole-word match: "auto" must not match inside "automatic"
            const padded = ` ${text.replace(/[^a-z0-9.]+/g, " ")} `;
            for (const [word, category] of this.#keywords) {
                if (padded.includes(` ${word} `)) {
                    return { category, source: "keyword", confidence: 0.6, reason: `the word “${word}”` };
                }
            }

            return { category: "other", source: "default", confidence: 0, reason: "no match yet: please check it" };
        }
    }

    FT.Categoriser = Categoriser;
})(window.FinTrack);
