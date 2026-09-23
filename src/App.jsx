import { useState, useMemo, useEffect, useRef } from "react";
import { LayoutDashboard, ShoppingCart, Package, Database, Settings, Search, Store, Heart, User, LogOut } from "lucide-react";

/* ------------------------------------------------------------------ *
 * MERON — local store availability + seller dashboard
 * Prototype. State is in memory but shaped like the intended
 * Firestore collections: stores / listings / sales.
 * ------------------------------------------------------------------ */

/* Only MY_STORE's slot exists — a fresh install has no fictional competitor
   stores and no fictional products. name/kind/area/hours/phone start blank
   (the same shape a first-time "I have a store" signup already produces),
   so a real owner's very first launch is a genuinely empty marketplace, not
   someone else's demo inventory. lat/lng/fallbackMeters stay populated so
   distance math doesn't NaN before the owner sets a real location — it's
   inert until the store actually has a name and shows up anywhere. */
const STORES = [
  { id: "s1", name: "", kind: "", area: "", lat: 14.173371, lng: 121.204259, fallbackMeters: 400, hours: "", phone: "" },
];

/* Seed listings are written as "checked N hours ago" for readability, then
   converted once at load into a real timestamp (lastCheckedAt) so freshness
   keeps advancing in real time and still makes sense after a reload —
   a static "age" number would otherwise look frozen forever once persisted. */
const hoursAgo = (n) => Date.now() - n * 3600000;

/* No seed products. Everything in Inventory is something a real owner
   actually added. */
const LISTINGS = [];


/* Fallback content for the seller Dashboard's "Searched near you" panel —
   ONLY shown there, clearly labeled "Example" (see isLiveDemand in
   SellerView), and replaced the moment any real search activity exists.
   Never shown to shoppers as if it were real data. */
const DEMAND = [
  { q: "laptop charger", searches: 34, listed: true },
  { q: "printer ink 664", searches: 21, listed: false },
  { q: "cctv camera", searches: 17, listed: false },
  { q: "wireless mouse", searches: 15, listed: true },
  { q: "laptop battery", searches: 12, listed: false },
];

const SUGGESTED = ["laptop charger", "cement", "brake pads", "rice", "led bulb"];
const MY_STORE = "s1";

/* ---------------------------- helpers ---------------------------- */

/* Start of the local calendar day containing t (ms). Sales are bucketed by
   the day they actually happened, using the phone's own clock/timezone. */
const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const peso = (n) => "\u20B1" + Math.round(n).toLocaleString("en-PH");
const pesoShort = (n) => (n >= 1000 ? "\u20B1" + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : "\u20B1" + n);

const freshness = (lastCheckedAt) => {
  if (lastCheckedAt == null) return { key: "stale", label: "not checked yet" };
  const hours = (Date.now() - lastCheckedAt) / 3600000;
  if (hours < 24) return { key: "fresh", label: hours < 1 ? "checked just now" : `checked ${Math.round(hours)}h ago` };
  const days = Math.round(hours / 24);
  if (hours < 96) return { key: "aging", label: `checked ${days}d ago` };
  return { key: "stale", label: `not checked in ${days}d` };
};

/* Great-circle distance in meters. Used to turn the user's real coordinates
   (if they grant location) into an actual "X meters away" instead of the
   fixed demo distance every store ships with. */
const haversine = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const STATUS = {
  in: { label: "In stock", sub: "Ready to buy" },
  low: { label: "Low stock", sub: "Few left" },
  out: { label: "Out of stock", sub: "Check back later" },
};

const statusFromQty = (q, lowAt = 3) => (q <= 0 ? "out" : q <= lowAt ? "low" : "in");
const dist = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

function score(listing, store, tokens) {
  if (!tokens.length) return 0;
  const hay = norm([listing.name, listing.brand, listing.specs.join(" "), store.name, store.kind].join(" "));
  let hits = 0;
  for (const t of tokens) {
    if (hay.some((w) => w === t)) hits += 2;
    else if (hay.some((w) => w.startsWith(t) || t.startsWith(w))) hits += 1;
  }
  if (hits === 0) return 0;
  let s = hits / (tokens.length * 2);
  if (listing.status === "in") s += 0.35;
  else if (listing.status === "low") s += 0.15;
  const f = freshness(listing.lastCheckedAt).key;
  if (f === "fresh") s += 0.25;
  else if (f === "stale") s -= 0.3;
  return s;
}

/* ---------------------------- shared pieces ---------------------------- */

function Stamp({ status, lastCheckedAt }) {
  const f = freshness(lastCheckedAt);
  return (
    <span className={`stamp st-${status} fr-${f.key}`}>
      <span className="stamp-main">{STATUS[status].label}</span>
      <span className="stamp-sub">{STATUS[status].sub}</span>
    </span>
  );
}

function Freshline({ lastCheckedAt }) {
  const f = freshness(lastCheckedAt);
  return <span className={`fresh fresh-${f.key}`}>{f.label}</span>;
}

/* ---------------------------- customer views ---------------------------- */

function FavHeart({ on, onClick, className = "", size = 16 }) {
  return (
    <button
      type="button"
      className={`fav-heart ${on ? "fav-heart-on" : ""} ${className}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-pressed={on}
      aria-label={on ? "Remove from favorites" : "Add to favorites"}
    >
      <Heart size={size} strokeWidth={2.2} fill={on ? "currentColor" : "none"} />
    </button>
  );
}

function SearchView({
  stores: allStores, listings, query, setQuery, onOpenStore, onRequest,
  favorites, onToggleFavoriteProduct, onToggleFavoriteStore,
  locStatus, onRequestLocation,
}) {
  const [mode, setMode] = useState("products");
  const [favOnly, setFavOnly] = useState(false);
  const tokens = norm(query);

  // A store with no name yet hasn't been set up by its owner — shoppers
  // should never see it, whether browsing, searching, or via a listing.
  const stores = useMemo(() => allStores.filter((s) => s.name.trim() !== ""), [allStores]);

  const results = useMemo(() => {
    if (mode !== "products") return null;
    const pool = favOnly ? listings.filter((l) => favorites.products.includes(l.id)) : listings;
    if (!tokens.length) {
      if (!favOnly) return null;
      return pool
        .map((l) => ({ l, store: stores.find((s) => s.id === l.storeId) }))
        .filter((r) => r.store)
        .sort((a, b) => a.store.meters - b.store.meters);
    }
    return pool
      .map((l) => {
        const store = stores.find((s) => s.id === l.storeId);
        return { l, store, s: store ? score(l, store, tokens) : 0 };
      })
      .filter((r) => r.store && r.s > 0.25)
      .sort((a, b) => b.s - a.s || a.store.meters - b.store.meters);
  }, [listings, query, mode, stores, favOnly, favorites.products]);

  const storeResults = useMemo(() => {
    if (mode !== "stores") return null;
    const pool = favOnly ? stores.filter((s) => favorites.stores.includes(s.id)) : stores;
    if (!tokens.length) {
      if (!favOnly) return null;
      return [...pool].sort((a, b) => a.meters - b.meters);
    }
    return pool
      .filter((s) => tokens.every((t) => (s.name + " " + s.kind + " " + s.area).toLowerCase().includes(t)))
      .sort((a, b) => a.meters - b.meters);
  }, [query, mode, stores, favOnly, favorites.stores]);

  const available = results ? results.filter((r) => r.l.status !== "out") : [];

  return (
    <>
      <section className="hero">
        <div className="hero-toprow">
          <div className="search-toggle">
            <button
              className={`search-toggle-opt ${mode === "products" ? "search-toggle-on" : ""}`}
              onClick={() => setMode("products")}
            >
              Products
            </button>
            <button
              className={`search-toggle-opt ${mode === "stores" ? "search-toggle-on" : ""}`}
              onClick={() => setMode("stores")}
            >
              Stores
            </button>
          </div>
          <button
            className={`fav-master ${favOnly ? "fav-master-on" : ""}`}
            onClick={() => setFavOnly((v) => !v)}
            aria-pressed={favOnly}
            aria-label={favOnly ? "Show all results" : `Show favorite ${mode}`}
            title={favOnly ? "Show all results" : `Show favorite ${mode}`}
          >
            <Heart size={17} strokeWidth={2.2} fill={favOnly ? "currentColor" : "none"} />
          </button>
        </div>

        <div className="searchbar">
          <input
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === "products" ? "What are you looking for?" : "Search a store by name or area"}
            aria-label={mode === "products" ? "Search for a product" : "Search for a store"}
          />
          {query && (
            <button className="search-clear" onClick={() => setQuery("")} aria-label="Clear search">×</button>
          )}
        </div>

        {locStatus === "granted" ? (
          <p className="loc-status loc-status-on">📍 Showing real distances from your location</p>
        ) : (
          <button className="loc-pill" onClick={onRequestLocation} disabled={locStatus === "locating"}>
            📍 {locStatus === "locating" ? "Locating…" : locStatus === "denied" || locStatus === "unavailable" ? "Distances are estimated · try again" : "Use my location for real distances"}
          </button>
        )}

        {mode === "products" && !query && (
          <div className="chips">
            {SUGGESTED.map((s) => (
              <button key={s} className="chip" onClick={() => setQuery(s)}>{s}</button>
            ))}
          </div>
        )}
      </section>

      <section className="results">
        {mode === "stores" ? (
          storeResults ? (
            storeResults.length > 0 ? (
              <>
                <p className="results-count">
                  {favOnly ? (
                    <>Your favorite {storeResults.length === 1 ? "store" : "stores"}</>
                  ) : (
                    <><strong>{storeResults.length}</strong> {storeResults.length === 1 ? "store" : "stores"} found</>
                  )}
                </p>
                {storeResults.map((s) => (
                  <div className="storecard-wrap" key={s.id}>
                    <button className="storecard" onClick={() => onOpenStore(s.id)}>
                      <span className="storecard-name">{s.name}</span>
                      <span className="storecard-kind">{s.kind}</span>
                      <span className="storecard-meta">{s.area} · {dist(s.meters)}</span>
                    </button>
                    <FavHeart
                      className="storecard-fav"
                      on={favorites.stores.includes(s.id)}
                      onClick={() => onToggleFavoriteStore(s.id)}
                    />
                  </div>
                ))}
              </>
            ) : (
              <div className="empty">
                <h3>{favOnly ? "No favorite stores yet." : "No store matches that."}</h3>
                <p>{favOnly ? "Tap the heart on a store to save it here and get notified when its stock changes." : "Try a different name or area."}</p>
              </div>
            )
          ) : stores.length > 0 ? (
            <>
              <p className="results-count">Stores near you</p>
              {stores.map((s) => (
                <div className="storecard-wrap" key={s.id}>
                  <button className="storecard" onClick={() => onOpenStore(s.id)}>
                    <span className="storecard-name">{s.name}</span>
                    <span className="storecard-kind">{s.kind}</span>
                    <span className="storecard-meta">{s.area} · {dist(s.meters)}</span>
                  </button>
                  <FavHeart
                    className="storecard-fav"
                    on={favorites.stores.includes(s.id)}
                    onClick={() => onToggleFavoriteStore(s.id)}
                  />
                </div>
              ))}
            </>
          ) : (
            <div className="empty">
              <h3>No stores listed yet.</h3>
              <p>Once a local store sets up here, it'll show up in this list.</p>
            </div>
          )
        ) : results ? (
          results.length > 0 ? (
            <>
              <p className="results-count">
                {favOnly ? (
                  <>Your favorite {results.length === 1 ? "product" : "products"}</>
                ) : (
                  <>
                    <strong>{available.length}</strong> {available.length === 1 ? "store has" : "stores have"} this
                    {results.length - available.length > 0 && `, ${results.length - available.length} ran out`}
                  </>
                )}
              </p>
              {results.map(({ l, store }) => (
                <article className="row" key={l.id}>
                  <div className="row-stamp"><Stamp status={l.status} lastCheckedAt={l.lastCheckedAt} /></div>
                  <div className="row-body">
                    <div className="row-top">
                      <h3 className="row-name">{l.name}</h3>
                      <FavHeart on={favorites.products.includes(l.id)} onClick={() => onToggleFavoriteProduct(l.id)} />
                    </div>
                    <p className="row-spec">
                      {l.brand !== "—" && <span className="brand">{l.brand}</span>}
                      {l.specs.join(" · ")}
                    </p>
                    <p className="row-price">{peso(l.price)}</p>
                    <button className="row-store" onClick={() => onOpenStore(store.id)}>{store.name}</button>
                    <p className="row-meta">{dist(store.meters)} away · <Freshline lastCheckedAt={l.lastCheckedAt} /></p>
                  </div>
                </article>
              ))}
            </>
          ) : (
            <div className="empty">
              {favOnly ? (
                <>
                  <h3>No favorite products yet.</h3>
                  <p>Tap the heart on a product to save it here and get notified when it's back in stock.</p>
                </>
              ) : (
                <>
                  <h3>No store here has listed that yet.</h3>
                  <p>Tell the local stores you're looking for it. They see what people are asking for and can reply when they have stock.</p>
                  <button className="btn btn-primary" onClick={() => onRequest(query)}>Ask stores for "{query}"</button>
                </>
              )}
            </div>
          )
        ) : (
          <div className="empty">
            <h3>Search for a product.</h3>
            <p>Type what you're looking for above, or tap one of the suggestions.</p>
          </div>
        )}
      </section>
    </>
  );
}

function StoreView({ store, listings, onBack, favorites, onToggleFavoriteProduct, onToggleFavoriteStore }) {
  const items = listings.filter((l) => l.storeId === store.id);
  const [q, setQ] = useState("");
  const tokens = norm(q);
  const shown = tokens.length ? items.filter((l) => score(l, store, tokens) > 0.25) : items;
  const freshest = items.length ? Math.max(...items.map((i) => i.lastCheckedAt)) : null;
  const storeFav = favorites.stores.includes(store.id);

  return (
    <>
      <button className="back" onClick={onBack}>← Back to search</button>
      <header className="store-head">
        <div className="store-head-top">
          <h1 className="store-name">{store.name}</h1>
          <FavHeart size={19} on={storeFav} onClick={() => onToggleFavoriteStore(store.id)} className="store-fav" />
        </div>
        <p className="store-kind">{store.kind}</p>
        <dl className="store-facts">
          <div><dt>Where</dt><dd>{store.area}</dd></div>
          <div><dt>Open</dt><dd>{store.hours}</dd></div>
          <div><dt>Distance</dt><dd>{dist(store.meters)}</dd></div>
          <div><dt>Stock updated</dt><dd><Freshline lastCheckedAt={freshest} /></dd></div>
        </dl>
        <div className="store-actions">
          <button className="btn btn-primary">Message {store.phone}</button>
          <button className="btn btn-ghost">Get directions</button>
        </div>
      </header>

      <div className="searchbar searchbar-inline">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search inside ${store.name}`} aria-label="Search inside this store" />
      </div>

      <section className="results">
        {shown.length === 0 && <div className="empty"><h3>Nothing matches that here.</h3><p>Try a shorter word, or go back and search all stores.</p></div>}
        {shown.map((l) => (
          <article className="row" key={l.id}>
            <div className="row-stamp"><Stamp status={l.status} lastCheckedAt={l.lastCheckedAt} /></div>
            <div className="row-body">
              <div className="row-top">
                <h3 className="row-name">{l.name}</h3>
                <FavHeart on={favorites.products.includes(l.id)} onClick={() => onToggleFavoriteProduct(l.id)} />
              </div>
              <p className="row-spec">
                {l.brand !== "—" && <span className="brand">{l.brand}</span>}
                {l.specs.join(" · ")}
              </p>
              <p className="row-price">{peso(l.price)}</p>
              <p className="row-meta"><Freshline lastCheckedAt={l.lastCheckedAt} /></p>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

/* ---------------------------- dashboard pieces ---------------------------- */

function Kpi({ label, value, note, tone, accent }) {
  return (
    <div className={`kpi kpi-${accent || "ink"}`}>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      {note && <p className={`kpi-note kpi-${tone || "flat"}`}>{note}</p>}
    </div>
  );
}

function SalesChart({ data, prev, labels, selected, onSelect }) {
  const max = Math.max(1, ...data, ...prev) * 1.15;
  const pts = prev.map((v, i) => `${((i + 0.5) / prev.length) * 100},${(1 - v / max) * 100}`).join(" ");

  return (
    <div className="chart">
      <div className="chart-axis">
        <span>{pesoShort(Math.round(max))}</span>
        <span>{pesoShort(Math.round(max / 2))}</span>
        <span>0</span>
      </div>
      <div className="chart-body">
        <div className="chart-plot">
          <div className="gridline" style={{ top: "0%" }} />
          <div className="gridline" style={{ top: "50%" }} />
          <div className="gridline gridline-base" style={{ top: "100%" }} />

          <svg className="chart-prev" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          </svg>

          <div className="bars">
            {data.map((v, i) => (
              <button
                key={i}
                className={`bar-col ${selected === i ? "bar-on" : ""}`}
                onClick={() => onSelect(selected === i ? null : i)}
                aria-label={`${labels[i]}: ${peso(v)}`}
              >
                <span className="bar" style={{ height: `${(v / max) * 100}%` }} />
              </button>
            ))}
          </div>
        </div>
        <div className="chart-labels">
          {labels.map((d, i) => (
            <span key={i} className={`chart-day ${i === labels.length - 1 ? "chart-today" : ""} ${selected === i ? "chart-day-on" : ""}`}>{d}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function PinGate({ storeName, correctPin, accountPhone, onUnlock, onForgotPin }) {
  const [entry, setEntry] = useState("");
  const [shake, setShake] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [phoneEntry, setPhoneEntry] = useState("");
  const [recoverError, setRecoverError] = useState("");

  const press = (d) => {
    if (entry.length >= 4) return;
    const next = entry + d;
    setEntry(next);
    if (next.length === 4) {
      if (next === correctPin) {
        setTimeout(() => onUnlock(), 120);
      } else {
        setShake(true);
        setTimeout(() => { setShake(false); setEntry(""); }, 420);
      }
    }
  };

  const submitRecovery = () => {
    const digits = phoneEntry.replace(/[^0-9]/g, "");
    const expected = (accountPhone || "").replace(/[^0-9]/g, "").slice(-10);
    if (!expected || digits !== expected) {
      setRecoverError("That doesn't match the phone number on this account.");
      return;
    }
    onForgotPin();
  };

  if (recovering) {
    return (
      <div className="pingate">
        <p className="eyebrow">Reset PIN</p>
        <h1 className="store-name">{storeName}</h1>
        <p className="pingate-sub">Confirm the phone number on this account to turn off the PIN lock. You can set a new one from Settings right after.</p>
        <label className="signup-field" style={{ marginTop: 14 }}>
          <span className="settings-label">Phone number</span>
          <div className="signup-phone">
            <span className="signup-phone-prefix">+63</span>
            <input
              className="field signup-phone-input"
              inputMode="numeric"
              placeholder="9XX XXX XXXX"
              value={phoneEntry}
              onChange={(e) => { setPhoneEntry(e.target.value.replace(/[^0-9]/g, "").slice(0, 10)); setRecoverError(""); }}
            />
          </div>
        </label>
        {recoverError && <p className="pin-error">{recoverError}</p>}
        <div className="addrow" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={submitRecovery}>Turn off PIN lock</button>
          <button className="btn btn-ghost" onClick={() => { setRecovering(false); setPhoneEntry(""); setRecoverError(""); }}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pingate">
      <p className="eyebrow">Locked</p>
      <h1 className="store-name">{storeName}</h1>
      <p className="pingate-sub">Enter your 4-digit PIN to continue.</p>
      <div className={`pingate-dots ${shake ? "pingate-shake" : ""}`}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`pingate-dot ${entry.length > i ? "pingate-dot-on" : ""}`} />
        ))}
      </div>
      <div className="pingate-pad">
        {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d, i) =>
          d === "" ? <span key={i} /> : (
            <button
              key={i}
              className="pingate-key"
              onClick={() => (d === "⌫" ? setEntry((e) => e.slice(0, -1)) : press(d))}
            >
              {d}
            </button>
          )
        )}
      </div>
      <button className="link pingate-forgot" onClick={() => setRecovering(true)}>Forgot PIN?</button>
    </div>
  );
}

function SellerView({
  listings, setListings, toast, navOpen, setNavOpen,
  page, setPage, cart, setCart, transactions, commitSale, commitReturn,
  store, onUpdateProfile, settings, setSettings, onResetDemoData, onLockNow, onSignOut,
}) {
  const items = listings.filter((l) => l.storeId === MY_STORE);

  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [openProductId, setOpenProductId] = useState(null);
  const [restockingId, setRestockingId] = useState(null);
  const [restockQty, setRestockQty] = useState(10);
  const [editingQtyId, setEditingQtyId] = useState(null);
  const [qtyDraft, setQtyDraft] = useState("");
  const [pickedDay, setPickedDay] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", price: "", qty: "", cost: "" });

  const [posName, setPosName] = useState("");
  const [posPickId, setPosPickId] = useState(null);
  const [posQty, setPosQty] = useState("1");
  const [openReturnTx, setOpenReturnTx] = useState(null);
  const [returnQtys, setReturnQtys] = useState({});

  /* Live demand: shared storage doesn't push updates, so poll it every 15s
     while the dashboard is open. null = "haven't loaded yet," which the
     render below treats differently from "loaded but empty." */
  const [liveDemand, setLiveDemand] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await window.storage.get("demand-requests", true);
        const arr = res?.value ? JSON.parse(res.value) : [];
        if (!cancelled) setLiveDemand(arr);
      } catch {
        if (!cancelled) setLiveDemand([]);
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  /* Collapse raw shared search events into a ranked list, and check each
     query against MY_STORE's own items so "not listed" is computed live
     instead of hand-curated. null (nothing loaded / no requests yet) falls
     back to the static DEMAND sample so the panel never looks broken on a
     brand-new deployment with zero real traffic. */
  const demandDisplay = useMemo(() => {
    if (!liveDemand || liveDemand.length === 0) return null;
    const counts = {};
    liveDemand.forEach(({ query }) => {
      const key = (query || "").trim().toLowerCase();
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([q, searches]) => ({ q, searches, listed: items.some((l) => score(l, store, norm(q)) > 0.25) }))
      .sort((a, b) => b.searches - a.searches)
      .slice(0, 6);
  }, [liveDemand, items, store]);

  const demandToShow = demandDisplay || DEMAND;
  const isLiveDemand = !!demandDisplay;

  /* ------------------------ Data / Settings tabs ------------------------ */
  const [profileDraft, setProfileDraft] = useState(store);
  const [profileSaved, setProfileSaved] = useState(false);
  const [pinStep, setPinStep] = useState("idle"); // idle | setting
  const [pinDraft, setPinDraft] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinError, setPinError] = useState("");
  const [lastBackup, setLastBackup] = useState(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState("");
  const [profileTouched, setProfileTouched] = useState(false);

  const profileErrors = {
    name: profileDraft.name.trim() ? "" : "Store name is required.",
    kind: profileDraft.kind.trim() ? "" : "Category is required.",
    area: profileDraft.area.trim() ? "" : "Area / address is required.",
    hours: profileDraft.hours.trim() ? "" : "Hours is required.",
    phone: profileDraft.phone.trim() ? "" : "Phone is required.",
  };
  const profileComplete = Object.values(profileErrors).every((e) => !e);

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setLocateError("Location isn't available on this device or browser — type your address instead.");
      return;
    }
    setLocating(true);
    setLocateError("");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`
          );
          const data = await res.json();
          setProfileDraft((p) => ({ ...p, area: data?.display_name || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` }));
        } catch {
          setProfileDraft((p) => ({ ...p, area: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` }));
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        setLocating(false);
        setLocateError(
          err.code === 1
            ? "Location permission denied — type your address instead."
            : "Couldn't get your location — type your address instead."
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const saveProfile = () => {
    if (!profileComplete) {
      setProfileTouched(true);
      toast("Fill in all store details before saving.");
      return;
    }
    onUpdateProfile({
      name: profileDraft.name.trim(),
      kind: profileDraft.kind.trim(),
      area: profileDraft.area.trim(),
      hours: profileDraft.hours.trim(),
      phone: profileDraft.phone.trim(),
    });
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2200);
    toast("Store profile updated.");
  };

  const downloadCsv = (filename, rows) => {
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setLastBackup(new Date());
    toast(`${filename} downloaded.`);
  };

  const exportInventory = () => {
    downloadCsv(`${store.name.replace(/\s+/g, "_")}_inventory.csv`, [
      ["Product", "Brand", "Price", "Cost", "Cost source", "On hand", "Units sold (7d)", "Status", "Low-stock alert at", "Last checked"],
      ...items.map((l) => [
        l.name, l.brand, l.price, l.cost, l.costEstimated ? "Estimated" : "Entered",
        l.qty, unitsOf(l), STATUS[l.status].label,
        l.lowAt ?? settings.lowStockThreshold,
        freshness(l.lastCheckedAt).label,
      ]),
    ]);
  };

  const exportSales = () => {
    downloadCsv(`${store.name.replace(/\s+/g, "_")}_sales_7d.csv`, [
      ["Date", "Day", "Net sales"],
      ...labels.map((d, i) => [new Date(dayStarts[i]).toLocaleDateString("en-CA"), d, sales[i]]),
    ]);
  };

  const setPin = () => {
    setPinError("");
    if (pinDraft.length !== 4) { setPinError("PIN must be exactly 4 digits."); return; }
    if (pinDraft !== pinConfirm) { setPinError("PINs don't match."); return; }
    setSettings((s) => ({ ...s, pin: pinDraft, pinEnabled: true }));
    setPinStep("idle"); setPinDraft(""); setPinConfirm("");
    toast("PIN lock enabled.");
  };

  const togglePinLock = () => {
    if (!settings.pinEnabled) {
      setPinStep("setting");
    } else {
      setSettings((s) => ({ ...s, pinEnabled: false }));
      toast("PIN lock turned off.");
    }
  };

  const getReturnQty = (t, l) => {
    const remaining = l.qty - l.returnedQty;
    const v = returnQtys[`${t.id}:${l.id}`];
    return Math.max(1, Math.min(v || 1, remaining));
  };
  const adjustReturnQty = (t, l, delta) => {
    const remaining = l.qty - l.returnedQty;
    setReturnQtys((prev) => {
      const key = `${t.id}:${l.id}`;
      const next = Math.max(1, Math.min((prev[key] || 1) + delta, remaining));
      return { ...prev, [key]: next };
    });
  };

  /* Sales history is DERIVED from the dated transaction log, never stored as
     its own array. The old approach kept 7 undated numbers and always added
     to the last one, so after midnight yesterday's sales kept showing as
     "today" and the whole chart drifted a day per day. Returns reduce the
     day of the original sale (net sales by sale date).

     dayKey re-checks the clock every minute so an app left open overnight
     rolls over to the new day on its own. */
  const [dayKey, setDayKey] = useState(() => startOfDay(Date.now()));
  useEffect(() => {
    const id = setInterval(() => {
      const k = startOfDay(Date.now());
      setDayKey((prev) => (prev === k ? prev : k));
    }, 60000);
    return () => clearInterval(id);
  }, []);

  const salesStats = useMemo(() => {
    // 14 local-midnight boundaries, oldest first: 0–6 = last week, 7–13 = this week.
    const starts = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(dayKey);
      d.setDate(d.getDate() - i);
      starts.push(d.getTime());
    }
    const indexOfDay = new Map(starts.map((t, i) => [t, i]));
    const byDay = new Array(14).fill(0);
    const units7d = {};
    transactions.forEach((tx) => {
      const idx = indexOfDay.get(startOfDay(new Date(tx.time).getTime()));
      if (idx === undefined) return; // older than 14 days (or clock set backwards)
      tx.lines.forEach((l) => {
        const n = l.qty - (l.returnedQty || 0);
        if (n <= 0) return;
        byDay[idx] += n * l.price;
        if (idx >= 7) units7d[l.id] = (units7d[l.id] || 0) + n;
      });
    });
    const labels = starts
      .slice(7)
      .map((t, i) => (i === 6 ? "Today" : new Date(t).toLocaleDateString("en-US", { weekday: "short" })));
    return { thisWeek: byDay.slice(7), lastWeek: byDay.slice(0, 7), units7d, labels, dayStarts: starts.slice(7) };
  }, [transactions, dayKey]);

  const { thisWeek: sales, lastWeek: salesLastWeek, units7d, labels, dayStarts } = salesStats;
  const unitsOf = (l) => units7d[l.id] || 0;

  const today = sales[6];
  const lastWeekToday = salesLastWeek[6];
  const delta = lastWeekToday ? Math.round(((today - lastWeekToday) / lastWeekToday) * 100) : null;
  const weekTotal = sales.reduce((a, b) => a + b, 0);
  const prevTotal = salesLastWeek.reduce((a, b) => a + b, 0);
  const weekDelta = prevTotal ? Math.round(((weekTotal - prevTotal) / prevTotal) * 100) : null;

  const stockValue = items.reduce((a, l) => a + (l.qty || 0) * l.cost, 0);
  const outCount = items.filter((l) => l.status === "out").length;
  const lowCount = items.filter((l) => l.status === "low").length;
  const staleItems = items.filter((l) => freshness(l.lastCheckedAt).key !== "fresh");
  const hasItems = items.length > 0;
  const freshPct = hasItems ? Math.round(((items.length - staleItems.length) / items.length) * 100) : null;
  const unitsWeek = items.reduce((a, l) => a + unitsOf(l), 0);
  const margin = items.reduce((a, l) => a + (l.price - l.cost) * unitsOf(l), 0);
  const estimatedCostCount = items.filter((l) => l.costEstimated && unitsOf(l) > 0).length;

  const topProducts = items.filter((l) => unitsOf(l) > 0).sort((a, b) => unitsOf(b) * b.price - unitsOf(a) * a.price).slice(0, 5);
  const topMax = Math.max(1, ...topProducts.map((p) => unitsOf(p) * p.price));

  const tokens = norm(q);
  const shown = items.filter((l) => {
    if (filter === "stale") { if (freshness(l.lastCheckedAt).key === "fresh") return false; }
    else if (filter !== "all" && l.status !== filter) return false;
    if (tokens.length && score(l, store, tokens) <= 0.25) return false;
    return true;
  });

  const patch = (id, fn) => setListings((prev) => prev.map((l) => (l.id === id ? fn(l) : l)));

  const setStatus = (id, status) => patch(id, (l) => ({ ...l, status, lastCheckedAt: Date.now() }));

  const confirmAll = () => {
    setListings((prev) => prev.map((l) => (l.storeId === MY_STORE ? { ...l, lastCheckedAt: Date.now() } : l)));
    toast("Stock confirmed. All listings show as checked just now.");
  };

  const restock = (l, amount) => {
    const newQty = (l.qty || 0) + amount;
    patch(l.id, (x) => ({ ...x, qty: newQty, status: statusFromQty(newQty, x.lowAt ?? settings.lowStockThreshold), lastCheckedAt: Date.now() }));
    toast(`${l.name} restocked to ${newQty}.`);
  };

  /* Direct correction for a mistyped on-hand count — e.g. meant to restock
     10, fat-fingered 13. This sets the exact number rather than adding or
     subtracting, and unlike a sale it doesn't create a transaction, so it
     never shows up in sales figures — it's a fix, not a sale. */
  const saveQtyEdit = (l) => {
    const newQty = Math.max(0, Number(qtyDraft) || 0);
    if (newQty !== l.qty) {
      patch(l.id, (x) => ({ ...x, qty: newQty, status: statusFromQty(newQty, x.lowAt ?? settings.lowStockThreshold), lastCheckedAt: Date.now() }));
      toast(`${l.name} on-hand corrected to ${newQty}.`);
    }
    setEditingQtyId(null);
  };

  const setLowAt = (id, raw) => {
    const v = raw === "" ? undefined : Math.max(0, Number(raw.replace(/[^0-9]/g, "")) || 0);
    patch(id, (l) => ({ ...l, lowAt: v, status: statusFromQty(l.qty || 0, v ?? settings.lowStockThreshold) }));
  };

  const addItem = () => {
    if (!draft.name.trim()) return;
    const qty = Number(draft.qty) || 0;
    const price = Number(draft.price) || 0;
    const costEntered = draft.cost.trim() !== "";
    const cost = costEntered ? Math.max(0, Number(draft.cost) || 0) : Math.round(price * 0.7);
    setListings((prev) => [
      { id: "n" + Date.now(), storeId: MY_STORE, name: draft.name.trim(), brand: "—", specs: [], price, cost, costEstimated: !costEntered, qty, status: statusFromQty(qty, settings.lowStockThreshold), lastCheckedAt: Date.now() },
      ...prev,
    ]);
    setDraft({ name: "", price: "", qty: "", cost: "" });
    setAdding(false);
    toast(costEntered ? "Product added and now visible to shoppers." : "Product added. Cost wasn't entered, so margin for this item is a rough estimate — add the real cost anytime in Inventory.");
  };

  /* Lets a seller fill in (or correct) a product's real supplier cost after
     the fact — the common case, since "Add product" cost is optional and
     often filled in later once an invoice is in hand. Clears the estimated
     flag once a real number is entered. */
  const setCost = (id, raw) => {
    const v = Math.max(0, Number(raw.replace(/[^0-9]/g, "")) || 0);
    patch(id, (l) => ({ ...l, cost: v, costEstimated: false }));
  };

  /* ---------------------------- POS ---------------------------- */

  const posMatches = useMemo(() => {
    const t = posName.trim().toLowerCase();
    if (!t || posPickId) return [];
    return items.filter((l) => l.name.toLowerCase().includes(t)).slice(0, 6);
  }, [posName, posPickId, items]);

  const inCartQty = (id) => cart.reduce((a, c) => (c.id === id ? a + c.qty : a), 0);

  const pickPosItem = (l) => {
    setPosName(l.name);
    setPosPickId(l.id);
    setPosQty("1");
  };

  const addToCart = () => {
    const listing = items.find((l) => l.id === posPickId);
    if (!listing) return;
    const already = inCartQty(listing.id);
    const room = listing.qty - already;
    let qty = Math.max(1, Number(posQty) || 1);
    if (room <= 0) { toast(`${listing.name} has no more stock to add.`); return; }
    if (qty > room) { qty = room; toast(`Only ${room} left · added ${room}.`); }

    setCart((prev) => {
      const existing = prev.find((c) => c.id === listing.id);
      if (existing) {
        // Already in the cart — bump the quantity and bring it back to the
        // top rather than leaving it wherever it first landed.
        const bumped = { ...existing, qty: existing.qty + qty };
        return [bumped, ...prev.filter((c) => c.id !== listing.id)];
      }
      return [{ id: listing.id, name: listing.name, price: listing.price, qty }, ...prev];
    });
    setPosName("");
    setPosPickId(null);
    setPosQty("1");
  };

  const adjustCartQty = (id, delta) => {
    setCart((prev) =>
      prev.flatMap((c) => {
        if (c.id !== id) return [c];
        const listing = items.find((l) => l.id === id);
        const max = listing ? listing.qty : 999;
        const next = c.qty + delta;
        if (next <= 0) return [];
        if (next > max) { toast(`Only ${max} in stock.`); return [c]; }
        return [{ ...c, qty: next }];
      })
    );
  };

  const removeFromCart = (id) => setCart((prev) => prev.filter((c) => c.id !== id));

  const cartTotal = cart.reduce((a, c) => a + c.qty * c.price, 0);

  const proceedSale = () => {
    if (!cart.length) return;
    commitSale(cart, "pos");
    setCart([]);
  };

  const returnLine = (t, line, qty) => {
    commitReturn(t, line, qty);
    setReturnQtys((prev) => {
      const next = { ...prev };
      delete next[`${t.id}:${line.id}`];
      return next;
    });
  };

  const NAV = [
    { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
    { id: "pos", label: "POS", Icon: ShoppingCart },
    { id: "inventory", label: "Inventory", Icon: Package },
    { id: "data", label: "Data", Icon: Database },
    { id: "settings", label: "Settings", Icon: Settings },
  ];

  return (
    <div className="seller-shell">
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <aside className={`sidebar ${navOpen ? "sidebar-open" : ""}`}>
        {NAV.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`sidebar-item ${page === id ? "sidebar-on" : ""}`}
            onClick={() => { setPage(id); setNavOpen(false); }}
            aria-current={page === id ? "page" : undefined}
          >
            <Icon size={18} strokeWidth={2} />
            <span className="sidebar-label">{label}</span>
          </button>
        ))}
      </aside>

      <div className="seller-content">
      {page === "dashboard" && (
        <>
          <header className="dash-head">
            <div>
              <h1 className="store-name">Dashboard</h1>
            </div>
            <button className="btn btn-primary" onClick={confirmAll}>Confirm stock</button>
          </header>

          {/* KPI strip */}
          <div className="kpis">
            <Kpi
              label="Sales today"
              value={peso(today)}
              accent="blue"
              tone={weekTotal === 0 || delta === null ? "flat" : delta >= 0 ? "up" : "down"}
              note={weekTotal === 0 ? "No sales yet" : delta === null ? "No sales same day last week" : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}% vs last week`}
            />
            <Kpi
              label="Gross margin, 7d"
              value={peso(margin)}
              accent={estimatedCostCount > 0 ? "amber" : "green"}
              note={estimatedCostCount > 0 ? `${unitsWeek} units sold · ${estimatedCostCount} at estimated cost` : `${unitsWeek} units sold`}
            />
            <Kpi label="Stock value" value={peso(stockValue)} accent="ink" note={`${items.length} products listed`} />
            <Kpi
              label="Listings current"
              value={hasItems ? freshPct + "%" : "—"}
              accent={!hasItems ? "ink" : freshPct >= 80 ? "green" : "amber"}
              tone={hasItems && freshPct >= 80 ? "up" : "down"}
              note={hasItems ? `${staleItems.length} need a check` : "Add your first product"}
            />
          </div>

          {/* Needs attention */}
          {(outCount > 0 || lowCount > 0 || staleItems.length > 0) && (
            <section className="panel panel-alert">
              <div className="panel-head">
                <h2 className="panel-h">Needs attention</h2>
              </div>
              <ul className="attn">
                {outCount > 0 && (
                  <li><span className="dot dot-out" /><span>{outCount} products are out of stock and hidden from search results.</span><button className="link" onClick={() => { setPage("inventory"); setFilter("out"); }}>Show</button></li>
                )}
                {lowCount > 0 && (
                  <li><span className="dot dot-low" /><span>{lowCount} products are down to their last few units.</span><button className="link" onClick={() => { setPage("inventory"); setFilter("low"); }}>Show</button></li>
                )}
                {staleItems.length > 0 && (
                  <li><span className="dot dot-stale" /><span>{staleItems.length} listings haven't been checked in over a day. Shoppers see these last.</span><button className="link" onClick={() => { setPage("inventory"); setFilter("stale"); }}>Show</button></li>
                )}
              </ul>
            </section>
          )}

          {/* Sales chart */}
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-h">Daily sales · last 7 days</h2>
              <p className="panel-note">
                {weekTotal === 0 ? (
                  "No sales recorded yet"
                ) : (
                  <>{peso(weekTotal)} total{weekDelta === null ? " · first week of data" : <> <span className={weekDelta >= 0 ? "up" : "down"}>{weekDelta >= 0 ? "▲" : "▼"} {Math.abs(weekDelta)}%</span></>}</>
                )}
              </p>
            </div>
            <SalesChart data={sales} prev={salesLastWeek} labels={labels} selected={pickedDay} onSelect={setPickedDay} />
            <p className="chart-read">
              {pickedDay === null ? (
                <>Dashed line is the same days last week. Tap a bar for detail.</>
              ) : (
                <>
                  <strong>{labels[pickedDay]}</strong> · {peso(sales[pickedDay])} this week vs {peso(salesLastWeek[pickedDay])} last week
                </>
              )}
            </p>
          </section>

          {/* Two-column: top products + demand */}
          <div className="cols">
            <section className="panel">
              <div className="panel-head"><h2 className="panel-h">Top products this week</h2></div>
              {topProducts.length > 0 ? (
                <ul className="rank">
                  {topProducts.map((p) => {
                    const rev = unitsOf(p) * p.price;
                    return (
                      <li key={p.id}>
                        <div className="rank-top">
                          <span className="rank-name">{p.name}</span>
                          <span className="rank-val">{peso(rev)}</span>
                        </div>
                        <div className="rank-track"><span className="rank-fill" style={{ width: `${(rev / topMax) * 100}%` }} /></div>
                        <span className="rank-sub">{unitsOf(p)} units · {peso(p.price)} each</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="panel-foot">{hasItems ? "No sales recorded yet this week." : "Add your first product to start tracking sales."}</p>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-h">Searched near you</h2>
                <p className={`panel-note ${isLiveDemand ? "panel-note-live" : ""}`}>{isLiveDemand ? "● Live" : "Example"}</p>
              </div>
              <ul className="demand">
                {demandToShow.map((d) => (
                  <li key={d.q}>
                    <span className="demand-q">{d.q}</span>
                    <span className="demand-n">{d.searches}</span>
                    <span className={`demand-tag ${d.listed ? "tag-yes" : "tag-no"}`}>{d.listed ? "you list this" : "not listed"}</span>
                  </li>
                ))}
              </ul>
              <p className="panel-foot">
                {isLiveDemand
                  ? "Real searches from shoppers using this app. The ones you don't stock are demand you're turning away."
                  : "No live searches yet — this is a sample of what shows up once shoppers start asking for things nearby."}
              </p>
            </section>
          </div>
        </>
      )}

      {page === "pos" && (
        <>
          <header className="dash-head">
            <div>
              <h1 className="store-name">POS</h1>
            </div>
          </header>

          <section className="panel">
            <div className="panel-head"><h2 className="panel-h">New sale</h2></div>

            <div className="pos-add">
              <div className="pos-field">
                <input
                  className="field"
                  placeholder="Type item name"
                  value={posName}
                  onChange={(e) => { setPosName(e.target.value); setPosPickId(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && posPickId) addToCart(); }}
                />
                {posMatches.length > 0 && (
                  <div className="pos-suggest">
                    {posMatches.map((m) => (
                      <button key={m.id} className="pos-suggest-opt" onClick={() => pickPosItem(m)}>
                        <span className="pos-suggest-name">{m.name}</span>
                        <span className="pos-suggest-meta">{peso(m.price)} · {Math.max(0, m.qty - inCartQty(m.id))} on hand</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <input
                className="field pos-qty-field"
                inputMode="numeric"
                placeholder="Qty"
                value={posQty}
                onChange={(e) => setPosQty(e.target.value.replace(/[^0-9]/g, ""))}
              />
              <button className="btn btn-primary" onClick={addToCart} disabled={!posPickId}>Add</button>
            </div>

            {cart.length === 0 ? (
              <p className="panel-foot">Add items above to start piling up this sale.</p>
            ) : (
              <>
                <ul className="pos-cart-list">
                  {cart.map((c) => (
                    <li key={c.id} className="pos-cart-row">
                      <div className="pos-cart-info">
                        <span className="pos-cart-name">{c.name}</span>
                        <span className="pos-cart-sub">{peso(c.price)} each</span>
                      </div>
                      <div className="pos-cart-ctl">
                        <span className="stepper">
                          <button onClick={() => adjustCartQty(c.id, -1)} aria-label="Fewer">−</button>
                          <span className="stepper-n">{c.qty}</span>
                          <button onClick={() => adjustCartQty(c.id, 1)} aria-label="More">+</button>
                        </span>
                        <span className="pos-cart-total">{peso(c.qty * c.price)}</span>
                        <button className="pos-cart-remove" onClick={() => removeFromCart(c.id)} aria-label={`Remove ${c.name}`}>×</button>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="pos-total">
                  <span>Total</span>
                  <span className="pos-total-val">{peso(cartTotal)}</span>
                </div>

                <button className="btn btn-primary btn-block" onClick={proceedSale}>Proceed</button>
              </>
            )}
          </section>

          <section className="panel">
            <div className="panel-head"><h2 className="panel-h">Recent sales</h2></div>
            {transactions.length === 0 ? (
              <p className="panel-foot">Completed sales will show up here.</p>
            ) : (
              <ul className="pos-history">
                {transactions.map((t) => {
                  const returnedAmt = t.lines.reduce((a, l) => a + l.returnedQty * l.price, 0);
                  const fullyReturned = returnedAmt >= t.total;
                  return (
                    <li key={t.id} className={`pos-tx ${fullyReturned ? "pos-tx-returned" : ""}`}>
                      <div className="pos-tx-top">
                        <span className="pos-tx-time">
                          {t.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          {t.source === "inventory" && <span className="pos-tx-src"> · from Inventory</span>}
                        </span>
                        <span className="pos-tx-total">
                          {returnedAmt > 0 && <span className="pos-tx-total-orig">{peso(t.total)}</span>}
                          {peso(t.total - returnedAmt)}
                        </span>
                      </div>
                      <p className="pos-tx-items">{t.lines.map((l) => `${l.qty} × ${l.name}`).join(", ")}</p>

                      {fullyReturned ? (
                        <span className="pos-tx-tag">Returned</span>
                      ) : t.lines.length === 1 && t.lines[0].qty === 1 ? (
                        <button className="link" onClick={() => returnLine(t, t.lines[0], 1)}>Mark as returned</button>
                      ) : (
                        <>
                          <button className="link" onClick={() => setOpenReturnTx(openReturnTx === t.id ? null : t.id)}>
                            {openReturnTx === t.id ? "Hide items" : "Return an item"}
                          </button>
                          {openReturnTx === t.id && (
                            <ul className="pos-tx-lines">
                              {t.lines.map((l) => {
                                const remaining = l.qty - l.returnedQty;
                                return (
                                  <li key={l.id} className="pos-tx-line">
                                    <span className="pos-tx-line-name">
                                      {l.qty} × {l.name}
                                      {l.returnedQty > 0 && <span className="pos-tx-line-note"> · {l.returnedQty} returned</span>}
                                    </span>
                                    {remaining <= 0 ? (
                                      <span className="pos-tx-line-tag">Returned</span>
                                    ) : remaining === 1 ? (
                                      <button className="link" onClick={() => returnLine(t, l, 1)}>Return</button>
                                    ) : (
                                      <span className="pos-tx-line-ctl">
                                        <span className="stepper">
                                          <button onClick={() => adjustReturnQty(t, l, -1)} aria-label="Fewer">−</button>
                                          <span className="stepper-n">{getReturnQty(t, l)}</span>
                                          <button onClick={() => adjustReturnQty(t, l, 1)} aria-label="More">+</button>
                                        </span>
                                        <button className="link" onClick={() => returnLine(t, l, getReturnQty(t, l))}>Return</button>
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}

      {page === "inventory" && (
        <>
          {(() => {
            const openItem = openProductId ? items.find((l) => l.id === openProductId) : null;

            if (openItem) {
              const l = openItem;
              return (
                <section className="panel">
                  <button className="back back-inline" onClick={() => setOpenProductId(null)}>← All products</button>
                  <div className="product-detail">
                    <h2 className="product-detail-name">{l.name}</h2>
                    <p className="product-detail-fresh"><Freshline lastCheckedAt={l.lastCheckedAt} /></p>

                    <div className="product-detail-row">
                      <span className="inv-k">Price</span>
                      <span className="product-detail-value">{peso(l.price)}</span>
                    </div>

                    <div className="product-detail-row">
                      <span className="inv-k">On hand</span>
                      {editingQtyId === l.id ? (
                        <span className="qty-edit">
                          <input
                            className="qty-edit-input"
                            type="text"
                            inputMode="numeric"
                            autoFocus
                            value={qtyDraft}
                            onChange={(e) => setQtyDraft(e.target.value.replace(/[^0-9]/g, ""))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveQtyEdit(l);
                              if (e.key === "Escape") setEditingQtyId(null);
                            }}
                            aria-label={`Correct on-hand count for ${l.name}`}
                          />
                          <button className="qty-edit-go" onClick={() => saveQtyEdit(l)} aria-label="Save">✓</button>
                          <button className="qty-edit-cancel" onClick={() => setEditingQtyId(null)} aria-label="Cancel">×</button>
                        </span>
                      ) : (
                        <button
                          className="qty-value-btn product-detail-qty-btn"
                          onClick={() => { setEditingQtyId(l.id); setQtyDraft(String(l.qty)); }}
                          aria-label={`Edit on-hand count for ${l.name}, currently ${l.qty}`}
                        >
                          <span className={`product-detail-value ${l.qty === 0 ? "qty-out" : l.qty <= (l.lowAt ?? settings.lowStockThreshold) ? "qty-low" : ""}`}>{l.qty}</span>
                        </button>
                      )}
                    </div>

                    <div className="product-detail-row">
                      <span className="inv-k">7d</span>
                      <span className="product-detail-value">{unitsOf(l)}</span>
                    </div>

                    <div className="seg">
                      {["in", "low", "out"].map((k) => (
                        <button key={k} className={`seg-btn seg-${k} ${l.status === k ? "seg-on" : ""}`} onClick={() => setStatus(l.id, k)} aria-pressed={l.status === k}>
                          {STATUS[k].label}
                        </button>
                      ))}
                    </div>

                    <div className="inv-lowat">
                      <span className="inv-k">Low stock at</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="lowat-input"
                        placeholder={String(settings.lowStockThreshold)}
                        value={l.lowAt ?? ""}
                        onChange={(e) => setLowAt(l.id, e.target.value)}
                        aria-label={`Low-stock threshold for ${l.name}`}
                      />
                      <span className="lowat-unit">{l.lowAt == null ? "(store default)" : "units"}</span>
                    </div>

                    <div className={`inv-lowat ${l.costEstimated ? "inv-lowat-warn" : ""}`}>
                      <span className="inv-k">Cost</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="lowat-input"
                        value={l.cost}
                        onChange={(e) => setCost(l.id, e.target.value)}
                        aria-label={`Supplier cost for ${l.name}`}
                      />
                      <span className="lowat-unit">{l.costEstimated ? "estimated — tap to fix" : "per unit"}</span>
                    </div>

                    <div className="inv-acts">
                      {l.qty === 0 && <span className="inv-warn">Out of stock</span>}
                      {restockingId === l.id ? (
                        <span className="stepper">
                          <button onClick={() => setRestockQty((n) => Math.max(1, n - 1))} aria-label="Fewer">−</button>
                          <input
                            className="stepper-input"
                            type="text"
                            inputMode="numeric"
                            value={restockQty}
                            onChange={(e) => setRestockQty(Math.max(1, Number(e.target.value.replace(/[^0-9]/g, "")) || 1))}
                            aria-label={`Restock amount for ${l.name}`}
                          />
                          <button onClick={() => setRestockQty((n) => n + 1)} aria-label="More">+</button>
                          <button className="stepper-go" onClick={() => { restock(l, restockQty); setRestockingId(null); setRestockQty(10); }}>Add</button>
                          <button className="stepper-cancel" onClick={() => setRestockingId(null)} aria-label="Cancel restock">×</button>
                        </span>
                      ) : (
                        <button className="link" onClick={() => { setRestockingId(l.id); setRestockQty(10); }}>Restock</button>
                      )}
                    </div>
                  </div>
                </section>
              );
            }

            return (
              <>
                <header className="dash-head">
                  <div>
                    <h1 className="store-name">Inventory</h1>
                  </div>
                  <button className="btn btn-primary" onClick={confirmAll}>Confirm stock</button>
                </header>

                <section className="panel">
                  <div className="panel-head">
                    <h2 className="panel-h">Inventory</h2>
                    <button className="btn btn-ghost btn-sm" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "+ Add product"}</button>
                  </div>

                  {adding && (
                    <div className="addbox">
                      <input className="field" placeholder="Product name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                      <div className="addrow">
                        <input className="field" placeholder="Price" inputMode="numeric" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
                        <input className="field" placeholder="On hand" inputMode="numeric" value={draft.qty} onChange={(e) => setDraft({ ...draft, qty: e.target.value })} />
                      </div>
                      <input className="field" placeholder="Cost from supplier (optional)" inputMode="numeric" value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
                      <p className="addbox-hint">Skip this and margin for this product will just be a rough guess — you can add the real cost later in Inventory.</p>
                      <button className="btn btn-primary" onClick={addItem}>Add product</button>
                    </div>
                  )}

                  <div className="toolbar">
                    <input className="field field-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product" aria-label="Find a product" />
                    <div className="filters">
                      {[["all", "All"], ["in", "In stock"], ["low", "Low"], ["out", "Out"], ["stale", "Stale"]].map(([k, label]) => (
                        <button key={k} className={`filter ${filter === k ? "filter-on" : ""}`} onClick={() => setFilter(k)}>{label}</button>
                      ))}
                    </div>
                  </div>

                  {shown.length === 0 && (
                    <p className="panel-foot">
                      {items.length === 0
                        ? 'No products yet — tap "+ Add product" above to add your first one.'
                        : "Nothing here. Change the filter or clear the search."}
                    </p>
                  )}

                  {shown.map((l) => (
                    <button key={l.id} className="inv-compact" onClick={() => setOpenProductId(l.id)}>
                      <span className="inv-compact-name">{l.name}</span>
                      <span className="inv-compact-price">{peso(l.price)}</span>
                      <span className={`inv-compact-qty ${l.qty === 0 ? "qty-out" : l.qty <= (l.lowAt ?? settings.lowStockThreshold) ? "qty-low" : ""}`}>{l.qty}</span>
                    </button>
                  ))}
                </section>
              </>
            );
          })()}
        </>
      )}

      {page === "settings" && (
        <>
          <header className="dash-head">
            <div>
              <h1 className="store-name">Settings</h1>
            </div>
          </header>

          <section className="panel">
            <div className="panel-head"><h2 className="panel-h">Store profile</h2></div>
            <p className="panel-note" style={{ marginBottom: 12 }}>This is what shoppers see when they open your store. All fields are required before it goes live.</p>
            <div className="settings-grid">
              <label className="settings-field">
                <span className="settings-label">Store name *</span>
                <input
                  className={`field ${profileTouched && profileErrors.name ? "field-invalid" : ""}`}
                  placeholder="e.g. ABC Computer Store"
                  value={profileDraft.name}
                  onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })}
                />
                {profileTouched && profileErrors.name && <p className="pin-error">{profileErrors.name}</p>}
              </label>
              <label className="settings-field">
                <span className="settings-label">Category *</span>
                <input
                  className={`field ${profileTouched && profileErrors.kind ? "field-invalid" : ""}`}
                  placeholder="e.g. Computer parts & repair"
                  value={profileDraft.kind}
                  onChange={(e) => setProfileDraft({ ...profileDraft, kind: e.target.value })}
                />
                {profileTouched && profileErrors.kind && <p className="pin-error">{profileErrors.kind}</p>}
              </label>
              <label className="settings-field">
                <span className="settings-label">Area / address *</span>
                <div className="field-row">
                  <input
                    className={`field ${profileTouched && profileErrors.area ? "field-invalid" : ""}`}
                    placeholder="e.g. Poblacion, Rizal St."
                    value={profileDraft.area}
                    onChange={(e) => setProfileDraft({ ...profileDraft, area: e.target.value })}
                  />
                  <button type="button" className="btn btn-ghost btn-sm field-row-btn" onClick={useMyLocation} disabled={locating}>
                    {locating ? "Locating…" : "Use my location"}
                  </button>
                </div>
                {locateError && <p className="pin-error">{locateError}</p>}
                {profileTouched && profileErrors.area && <p className="pin-error">{profileErrors.area}</p>}
              </label>
              <label className="settings-field">
                <span className="settings-label">Hours *</span>
                <input
                  className={`field ${profileTouched && profileErrors.hours ? "field-invalid" : ""}`}
                  placeholder="e.g. 9AM–7PM · Mon–Sat"
                  value={profileDraft.hours}
                  onChange={(e) => setProfileDraft({ ...profileDraft, hours: e.target.value })}
                />
                {profileTouched && profileErrors.hours && <p className="pin-error">{profileErrors.hours}</p>}
              </label>
              <label className="settings-field">
                <span className="settings-label">Phone *</span>
                <input
                  className={`field ${profileTouched && profileErrors.phone ? "field-invalid" : ""}`}
                  placeholder="e.g. 0917 555 0101"
                  value={profileDraft.phone}
                  onChange={(e) => setProfileDraft({ ...profileDraft, phone: e.target.value })}
                />
                {profileTouched && profileErrors.phone && <p className="pin-error">{profileErrors.phone}</p>}
              </label>
            </div>
            <button className="btn btn-primary" onClick={saveProfile} style={{ marginTop: 4 }}>
              {profileSaved ? "Saved ✓" : "Save profile"}
            </button>
            {profileTouched && !profileComplete && (
              <p className="pin-error" style={{ marginTop: 8 }}>Fill in every field above to save your store profile.</p>
            )}
          </section>

          <section className="panel">
            <div className="panel-head"><h2 className="panel-h">Low-stock alert</h2></div>
            <p className="panel-note" style={{ marginBottom: 12 }}>Flag a product as "low" once it drops to this quantity or below. This is the default — override it for any individual product from the Inventory tab.</p>
            <div className="settings-row">
              <input
                className="field"
                style={{ maxWidth: 90 }}
                inputMode="numeric"
                value={settings.lowStockThreshold}
                onChange={(e) => setSettings((s) => ({ ...s, lowStockThreshold: Math.max(0, Number(e.target.value.replace(/[^0-9]/g, "")) || 0) }))}
              />
              <span className="settings-row-note">units or fewer</span>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2 className="panel-h">PIN lock</h2></div>
            <p className="panel-note" style={{ marginBottom: 12 }}>Require a 4-digit PIN before opening My Store — handy on a shared phone.</p>

            <div className="settings-row">
              <button
                className={`switch ${settings.pinEnabled ? "switch-on" : ""}`}
                onClick={togglePinLock}
                aria-pressed={settings.pinEnabled}
                aria-label="Toggle PIN lock"
              >
                <span className="switch-knob" />
              </button>
              <span className="settings-row-note">{settings.pinEnabled ? "PIN lock is on" : "PIN lock is off"}</span>
            </div>

            {settings.pinEnabled && pinStep !== "setting" && (
              <div className="settings-row" style={{ marginTop: 10 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setPinStep("setting")}>Change PIN</button>
                <button className="btn btn-ghost btn-sm" onClick={onLockNow}>Lock now</button>
              </div>
            )}

            {pinStep === "setting" && (
              <div className="addbox" style={{ marginTop: 12 }}>
                <input
                  className="field" inputMode="numeric" placeholder="New 4-digit PIN" maxLength={4}
                  value={pinDraft} onChange={(e) => setPinDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
                />
                <input
                  className="field" inputMode="numeric" placeholder="Confirm PIN" maxLength={4}
                  value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
                />
                {pinError && <p className="pin-error">{pinError}</p>}
                <div className="addrow">
                  <button className="btn btn-primary" onClick={setPin}>Save PIN</button>
                  <button className="btn btn-ghost" onClick={() => { setPinStep("idle"); setPinDraft(""); setPinConfirm(""); setPinError(""); }}>Cancel</button>
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head"><h2 className="panel-h">Language</h2></div>
            <div className="settings-row">
              <select
                className="field"
                style={{ maxWidth: 220 }}
                value={settings.language}
                onChange={(e) => setSettings((s) => ({ ...s, language: e.target.value }))}
              >
                <option value="en">English</option>
                <option value="fil" disabled>Filipino — coming soon</option>
              </select>
            </div>
          </section>

          <section className="panel">
            <button className="link" onClick={onSignOut}>Sign out</button>
          </section>
        </>
      )}

      {page === "data" && (
        <>
          <header className="dash-head">
            <div>
              <h1 className="store-name">Data</h1>
            </div>
          </header>

          <section className="panel">
            <div className="panel-head"><h2 className="panel-h">Backup status</h2></div>
            <p className="panel-note">
              {lastBackup
                ? <>Last exported <strong>{lastBackup.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</strong> today.</>
                : "Not exported yet this session."}
            </p>
          </section>

          <section className="panel">
            <div className="panel-head"><h2 className="panel-h">Export</h2></div>
            <p className="panel-note" style={{ marginBottom: 12 }}>Download a CSV you can open in Excel or Google Sheets, or hand to your accountant.</p>
            <div className="settings-row">
              <button className="btn btn-primary btn-sm" onClick={exportInventory}>Export inventory</button>
              <button className="btn btn-ghost btn-sm" onClick={exportSales}>Export sales (7d)</button>
            </div>
          </section>

          <section className="panel panel-alert">
            <div className="panel-head"><h2 className="panel-h">Clear store data</h2></div>
            <p className="panel-note" style={{ marginBottom: 12 }}>Deletes every product and every sale on this phone. This can't be undone — export first if you need a copy.</p>
            {!resetConfirm ? (
              <button className="btn btn-ghost btn-sm" onClick={() => setResetConfirm(true)}>Clear store data</button>
            ) : (
              <div className="settings-row">
                <button className="btn btn-primary btn-sm" onClick={() => { onResetDemoData(); setResetConfirm(false); }}>Yes, delete everything</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setResetConfirm(false)}>Cancel</button>
              </div>
            )}
          </section>
        </>
      )}
      </div>
    </div>
  );
}

/* ---------------------------- landing ---------------------------- */

function LandingView({ onGetStarted }) {
  return (
    <div className="landing">
      <div className="landing-mark">
        <span className="landing-logo">And<em>ito</em></span>
        <span className="landing-by">by D<span className="flag-a">A</span>PU</span>
      </div>

      <div className="landing-actions">
        <button className="landing-card landing-card-cta" onClick={onGetStarted}>
          <span className="landing-card-h">Get Started</span>
        </button>
      </div>
    </div>
  );
}

function SignupView({ onContinue, onSkip }) {
  const [role, setRole] = useState(null);
  const [phone, setPhone] = useState("");

  const digits = phone.replace(/[^0-9]/g, "");
  const canContinue = role && digits.length === 10;

  return (
    <div className="signup">
      <div className="signup-mark">
        <span className="landing-logo signup-logo">And<em>ito</em></span>
      </div>

      <p className="signup-kicker">Create your account</p>

      <div className="signup-roles">
        <button
          className={`signup-role ${role === "searcher" ? "signup-role-on" : ""}`}
          onClick={() => setRole("searcher")}
          aria-pressed={role === "searcher"}
        >
          <span className="signup-role-h">I'm looking for products</span>
          <span className="signup-role-p">Search nearby stores for what's in stock</span>
        </button>
        <button
          className={`signup-role ${role === "owner" ? "signup-role-on" : ""}`}
          onClick={() => setRole("owner")}
          aria-pressed={role === "owner"}
        >
          <span className="signup-role-h">I have a store</span>
          <span className="signup-role-p">List your stock so shoppers can find you</span>
        </button>
      </div>

      <label className="signup-field">
        <span className="settings-label">Phone number</span>
        <div className="signup-phone">
          <span className="signup-phone-prefix">+63</span>
          <input
            className="field signup-phone-input"
            inputMode="numeric"
            placeholder="9XX XXX XXXX"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
          />
        </div>
      </label>

      <button
        className="btn btn-primary btn-block signup-continue"
        disabled={!canContinue}
        onClick={() => onContinue(role, `+63${digits}`)}
      >
        Continue
      </button>

      <button className="link signup-skip" onClick={onSkip}>Skip for now (testing)</button>
    </div>
  );
}

/* ---------------------------- shell ---------------------------- */

export default function Andito() {
  const [listings, setListings] = useState(LISTINGS);
  const [view, setView] = useState("landing");
  const [account, setAccount] = useState(null); // { role: "searcher" | "owner", phone } | null
  const [storeId, setStoreId] = useState(null);
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  /* Seller work-in-progress lives here, not in SellerView, so a half-finished
     sale survives a trip to the shopper side and back. */
  const [page, setPage] = useState("dashboard");
  const [cart, setCart] = useState([]);
  const [transactions, setTransactions] = useState([]);

  /* Store profile + app settings, lifted here so edits in "My store" show up
     immediately on the shopper side without a page reload. */
  const [storeProfile, setStoreProfile] = useState(() => {
    const s = STORES.find((x) => x.id === MY_STORE);
    return { name: s.name, kind: s.kind, area: s.area, hours: s.hours, phone: s.phone };
  });
  const [settings, setSettings] = useState({
    lowStockThreshold: 3,
    pinEnabled: false,
    pin: "",
    language: "en",
  });
  const [pinUnlocked, setPinUnlocked] = useState(false);

  /* Favorites, lifted here so they survive navigation between shop/store/seller
     views and so restocks can be detected app-wide (see effect below).
     Favoriting requires an account (somewhere to persist it and to send
     restock notifications to) — a guest tap is redirected to sign up, and
     the tapped item is remembered so it's favorited automatically right
     after they finish signing up. */
  const [favorites, setFavorites] = useState({ products: [], stores: [] });
  const [pendingFavorite, setPendingFavorite] = useState(null); // { type: "product" | "store", id } | null

  /* True once this device has ever had a real owner account — either
     restored from storage or created fresh this session. Distinguishes a
     genuinely first-time "I have a store" signup (blank slate) from a
     returning owner who signed out and is signing back in (keep their
     real, now-persisted data — see startFreshOwnerAccount below). */
  const [ownerConfigured, setOwnerConfigured] = useState(false);

  /* Everything above is in-memory only by default — a reload wipes it. This
     restores a previous session from this artifact's personal key-value
     storage (not shared: only this browser/account sees it back). Only
     MY_STORE's listings are saved/restored; s2–s5 are static demo data that
     never changes, so there's nothing to persist for them. */
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await window.storage.get("app-state");
        const saved = res?.value ? JSON.parse(res.value) : null;
        if (saved && !cancelled) {
          if (saved.account) setAccount(saved.account);
          if (saved.storeProfile) { setStoreProfile(saved.storeProfile); setOwnerConfigured(true); }
          if (Array.isArray(saved.myListings)) {
            setListings((prev) => [...prev.filter((l) => l.storeId !== MY_STORE), ...saved.myListings]);
          }
          // saved.sales (the old undated 7-slot array) is intentionally ignored:
          // sales figures are rebuilt from the dated transaction log below.
          if (Array.isArray(saved.transactions)) {
            setTransactions(saved.transactions.map((t) => ({ ...t, time: new Date(t.time) })));
          }
          if (saved.settings) setSettings((s) => ({ ...s, ...saved.settings }));
          if (saved.favorites) setFavorites(saved.favorites);
          if (Array.isArray(saved.cart)) setCart(saved.cart);
          if (saved.account) setView(saved.account.role === "owner" ? "seller" : "shop");
        }
      } catch {
        // first run on this device — nothing saved yet, start fresh
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const applyFavorite = (type, id) =>
    setFavorites((f) =>
      type === "product"
        ? { ...f, products: f.products.includes(id) ? f.products.filter((x) => x !== id) : [...f.products, id] }
        : { ...f, stores: f.stores.includes(id) ? f.stores.filter((x) => x !== id) : [...f.stores, id] }
    );

  const requestFavorite = (type, id) => {
    if (!account) {
      setPendingFavorite({ type, id, returnView: view });
      setView("signup");
      toast("Sign up to save favorites and get restock alerts.");
      return;
    }
    applyFavorite(type, id);
  };

  const toggleFavoriteProduct = (id) => requestFavorite("product", id);
  const toggleFavoriteStore = (id) => requestFavorite("store", id);

  /* Real distance for shoppers, opt-in. Nothing is requested automatically —
     browsers (and this sandbox) require a user gesture for a geolocation
     prompt anyway, and asking on load feels invasive. Until the shopper taps
     "Use my location," every store falls back to its fixed demo distance
     (see the stores useMemo below). */
  const [userLoc, setUserLoc] = useState(null); // {lat,lng} | null
  const [locStatus, setLocStatus] = useState("idle"); // idle | locating | granted | denied | unavailable

  const requestUserLocation = () => {
    if (!navigator.geolocation) {
      setLocStatus("unavailable");
      toast("Location isn't available on this device or browser.");
      return;
    }
    setLocStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocStatus("granted");
        toast("Using your location for distances.");
      },
      (err) => {
        setLocStatus(err.code === 1 ? "denied" : "unavailable");
        toast(err.code === 1 ? "Location permission denied." : "Couldn't get your location.");
      },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  };

  const stores = useMemo(
    () =>
      STORES.map((s) => {
        const base = s.id === MY_STORE ? { ...s, ...storeProfile } : s;
        const meters = userLoc ? Math.round(haversine(userLoc.lat, userLoc.lng, s.lat, s.lng)) : s.fallbackMeters;
        return { ...base, meters };
      }),
    [storeProfile, userLoc]
  );

  const toast = (t) => {
    setMsg(t);
    setTimeout(() => setMsg(null), 2800);
  };

  /* Write-through autosave: fires whenever any persisted slice changes.
     Gated on `loaded` so the very first render (before the restore above
     has finished) can't stomp a previous session with fresh-boot defaults. */
  useEffect(() => {
    if (!loaded) return;
    const myListings = listings.filter((l) => l.storeId === MY_STORE);
    const payload = { account, storeProfile, myListings, transactions, settings, favorites, cart };
    window.storage.set("app-state", JSON.stringify(payload)).catch(() => {});
  }, [loaded, account, storeProfile, listings, transactions, settings, favorites, cart]);

  /* Notify on restocks for anything the user has favorited — either the
     product itself, or any item at a favorited store. Only fires on view
     "shop" so a seller mid-edit on their own dashboard isn't interrupted.
     toast() only holds one message at a time, so if several favorited
     items restock in the same update, collapse them into a single summary
     line instead of firing toast() per item — otherwise every call but the
     last silently overwrites the one before it and never gets seen. */
  const prevListingsRef = useRef(listings);
  useEffect(() => {
    const prev = prevListingsRef.current;
    if (view === "shop" || view === "store") {
      const notes = [];
      listings.forEach((l) => {
        const before = prev.find((p) => p.id === l.id);
        if (!before || before.status === l.status) return;
        const restocked = before.status !== "in" && l.status === "in";
        if (!restocked) return;
        const store = STORES.find((s) => s.id === l.storeId);
        if (favorites.products.includes(l.id)) {
          notes.push(`${l.name} is back in stock at ${store?.name || "a store you follow"}.`);
        } else if (favorites.stores.includes(l.storeId)) {
          notes.push(`${store?.name} restocked ${l.name}.`);
        }
      });
      if (notes.length === 1) toast(notes[0]);
      else if (notes.length > 1) toast(`${notes.length} items you follow are back in stock.`);
    }
    prevListingsRef.current = listings;
  }, [listings]);

  /* "Ask stores for X" writes to a SHARED storage bucket (shared: true) so
     any seller with this same app open sees real demand land on their
     dashboard within ~15s — not just whoever searched. That's the point of
     the feature, but it does mean these search terms are visible to anyone
     who opens this artifact, not just this one account. */
  const submitDemandRequest = async (q) => {
    const query = (q || "").trim();
    if (!query) return;
    try {
      let existing = [];
      try {
        const res = await window.storage.get("demand-requests", true);
        existing = res?.value ? JSON.parse(res.value) : [];
      } catch {
        existing = [];
      }
      const next = [...existing, { query, ts: Date.now() }].slice(-80);
      await window.storage.set("demand-requests", JSON.stringify(next), true);
    } catch {
      // best-effort — the customer still gets a confirmation either way
    }
    toast(`Request sent. Stores nearby will see that someone is looking for "${query}".`);
  };

  const resetDemoData = () => {
    setListings(LISTINGS);
    setTransactions([]);
    setCart([]);
    toast("Store data cleared.");
  };

  /* A fresh "I have a store" signup already starts with a blank profile
     (see onContinue below) — but MY_STORE's listings, sales, and past
     transactions are shared demo data, so without this a brand-new owner's
     first login shows someone else's laptop chargers and GPUs as if they
     already had stock. Strip everything tied to MY_STORE so "blank profile"
     actually means "blank store." */
  const startFreshOwnerAccount = () => {
    setListings((prev) => prev.filter((l) => l.storeId !== MY_STORE));
    setTransactions([]);
    setCart([]);
    setOwnerConfigured(true);
  };

  /* Single path for every sale, whether it came from POS or from Inventory. */
  const commitSale = (lines, source) => {
    if (!lines.length) return;
    const total = lines.reduce((a, c) => a + c.qty * c.price, 0);

    setListings((prev) =>
      prev.map((l) => {
        const line = lines.find((c) => c.id === l.id);
        if (!line) return l;
        const newQty = Math.max(0, (l.qty || 0) - line.qty);
        return { ...l, qty: newQty, status: statusFromQty(newQty, l.lowAt ?? settings.lowStockThreshold), lastCheckedAt: Date.now() };
      })
    );
    setTransactions((prev) => [
      {
        id: "t" + Date.now(),
        time: new Date(),
        source,
        lines: lines.map((c) => ({ id: c.id, name: c.name, price: c.price, qty: c.qty, returnedQty: 0 })),
        total,
      },
      ...prev,
    ]);

    toast(
      lines.length === 1
        ? `${lines[0].qty} × ${lines[0].name} recorded · ${peso(total)}`
        : `Sale recorded · ${peso(total)}`
    );
  };

  const commitReturn = (t, line, qty) => {
    const remaining = line.qty - line.returnedQty;
    qty = Math.max(1, Math.min(qty, remaining));
    if (qty <= 0) return;

    setListings((prev) =>
      prev.map((l) => {
        if (l.id !== line.id) return l;
        const newQty = (l.qty || 0) + qty;
        return { ...l, qty: newQty, status: statusFromQty(newQty, l.lowAt ?? settings.lowStockThreshold), lastCheckedAt: Date.now() };
      })
    );
    setTransactions((prev) =>
      prev.map((tx) =>
        tx.id === t.id
          ? { ...tx, lines: tx.lines.map((l) => (l.id === line.id ? { ...l, returnedQty: l.returnedQty + qty } : l)) }
          : tx
      )
    );
    toast(`${qty} × ${line.name} returned · −${peso(qty * line.price)}`);
  };

  return (
    <div className="app">
      <style>{`
@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

.app{
  --ink:#2A2721; --ink-60:#736C5E; --ink-30:#A79F8C;
  --paper:#F7F4EC; --card:#FFFFFF; --line:#E7E1D2; --line-2:#EFEADD;
  --accent:#2F6F52; --accent-hi:#3D8A66; --accent-soft:#E3EEE5;
  --in:#2F6F52; --low:#AD7A2E; --out:#B2483B;
  background:var(--paper); color:var(--ink);
  font-family:'Inter',system-ui,sans-serif;
  min-height:100%; padding:0 0 64px; -webkit-font-smoothing:antialiased;
}
.app *{box-sizing:border-box;}
.app button{font:inherit;cursor:pointer;}
.app :focus-visible{outline:2.5px solid var(--accent);outline-offset:2px;border-radius:4px;}
.up{color:var(--in);} .down{color:var(--out);}

.wrap{max-width:680px;margin:0 auto;padding:0 18px;}
.wrap-wide{max-width:1040px;}

.topbar{position:sticky;top:0;z-index:20;background:var(--paper);color:var(--ink);
  border-bottom:1px solid var(--line);
  display:flex;align-items:center;justify-content:space-between;padding:12px 18px;}
.brandmark{display:flex;align-items:baseline;gap:10px;background:none;border:0;padding:0;}
.brandmark-seller{display:flex;align-items:center;gap:10px;min-width:0;}
.brandmark-storename{font-family:'Source Serif 4',serif;font-weight:600;font-size:15.5px;color:var(--ink);
  max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.logo{font-family:'Source Serif 4',serif;font-weight:700;font-size:21px;letter-spacing:-.01em;}
.logo em{font-style:normal;color:var(--accent);}
.logo-squares{display:inline-flex;align-items:center;gap:6px;}
.logo-sq{display:inline-block;width:13px;height:13px;border-radius:3px;}
.sq-blk{background:var(--ink);}
.sq-grn{background:var(--accent);}

.hamburger{display:inline-flex;flex-direction:column;justify-content:center;gap:4px;width:20px;height:16px;}
.ham-bar{display:block;height:2.5px;width:100%;border-radius:2px;transition:transform .2s ease,opacity .2s ease,background .2s ease;}
.ham-blk{background:var(--ink);}
.ham-grn{background:var(--accent);}
.hamburger-open .ham-bar:nth-child(1){transform:translateY(6.5px) rotate(45deg);background:var(--ink);}
.hamburger-open .ham-bar:nth-child(2){opacity:0;}
.hamburger-open .ham-bar:nth-child(3){transform:translateY(-6.5px) rotate(-45deg);background:var(--ink);}
.flag-a{position:relative;display:inline-block;font-weight:800;
  background:linear-gradient(180deg,#0038A8 0%,#0038A8 50%,#CE1126 50%,#CE1126 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;}
.flag-a::before{content:'';position:absolute;top:-4px;left:50%;transform:translateX(-50%) rotate(45deg);
  width:3px;height:3px;background:#FCD116;box-shadow:0 0 0 1px transparent;}
.tabs{display:flex;gap:4px;background:var(--line-2);padding:3px;border-radius:999px;}
.tab{background:transparent;border:0;color:var(--ink);display:flex;align-items:center;justify-content:center;
  width:36px;height:36px;padding:0;border-radius:999px;transition:background .15s,color .15s;}
.tab-on{background:var(--accent);color:#fff;}

.signup-pill{background:var(--accent);color:#fff;border:0;border-radius:999px;padding:9px 18px;
  font-family:'Inter',sans-serif;font-size:13px;font-weight:600;letter-spacing:.01em;transition:background .15s;}
.signup-pill:hover{background:var(--accent-hi,var(--accent));}

.search-toggle{display:inline-flex;gap:4px;background:var(--line-2);padding:3px;border-radius:999px;margin-bottom:14px;}
.search-toggle-opt{background:transparent;border:0;color:var(--ink);
  font-family:'Inter',sans-serif;font-size:12.5px;font-weight:600;letter-spacing:.01em;padding:7px 16px;border-radius:999px;transition:background .15s,color .15s;}
.search-toggle-on{background:var(--accent);color:#fff;}

/* landing */
.landing{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:space-between;
  padding:64px 24px 40px;text-align:center;}
.landing-mark{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;}
.landing-logo{font-family:'Source Serif 4',serif;font-weight:700;font-size:clamp(48px,14vw,80px);letter-spacing:-.02em;line-height:1;color:var(--accent);}
.landing-logo em{font-style:normal;}
.landing-by{font-family:'Inter',sans-serif;font-size:11.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-60);}
.landing-actions{width:100%;max-width:420px;display:flex;flex-direction:column;gap:10px;}
.landing-card{display:flex;align-items:center;justify-content:center;text-align:center;width:100%;
  background:var(--card);border:1.5px solid var(--line);border-radius:16px;padding:20px 18px;
  box-shadow:0 1px 2px rgba(42,39,33,.04);transition:border-color .15s,transform .15s;}
.landing-card:hover{border-color:var(--accent);transform:translateY(-1px);}
.landing-card-h{font-family:'Source Serif 4',serif;font-size:18px;font-weight:600;}
.landing-card-alt .landing-card-h{color:var(--accent);}
.landing-card-cta{background:var(--ink);border-color:var(--ink);padding:22px 18px;}
.landing-card-cta .landing-card-h{color:var(--paper);font-size:19px;}
.landing-card-cta:hover{border-color:var(--accent);background:var(--accent);}

/* signup */
.signup{min-height:100vh;display:flex;flex-direction:column;align-items:center;
  padding:48px 24px 40px;text-align:center;}
.signup-mark{margin-bottom:22px;}
.signup-logo{font-size:clamp(30px,8vw,40px);}
.signup-kicker{font-family:'Inter',sans-serif;font-size:11px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:var(--ink-60);margin:0 0 18px;}
.signup-roles{width:100%;max-width:420px;display:flex;flex-direction:column;gap:10px;margin-bottom:22px;}
.signup-role{display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-align:left;width:100%;
  background:var(--card);border:1.5px solid var(--line);border-radius:16px;padding:16px 18px;
  box-shadow:0 1px 2px rgba(42,39,33,.04);transition:border-color .15s,background .15s;}
.signup-role-h{font-size:15.5px;font-weight:600;}
.signup-role-p{font-size:12.5px;color:var(--ink-60);}
.signup-role-on{border-color:var(--accent);background:var(--accent-soft,#e7efe9);}
.signup-role-on .signup-role-h{color:var(--accent);}
.signup-field{width:100%;max-width:420px;display:flex;flex-direction:column;gap:6px;text-align:left;margin-bottom:20px;}
.signup-phone{display:flex;align-items:center;gap:8px;}
.signup-phone-prefix{font-family:'IBM Plex Mono',monospace;font-size:15px;font-weight:600;color:var(--ink-60);
  background:var(--line-2);border-radius:10px;padding:11px 12px;}
.signup-phone-input{flex:1;}
.signup-continue{width:100%;max-width:420px;}
.signup-continue:disabled{opacity:.45;}
.signup-skip{margin-top:16px;color:var(--ink-60);text-decoration:none;font-weight:500;}

/* hero + customer side */
.hero{padding:38px 0 22px;}
.account-menu-wrap{position:relative;}
.account-btn{display:flex;align-items:center;justify-content:center;width:36px;height:36px;
  border-radius:999px;background:var(--line-2);border:0;color:var(--ink-60);transition:background .15s,color .15s;}
.account-btn:hover{color:var(--ink);}
.account-menu{position:fixed;top:52px;right:18px;z-index:30;min-width:190px;background:var(--card);
  border:1px solid var(--line);border-radius:14px;padding:10px;box-shadow:0 10px 28px rgba(42,39,33,.16);}
.account-menu-phone{font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:var(--ink-60);
  padding:6px 10px 10px;margin:0;border-bottom:1px solid var(--line);}
.account-menu-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;
  border:0;padding:10px;border-radius:8px;font-size:14px;font-weight:600;color:var(--ink);margin-top:4px;}
.account-menu-item:hover{background:var(--line-2);}
.hero-toprow{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;}
.hero-toprow .search-toggle{margin-bottom:0;}
.fav-master{display:flex;align-items:center;justify-content:center;flex:0 0 auto;width:38px;height:38px;
  border-radius:999px;background:var(--card);border:1.5px solid var(--line);color:var(--ink-60);
  transition:background .15s,color .15s,border-color .15s;}
.fav-master-on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);}
.fav-heart{display:flex;align-items:center;justify-content:center;flex:0 0 auto;width:30px;height:30px;
  border-radius:999px;background:none;border:0;color:var(--ink-30);transition:color .15s,transform .1s;}
.fav-heart:active{transform:scale(.9);}
.fav-heart-on{color:var(--accent);}
.row-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;}
.row-top .row-name{margin:0;}
.storecard-wrap{position:relative;border-bottom:1px solid var(--line);}
.storecard-wrap .storecard{border-bottom:0;padding-right:40px;}
.storecard-fav{position:absolute;top:12px;right:0;}
.store-head-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}
.store-head-top .store-name{margin:0;}
.store-fav{width:36px;height:36px;}
.eyebrow{font-family:'Inter',sans-serif;font-size:11.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin:0 0 10px;}
.hero-h{font-family:'Source Serif 4',serif;font-weight:600;font-size:clamp(36px,10vw,56px);line-height:1.02;margin:0 0 26px;letter-spacing:-.01em;}
.hero-em{color:var(--accent);font-style:italic;}
.hero-sub{margin:16px 0 20px;font-size:15px;line-height:1.55;color:var(--ink-60);max-width:34em;}
.searchbar{position:relative;display:flex;}
.searchbar-inline{margin:18px 0 6px;}
.search-input{width:100%;background:var(--card);border:1.5px solid var(--line);border-radius:14px;
  padding:15px 46px 15px 17px;font-size:16px;font-family:inherit;color:var(--ink);
  box-shadow:0 1px 2px rgba(42,39,33,.04);transition:border-color .15s,box-shadow .15s;}
.search-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);outline:none;}
.search-input::placeholder{color:var(--ink-30);}
.search-clear{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:0;font-size:22px;line-height:1;color:var(--ink-60);padding:4px 8px;}
.loc-pill{margin-top:10px;background:transparent;border:1px dashed var(--line);border-radius:100px;
  padding:7px 13px;font-size:12.5px;font-weight:600;color:var(--ink-60);}
.loc-pill:hover:not(:disabled){border-color:var(--accent);color:var(--accent);}
.loc-pill:disabled{opacity:.6;}
.loc-status{margin:10px 0 0;font-size:12.5px;font-weight:600;color:var(--accent);}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}
.chip{background:var(--card);border:1px solid var(--line);border-radius:100px;padding:7px 14px;font-size:13px;color:var(--ink-60);transition:border-color .15s,color .15s;}
.chip:hover{border-color:var(--accent);color:var(--accent);}
.results{padding-bottom:24px;}
.results-count{font-family:'Inter',sans-serif;font-weight:600;letter-spacing:.02em;font-size:12.5px;
  color:var(--ink-60);border-bottom:1px solid var(--line);padding-bottom:10px;margin:8px 0 0;}
.results-count strong{color:var(--ink);font-size:14px;}
.row{display:flex;gap:14px;padding:18px 0;border-bottom:1px solid var(--line);}
.row-stamp{flex:0 0 auto;padding-top:2px;}
.row-name{font-size:16px;font-weight:600;margin:0 0 3px;line-height:1.3;}
.row-spec{font-size:13px;color:var(--ink-60);margin:0 0 7px;line-height:1.4;}
.brand{font-family:'Inter',sans-serif;text-transform:uppercase;letter-spacing:.08em;font-size:11px;font-weight:600;color:var(--ink);margin-right:8px;}
.row-price{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:18px;margin:0 0 8px;}
.row-store{background:none;border:0;padding:0;font-size:14px;font-weight:600;color:var(--accent);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--accent-soft);}
.row-meta{font-size:12.5px;color:var(--ink-60);margin:5px 0 0;}

.stamp{display:flex;flex-direction:column;align-items:center;justify-content:center;width:88px;min-height:50px;padding:6px 4px;
  border-radius:12px;background:var(--accent-soft);font-family:'Inter',sans-serif;}
.stamp-main{font-weight:700;font-size:15.5px;letter-spacing:0;line-height:1;}
.stamp-sub{font-size:9.5px;letter-spacing:.04em;margin-top:3px;opacity:.7;}
.st-in{color:var(--in);} .st-low{color:var(--low);background-color:#F4EADA;} .st-out{color:var(--out);background-color:#F5E4E1;opacity:.7;}
.stamp.fr-stale{opacity:.55;}
.stamp.fr-aging{opacity:.85;}
.fresh{font-family:'IBM Plex Mono',monospace;font-size:12px;}
.fresh-fresh{color:var(--in);} .fresh-aging{color:var(--ink-60);} .fresh-stale{color:var(--out);font-weight:600;}

.storecard{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;
  background:none;border:0;border-bottom:1px solid var(--line);padding:16px 0;}
.storecard-name{font-family:'Source Serif 4',serif;font-size:19px;font-weight:600;}
.storecard-kind{font-size:13.5px;color:var(--ink-60);}
.storecard-meta{font-size:12.5px;color:var(--ink-60);font-family:'IBM Plex Mono',monospace;}
.back{background:none;border:0;padding:18px 0 0;color:var(--accent);font-size:14px;font-weight:600;}
.back-inline{padding:0 0 18px;}
.store-head{padding:14px 0 4px;}
.store-name{font-family:'Source Serif 4',serif;font-weight:600;font-size:clamp(26px,7vw,36px);line-height:1.05;margin:0;}
.store-kind{color:var(--ink-60);margin:8px 0 18px;font-size:14.5px;}
.store-facts{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;margin:0 0 20px;
  background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;}
.store-facts dt{font-family:'Inter',sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-60);margin-bottom:3px;}
.store-facts dd{margin:0;font-size:14px;font-weight:500;}
.store-actions{display:flex;gap:9px;flex-wrap:wrap;}
.empty{padding:32px 0;border-bottom:1px solid var(--line);}
.empty h3{font-family:'Source Serif 4',serif;font-size:19px;font-weight:600;margin:0 0 8px;}
.empty p{color:var(--ink-60);font-size:14.5px;line-height:1.55;margin:0 0 16px;max-width:38em;}

/* ============ dashboard ============ */
.dash-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;padding:26px 0 20px;flex-wrap:wrap;}

/* seller sidebar shell */
.seller-shell{position:relative;min-height:calc(100vh - 44px);}
.seller-content{width:100%;max-width:980px;}

.nav-backdrop{position:fixed;inset:44px 0 0 0;background:rgba(42,39,33,.28);z-index:29;
  animation:navBackdropIn .18s ease both;}
@keyframes navBackdropIn{from{opacity:0;}to{opacity:1;}}

.sidebar{position:fixed;top:44px;left:0;right:0;z-index:30;display:flex;flex-direction:row;flex-wrap:wrap;gap:4px;
  background:var(--paper);border-bottom:1px solid var(--line);box-shadow:0 12px 24px rgba(42,39,33,.12);
  padding:10px 14px;transform:translateY(-8px);opacity:0;pointer-events:none;
  max-height:0;overflow:hidden;transition:opacity .18s ease,transform .18s ease;}
.sidebar-open{opacity:1;pointer-events:auto;transform:translateY(0);max-height:80vh;overflow:visible;}
.sidebar-item{display:flex;flex-direction:row;align-items:center;gap:8px;
  background:transparent;border:0;border-radius:10px;padding:9px 12px;color:var(--ink-60);
  font-family:'Inter',sans-serif;font-size:13px;font-weight:600;letter-spacing:.01em;transition:background .15s,color .15s;}
.sidebar-item svg{flex:0 0 auto;}
.sidebar-label{line-height:1;}
.sidebar-item:hover{color:var(--ink);}
.sidebar-on{background:var(--accent-10,#e7efe9);color:var(--accent);}


.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:14px;}
@media(min-width:760px){.kpis{grid-template-columns:repeat(4,1fr);}}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px 15px;box-shadow:0 1px 2px rgba(42,39,33,.04);}
.kpi-blue{border-top:3px solid var(--accent);border-radius:14px;} .kpi-green{border-top:3px solid var(--in);} .kpi-amber{border-top:3px solid var(--low);}
.kpi-label{font-family:'Inter',sans-serif;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-60);margin:0 0 8px;}
.kpi-value{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:clamp(20px,5.4vw,26px);margin:0;line-height:1;letter-spacing:-.02em;}
.kpi-note{font-size:11.5px;margin:7px 0 0;color:var(--ink-60);font-family:'IBM Plex Mono',monospace;}
.kpi-up{color:var(--in);} .kpi-down{color:var(--out);}

.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:14px;box-shadow:0 1px 2px rgba(42,39,33,.04);}
.panel-alert{border-left:4px solid var(--low);}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;}
.panel-h{font-family:'Source Serif 4',serif;font-weight:600;letter-spacing:0;font-size:16px;margin:0;}
.panel-note{font-family:'IBM Plex Mono',monospace;font-size:12.5px;margin:0;color:var(--ink-60);}
.panel-note-live{color:var(--accent);font-weight:600;}
.panel-foot{font-size:12.5px;color:var(--ink-60);line-height:1.5;margin:12px 0 0;}

/* chart */
.chart{display:flex;gap:10px;}
.chart-axis{display:flex;flex-direction:column;justify-content:space-between;height:170px;
  font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:var(--ink-30);text-align:right;flex:0 0 auto;}
.chart-body{flex:1;min-width:0;}
.chart-plot{position:relative;height:170px;}
.gridline{position:absolute;left:0;right:0;border-top:1px dashed var(--line);}
.gridline-base{border-top:1.5px solid var(--ink-30);}
.chart-prev{position:absolute;inset:0;width:100%;height:100%;color:var(--ink-30);overflow:visible;pointer-events:none;z-index:3;}
.bars{position:absolute;inset:0;display:flex;gap:5px;z-index:2;}
.bar-col{flex:1;background:none;border:0;padding:0;display:flex;align-items:flex-end;justify-content:center;}
.bar{display:block;width:100%;background:var(--accent-soft);border-radius:5px 5px 0 0;transition:background .15s;}
.bar-col:last-child .bar{background:var(--in);}
.bar-col:hover .bar,.bar-on .bar{background:var(--ink);}
.chart-labels{display:flex;gap:4px;margin-top:8px;}
.chart-day{flex:1;text-align:center;font-family:'Inter',sans-serif;font-size:11px;font-weight:500;
  color:var(--ink-60);}
.chart-today{color:var(--in);font-weight:600;}
.chart-day-on{color:var(--ink);font-weight:600;}
.chart-read{font-size:12.5px;color:var(--ink-60);margin:14px 0 0;border-top:1px solid var(--line-2);padding-top:11px;}
.chart-read strong{color:var(--ink);}

/* attention */
.attn{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:11px;}
.attn li{display:flex;align-items:flex-start;gap:9px;font-size:13.5px;line-height:1.45;}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;margin-top:5px;}
.dot-out{background:var(--out);} .dot-low{background:var(--low);} .dot-stale{background:var(--ink-30);}
.link{background:none;border:0;padding:0;color:var(--accent);font-size:13px;font-weight:600;text-decoration:underline;text-underline-offset:3px;white-space:nowrap;}

.cols{display:grid;grid-template-columns:1fr;gap:14px;}
@media(min-width:760px){.cols{grid-template-columns:1fr 1fr;}}

/* rank list */
.rank{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px;}
.rank-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline;}
.rank-name{font-size:13.5px;font-weight:500;}
.rank-val{font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;white-space:nowrap;}
.rank-track{height:7px;background:var(--line-2);margin:6px 0 4px;border-radius:99px;}
.rank-fill{display:block;height:100%;background:var(--accent);border-radius:99px;}
.rank-sub{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--ink-60);}

/* demand */
.demand{list-style:none;margin:0;padding:0;}
.demand li{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line-2);}
.demand li:last-child{border-bottom:0;}
.demand-q{flex:1;font-size:13.5px;}
.demand-n{font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;}
.demand-tag{font-family:'Inter',sans-serif;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  padding:4px 9px;border-radius:99px;white-space:nowrap;}
.tag-yes{color:var(--in);background:var(--accent-soft);} .tag-no{color:var(--out);background:#F5E4E1;}

/* inventory */
.toolbar{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:14px;align-items:center;}
.field{border:1.5px solid var(--line);border-radius:12px;padding:10px 13px;font:inherit;font-size:15px;width:100%;background:var(--card);transition:border-color .15s;}
.field-invalid{border-color:#b3372c;}
.field-invalid:focus{box-shadow:0 0 0 3px rgba(179,55,44,.15);}
.field-row{display:flex;gap:8px;align-items:center;}
.field-row .field{flex:1;min-width:0;}
.field-row-btn{flex:0 0 auto;white-space:nowrap;}
.field:focus{border-color:var(--accent);outline:none;}
.field-search{flex:1;min-width:150px;width:auto;}
.filters{display:flex;gap:6px;flex-wrap:wrap;}
.filter{background:var(--card);border:1px solid var(--line);border-radius:99px;padding:8px 13px;
  font-family:'Inter',sans-serif;font-size:12px;font-weight:600;color:var(--ink-60);}
.filter-on{background:var(--ink);color:var(--paper);border-color:var(--ink);}
.addbox{display:flex;flex-direction:column;gap:9px;background:var(--paper);border:1px solid var(--line);padding:14px;margin-bottom:14px;border-radius:14px;}
.addbox-hint{font-size:12px;color:var(--ink-60);line-height:1.5;margin:-2px 0 0;}

/* POS */
.pos-add{display:flex;gap:8px;margin-bottom:16px;align-items:flex-start;flex-wrap:wrap;}
.pos-field{position:relative;flex:1 1 200px;min-width:160px;}
.pos-qty-field{flex:0 0 76px;width:76px;text-align:center;}
.pos-suggest{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:5;background:var(--card);
  border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 20px rgba(42,39,33,.12);overflow:hidden;}
.pos-suggest-opt{display:flex;flex-direction:column;align-items:flex-start;width:100%;text-align:left;
  background:transparent;border:0;padding:9px 13px;border-bottom:1px solid var(--line);}
.pos-suggest-opt:last-child{border-bottom:0;}
.pos-suggest-opt:hover{background:var(--paper);}
.pos-suggest-name{font-size:14px;font-weight:600;color:var(--ink);}
.pos-suggest-meta{font-size:11.5px;color:var(--ink-60);}

.pos-cart-list{list-style:none;margin:0 0 14px;padding:0;border-top:1px solid var(--line);}
.pos-cart-row{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:11px 0;border-bottom:1px solid var(--line);}
.pos-cart-info{display:flex;flex-direction:column;min-width:0;}
.pos-cart-name{font-size:14px;font-weight:600;color:var(--ink);}
.pos-cart-sub{font-size:11.5px;color:var(--ink-60);}
.pos-cart-ctl{display:flex;align-items:center;gap:10px;flex:0 0 auto;}
.pos-cart-total{font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;min-width:64px;text-align:right;}
.pos-cart-remove{background:transparent;border:0;color:var(--ink-60);font-size:20px;line-height:1;padding:0 2px;}
.pos-cart-remove:hover{color:#b3372c;}

.pos-total{display:flex;align-items:center;justify-content:space-between;font-family:'Source Serif 4',serif;
  font-size:17px;font-weight:600;padding:4px 0 16px;}
.pos-total-val{font-family:'IBM Plex Mono',monospace;}
.btn-block{width:100%;}

.pos-history{list-style:none;margin:0;padding:0;}
.pos-tx{padding:12px 0;border-bottom:1px solid var(--line);}
.pos-tx:last-child{border-bottom:0;}
.pos-tx-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;}
.pos-tx-time{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink-60);}
.pos-tx-src{color:var(--ink-30);}
.pos-tx-total{font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;}
.pos-tx-items{font-size:13px;color:var(--ink-60);margin:0 0 6px;}
.pos-tx-tag{font-family:'Inter',sans-serif;font-size:11px;font-weight:600;letter-spacing:.02em;
  color:#b3372c;text-transform:uppercase;}
.pos-tx-returned{opacity:.6;}
.pos-tx-total-orig{color:var(--ink-60);text-decoration:line-through;font-weight:500;margin-right:7px;}
.pos-tx-lines{list-style:none;margin:8px 0 0;padding:9px 10px 2px;background:var(--paper);border-radius:10px;}
.pos-tx-line{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;font-size:13px;}
.pos-tx-line-name{color:var(--ink);}
.pos-tx-line-note{color:var(--ink-60);font-size:12px;}
.pos-tx-line-ctl{display:flex;align-items:center;gap:9px;flex:0 0 auto;}
.pos-tx-line-tag{font-family:'Inter',sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.02em;
  color:var(--ink-60);text-transform:uppercase;}
.addrow{display:flex;gap:9px;}

.inv-compact{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:none;border:0;
  border-bottom:1px solid var(--line-2);padding:14px 2px;}
.inv-compact:last-child{border-bottom:0;}
.inv-compact:hover{background:var(--line-2);}
.inv-compact-name{flex:1;min-width:0;font-size:14.5px;font-weight:500;color:var(--ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.inv-compact-price{font-family:'IBM Plex Mono',monospace;font-size:13.5px;color:var(--ink-60);white-space:nowrap;}
.inv-compact-qty{font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:700;min-width:26px;text-align:right;}

.product-detail{display:flex;flex-direction:column;gap:20px;}
.product-detail-name{font-family:'Inter',sans-serif;font-weight:700;font-size:24px;margin:0;letter-spacing:-.01em;}
.product-detail-fresh{margin:-10px 0 0;font-size:13.5px;}
.product-detail-row{display:flex;flex-direction:column;gap:5px;}
.product-detail-value{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:600;}
.product-detail-qty-btn{align-self:flex-start;background:none;border:0;padding:2px 6px;margin:-2px -6px;
  border-radius:8px;border-bottom:1px dashed var(--line);}
.product-detail-qty-btn:hover{background:var(--line-2);}

.inv-k{font-family:'Inter',sans-serif;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-60);}
.qty-out{color:var(--out);} .qty-low{color:var(--low);}
.qty-value-btn{background:none;border:0;padding:2px 4px;margin:-2px -4px;border-radius:6px;
  border-bottom:1px dashed var(--line);}
.qty-value-btn:hover{background:var(--line-2);}
.qty-edit{display:inline-flex;align-items:center;gap:4px;}
.qty-edit-input{width:44px;font-family:'IBM Plex Mono',monospace;font-size:13.5px;font-weight:600;
  text-align:center;border:1.5px solid var(--accent);border-radius:8px;padding:4px 2px;background:var(--card);color:var(--ink);}
.qty-edit-go{background:var(--in) !important;color:#fff;border-radius:8px;padding:4px 8px !important;font-size:13px !important;line-height:1;}
.qty-edit-cancel{background:none !important;color:var(--ink-30) !important;padding:4px 6px !important;font-size:15px !important;line-height:1;}
.seg{display:flex;gap:5px;}
.seg-btn{flex:1;background:var(--card);border:1.5px solid var(--line);border-radius:10px;padding:8px 5px;
  font-family:'Inter',sans-serif;font-size:12px;font-weight:600;color:var(--ink-60);}
.seg-on{background:var(--ink);color:var(--paper);border-color:var(--ink);}
.seg-on.seg-in{background:var(--in);border-color:var(--in);color:#fff;}
.seg-on.seg-low{background:var(--low);border-color:var(--low);color:#fff;}
.seg-on.seg-out{background:var(--out);border-color:var(--out);color:#fff;}
.inv-acts{display:flex;gap:14px;align-items:center;margin-top:9px;flex-wrap:wrap;}
.inv-lowat{display:flex;align-items:center;gap:7px;margin-top:9px;}
.inv-lowat-warn .lowat-input{border-color:var(--low);}
.inv-lowat-warn .lowat-unit{color:var(--low);font-weight:600;}
.lowat-input{width:52px;background:var(--card);border:1.5px solid var(--line);border-radius:8px;
  padding:6px 7px;font:inherit;font-size:13px;text-align:center;color:var(--ink);}
.lowat-input:focus{border-color:var(--accent);}
.lowat-unit{font-size:11px;color:var(--ink-30);}
.inv-warn{font-family:'Inter',sans-serif;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--out);}
.stepper{display:inline-flex;align-items:center;gap:2px;border:1.5px solid var(--line);border-radius:10px;overflow:hidden;}
.stepper button{background:var(--card);border:0;padding:5px 12px;font-size:16px;line-height:1;color:var(--ink);}
.stepper-n{font-family:'IBM Plex Mono',monospace;font-size:13px;min-width:26px;text-align:center;font-weight:600;}
.stepper-go{background:var(--in) !important;color:#fff;font-family:'Inter',sans-serif;font-size:11.5px !important;font-weight:600;
  letter-spacing:.02em;padding:7px 12px !important;}
.stepper-input{font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;min-width:36px;width:36px;
  text-align:center;border:0;background:var(--card);color:var(--ink);padding:5px 2px;}
.stepper-cancel{color:var(--ink-30) !important;font-size:15px !important;padding:5px 9px !important;}

/* buttons */
.btn{border:1.5px solid var(--ink);border-radius:99px;padding:11px 18px;font-family:'Inter',sans-serif;
  font-weight:600;letter-spacing:.01em;font-size:13.5px;transition:background .15s,color .15s,box-shadow .15s;}
.btn-sm{padding:7px 13px;font-size:12px;}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 1px 2px rgba(47,111,82,.25);}
.btn-primary:hover{background:var(--accent-hi);border-color:var(--accent-hi);}
.btn-ghost{background:transparent;color:var(--ink);border-color:var(--line);}
.btn-ghost:hover{border-color:var(--ink);}

.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);color:var(--paper);
  padding:12px 20px;border-radius:99px;font-size:13.5px;z-index:50;max-width:88%;text-align:center;
  box-shadow:0 8px 24px rgba(42,39,33,.28);}

@media(prefers-reduced-motion:reduce){.app *{animation:none !important;transition:none !important;}}

/* settings */
.settings-grid{display:grid;grid-template-columns:1fr;gap:12px;margin-bottom:14px;}
@media(min-width:640px){.settings-grid{grid-template-columns:1fr 1fr;}}
.settings-field{display:flex;flex-direction:column;gap:5px;}
.settings-label{font-family:'Inter',sans-serif;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-60);}
.settings-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.settings-row-note{font-size:13px;color:var(--ink-60);}
.pin-error{color:#b3372c;font-size:12.5px;margin:2px 0 0;}

.switch{position:relative;width:42px;height:24px;border-radius:99px;border:0;background:var(--line);padding:0;flex:0 0 auto;transition:background .15s;}
.switch-on{background:var(--accent);}
.switch-knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;
  box-shadow:0 1px 2px rgba(42,39,33,.25);transition:transform .15s;}
.switch-on .switch-knob{transform:translateX(18px);}

/* PIN gate */
.pingate{min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;gap:6px;}
.pingate-sub{font-size:13.5px;color:var(--ink-60);margin:0 0 20px;}
.pingate-dots{display:flex;gap:14px;margin-bottom:28px;}
.pingate-dot{width:13px;height:13px;border-radius:50%;border:1.5px solid var(--line);background:transparent;transition:background .1s,border-color .1s;}
.pingate-dot-on{background:var(--accent);border-color:var(--accent);}
.pingate-shake{animation:pingateShake .38s ease;}
@keyframes pingateShake{
  0%,100%{transform:translateX(0);} 20%{transform:translateX(-8px);} 40%{transform:translateX(8px);}
  60%{transform:translateX(-6px);} 80%{transform:translateX(6px);}
}
.pingate-pad{display:grid;grid-template-columns:repeat(3,64px);gap:12px;}
.pingate-forgot{display:block;margin-top:22px;}
.pingate-key{width:64px;height:64px;border-radius:50%;background:var(--card);border:1px solid var(--line);
  font-family:'Inter',sans-serif;font-size:20px;font-weight:600;color:var(--ink);}
.pingate-key:active{background:var(--line-2);}

/* page transitions */
@keyframes pageFade{
  from{opacity:0;transform:translateY(8px);}
  to{opacity:1;transform:translateY(0);}
}
.page-fade{animation:pageFade .22s cubic-bezier(.22,.9,.32,1);}
.tab{transition:background .15s ease,color .15s ease;}
.landing-card{transition:border-color .15s ease,transform .12s ease,box-shadow .15s ease;}
.landing-card:active{transform:scale(.98);}
.brandmark{transition:opacity .15s ease;}
.brandmark:active{opacity:.6;}
      `}</style>

      {view === "landing" ? (
        <div key="landing" className="page-fade">
          <LandingView onGetStarted={() => setView("shop")} />
        </div>
      ) : view === "signup" ? (
        <div key="signup" className="page-fade">
          <SignupView
            onContinue={(role, phone) => {
              setAccount({ role, phone });
              if (role === "owner") {
                if (!ownerConfigured) {
                  /* Genuinely first-time — the profile form should start
                     blank (not the demo "ABC Computer Store" data) so the
                     owner sets up their own store. Phone carries over since
                     they already typed it during signup. */
                  setStoreProfile({ name: "", kind: "", area: "", hours: "", phone });
                  startFreshOwnerAccount();
                } else {
                  /* Returning owner who signed out and is signing back in —
                     their store profile and inventory are already
                     persisted, so just refresh the phone on file. */
                  setStoreProfile((p) => ({ ...p, phone }));
                }
              }
              if (pendingFavorite) {
                applyFavorite(pendingFavorite.type, pendingFavorite.id);
                setView(pendingFavorite.returnView || (role === "owner" ? "seller" : "shop"));
                setPendingFavorite(null);
              } else {
                setView(role === "owner" ? "seller" : "shop");
              }
            }}
            onSkip={() => { setPendingFavorite(null); setView("shop"); }}
          />
        </div>
      ) : (
        <>
          <nav className="topbar">
            <button
              className="brandmark"
              onClick={() => (view === "seller" ? setNavOpen((o) => !o) : setView("shop"))}
              aria-label={view === "seller" ? "Toggle menu" : "Home"}
              aria-expanded={view === "seller" ? navOpen : undefined}
            >
              {view === "seller" ? (
                <span className="brandmark-seller">
                  <span className={`hamburger ${navOpen ? "hamburger-open" : ""}`}>
                    <span className="ham-bar ham-blk" />
                    <span className="ham-bar ham-grn" />
                    <span className="ham-bar ham-blk" />
                  </span>
                  <span className="brandmark-storename">{storeProfile.name || "My store"}</span>
                </span>
              ) : (
                <span className="logo-squares"><span className="logo-sq sq-blk" /><span className="logo-sq sq-grn" /></span>
              )}
            </button>

            {account?.role === "owner" ? (
              <span className="tabs">
                <button className={`tab ${view !== "seller" ? "tab-on" : ""}`} onClick={() => { setView("shop"); setStoreId(null); setNavOpen(false); }} aria-label="Stores" aria-current={view !== "seller" ? "page" : undefined}>
                  <Search size={17} strokeWidth={2.2} />
                </button>
                <button className={`tab ${view === "seller" ? "tab-on" : ""}`} onClick={() => setView("seller")} aria-label="MyStore" aria-current={view === "seller" ? "page" : undefined}>
                  <Store size={17} strokeWidth={2.2} />
                </button>
              </span>
            ) : account?.role === "searcher" ? (
              <div className="account-menu-wrap">
                <button
                  className="account-btn"
                  onClick={() => setAccountMenuOpen((o) => !o)}
                  aria-label="Account menu"
                  aria-expanded={accountMenuOpen}
                >
                  <User size={17} strokeWidth={2.2} />
                </button>
                {accountMenuOpen && (
                  <>
                    <div className="nav-backdrop" onClick={() => setAccountMenuOpen(false)} />
                    <div className="account-menu">
                      <p className="account-menu-phone">{account.phone}</p>
                      <button
                        className="account-menu-item"
                        onClick={() => {
                          setAccountMenuOpen(false);
                          setAccount(null);
                          setView("shop");
                          toast("Signed out.");
                        }}
                      >
                        <LogOut size={15} strokeWidth={2.2} /> Sign out
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : !account ? (
              <button className="signup-pill" onClick={() => setView("signup")}>Sign up</button>
            ) : null}
          </nav>

          <div className={`wrap ${view === "seller" ? "wrap-wide" : ""}`}>
            <div key={view === "store" ? `store-${storeId}` : view} className="page-fade">
              {view === "shop" && (
                <SearchView
                  stores={stores}
                  listings={listings}
                  query={query}
                  setQuery={setQuery}
                  onOpenStore={(id) => { setStoreId(id); setView("store"); }}
                  onRequest={submitDemandRequest}
                  favorites={favorites}
                  onToggleFavoriteProduct={toggleFavoriteProduct}
                  onToggleFavoriteStore={toggleFavoriteStore}
                  locStatus={locStatus}
                  onRequestLocation={requestUserLocation}
                />
              )}
              {view === "store" && (
                <StoreView
                  store={stores.find((s) => s.id === storeId)}
                  listings={listings}
                  onBack={() => setView("shop")}
                  favorites={favorites}
                  onToggleFavoriteProduct={toggleFavoriteProduct}
                  onToggleFavoriteStore={toggleFavoriteStore}
                />
              )}
              {view === "seller" && settings.pinEnabled && !pinUnlocked ? (
                <PinGate
                  storeName={storeProfile.name}
                  correctPin={settings.pin || "0000"}
                  accountPhone={account?.phone}
                  onUnlock={() => setPinUnlocked(true)}
                  onForgotPin={() => {
                    setSettings((s) => ({ ...s, pinEnabled: false, pin: "" }));
                    setPinUnlocked(true);
                    toast("PIN lock turned off. Set a new PIN anytime from Settings.");
                  }}
                />
              ) : view === "seller" ? (
                <SellerView
                  listings={listings}
                  setListings={setListings}
                  toast={toast}
                  navOpen={navOpen}
                  setNavOpen={setNavOpen}
                  page={page}
                  setPage={setPage}
                  cart={cart}
                  setCart={setCart}
                  transactions={transactions}
                  commitSale={commitSale}
                  commitReturn={commitReturn}
                  store={stores.find((s) => s.id === MY_STORE)}
                  onUpdateProfile={(patch) => setStoreProfile((p) => ({ ...p, ...patch }))}
                  settings={settings}
                  setSettings={setSettings}
                  onResetDemoData={resetDemoData}
                  onLockNow={() => setPinUnlocked(false)}
                  onSignOut={() => { setAccount(null); setPinUnlocked(false); setView("shop"); toast("Signed out."); }}
                />
              ) : null}
            </div>
          </div>
        </>
      )}

      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}
