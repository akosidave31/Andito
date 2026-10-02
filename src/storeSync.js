/*
 * Keeps the owner's published store in Firebase in step with the phone.
 *
 * The phone is always the main copy: if Firebase is down or the phone is
 * offline, nothing in the app stops working; publishing just catches up
 * later. All Firebase work runs one task at a time through a queue, so an
 * "unlist my store" can never interleave with a publish still in flight
 * (which could otherwise re-create a store the owner just removed).
 *
 * status values:
 *   off            publishing is turned off
 *   needs-profile  turned on, but the store profile isn't complete yet
 *   offline        no internet; will publish when it comes back
 *   syncing        uploading changes
 *   synced         up to date (at = time of last successful sync, uid = store id)
 *   error          last upload failed; retries automatically (message)
 *   removing       deleting the store from Firebase
 *   remove-failed  deleting failed; store may still be public (message)
 */
import { useEffect, useRef, useState } from "react";
import { ensureSignedIn, fetchPublished, pushChanges, unpublishStore } from "./firebase.js";

const SYNC_DELAY_MS = 2000;
const RETRY_MS = 60000;

export const isProfileComplete = (p) =>
  !!p && ["name", "kind", "area", "hours", "phone"].every((k) => String(p[k] ?? "").trim() !== "");

export function useStoreSync({ enabled, profile, listings }) {
  const [state, setState] = useState({ status: "off" });

  const latestRef = useRef({ enabled, profile, listings });
  latestRef.current = { enabled, profile, listings };

  const remoteRef = useRef(null); // Map<listingId, fingerprint> | null = unknown, fetch first
  const storeFpRef = useRef(null);
  const retryRef = useRef(null);
  const chainRef = useRef(Promise.resolve());
  const syncQueuedRef = useRef(false);
  const apiRef = useRef(null);

  // Built once. Everything inside only touches refs and setState, which never change.
  if (!apiRef.current) {
    const enqueue = (task) => {
      const p = chainRef.current.then(task, task);
      chainRef.current = p.catch(() => {});
      return p;
    };

    const doSync = async () => {
      const { enabled, profile, listings } = latestRef.current;
      if (!enabled) return;
      if (!isProfileComplete(profile)) {
        setState({ status: "needs-profile" });
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setState({ status: "offline" });
        return;
      }
      setState((s) => ({ ...s, status: "syncing" }));
      try {
        const uid = await ensureSignedIn();
        if (!remoteRef.current) remoteRef.current = await fetchPublished(uid);
        const res = await pushChanges(uid, profile, listings, remoteRef.current, storeFpRef.current);
        remoteRef.current = res.remote;
        storeFpRef.current = res.storeFingerprint;
        // uid lets the Shop screen hide this store's online copy from its own owner.
        setState({ status: "synced", at: Date.now(), uid });
      } catch (e) {
        // Forget what we think is published; the next attempt re-reads it.
        remoteRef.current = null;
        storeFpRef.current = null;
        setState({ status: "error", message: String(e?.message || e) });
        clearTimeout(retryRef.current);
        retryRef.current = setTimeout(() => apiRef.current.requestSync(), RETRY_MS);
      }
    };

    const requestSync = () => {
      if (syncQueuedRef.current) return; // one waiting sync is enough; it reads the latest data when it runs
      syncQueuedRef.current = true;
      enqueue(async () => {
        syncQueuedRef.current = false;
        await doSync();
      });
    };

    // Resolves when the store is gone from Firebase; rejects if it couldn't be removed.
    const unpublish = () =>
      enqueue(async () => {
        clearTimeout(retryRef.current);
        setState({ status: "removing" });
        try {
          const uid = await ensureSignedIn();
          await unpublishStore(uid);
          remoteRef.current = new Map();
          storeFpRef.current = null;
          setState({ status: "off" });
        } catch (e) {
          setState({ status: "remove-failed", message: String(e?.message || e) });
          throw e;
        }
      });

    apiRef.current = { requestSync, unpublish };
  }

  // Publish a couple of seconds after the last change, so a burst of edits
  // (or a multi-item sale) becomes one upload instead of many.
  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.status === "removing" || s.status === "remove-failed" ? s : { status: "off" }));
      return;
    }
    const t = setTimeout(() => apiRef.current.requestSync(), SYNC_DELAY_MS);
    return () => clearTimeout(t);
  }, [enabled, profile, listings]);

  // Catch up as soon as the internet comes back.
  useEffect(() => {
    const onOnline = () => {
      if (latestRef.current.enabled) apiRef.current.requestSync();
    };
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      clearTimeout(retryRef.current);
    };
  }, []);

  return { state, unpublish: apiRef.current.unpublish };
}
