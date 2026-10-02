/*
 * Firebase connection for Andito.
 *
 * These config values are not secrets: every Firebase web app ships them in
 * plain view. What protects the data is firestore.rules (in the repo root),
 * which must be pasted into the Firebase console's Firestore → Rules tab.
 *
 * What's stored, and where:
 *   stores/{ownerUid}                     public store profile
 *   stores/{ownerUid}/listings/{id}       public product info
 * Supplier cost, exact stock counts and sales never leave the phone.
 */
import { initializeApp } from "firebase/app";
import { initializeAuth, indexedDBLocalPersistence, signInAnonymously } from "firebase/auth";
import { getFirestore, doc, collection, getDocs, writeBatch, serverTimestamp } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCjBRm5peWQinIymyams6-WBVau2ivvzPw",
  authDomain: "andito-912a9.firebaseapp.com",
  projectId: "andito-912a9",
  storageBucket: "andito-912a9.firebasestorage.app",
  messagingSenderId: "522479122317",
  appId: "1:522479122317:web:507b1ef084ca21d6f9afc4",
};

const app = initializeApp(firebaseConfig);

// initializeAuth instead of getAuth: getAuth also loads a sign-in popup
// helper that can hang inside the Android app's web view. The login is kept
// in IndexedDB, so the same anonymous account comes back after a restart.
const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
const db = getFirestore(app);

let signingIn = null;

/* Returns this phone's Firebase user id, signing in anonymously the first
   time. Until real phone login exists, this id is the store's identity: if
   the app is uninstalled or its data cleared, a new id is created and the
   old published store can no longer be edited from this phone. */
export async function ensureSignedIn() {
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser.uid;
  if (!signingIn) {
    signingIn = signInAnonymously(auth).finally(() => {
      signingIn = null;
    });
  }
  const cred = await signingIn;
  return cred.user.uid;
}

const clip = (v, n) => String(v ?? "").trim().slice(0, n);

/* The public shape of a store. Every field here is visible to anyone, so
   only add fields the owner has been told will be public. The fixed key
   order also makes JSON.stringify usable as a change fingerprint. */
export function publicStoreDoc(uid, profile, productCount) {
  return {
    ownerUid: uid,
    name: clip(profile.name, 80),
    kind: clip(profile.kind, 80),
    area: clip(profile.area, 200),
    hours: clip(profile.hours, 80),
    phone: clip(profile.phone, 30),
    productCount,
  };
}

/* The public shape of a product. Cost and exact quantity are deliberately
   left out; shoppers only see whether it's in stock, low, or out. */
export function publicListingDoc(l) {
  return {
    name: clip(l.name, 120) || "Unnamed product",
    brand: l.brand && l.brand !== "—" ? clip(l.brand, 60) : "",
    specs: Array.isArray(l.specs) ? l.specs.slice(0, 10).map((s) => clip(s, 60)) : [],
    price: Math.max(0, Number(l.price) || 0),
    status: ["in", "low", "out"].includes(l.status) ? l.status : "in",
    lastCheckedAt: Math.round(Number(l.lastCheckedAt) || 0),
  };
}

const fingerprint = (obj) => JSON.stringify(obj);

/* What's currently published for this store: Map of listing id → fingerprint.
   Read once per app launch (or after an error), then kept up to date
   locally so later syncs only upload what actually changed. */
export async function fetchPublished(uid) {
  const snap = await getDocs(collection(db, "stores", uid, "listings"));
  const map = new Map();
  snap.forEach((d) => map.set(d.id, fingerprint(publicListingDoc(d.data()))));
  return map;
}

// Firestore allows at most 500 writes per batch.
async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + 450)) {
      if (op.kind === "set") batch.set(op.ref, op.data);
      else batch.delete(op.ref);
    }
    await batch.commit();
  }
}

/* Uploads only the differences between the phone and what's published:
   changed products are rewritten, removed products are deleted, and the
   store profile is rewritten only when it changed. Keeps daily writes far
   inside Firebase's free tier even for a busy store. */
export async function pushChanges(uid, profile, listings, remote, lastStoreFingerprint) {
  const ops = [];
  const nextRemote = new Map(remote);
  const localIds = new Set();

  for (const l of listings) {
    const id = String(l.id);
    localIds.add(id);
    const data = publicListingDoc(l);
    const fp = fingerprint(data);
    if (remote.get(id) !== fp) {
      ops.push({ kind: "set", ref: doc(db, "stores", uid, "listings", id), data: { ...data, updatedAt: serverTimestamp() } });
      nextRemote.set(id, fp);
    }
  }
  for (const id of remote.keys()) {
    if (!localIds.has(id)) {
      ops.push({ kind: "delete", ref: doc(db, "stores", uid, "listings", id) });
      nextRemote.delete(id);
    }
  }

  const storeData = publicStoreDoc(uid, profile, listings.length);
  const storeFp = fingerprint(storeData);
  if (storeFp !== lastStoreFingerprint) {
    ops.unshift({ kind: "set", ref: doc(db, "stores", uid), data: { ...storeData, updatedAt: serverTimestamp() } });
  }

  await commitInChunks(ops);
  return { remote: nextRemote, storeFingerprint: storeFp, writes: ops.length };
}

/* Removes the store and every product from Firebase. Products go first
   and the store document last, so a failure partway leaves at most a store
   with fewer products, never products without a store. */
export async function unpublishStore(uid) {
  const snap = await getDocs(collection(db, "stores", uid, "listings"));
  const ops = snap.docs.map((d) => ({ kind: "delete", ref: d.ref }));
  await commitInChunks(ops);
  await commitInChunks([{ kind: "delete", ref: doc(db, "stores", uid) }]);
}
