/*
 * Loads every published store and product for the Shop screen.
 *
 * Firebase's free plan allows 50,000 reads a day, and one load reads every
 * product once. So results are cached on the phone and only re-downloaded
 * when they're over 5 minutes old (or the shopper taps Refresh). The cache
 * also means the Shop screen still shows the last results with no internet.
 *
 * status values:
 *   idle     nothing loaded yet
 *   loading  downloading
 *   ok       up to date (updatedAt = when)
 *   offline  no internet; showing cached results if there are any
 *   error    download failed (message); showing cached results if any
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMarketplace, currentUidIfSignedIn } from "./firebase.js";

const CACHE_KEY = "andito:marketplace:v1";
const MAX_AGE_MS = 5 * 60 * 1000;

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (c && Array.isArray(c.stores) && Array.isArray(c.listings)) return c;
  } catch {
    // corrupt or missing cache: start empty
  }
  return null;
}

function writeCache(c) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    // storage full or unavailable: the Shop screen still works, just uncached
  }
}

export function useMarketplace() {
  const [state, setState] = useState(() => {
    const c = readCache();
    return {
      stores: c ? c.stores : [],
      listings: c ? c.listings : [],
      updatedAt: c ? c.at : null,
      ownUid: null,
      status: "idle",
      message: "",
    };
  });
  const loadingRef = useRef(false);
  const updatedAtRef = useRef(state.updatedAt);

  const refresh = useCallback(async ({ force = false } = {}) => {
    if (loadingRef.current) return;
    if (!force && updatedAtRef.current && Date.now() - updatedAtRef.current < MAX_AGE_MS) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState((s) => ({ ...s, status: "offline" }));
      return;
    }
    loadingRef.current = true;
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const [{ stores, listings }, ownUid] = await Promise.all([fetchMarketplace(), currentUidIfSignedIn()]);
      const at = Date.now();
      updatedAtRef.current = at;
      writeCache({ at, stores, listings });
      setState({ stores, listings, updatedAt: at, ownUid, status: "ok", message: "" });
    } catch (e) {
      setState((s) => ({ ...s, status: "error", message: String(e?.message || e) }));
    } finally {
      loadingRef.current = false;
    }
  }, []);

  // Load (or refresh a stale cache) when the app starts, and catch up when
  // the internet comes back.
  useEffect(() => {
    refresh();
    const onOnline = () => refresh();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [refresh]);

  // ownUid also matters for cached results shown before the first download.
  useEffect(() => {
    let cancelled = false;
    currentUidIfSignedIn()
      .then((uid) => {
        if (!cancelled && uid) setState((s) => (s.ownUid === uid ? s : { ...s, ownUid: uid }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return { ...state, refresh };
}
