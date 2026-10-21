/*
 * Saved data for Andito, kept on this phone.
 *
 * App.jsx saves through window.storage.get / set / delete / list (the shape
 * of the Claude artifact storage API it was first written for). This file
 * provides that API; each call returns {key, value, shared} or null.
 *
 * WHERE IT'S KEPT: IndexedDB. Earlier versions used localStorage, which the
 * Android web view caps at roughly 5-10 MB for the whole app. The sales log
 * grows with every sale, so a busy store would eventually fill that up, and
 * from then on nothing new would be saved. IndexedDB has no such small cap.
 *
 * MOVING OVER is automatic. When a key isn't in IndexedDB yet, its old
 * localStorage copy is read instead, and the next save writes it to
 * IndexedDB. The old copy stays where it is and is never written again, so
 * if an older APK were ever installed it would still find the store as it
 * was on the day of the move, not an empty one. (The one time it's removed:
 * when localStorage is so full that even the small "moved" marker won't
 * fit. By then the old copy is out of date anyway.)
 *
 * ERRORS ARE PASSED ON, NEVER HIDDEN. If saved data can't be read, get()
 * rejects instead of answering "nothing saved", so the app never mistakes a
 * read problem for a first launch and autosaves a blank store over the real
 * one. The one exception is a phone where IndexedDB has never held Andito's
 * data (MOVED_FLAG not set): there, localStorage is still the newest copy,
 * so carrying on with it as before loses nothing.
 */

import { Capacitor } from "@capacitor/core";

const PREFIX = "andito:";
const DB_NAME = "andito";
const DB_STORE = "kv";
const OPEN_TIMEOUT_MS = 10000;
const MOVED_FLAG = `${PREFIX}moved-to-indexeddb`;

const fullKey = (key, shared) => `${PREFIX}${shared ? "shared:" : "personal:"}${key}`;
const hasIndexedDB = typeof indexedDB !== "undefined";

/* Ask Android to treat Andito's saved data as persistent, so it isn't
   cleared to make room when the phone runs low on space (Capacitor's storage
   guide: on Android, the persisted storage API protects IndexedDB). Only in
   the app; a desktop browser might show a permission prompt for this. */
try {
  if (Capacitor.isNativePlatform() && typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
} catch {
  // not available: nothing to do
}

function hasMoved() {
  try {
    return localStorage.getItem(MOVED_FLAG) === "1";
  } catch {
    return false;
  }
}

// Called after `k` was saved to IndexedDB.
function markMoved(k) {
  if (hasMoved()) return;
  try {
    localStorage.setItem(MOVED_FLAG, "1");
  } catch {
    // localStorage is full, most likely with this key's old copy (the very
    // reason for moving). That copy is out of date now, so it goes to make
    // room for the flag.
    try {
      localStorage.removeItem(k);
      localStorage.setItem(MOVED_FLAG, "1");
    } catch {
      // Still impossible. The data itself is safely in IndexedDB either way.
    }
  }
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Saved data took too long to open.")), OPEN_TIMEOUT_MS);
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      // If the connection goes away, the next call opens a new one.
      const forget = () => {
        if (dbPromise === p) dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error || new Error("Couldn't open saved data."));
    };
  });
  dbPromise = p;
  // A failed open isn't remembered: the next call tries again.
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

/* Runs one request in its own transaction. Resolves with the request's
   result once the transaction has completed (for a write: once it's saved). */
function run(mode, makeRequest) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let tx;
        try {
          // "strict": a save counts as done only once it's actually on the
          // phone's storage, so a sale isn't lost if the phone dies right
          // after. (Older phones ignore this option.)
          tx = mode === "readwrite" ? db.transaction(DB_STORE, mode, { durability: "strict" }) : db.transaction(DB_STORE, mode);
        } catch (e) {
          dbPromise = null; // the connection is no longer usable: reopen next time
          reject(e);
          return;
        }
        const req = makeRequest(tx.objectStore(DB_STORE));
        let result;
        req.onsuccess = () => {
          result = req.result;
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || req.error || new Error("Saving failed."));
        tx.onabort = () => reject(tx.error || new Error("Saving was interrupted."));
        if (mode === "readwrite" && typeof tx.commit === "function") tx.commit();
      })
  );
}

/* Besides {key, value, shared}, get() can report two unusual cases, both
   only possible if IndexedDB lost data it once held (for example, Android
   clearing it when the phone was nearly full):
     stale: true    the value is the older localStorage copy from the day of
                    the move, not the latest save;
     lost: true     no copy at all (value is null).
   The app tells the owner about either one, instead of silently opening an
   old or empty store. */
async function get(key, shared = false) {
  const k = fullKey(key, shared);
  if (hasIndexedDB) {
    try {
      const value = await run("readonly", (s) => s.get(k));
      if (value !== undefined) return { key, value, shared };
    } catch (e) {
      if (hasMoved()) throw e; // the real data is in IndexedDB: don't answer from an older copy
    }
  }
  // Not moved to IndexedDB yet (or this phone has no IndexedDB): the localStorage copy.
  const legacy = localStorage.getItem(k);
  const moved = hasIndexedDB && hasMoved();
  if (legacy == null) return moved ? { key, value: null, shared, lost: true } : null;
  return moved ? { key, value: legacy, shared, stale: true } : { key, value: legacy, shared };
}

async function set(key, value, shared = false) {
  const k = fullKey(key, shared);
  if (hasIndexedDB) {
    try {
      await run("readwrite", (s) => s.put(value, k));
      markMoved(k);
      return { key, value, shared };
    } catch (e) {
      if (hasMoved()) throw e; // never split newer data across two places
    }
  }
  localStorage.setItem(k, value); // throws if full: the app shows that saving failed
  return { key, value, shared };
}

async function del(key, shared = false) {
  const k = fullKey(key, shared);
  const existed = (await get(key, shared)) != null;
  if (hasIndexedDB) {
    try {
      await run("readwrite", (s) => s.delete(k));
    } catch (e) {
      if (hasMoved()) throw e;
    }
  }
  localStorage.removeItem(k);
  return existed ? { key, deleted: true, shared } : null;
}

async function list(prefix = "", shared = false) {
  const scope = `${PREFIX}${shared ? "shared:" : "personal:"}`;
  const keys = new Set();
  if (hasIndexedDB) {
    try {
      const all = await run("readonly", (s) => s.getAllKeys());
      for (const full of all || []) {
        if (typeof full === "string" && full.startsWith(scope + prefix)) keys.add(full.slice(scope.length));
      }
    } catch (e) {
      if (hasMoved()) throw e;
    }
  }
  for (let i = 0; i < localStorage.length; i++) {
    const full = localStorage.key(i);
    if (full && full.startsWith(scope + prefix)) keys.add(full.slice(scope.length));
  }
  return { keys: [...keys], prefix, shared };
}

if (typeof window !== "undefined" && !window.storage) {
  window.storage = { get, set, delete: del, list };
}
