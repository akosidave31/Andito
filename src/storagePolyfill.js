/*
 * App.jsx was originally built as a Claude.ai artifact, where `window.storage`
 * is a built-in key-value API provided by the Claude runtime. That API does
 * not exist in a normal browser or in a Capacitor WebView, so this file
 * recreates the same shape (get/set/delete/list, each returning
 * {key, value, shared} | null) backed by plain localStorage.
 *
 * IMPORTANT LIMITATION: in the real Claude.ai artifact, `shared: true` data
 * (used here for the live "demand-requests" signal — customers searching for
 * products a store doesn't carry) is visible to every user of the app. This
 * polyfill has no backend, so shared data is only shared within *this one
 * device's browser storage* — it will not sync between a customer's phone
 * and a seller's phone. To make that feature genuinely cross-device, swap
 * this file for calls to a real backend (Firebase/Firestore is the natural
 * fit given the rest of this app's data shapes).
 */

const PREFIX = "andito:";

function keyFor(key, shared) {
  return `${PREFIX}${shared ? "shared:" : "personal:"}${key}`;
}

async function get(key, shared = false) {
  const raw = localStorage.getItem(keyFor(key, shared));
  if (raw == null) return null;
  return { key, value: raw, shared };
}

async function set(key, value, shared = false) {
  localStorage.setItem(keyFor(key, shared), value);
  return { key, value, shared };
}

async function del(key, shared = false) {
  const existed = localStorage.getItem(keyFor(key, shared)) != null;
  localStorage.removeItem(keyFor(key, shared));
  return existed ? { key, deleted: true, shared } : null;
}

async function list(prefix = "", shared = false) {
  const scope = `${PREFIX}${shared ? "shared:" : "personal:"}`;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const full = localStorage.key(i);
    if (full && full.startsWith(scope)) {
      const bare = full.slice(scope.length);
      if (bare.startsWith(prefix)) keys.push(bare);
    }
  }
  return { keys, prefix, shared };
}

if (typeof window !== "undefined" && !window.storage) {
  window.storage = { get, set, delete: del, list };
}
