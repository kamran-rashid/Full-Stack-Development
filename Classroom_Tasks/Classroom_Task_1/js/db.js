/* =====================================================================
   FinTrack Pocket - js/db.js
   INDEXEDDB: the structured records. Three object stores:

     expenses  { id, amount (paise), category, note, date, location, placeId,
                 createdAt, updatedAt }
               indexes: byDate, byCategory, byPlace
     places    { id, name, lat, lon, radiusM }   saved places ("Home", "College")
     meta      { key, value }                    e.g. the last analysis result

   IndexedDB has an event-based API; this file wraps every request and
   transaction in a Promise so the rest of the app can use async/await.

   If the database cannot be opened (private browsing in some browsers,
   storage disabled, a blocked upgrade), the app keeps working with an
   in-memory copy and tells the user that nothing will be saved.
===================================================================== */
"use strict";

(function (P) {
    const DB_NAME = "fintrack-pocket";
    const DB_VERSION = 1;

    class StorageError extends Error {
        constructor(kind, message) {
            super(message);
            this.name = "StorageError";
            this.kind = kind;        // "unavailable" | "blocked" | "full" | "constraint" | "failed"
        }
    }

    function explain(error) {
        const name = error?.name;
        if (name === "QuotaExceededError") return new StorageError("full", "The browser's storage is full. Delete old records or free some space.");
        if (name === "ConstraintError") return new StorageError("constraint", "A record with that id already exists.");
        return new StorageError("failed", `The database refused the change (${name || "unknown error"}).`);
    }

    /** Promise around a single IDBRequest. */
    function req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(explain(request.error));
        });
    }

    /** Promise around a whole transaction: resolves only once it has committed. */
    function done(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(explain(tx.error));
            tx.onabort = () => reject(explain(tx.error));
        });
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            if (!("indexedDB" in window) || !window.indexedDB) {
                reject(new StorageError("unavailable", "This browser has no IndexedDB."));
                return;
            }
            let request;
            try {
                request = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (error) {
                reject(new StorageError("unavailable", `IndexedDB is switched off (${error.name}).`));
                return;
            }

            // first visit, or a newer version: create the stores and indexes
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains("expenses")) {
                    const expenses = db.createObjectStore("expenses", { keyPath: "id" });
                    expenses.createIndex("byDate", "date");
                    expenses.createIndex("byCategory", "category");
                    expenses.createIndex("byPlace", "placeId");
                }
                if (!db.objectStoreNames.contains("places")) db.createObjectStore("places", { keyPath: "id" });
                if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
            };
            request.onblocked = () => reject(new StorageError("blocked", "Another FinTrack Pocket tab is holding an older version of the database open. Close it and reload."));
            request.onerror = () => reject(new StorageError("unavailable", `The database could not be opened (${request.error?.name}).`));
            request.onsuccess = () => {
                const db = request.result;
                // if a newer version is opened in another tab, step aside instead of blocking it
                db.onversionchange = () => db.close();
                resolve(db);
            };
        });
    }


    /* ---------- the real database ---------- */
    class IndexedStore {
        constructor(db) { this.db = db; this.persistent = true; }

        async getAll(store) {
            const tx = this.db.transaction(store, "readonly");
            return req(tx.objectStore(store).getAll());
        }

        async get(store, key) {
            const tx = this.db.transaction(store, "readonly");
            return req(tx.objectStore(store).get(key));
        }

        /** Records of one index value, e.g. every expense in "food". */
        async getAllByIndex(store, index, value) {
            const tx = this.db.transaction(store, "readonly");
            return req(tx.objectStore(store).index(index).getAll(value));
        }

        async add(store, record) {
            const tx = this.db.transaction(store, "readwrite");
            tx.objectStore(store).add(record);       // add() fails if the id already exists
            await done(tx);
            return record;
        }

        async put(store, record) {
            const tx = this.db.transaction(store, "readwrite");
            tx.objectStore(store).put(record);       // put() inserts or replaces
            await done(tx);
            return record;
        }

        async delete(store, key) {
            const tx = this.db.transaction(store, "readwrite");
            tx.objectStore(store).delete(key);
            await done(tx);
        }

        /** Many records in ONE transaction: all are saved, or none are. */
        async bulkPut(store, records) {
            const tx = this.db.transaction(store, "readwrite");
            const os = tx.objectStore(store);
            for (const record of records) os.put(record);
            await done(tx);
            return records.length;
        }

        async clear(store) {
            const tx = this.db.transaction(store, "readwrite");
            tx.objectStore(store).clear();
            await done(tx);
        }

        async count(store) {
            const tx = this.db.transaction(store, "readonly");
            return req(tx.objectStore(store).count());
        }
    }


    /* ---------- fallback: same methods, kept in memory only ---------- */
    class MemoryStore {
        constructor() {
            this.persistent = false;
            this.stores = { expenses: new Map(), places: new Map(), meta: new Map() };
        }
        keyOf(store, record) { return store === "meta" ? record.key : record.id; }
        async getAll(store) { return [...this.stores[store].values()].map((r) => structuredClone(r)); }
        async get(store, key) { const r = this.stores[store].get(key); return r ? structuredClone(r) : undefined; }
        async getAllByIndex(store, index, value) {
            const field = { byDate: "date", byCategory: "category", byPlace: "placeId" }[index];
            return (await this.getAll(store)).filter((r) => r[field] === value);
        }
        async add(store, record) {
            const key = this.keyOf(store, record);
            if (this.stores[store].has(key)) throw new StorageError("constraint", "A record with that id already exists.");
            this.stores[store].set(key, structuredClone(record));
            return record;
        }
        async put(store, record) { this.stores[store].set(this.keyOf(store, record), structuredClone(record)); return record; }
        async delete(store, key) { this.stores[store].delete(key); }
        async bulkPut(store, records) { for (const r of records) await this.put(store, r); return records.length; }
        async clear(store) { this.stores[store].clear(); }
        async count(store) { return this.stores[store].size; }
    }

    /** Opens IndexedDB; on failure returns the memory store plus the reason. */
    async function connect() {
        try {
            return { db: new IndexedStore(await openDatabase()), error: null };
        } catch (error) {
            return { db: new MemoryStore(), error };
        }
    }

    P.db = { connect, StorageError, DB_NAME };
})(window.Pocket);
