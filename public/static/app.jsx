/* =========================================================================
   SplitRight — single-file React app
   - Auth: Sign in with Google (mocked client-side; replace with real OAuth /
     Capacitor GoogleAuth + Sign in with Apple before App Store submission)
   - Subscription: 7-day free trial → $4.99 / month or $39.99 / year
     (Web demo uses localStorage; on iOS this MUST be wired to StoreKit
     IAP via @capacitor-community/in-app-purchases. Apple requires IAP for
     digital subscriptions — Stripe/credit-card forms are not allowed.)
   - Flow: SignIn → Paywall → Scan → People → Items → Tip & Tax → Summary → Send
   - Account screen (top-right avatar) shows trial status, plan, and "manage"
   - Pre-loaded with dummy receipt data so it's testable instantly
   - All in one file as requested
   ========================================================================= */

const { useState, useMemo, useEffect, useRef, useCallback } = React;

/* ----------------------------- Persistence ------------------------------ */
const STORAGE_KEY = "splitright.v1";

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveState(partial) {
  try {
    const cur = loadState() || {};
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, ...partial }));
  } catch {}
}

/* ----------------------------- Pricing ---------------------------------- */
const PLANS = {
  monthly: { id: "monthly", label: "Monthly",  price: 4.99,  per: "month", trialDays: 7 },
  yearly:  { id: "yearly",  label: "Yearly",   price: 39.99, per: "year",  trialDays: 7, savePct: 33 }
};
const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;

/* ----------------------------- Currencies ------------------------------- */
/* Each currency carries its ISO code, symbol, locale for Intl formatting,
   number of decimals, and the App Store local price tier (roughly
   matching Apple's tier 5 for monthly / tier 39 for yearly). The local
   price is what we display on the paywall; on iOS, StoreKit will deliver
   the exact local price from App Store Connect, so this is just a visual
   approximation. */
const CURRENCIES = {
  USD: { code: "USD", symbol: "$",   name: "US Dollar",        locale: "en-US", decimals: 2, monthly: 4.99,  yearly: 39.99 },
  EUR: { code: "EUR", symbol: "€",   name: "Euro",             locale: "de-DE", decimals: 2, monthly: 4.99,  yearly: 39.99 },
  GBP: { code: "GBP", symbol: "£",   name: "British Pound",    locale: "en-GB", decimals: 2, monthly: 4.49,  yearly: 34.99 },
  JPY: { code: "JPY", symbol: "¥",   name: "Japanese Yen",     locale: "ja-JP", decimals: 0, monthly: 700,   yearly: 5800 },
  CAD: { code: "CAD", symbol: "CA$", name: "Canadian Dollar",  locale: "en-CA", decimals: 2, monthly: 6.99,  yearly: 54.99 },
  AUD: { code: "AUD", symbol: "A$",  name: "Australian Dollar",locale: "en-AU", decimals: 2, monthly: 7.99,  yearly: 64.99 },
  INR: { code: "INR", symbol: "₹",   name: "Indian Rupee",     locale: "en-IN", decimals: 2, monthly: 399,   yearly: 2999 },
  CNY: { code: "CNY", symbol: "¥",   name: "Chinese Yuan",     locale: "zh-CN", decimals: 2, monthly: 35,    yearly: 288 },
  KRW: { code: "KRW", symbol: "₩",   name: "Korean Won",       locale: "ko-KR", decimals: 0, monthly: 6500,  yearly: 52000 },
  BRL: { code: "BRL", symbol: "R$",  name: "Brazilian Real",   locale: "pt-BR", decimals: 2, monthly: 24.90, yearly: 199.90 },
  MXN: { code: "MXN", symbol: "MX$", name: "Mexican Peso",     locale: "es-MX", decimals: 2, monthly: 99,    yearly: 799 },
  CHF: { code: "CHF", symbol: "CHF", name: "Swiss Franc",      locale: "de-CH", decimals: 2, monthly: 4.99,  yearly: 39.99 }
};

/* ----------------------------- Regions ---------------------------------- */
/* Each region maps to a default currency, default tip % (a tip
   convention common to that country — Japan/UK tip very little; the US
   tips 18-20%), default tax/VAT rate, and which payment providers we
   show on the Send screen. Order matches popular first. */
const REGIONS = {
  US: { code: "US", flag: "🇺🇸", name: "United States",   currency: "USD", defaultTip: 0.20, defaultTax: 0.0875, providers: ["venmo", "cashapp", "paypal"] },
  CA: { code: "CA", flag: "🇨🇦", name: "Canada",          currency: "CAD", defaultTip: 0.15, defaultTax: 0.13,   providers: ["paypal"] },
  GB: { code: "GB", flag: "🇬🇧", name: "United Kingdom",  currency: "GBP", defaultTip: 0.125,defaultTax: 0.20,   providers: ["paypal"] },
  IE: { code: "IE", flag: "🇮🇪", name: "Ireland",         currency: "EUR", defaultTip: 0.10, defaultTax: 0.135,  providers: ["paypal"] },
  DE: { code: "DE", flag: "🇩🇪", name: "Germany",         currency: "EUR", defaultTip: 0.10, defaultTax: 0.07,   providers: ["paypal"] },
  FR: { code: "FR", flag: "🇫🇷", name: "France",          currency: "EUR", defaultTip: 0.05, defaultTax: 0.10,   providers: ["paypal"] },
  ES: { code: "ES", flag: "🇪🇸", name: "Spain",           currency: "EUR", defaultTip: 0.05, defaultTax: 0.10,   providers: ["paypal"] },
  IT: { code: "IT", flag: "🇮🇹", name: "Italy",           currency: "EUR", defaultTip: 0.05, defaultTax: 0.10,   providers: ["paypal"] },
  NL: { code: "NL", flag: "🇳🇱", name: "Netherlands",     currency: "EUR", defaultTip: 0.05, defaultTax: 0.09,   providers: ["paypal"] },
  CH: { code: "CH", flag: "🇨🇭", name: "Switzerland",     currency: "CHF", defaultTip: 0.05, defaultTax: 0.077,  providers: ["paypal"] },
  AU: { code: "AU", flag: "🇦🇺", name: "Australia",       currency: "AUD", defaultTip: 0.10, defaultTax: 0.10,   providers: ["paypal"] },
  JP: { code: "JP", flag: "🇯🇵", name: "Japan",           currency: "JPY", defaultTip: 0.00, defaultTax: 0.10,   providers: ["paypal"] },
  KR: { code: "KR", flag: "🇰🇷", name: "South Korea",     currency: "KRW", defaultTip: 0.00, defaultTax: 0.10,   providers: ["paypal"] },
  CN: { code: "CN", flag: "🇨🇳", name: "China",           currency: "CNY", defaultTip: 0.00, defaultTax: 0.06,   providers: ["paypal"] },
  IN: { code: "IN", flag: "🇮🇳", name: "India",           currency: "INR", defaultTip: 0.10, defaultTax: 0.05,   providers: ["paypal"] },
  BR: { code: "BR", flag: "🇧🇷", name: "Brazil",          currency: "BRL", defaultTip: 0.10, defaultTax: 0.10,   providers: ["paypal"] },
  MX: { code: "MX", flag: "🇲🇽", name: "Mexico",          currency: "MXN", defaultTip: 0.10, defaultTax: 0.16,   providers: ["paypal"] }
};

/* Detect a sensible default region. Tries the IANA timezone first
   (most reliable signal of where the phone actually is — survives
   English-language phones being used abroad), then the browser locale,
   then language. Falls back to US so the flow stays identical for
   first-time US users. */
function detectRegion() {
  try {
    // 1) Timezone → country. Covers travelers + English-set phones abroad.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const tzMap = {
      "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US",
      "America/Los_Angeles": "US", "America/Phoenix": "US", "America/Anchorage": "US",
      "Pacific/Honolulu": "US", "America/Detroit": "US", "America/Indianapolis": "US",
      "America/Toronto": "CA", "America/Vancouver": "CA", "America/Montreal": "CA",
      "America/Edmonton": "CA", "America/Halifax": "CA",
      "America/Mexico_City": "MX", "America/Tijuana": "MX",
      "America/Sao_Paulo": "BR", "America/Buenos_Aires": "BR",
      "Europe/London": "GB", "Europe/Dublin": "GB",
      "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES",
      "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Brussels": "NL",
      "Europe/Zurich": "CH", "Europe/Vienna": "DE", "Europe/Lisbon": "BR",
      "Europe/Stockholm": "DE", "Europe/Helsinki": "DE", "Europe/Oslo": "DE",
      "Europe/Copenhagen": "DE", "Europe/Warsaw": "DE", "Europe/Prague": "DE",
      "Asia/Tokyo": "JP", "Asia/Seoul": "KR",
      "Asia/Shanghai": "CN", "Asia/Hong_Kong": "CN", "Asia/Taipei": "CN",
      "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Mumbai": "IN",
      "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU",
      "Australia/Perth": "AU", "Pacific/Auckland": "AU"
    };
    if (tzMap[tz] && REGIONS[tzMap[tz]]) return tzMap[tz];

    // 2) Browser locale (e.g. en-GB, de-CH) → country code.
    const locale = (navigator.languages && navigator.languages[0]) || navigator.language || "en-US";
    const parts = locale.split(/[-_]/);
    const cc = (parts[1] || "").toUpperCase();
    if (REGIONS[cc]) return cc;

    // 3) Language → most likely region.
    const langMap = { en: "US", de: "DE", fr: "FR", es: "ES", it: "IT", nl: "NL", ja: "JP", ko: "KR", zh: "CN", pt: "BR", hi: "IN" };
    const lang = (parts[0] || "en").toLowerCase();
    return langMap[lang] || "US";
  } catch { return "US"; }
}

/* ----------------------------- Dummy data ------------------------------- */
const DUMMY_RECEIPT = {
  restaurant: "The Iron Skillet",
  date: "May 15, 2026 · 7:42 PM",
  items: [
    { id: "i1", name: "Truffle Fries",            price: 9.50 },
    { id: "i2", name: "Caesar Salad",             price: 12.00 },
    { id: "i3", name: "Margherita Pizza",         price: 18.50 },
    { id: "i4", name: "Grilled Salmon",           price: 26.00 },
    { id: "i5", name: "Ribeye Steak (12oz)",      price: 38.00 },
    { id: "i6", name: "Spaghetti Carbonara",      price: 21.00 },
    { id: "i7", name: "House Red Wine — Glass",   price: 11.00 },
    { id: "i8", name: "Sparkling Water",          price: 5.00 },
    { id: "i9", name: "Tiramisu",                 price: 9.00 },
    { id: "i10", name: "Espresso",                price: 4.50 }
  ],
  subtotal: 154.50,
  taxRate: 0.0875 // 8.75%
};

const PRESET_COLORS = [
  "#6366F1", // indigo
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EF4444", // red
  "#EC4899", // pink
  "#06B6D4", // cyan
  "#8B5CF6", // violet
  "#F97316"  // orange
];

/* Sample people for the "Try sample" demo flow. Includes sample contact
   info so the validation on the People screen passes without typing.
   (Real flow starts with 2 empty rows — see handleReviewNext.) */
const STARTER_PEOPLE = [
  { id: "p1", name: "Alex",   color: PRESET_COLORS[0], phone: "+1 555 0101",  email: "alex@example.com"   },
  { id: "p2", name: "Jordan", color: PRESET_COLORS[1], phone: "+1 555 0102",  email: "jordan@example.com" },
  { id: "p3", name: "Sam",    color: PRESET_COLORS[2], phone: "+1 555 0103",  email: "sam@example.com"    },
  { id: "p4", name: "Taylor", color: PRESET_COLORS[3], phone: "+1 555 0104",  email: "taylor@example.com" }
];

/* Pre-assign items so the Summary screen works immediately on first run */
const STARTER_ASSIGNMENTS = {
  i1: ["p1", "p2", "p3", "p4"], // shared fries
  i2: ["p1"],
  i3: ["p2", "p3"],              // shared pizza
  i4: ["p4"],
  i5: ["p1"],
  i6: ["p2"],
  i7: ["p3"],
  i8: ["p1", "p2", "p3", "p4"], // shared water
  i9: ["p4"],
  i10: ["p3"]
};

/* ------------------------------ Helpers --------------------------------- */
/* Money formatter — backed by Intl.NumberFormat for proper grouping,
   correct symbol placement (€1.234,56 vs $1,234.56) and zero-decimal
   currencies like JPY/KRW. The default `fmt` falls back to USD; once the
   <CurrencyProvider> is mounted, components should use `useFmt()` which
   reads the currently selected currency from context. */
function makeFormatter(currencyCode = "USD") {
  const cur = CURRENCIES[currencyCode] || CURRENCIES.USD;
  let nf;
  try {
    nf = new Intl.NumberFormat(cur.locale, {
      style: "currency",
      currency: cur.code,
      minimumFractionDigits: cur.decimals,
      maximumFractionDigits: cur.decimals
    });
  } catch {
    nf = null;
  }
  return (n) => {
    const safe = Number.isFinite(n) ? n : 0;
    if (nf) return nf.format(safe);
    const fixed = safe.toFixed(cur.decimals);
    return `${cur.symbol}${fixed}`;
  };
}
const fmt = makeFormatter("USD"); // default; replaced via CurrencyContext
const CurrencyContext = React.createContext({
  currency: "USD",
  region: "US",
  fmt: fmt,
  setCurrency: () => {},
  setRegion: () => {}
});
const useFmt = () => React.useContext(CurrencyContext).fmt;
const useCurrency = () => React.useContext(CurrencyContext);

const initialsOf = (name) =>
  (name || "?")
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const uid = () => Math.random().toString(36).slice(2, 9);

/* Downscale a File/Blob into a small JPEG data URL so we don't ship a
   10MB photo over the wire. Keeps the long edge at maxDim and re-encodes
   at the given quality. Returns a "data:image/jpeg;base64,..." string. */
async function downscaleImage(file, maxDim = 1280, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

/* Heuristic parser used when we fall back to Tesseract.js client-OCR.
   Walks each line, recognises "$12.34", "12.34", "12,34" at the end of a
   line, and pulls everything before it as the item name. Skips totals /
   tax / tip / subtotal lines. */
function parseReceiptText(text) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const SKIP = /^(sub\s*total|subtotal|total|tax|gst|hst|vat|tip|gratuity|service|charge|change|cash|visa|mastercard|amex|debit|credit|amount|balance|due|paid|thank|approval|auth|order|receipt|table|server|guest|date|time|tender|tendered|invoice|cust)/i;
  const PRICE = /(\d{1,4}[.,]\d{2})\s*$/;

  const items = [];
  let restaurant = null;
  let taxRate = 0.0875;

  // First non-empty line is usually the merchant name
  for (const l of lines.slice(0, 4)) {
    if (l.length >= 3 && !PRICE.test(l) && /[a-z]/i.test(l)) { restaurant = l; break; }
  }

  let subtotal = 0, taxAmt = 0;
  for (const line of lines) {
    const m = line.match(PRICE);
    if (!m) continue;
    const priceStr = m[1].replace(",", ".");
    const price = parseFloat(priceStr);
    if (!Number.isFinite(price) || price <= 0) continue;
    const namePart = line.slice(0, line.length - m[0].length).trim()
      .replace(/^\d+\s*x?\s+/i, "")    // strip leading qty like "2x "
      .replace(/[#@$]+\s*$/, "")
      .replace(/\s{2,}/g, " ");
    if (!namePart) continue;
    if (SKIP.test(namePart)) {
      const lower = namePart.toLowerCase();
      if (/sub\s*total|subtotal/.test(lower)) subtotal = price;
      else if (/tax|gst|hst|vat/.test(lower)) taxAmt = price;
      continue;
    }
    if (price > 500) continue; // sanity: a single line item over $500 is rare
    items.push({ name: namePart.replace(/^\W+/, "").slice(0, 80), price });
  }
  if (subtotal > 0 && taxAmt > 0) taxRate = +(taxAmt / subtotal).toFixed(4);
  return {
    restaurant: restaurant || "Receipt",
    items,
    taxRate: Math.max(0, Math.min(0.2, taxRate))
  };
}

/* Compute per-person totals.
   For each item, divide the price evenly between assigned people.
   Tax is allocated proportionally to each person's subtotal.
   Tip is computed against the pre-tax subtotal and allocated proportionally. */
function computeTotals({ items, assignments, people, taxRate, tipPct }) {
  const personSubtotal = Object.fromEntries(people.map((p) => [p.id, 0]));
  let assignedSubtotal = 0;
  let unassignedSubtotal = 0;

  items.forEach((item) => {
    const assignees = assignments[item.id] || [];
    if (assignees.length === 0) {
      unassignedSubtotal += item.price;
      return;
    }
    const share = item.price / assignees.length;
    assignees.forEach((pid) => {
      if (personSubtotal[pid] !== undefined) personSubtotal[pid] += share;
    });
    assignedSubtotal += item.price;
  });

  const subtotal = assignedSubtotal + unassignedSubtotal;
  const tax = subtotal * taxRate;
  const tip = subtotal * tipPct;
  const grandTotal = subtotal + tax + tip;

  const breakdown = people.map((p) => {
    const sub = personSubtotal[p.id] || 0;
    const ratio = subtotal > 0 ? sub / subtotal : 0;
    const personTax = tax * ratio;
    const personTip = tip * ratio;
    const personTotal = sub + personTax + personTip;
    return {
      person: p,
      subtotal: sub,
      tax: personTax,
      tip: personTip,
      total: personTotal
    };
  });

  return {
    subtotal,
    tax,
    tip,
    grandTotal,
    unassignedSubtotal,
    breakdown
  };
}

/* ------------------------------ UI atoms -------------------------------- */
function Avatar({ person, size = "md" }) {
  const cls = size === "sm" ? "avatar sm" : size === "lg" ? "avatar lg" : "avatar";
  return (
    <span className={cls} style={{ background: person.color }}>
      {initialsOf(person.name)}
    </span>
  );
}

function Header({ title, subtitle, onBack, right }) {
  return (
    <div className="px-5 pt-5 pb-3 flex items-center gap-3">
      {onBack ? (
        <button
          onClick={onBack}
          className="w-10 h-10 rounded-full bg-white border border-slate-200 flex items-center justify-center active:scale-95 transition"
          aria-label="Back"
        >
          <i className="fa-solid fa-chevron-left text-slate-700"></i>
        </button>
      ) : (
        <div className="w-10 h-10" />
      )}
      <div className="flex-1">
        <h1 className="text-[22px] leading-tight font-extrabold tracking-tight text-ink-900">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {right || <div className="w-10 h-10" />}
    </div>
  );
}

function Stepper({ step, total = 4 }) {
  return (
    <div className="flex items-center justify-center gap-2 py-2">
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className={`step-dot transition-all ${i <= step ? "is-on" : ""}`} />
      ))}
    </div>
  );
}

function Toast({ message, onDone }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 1800);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return <div className="toast"><i className="fa-solid fa-check-circle mr-2 text-emerald-400"></i>{message}</div>;
}

/* =========================================================================
   Screen 1 — Splash / Scan Receipt
   Uses the real device camera via <input type="file" capture="environment">.
   Sends the downscaled photo to POST /api/scan-receipt; if the server has
   no OpenAI key (or fails), falls back to Tesseract.js in-browser OCR with
   a real progress bar. Then hands the parsed items off to ReviewItemsScreen.
   ========================================================================= */
function ScanScreen({ onScanned, onUseSample, onSkipManual, user, subscription, onOpenAccount }) {
  const [phase, setPhase] = useState("idle"); // idle | reading | ocr | error
  const [progress, setProgress] = useState(0);
  const [statusLabel, setStatusLabel] = useState("");
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState(null);
  const fileRef = useRef(null);

  const daysLeft = subscription?.status === "trial"
    ? Math.max(0, Math.ceil((subscription.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  const openCamera = () => {
    setError("");
    if (fileRef.current) {
      fileRef.current.value = ""; // allow re-picking the same file
      fileRef.current.click();
    }
  };

  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhase("reading");
    setStatusLabel("Preparing photo…");
    setProgress(5);

    let dataUrl;
    try {
      dataUrl = await downscaleImage(file, 1280, 0.82);
    } catch (err) {
      setPhase("error");
      setError("Couldn't read that photo. Try another shot.");
      return;
    }
    setPreviewUrl(dataUrl);
    setProgress(20);
    setStatusLabel("Reading items with AI…");

    // 1) Try the server endpoint (OpenAI vision)
    try {
      const r = await fetch("/api/scan-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl })
      });
      const data = await r.json();
      if (data?.ok && Array.isArray(data.items) && data.items.length > 0) {
        setProgress(100);
        const items = data.items.map((it) => ({
          id: uid(), name: it.name, price: Number(it.price) || 0
        }));
        onScanned({ restaurant: data.restaurant || "Receipt", items, taxRate: data.taxRate ?? 0.0875 });
        return;
      }
      // 2) Server signaled fall-back to client OCR (or returned no items)
      setStatusLabel("Reading items on device…");
      await runClientOcr(dataUrl);
    } catch (err) {
      setStatusLabel("Reading items on device…");
      await runClientOcr(dataUrl);
    }
  };

  const runClientOcr = async (dataUrl) => {
    setPhase("ocr");
    setProgress(25);
    if (typeof window.Tesseract === "undefined") {
      setPhase("error");
      setError("OCR engine didn't load. Check your connection and try again.");
      return;
    }
    try {
      const res = await window.Tesseract.recognize(dataUrl, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text") {
            setProgress(25 + Math.round(m.progress * 70));
          } else if (m.status) {
            setStatusLabel(m.status[0].toUpperCase() + m.status.slice(1) + "…");
          }
        }
      });
      const text = res?.data?.text || "";
      const parsed = parseReceiptText(text);
      setProgress(100);
      if (parsed.items.length === 0) {
        // OCR ran but found nothing parseable — send empty list, user can add manually
        onScanned({ restaurant: parsed.restaurant, items: [], taxRate: parsed.taxRate, manual: true });
        return;
      }
      const items = parsed.items.map((it) => ({ id: uid(), name: it.name, price: it.price }));
      onScanned({ restaurant: parsed.restaurant, items, taxRate: parsed.taxRate });
    } catch (err) {
      setPhase("error");
      setError("Couldn't read the receipt. Try a clearer photo, or enter items manually.");
    }
  };

  const busy = phase === "reading" || phase === "ocr";

  return (
    <div className="app-shell flex flex-col">
      <div className="px-5 pt-10">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-2xl bg-brand-600 flex items-center justify-center shadow-pop">
            <i className="fa-solid fa-receipt text-white"></i>
          </div>
          <span className="font-extrabold text-lg tracking-tight">SplitRight</span>
          {daysLeft !== null && (
            <span className="ml-1 badge badge-trial">
              <i className="fa-solid fa-gift text-[9px]"></i> Trial · {daysLeft}d left
            </span>
          )}
          <div className="flex-1"></div>
          {user && onOpenAccount && (
            <button
              onClick={onOpenAccount}
              className="w-10 h-10 rounded-full bg-white border border-slate-200 flex items-center justify-center active:scale-95"
              aria-label="Account"
            >
              <span className="avatar sm" style={{ background: "#6366F1" }}>{initialsOf(user.name)}</span>
            </button>
          )}
        </div>

        <h1 className="mt-10 text-4xl font-black leading-[1.05] tracking-tight">
          Split the bill,<br/>
          <span className="text-brand-600">the right way.</span>
        </h1>
        <p className="mt-3 text-slate-500 text-base">
          Snap a photo of the receipt. We'll read the items, then you tap who ordered what.
        </p>
      </div>

      <div className="px-5 mt-8">
        <div className="card p-4">
          <div className="relative rounded-2xl overflow-hidden bg-slate-900 aspect-[4/5]">
            {previewUrl ? (
              <img src={previewUrl} alt="Your receipt" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="absolute inset-4 bg-white rounded-xl p-4 text-[11px] leading-relaxed text-slate-700 shadow-xl font-mono">
                <div className="text-center font-bold tracking-widest">YOUR RECEIPT</div>
                <div className="text-center text-slate-400">Tap "Scan receipt" to snap a photo</div>
                <div className="border-t border-dashed my-2"></div>
                <div className="flex justify-between text-slate-300"><span>Item</span><span>$0.00</span></div>
                <div className="flex justify-between text-slate-300"><span>Item</span><span>$0.00</span></div>
                <div className="flex justify-between text-slate-300"><span>Item</span><span>$0.00</span></div>
              </div>
            )}

            {/* Frame corners */}
            <div className="absolute inset-3 pointer-events-none">
              <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-white/80 rounded-tl-lg"></span>
              <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-white/80 rounded-tr-lg"></span>
              <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-white/80 rounded-bl-lg"></span>
              <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-white/80 rounded-br-lg"></span>
            </div>

            {busy && <div className="scanline"></div>}

            {busy && (
              <div className="absolute left-3 right-3 bottom-3">
                <div className="bg-black/55 backdrop-blur rounded-xl px-3 py-2.5 text-white">
                  <div className="flex items-center justify-between text-[12px] font-semibold">
                    <span>{statusLabel}</span>
                    <span className="tabular-nums">{progress}%</span>
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-white/20 overflow-hidden">
                    <div className="h-full bg-white" style={{ width: `${progress}%`, transition: "width 200ms ease" }} />
                  </div>
                </div>
              </div>
            )}

            {!busy && !previewUrl && (
              <div className="absolute bottom-3 left-0 right-0 text-center text-white/90 text-xs font-semibold">
                Align receipt within the frame
              </div>
            )}
          </div>

          {error && (
            <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
              <i className="fa-solid fa-triangle-exclamation mr-1.5"></i>{error}
            </div>
          )}
        </div>
      </div>

      <div className="px-5 mt-6 grid grid-cols-3 gap-3">
        <Feature icon="fa-camera"      label="Real scan" />
        <Feature icon="fa-users"       label="Fair split" />
        <Feature icon="fa-paper-plane" label="One-tap pay" />
      </div>

      <div className="flex-1"></div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPickFile}
        className="hidden"
      />

      <div className="action-bar">
        <button className="btn-primary" onClick={openCamera} disabled={busy}>
          {busy ? (
            <span><i className="fa-solid fa-circle-notch fa-spin mr-2"></i> Reading receipt…</span>
          ) : (
            <span><i className="fa-solid fa-camera mr-2"></i> Scan receipt</span>
          )}
        </button>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button className="btn-ghost text-center" onClick={onSkipManual} disabled={busy}>
            Enter manually
          </button>
          <button className="btn-ghost text-center" onClick={onUseSample} disabled={busy}>
            Try sample →
          </button>
        </div>
      </div>
    </div>
  );
}

function Feature({ icon, label }) {
  return (
    <div className="card p-3 flex flex-col items-center gap-1.5">
      <div className="w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
        <i className={`fa-solid ${icon}`}></i>
      </div>
      <span className="text-xs font-semibold text-slate-700">{label}</span>
    </div>
  );
}

/* =========================================================================
   Screen 1b — Review scanned items (or enter them by hand)
   Shows the items we extracted from the photo (or an empty list for manual
   entry). Every row is editable; user can fix names, prices, add or
   remove lines, and rename the restaurant before moving on.
   ========================================================================= */
function ReviewItemsScreen({ initial, source, onBack, onNext }) {
  const fmt = useFmt();
  const [restaurant, setRestaurant] = useState(initial?.restaurant || "Receipt");
  const [items, setItems] = useState(
    (initial?.items && initial.items.length > 0)
      ? initial.items.map((it) => ({ id: it.id || uid(), name: it.name, price: Number(it.price) || 0 }))
      : []
  );

  const subtotal = items.reduce((s, i) => s + (Number(i.price) || 0), 0);

  const updateItem = (id, patch) =>
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const removeItem = (id) => setItems((cur) => cur.filter((it) => it.id !== id));
  const addItem = () =>
    setItems((cur) => [...cur, { id: uid(), name: "", price: 0 }]);

  const ready = items.length > 0 && items.every((it) => it.name.trim() && Number(it.price) > 0);

  const headline =
    source === "ai"     ? "We found these items" :
    source === "ocr"    ? "We read these from the photo" :
    source === "manual" ? "Add your items" :
                          "Review the items";
  const subhead =
    source === "ai"     ? "Tap any row to fix it. Add or remove anything that's wrong." :
    source === "ocr"    ? "OCR isn't perfect — double-check names and prices, then continue." :
    source === "manual" ? "Type each item from the receipt. Tap Add when you're done." :
                          "Make sure everything looks right before you split.";

  return (
    <div className="app-shell flex flex-col">
      <Header title={headline} subtitle={subhead} onBack={onBack} />

      <div className="px-5">
        <div className="card p-4">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Restaurant</label>
          <input
            value={restaurant}
            onChange={(e) => setRestaurant(e.target.value)}
            placeholder="Restaurant name"
            className="mt-1 w-full bg-slate-100 rounded-xl px-4 py-3 text-base font-semibold outline-none focus:ring-2 focus:ring-brand-500/40"
          />
        </div>
      </div>

      <div className="px-5 mt-4 mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">
          Items
        </h2>
        <span className="text-xs text-slate-400">{items.length} · {fmt(subtotal)}</span>
      </div>

      <div className="px-5 space-y-2">
        {items.length === 0 && (
          <div className="card p-5 text-center text-slate-500 text-sm">
            No items yet. Tap <b className="text-ink-900">Add item</b> to enter the first one.
          </div>
        )}
        {items.map((it) => (
          <div key={it.id} className="card p-3">
            <div className="flex items-center gap-2">
              <input
                value={it.name}
                onChange={(e) => updateItem(it.id, { name: e.target.value })}
                placeholder="Item name"
                className="flex-1 bg-slate-50 rounded-xl px-3 py-2.5 text-sm font-semibold outline-none focus:ring-2 focus:ring-brand-500/40"
              />
              <div className="relative w-24">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={Number.isFinite(it.price) ? it.price : ""}
                  onChange={(e) => updateItem(it.id, { price: parseFloat(e.target.value) || 0 })}
                  placeholder="0.00"
                  className="w-full bg-slate-50 rounded-xl pl-6 pr-2 py-2.5 text-sm font-bold text-right outline-none focus:ring-2 focus:ring-brand-500/40 tabular-nums"
                />
              </div>
              <button
                onClick={() => removeItem(it.id)}
                className="w-9 h-9 rounded-xl bg-slate-50 text-slate-400 active:scale-95 hover:text-red-500"
                aria-label="Remove item"
              >
                <i className="fa-solid fa-trash text-sm"></i>
              </button>
            </div>
          </div>
        ))}

        <button onClick={addItem} className="w-full mt-1 btn-secondary">
          <i className="fa-solid fa-plus mr-2"></i> Add item
        </button>
      </div>

      <div className="flex-1"></div>

      <div className="action-bar">
        <button className="btn-primary" onClick={() => onNext({ restaurant: restaurant.trim() || "Receipt", items })} disabled={!ready}>
          Continue <i className="fa-solid fa-arrow-right ml-2"></i>
        </button>
        {!ready && (
          <p className="mt-2 text-center text-xs text-slate-500">
            Add at least one item with a name and a price.
          </p>
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   Screen 2 — People at the table
   ========================================================================= */
/* "How many people?" — big stepper at the top auto-generates N rows. Each
   row asks for a Name + Phone OR Email. Continue is disabled until every
   row is complete (a name AND at least one valid contact method). This is
   the "1-tap" centerpiece: pick a number, type the names, done. */
function PeopleScreen({ people, setPeople, onBack, onNext }) {
  // hasContact: requires at least 2 phone digits OR an email containing "@"
  const isPhoneOk = (s) => !!s && (s.match(/\d/g) || []).length >= 2;
  const isEmailOk = (s) => !!s && s.includes("@") && s.includes(".");
  const hasContact = (p) => isPhoneOk(p.phone) || isEmailOk(p.email);
  const isPersonComplete = (p) => !!p.name.trim() && hasContact(p);

  // Resize the list to N rows, keeping existing data when shrinking/growing.
  const setCount = (n) => {
    const target = Math.max(1, Math.min(20, n));
    if (target === people.length) return;
    if (target < people.length) {
      setPeople(people.slice(0, target));
    } else {
      const add = [];
      for (let i = people.length; i < target; i++) {
        add.push({
          id: uid(),
          name: "",
          color: PRESET_COLORS[i % PRESET_COLORS.length],
          phone: "",
          email: ""
        });
      }
      setPeople([...people, ...add]);
    }
  };

  const updateField = (id, field, value) =>
    setPeople(people.map((p) => (p.id === id ? { ...p, [field]: value } : p)));

  const updateColor = (id, newColor) =>
    setPeople(people.map((p) => (p.id === id ? { ...p, color: newColor } : p)));

  const allComplete = people.length >= 2 && people.every(isPersonComplete);
  const completeCount = people.filter(isPersonComplete).length;

  return (
    <div className="app-shell flex flex-col">
      <Header
        title="Who's at the table?"
        subtitle="Pick a number, add their names + phone or email."
        onBack={onBack}
      />
      <Stepper step={0} />

      {/* Big number stepper — "How many people?" */}
      <div className="px-5 mt-2">
        <div className="card p-5">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide text-center">
            How many people?
          </div>
          <div className="mt-3 flex items-center justify-center gap-4">
            <button
              onClick={() => setCount(people.length - 1)}
              disabled={people.length <= 1}
              className="w-14 h-14 rounded-2xl bg-slate-100 text-2xl font-bold text-ink-900 active:scale-95 disabled:opacity-40"
              aria-label="One less person"
            >
              <i className="fa-solid fa-minus"></i>
            </button>
            <div className="w-20 text-center">
              <div className="text-5xl font-black text-ink-900 leading-none">{people.length}</div>
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mt-1">
                {people.length === 1 ? "person" : "people"}
              </div>
            </div>
            <button
              onClick={() => setCount(people.length + 1)}
              disabled={people.length >= 20}
              className="w-14 h-14 rounded-2xl bg-brand-600 text-white text-2xl font-bold active:scale-95 disabled:opacity-40 shadow-pop"
              aria-label="One more person"
            >
              <i className="fa-solid fa-plus"></i>
            </button>
          </div>
          {/* quick-pick chips for common group sizes */}
          <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
            {[2, 3, 4, 5, 6, 8].map((n) => (
              <button
                key={n}
                onClick={() => setCount(n)}
                className={`px-3 py-1.5 rounded-full text-sm font-bold transition ${
                  people.length === n
                    ? "bg-brand-600 text-white"
                    : "bg-slate-100 text-slate-600 active:scale-95"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Progress indicator: X of N completed */}
      <div className="px-5 mt-4 mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">
          Their info
        </h2>
        <span className={`text-xs font-bold ${allComplete ? "text-emerald-600" : "text-slate-400"}`}>
          {completeCount} / {people.length} done
        </span>
      </div>

      <div className="px-5 space-y-2">
        {people.map((p, idx) => {
          const phoneOk = isPhoneOk(p.phone);
          const emailOk = isEmailOk(p.email);
          const personOk = isPersonComplete(p);
          return (
            <div
              key={p.id}
              className={`card p-3 transition ${personOk ? "" : "ring-1 ring-slate-100"}`}
            >
              <div className="flex items-center gap-3">
                <Avatar person={{ ...p, name: p.name || `?${idx + 1}` }} size="lg" />
                <input
                  value={p.name}
                  onChange={(e) => updateField(p.id, "name", e.target.value)}
                  placeholder={`Person ${idx + 1} name`}
                  autoCapitalize="words"
                  autoComplete="off"
                  className="flex-1 min-w-0 bg-slate-100 rounded-xl px-3 py-2.5 text-base font-semibold outline-none focus:ring-2 focus:ring-brand-500/40"
                />
                {personOk && (
                  <span
                    className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center"
                    aria-label="Complete"
                  >
                    <i className="fa-solid fa-check"></i>
                  </span>
                )}
              </div>

              {/* Color tag picker (small) */}
              <div className="mt-2 flex items-center gap-1.5 flex-wrap pl-[52px]">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => updateColor(p.id, c)}
                    className={`w-4 h-4 rounded-full transition ${p.color === c ? "ring-2 ring-offset-1 ring-ink-900" : "opacity-50"}`}
                    style={{ background: c }}
                    aria-label={`Set color ${c}`}
                  />
                ))}
              </div>

              {/* Phone + Email — at least ONE required to continue */}
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-2">
                  <i className={`fa-solid fa-phone text-sm w-5 text-center ${phoneOk ? "text-emerald-500" : "text-slate-400"}`}></i>
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={p.phone || ""}
                    onChange={(e) => updateField(p.id, "phone", e.target.value)}
                    placeholder="Phone (+1 555 123 4567)"
                    className="flex-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-brand-500/40"
                  />
                </div>
                <div className="text-center text-[10px] font-bold text-slate-400 tracking-wider">
                  — OR —
                </div>
                <div className="flex items-center gap-2">
                  <i className={`fa-solid fa-envelope text-sm w-5 text-center ${emailOk ? "text-emerald-500" : "text-slate-400"}`}></i>
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={p.email || ""}
                    onChange={(e) => updateField(p.id, "email", e.target.value)}
                    placeholder="Email (alex@gmail.com)"
                    className="flex-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-brand-500/40"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-5 mt-3">
        <p className="text-[11px] text-slate-500 text-center">
          <i className="fa-solid fa-circle-info mr-1"></i>
          We use this to send each person their share by text or email. They don't need to download anything.
        </p>
      </div>

      <div className="flex-1 min-h-[120px]"></div>

      <div className="action-bar">
        <button
          className="btn-primary"
          onClick={onNext}
          disabled={!allComplete}
        >
          {allComplete ? (
            <>
              Continue with {people.length} {people.length === 1 ? "person" : "people"}
              <i className="fa-solid fa-arrow-right ml-2"></i>
            </>
          ) : (
            <>
              Add a name + phone or email for everyone
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   Screen 3 — Receipt Items: assign to one or more people
   ========================================================================= */
function ItemsScreen({ items, setItems, people, assignments, setAssignments, restaurant, onBack, onNext }) {
  const fmt = useFmt();
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");

  const toggleAssign = (itemId, personId) => {
    const current = assignments[itemId] || [];
    const next = current.includes(personId)
      ? current.filter((id) => id !== personId)
      : [...current, personId];
    setAssignments({ ...assignments, [itemId]: next });
  };

  const assignAll = (itemId) => {
    setAssignments({ ...assignments, [itemId]: people.map((p) => p.id) });
  };

  const removeItem = (itemId) => {
    setItems(items.filter((i) => i.id !== itemId));
    const next = { ...assignments };
    delete next[itemId];
    setAssignments(next);
  };

  const addItem = () => {
    const name = newName.trim();
    const price = parseFloat(newPrice);
    if (!name || isNaN(price) || price <= 0) return;
    const id = uid();
    setItems([...items, { id, name, price }]);
    setAssignments({ ...assignments, [id]: [] });
    setNewName("");
    setNewPrice("");
    setShowAdd(false);
  };

  const allAssigned = items.every((i) => (assignments[i.id] || []).length > 0);
  const unassignedCount = items.filter((i) => (assignments[i.id] || []).length === 0).length;

  return (
    <div className="app-shell flex flex-col">
      <Header
        title="Assign items"
        subtitle="Tap people who shared each item."
        onBack={onBack}
        right={
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="w-10 h-10 rounded-full bg-white border border-slate-200 flex items-center justify-center active:scale-95"
            aria-label="Add item"
          >
            <i className="fa-solid fa-plus text-slate-700"></i>
          </button>
        }
      />
      <Stepper step={1} />

      {showAdd && (
        <div className="px-5 mb-2">
          <div className="card p-3 flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Item name"
              className="flex-1 bg-slate-100 rounded-xl px-3 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-brand-500/40"
            />
            <input
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              inputMode="decimal"
              type="number"
              step="0.01"
              placeholder="0.00"
              className="w-24 bg-slate-100 rounded-xl px-3 py-2.5 text-sm font-semibold outline-none focus:ring-2 focus:ring-brand-500/40 text-right"
            />
            <button onClick={addItem} className="px-3 py-2.5 rounded-xl bg-brand-600 text-white font-bold text-sm">
              Add
            </button>
          </div>
        </div>
      )}

      <div className="px-5 mt-1 mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">
          {restaurant || DUMMY_RECEIPT.restaurant}
        </h2>
        <span className="text-xs text-slate-400">{items.length} items</span>
      </div>

      <div className="px-5 space-y-2">
        {items.map((item) => {
          const assigned = assignments[item.id] || [];
          const sharedPrice = assigned.length > 0 ? item.price / assigned.length : item.price;
          return (
            <div key={item.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-ink-900 leading-tight">{item.name}</div>
                  <div className="text-sm text-slate-500 mt-0.5">
                    {fmt(item.price)}
                    {assigned.length > 1 && (
                      <span className="ml-2 text-brand-600 font-semibold">
                        · {fmt(sharedPrice)}/person
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => removeItem(item.id)}
                  className="w-8 h-8 rounded-lg text-slate-400 active:scale-95"
                  aria-label="Remove item"
                >
                  <i className="fa-solid fa-xmark"></i>
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {people.map((p) => {
                  const on = assigned.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => toggleAssign(item.id, p.id)}
                      className={`assign-pill ${on ? "is-on" : ""}`}
                      style={on ? { background: p.color } : {}}
                    >
                      <Avatar person={p} size="sm" />
                      <span>{p.name}</span>
                      {on && <i className="fa-solid fa-check text-[10px]"></i>}
                    </button>
                  );
                })}
                <button
                  onClick={() => assignAll(item.id)}
                  className="assign-pill"
                  title="Everyone shared"
                >
                  <i className="fa-solid fa-users text-[11px]"></i>
                  Everyone
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex-1"></div>

      {!allAssigned && (
        <div className="px-5 mt-3">
          <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-xl text-sm font-semibold">
            <i className="fa-solid fa-triangle-exclamation"></i>
            {unassignedCount} item{unassignedCount > 1 ? "s" : ""} unassigned — they'll be split evenly.
          </div>
        </div>
      )}

      <div className="action-bar">
        <button className="btn-primary" onClick={onNext}>
          Next: Tip &amp; Tax
          <i className="fa-solid fa-arrow-right ml-2"></i>
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   Screen 4 — Tip selector + Tax
   ========================================================================= */
function TipScreen({ tipPct, setTipPct, taxRate, setTaxRate, subtotalPreview, onBack, onNext }) {
  const fmt = useFmt();
  const presets = [0.10, 0.15, 0.20];
  const isCustom = !presets.includes(tipPct);
  const [customInput, setCustomInput] = useState(
    isCustom ? String(Math.round(tipPct * 100)) : ""
  );

  const setPreset = (pct) => {
    setTipPct(pct);
    setCustomInput("");
  };

  const setCustom = (val) => {
    setCustomInput(val);
    const n = parseFloat(val);
    if (!isNaN(n) && n >= 0) setTipPct(n / 100);
  };

  const tipAmount = subtotalPreview * tipPct;
  const taxAmount = subtotalPreview * taxRate;

  return (
    <div className="app-shell flex flex-col">
      <Header title="Tip & tax" subtitle="Adjust if your receipt's different." onBack={onBack} />
      <Stepper step={2} />

      <div className="px-5 mt-2 space-y-4">
        <div className="card p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold text-ink-900">Tip</h2>
            <span className="text-brand-600 font-bold">{Math.round(tipPct * 100)}%</span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {presets.map((p) => (
              <button
                key={p}
                onClick={() => setPreset(p)}
                className={`tip-option ${!isCustom && tipPct === p ? "is-on" : ""}`}
              >
                <div className="text-lg">{Math.round(p * 100)}%</div>
                <div className="text-[11px] text-slate-500 font-medium">{fmt(subtotalPreview * p)}</div>
              </button>
            ))}
            <div className={`tip-option ${isCustom ? "is-on" : ""} flex flex-col justify-center`}>
              <div className="flex items-center justify-center">
                <input
                  value={customInput}
                  onChange={(e) => setCustom(e.target.value)}
                  inputMode="numeric"
                  type="number"
                  placeholder="—"
                  className="w-10 bg-transparent text-center text-lg font-bold outline-none"
                />
                <span className="text-lg font-bold">%</span>
              </div>
              <div className="text-[11px] text-slate-500 font-medium">Custom</div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-slate-500">Tip amount</span>
            <span className="font-semibold">{fmt(tipAmount)}</span>
          </div>
        </div>

        <div className="card p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold text-ink-900">Tax</h2>
            <span className="text-brand-600 font-bold">{(taxRate * 100).toFixed(2)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="15"
            step="0.25"
            value={taxRate * 100}
            onChange={(e) => setTaxRate(parseFloat(e.target.value) / 100)}
            className="w-full mt-3 accent-brand-600"
          />
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-slate-500">Tax amount</span>
            <span className="font-semibold">{fmt(taxAmount)}</span>
          </div>
        </div>

        <div className="card p-5">
          <Row label="Subtotal" value={fmt(subtotalPreview)} />
          <Row label="Tax" value={fmt(taxAmount)} />
          <Row label="Tip" value={fmt(tipAmount)} />
          <div className="border-t border-slate-100 my-2"></div>
          <Row label="Total" value={fmt(subtotalPreview + taxAmount + tipAmount)} bold />
        </div>
      </div>

      <div className="flex-1"></div>

      <div className="action-bar">
        <button className="btn-primary" onClick={onNext}>
          See the split
          <i className="fa-solid fa-arrow-right ml-2"></i>
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, bold }) {
  return (
    <div className={`flex items-center justify-between py-1.5 ${bold ? "text-base" : "text-sm"}`}>
      <span className={bold ? "font-bold" : "text-slate-500"}>{label}</span>
      <span className={bold ? "font-extrabold" : "font-semibold"}>{value}</span>
    </div>
  );
}

/* =========================================================================
   Screen 5 — Summary + Send (combined for 1-tap experience)
   Each person's card has inline SMS / Email / PayPal buttons. The
   recipient doesn't need the app — sms: / mailto: deep links open
   their native messaging app with the breakdown pre-filled.
   ========================================================================= */
function SummaryScreen({ totals, people, restaurant, onBack, onDone, showToast }) {
  const fmt = useFmt();
  const [expanded, setExpanded] = useState(null);
  const [yourPaypal, setYourPaypal] = useState("");
  const [copiedId, setCopiedId] = useState(null);

  const messageFor = (b) => {
    const lines = [
      `Hey ${b.person.name}! 👋`,
      `Your share of ${restaurant} is ${fmt(b.total)}.`,
      `(Items ${fmt(b.subtotal)} + Tax ${fmt(b.tax)} + Tip ${fmt(b.tip)})`
    ];
    if (yourPaypal.trim()) {
      lines.push(`Send to paypal.me/${yourPaypal.trim().replace(/^@/, "")}. Thanks!`);
    } else {
      lines.push(`Thanks!`);
    }
    lines.push(`— Split with SplitRight`);
    return lines.join("\n");
  };

  const smsLinkFor = (b) => {
    if (!b.person.phone) return null;
    const phone = b.person.phone.replace(/[^\d+]/g, "");
    if (!phone) return null;
    return `sms:${phone}?&body=${encodeURIComponent(messageFor(b))}`;
  };
  const emailLinkFor = (b) => {
    if (!b.person.email || !b.person.email.includes("@")) return null;
    return `mailto:${b.person.email.trim()}?subject=${encodeURIComponent(
      `Your share of ${restaurant}`
    )}&body=${encodeURIComponent(messageFor(b))}`;
  };
  const paypalLinkFor = (b) => {
    const handle = yourPaypal.trim().replace(/^@/, "");
    if (!handle) return null;
    return `https://paypal.me/${encodeURIComponent(handle)}/${b.total.toFixed(2)}`;
  };

  const copyMessage = async (b) => {
    try {
      await navigator.clipboard.writeText(messageFor(b));
      setCopiedId(b.person.id);
      showToast(`Copied ${b.person.name}'s message`);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      showToast("Couldn't copy");
    }
  };

  return (
    <div className="app-shell flex flex-col">
      <Header title="The split" subtitle={restaurant} onBack={onBack} />
      <Stepper step={3} />

      <div className="px-5 mt-2">
        <div className="card p-5 bg-gradient-to-br from-brand-600 to-brand-700 text-white">
          <div className="flex items-center justify-between">
            <span className="text-white/80 text-sm font-semibold uppercase tracking-wider">Grand total</span>
            <i className="fa-solid fa-wallet text-white/70"></i>
          </div>
          <div className="text-4xl font-black mt-1 tracking-tight">{fmt(totals.grandTotal)}</div>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-white/80">Subtotal {fmt(totals.subtotal)}</span>
            <span className="text-white/80">Tax {fmt(totals.tax)}</span>
            <span className="text-white/80">Tip {fmt(totals.tip)}</span>
          </div>
        </div>
      </div>

      {/* Optional PayPal handle for the user (so a paypal.me link can be built) */}
      <div className="px-5 mt-3">
        <div className="card p-3 flex items-center gap-2">
          <i className="fa-brands fa-paypal text-[#003087] text-lg w-6 text-center"></i>
          <input
            value={yourPaypal}
            onChange={(e) => setYourPaypal(e.target.value)}
            placeholder="Your PayPal handle (optional)"
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 bg-slate-50 rounded-lg px-3 py-2 text-sm font-medium outline-none focus:ring-2 focus:ring-brand-500/40"
          />
        </div>
      </div>

      <div className="px-5 mt-4 mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Per person</h2>
        <span className="text-xs text-slate-400">{people.length} people · tap to send</span>
      </div>

      <div className="px-5 space-y-2">
        {totals.breakdown.map((b) => {
          const open = expanded === b.person.id;
          const sms = smsLinkFor(b);
          const email = emailLinkFor(b);
          const paypal = paypalLinkFor(b);
          return (
            <div key={b.person.id} className="card overflow-hidden">
              <button
                onClick={() => setExpanded(open ? null : b.person.id)}
                className="w-full p-4 flex items-center gap-3 text-left active:bg-slate-50"
              >
                <Avatar person={b.person} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-ink-900">{b.person.name}</div>
                  <div className="text-xs text-slate-500">
                    Items {fmt(b.subtotal)} · Tax {fmt(b.tax)} · Tip {fmt(b.tip)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-extrabold">{fmt(b.total)}</div>
                  <div className="text-[11px] text-slate-400 uppercase tracking-wider">owes</div>
                </div>
                <i className={`fa-solid fa-chevron-${open ? "up" : "down"} text-slate-400 ml-1`}></i>
              </button>
              {open && (
                <div className="px-4 pb-4 -mt-1 space-y-3">
                  {/* Send actions — one-tap, recipient doesn't need the app */}
                  <div className="grid grid-cols-3 gap-2">
                    {sms ? (
                      <a
                        href={sms}
                        className="px-2 py-2.5 rounded-xl text-white text-xs font-bold text-center active:scale-95 flex items-center justify-center gap-1.5"
                        style={{ background: "#34C759" }}
                      >
                        <i className="fa-solid fa-comment-sms"></i> Text
                      </a>
                    ) : (
                      <button
                        disabled
                        className="px-2 py-2.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-400 cursor-not-allowed flex items-center justify-center gap-1.5"
                      >
                        <i className="fa-solid fa-comment-sms"></i> No phone
                      </button>
                    )}
                    {email ? (
                      <a
                        href={email}
                        className="px-2 py-2.5 rounded-xl text-white text-xs font-bold text-center active:scale-95 flex items-center justify-center gap-1.5"
                        style={{ background: "#0A84FF" }}
                      >
                        <i className="fa-solid fa-envelope"></i> Email
                      </a>
                    ) : (
                      <button
                        disabled
                        className="px-2 py-2.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-400 cursor-not-allowed flex items-center justify-center gap-1.5"
                      >
                        <i className="fa-solid fa-envelope"></i> No email
                      </button>
                    )}
                    {paypal ? (
                      <a
                        href={paypal}
                        target="_blank"
                        rel="noreferrer"
                        className="px-2 py-2.5 rounded-xl text-white text-xs font-bold text-center active:scale-95 flex items-center justify-center gap-1.5"
                        style={{ background: "#003087" }}
                      >
                        <i className="fa-brands fa-paypal"></i> PayPal
                      </a>
                    ) : (
                      <button
                        disabled
                        onClick={() => showToast("Add your PayPal handle above")}
                        className="px-2 py-2.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-400 flex items-center justify-center gap-1.5"
                      >
                        <i className="fa-brands fa-paypal"></i> PayPal
                      </button>
                    )}
                  </div>

                  <div className="bg-slate-50 rounded-xl p-3">
                    <Row label="Items subtotal" value={fmt(b.subtotal)} />
                    <Row label="Tax share"      value={fmt(b.tax)} />
                    <Row label="Tip share"      value={fmt(b.tip)} />
                    <div className="border-t border-slate-200 my-2"></div>
                    <Row label="Total"          value={fmt(b.total)} bold />
                  </div>

                  <button
                    onClick={() => copyMessage(b)}
                    className="w-full btn-secondary"
                  >
                    <i className={`fa-regular ${copiedId === b.person.id ? "fa-circle-check text-emerald-600" : "fa-copy"} mr-2`}></i>
                    {copiedId === b.person.id ? "Copied!" : "Copy message"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-1 min-h-[80px]"></div>

      <div className="action-bar">
        <button className="btn-primary" onClick={onDone}>
          <i className="fa-solid fa-check mr-2"></i> Done
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   Screen 6 — Send: per-person payment message + Venmo/Cash/PayPal links
   ========================================================================= */
function SendScreen({ totals, restaurant, onBack, onDone, showToast }) {
  const fmt = useFmt();
  const { region } = useCurrency();
  const regionInfo = REGIONS[region] || REGIONS.US;
  // Region-aware provider list. Venmo + Cash App are US-only and currently
  // disabled across all regions ("Coming soon"); PayPal is enabled
  // everywhere we ship.
  const allProviders = [
    { id: "venmo",   label: "Venmo",    icon: "fa-v",           color: "#3D95CE", disabled: true,  note: "Coming soon" },
    { id: "cashapp", label: "Cash App", icon: "fa-dollar-sign", color: "#00D632", disabled: true,  note: "Coming soon" },
    { id: "paypal",  label: "PayPal",   icon: "fa-paypal",      color: "#003087", disabled: false }
  ];
  const providers = allProviders.filter((p) => regionInfo.providers.includes(p.id));

  const [yourHandle, setYourHandle] = useState("@you");
  const [provider, setProvider] = useState(() => providers.find((p) => !p.disabled)?.id || providers[0]?.id || "paypal");
  const [copied, setCopied] = useState(null);

  const messageFor = (b) =>
    `Hey ${b.person.name}! 👋\n` +
    `Your share of ${restaurant} comes to ${fmt(b.total)}.\n` +
    `(Items ${fmt(b.subtotal)} + Tax ${fmt(b.tax)} + Tip ${fmt(b.tip)})\n` +
    `Please send to ${yourHandle} on ${providers.find((p) => p.id === provider).label}. Thanks!\n` +
    `— Split with SplitRight`;

  /* Build a deep link that opens the chosen app pre-filled with the amount.
     Currently only PayPal is enabled — Venmo and Cash App are stubbed out. */
  const linkFor = (b) => {
    const amount = b.total.toFixed(2);
    const handle = encodeURIComponent(yourHandle.replace(/^@/, ""));
    if (provider === "paypal") {
      return `https://paypal.me/${handle}/${amount}`;
    }
    return "#"; // venmo / cashapp disabled
  };

  /* Per-person SMS / Email deep links.
     The recipient does NOT need the app installed — these open their
     native SMS app or mail client, with the breakdown pre-filled. */
  const smsLinkFor = (b) => {
    if (!b.person.phone) return null;
    const phone = b.person.phone.replace(/[^\d+]/g, "");
    if (!phone) return null;
    const body = encodeURIComponent(messageFor(b));
    return `sms:${phone}?&body=${body}`;
  };
  const emailLinkFor = (b) => {
    if (!b.person.email) return null;
    const email = b.person.email.trim();
    if (!email.includes("@")) return null;
    const subject = encodeURIComponent(`Your share of ${restaurant}`);
    const body = encodeURIComponent(messageFor(b));
    return `mailto:${email}?subject=${subject}&body=${body}`;
  };

  const currentProvider = providers.find((p) => p.id === provider);
  const providerDisabled = !!currentProvider?.disabled;

  const copyMessage = async (b) => {
    const text = messageFor(b);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(b.person.id);
      showToast(`Copied ${b.person.name}'s message`);
      setTimeout(() => setCopied(null), 1500);
    } catch (e) {
      showToast("Couldn't copy — long-press to select");
    }
  };

  const copyAll = async () => {
    const all = totals.breakdown.map(messageFor).join("\n\n———\n\n");
    try {
      await navigator.clipboard.writeText(all);
      showToast("Copied all messages");
    } catch {
      showToast("Couldn't copy");
    }
  };

  const shareNative = async (b) => {
    const text = messageFor(b);
    if (navigator.share) {
      try {
        await navigator.share({ title: `Payment request for ${b.person.name}`, text });
      } catch { /* user canceled */ }
    } else {
      copyMessage(b);
    }
  };

  return (
    <div className="app-shell flex flex-col">
      <Header title="Send requests" subtitle="Text or email each person — they don't need the app." onBack={onBack} />

      <div className="px-5 mt-2">
        <div className="card p-4">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Your handle</label>
          <input
            value={yourHandle}
            onChange={(e) => setYourHandle(e.target.value)}
            placeholder="@your-handle"
            className="mt-1 w-full bg-slate-100 rounded-xl px-4 py-3 text-base font-semibold outline-none focus:ring-2 focus:ring-brand-500/40"
          />

          <div className={`mt-3 grid gap-2 ${providers.length >= 3 ? "grid-cols-3" : providers.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
            {providers.map((p) => {
              const isOn = provider === p.id;
              const handleClick = () => {
                if (p.disabled) {
                  showToast(`${p.label} is coming soon`);
                  return;
                }
                setProvider(p.id);
              };
              return (
                <button
                  key={p.id}
                  onClick={handleClick}
                  aria-disabled={p.disabled || undefined}
                  className={`tip-option ${isOn ? "is-on" : ""} ${p.disabled ? "opacity-50" : ""} relative`}
                >
                  <div
                    className="w-8 h-8 rounded-lg mx-auto flex items-center justify-center text-white text-sm"
                    style={{ background: p.color }}
                  >
                    <i className={`fa-solid ${p.icon}`}></i>
                  </div>
                  <div className="text-xs mt-1">{p.label}</div>
                  {p.disabled && (
                    <div className="text-[10px] mt-0.5 font-semibold text-slate-400 uppercase tracking-wide">
                      Soon
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          {providerDisabled && (
            <div className="mt-3 text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
              <i className="fa-solid fa-circle-info mr-1.5 text-slate-400"></i>
              Venmo and Cash App are coming soon. Use PayPal, or copy the message and send it however you like.
            </div>
          )}
        </div>
      </div>

      <div className="px-5 mt-4 mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">
          Payment requests
        </h2>
        <button onClick={copyAll} className="text-xs font-semibold text-brand-600 active:opacity-70">
          <i className="fa-regular fa-copy mr-1"></i> Copy all
        </button>
      </div>

      <div className="px-5 space-y-2">
        {totals.breakdown.map((b) => {
          const smsLink = smsLinkFor(b);
          const emailLink = emailLinkFor(b);
          return (
            <div key={b.person.id} className="card p-4">
              <div className="flex items-center gap-3">
                <Avatar person={b.person} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="font-bold">{b.person.name}</div>
                  <div className="text-xs text-slate-500">owes {fmt(b.total)}</div>
                </div>
                {providerDisabled ? (
                  <button
                    onClick={() => showToast(`${currentProvider.label} is coming soon`)}
                    className="px-3 py-2 rounded-xl text-white text-xs font-bold active:scale-95 opacity-60 cursor-not-allowed"
                    style={{ background: currentProvider.color }}
                    title="Coming soon"
                  >
                    Soon <i className="fa-solid fa-lock ml-1 text-[10px]"></i>
                  </button>
                ) : (
                  <a
                    href={linkFor(b)}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-2 rounded-xl text-white text-xs font-bold active:scale-95"
                    style={{ background: currentProvider.color }}
                  >
                    PayPal <i className="fa-solid fa-arrow-up-right-from-square ml-1 text-[10px]"></i>
                  </a>
                )}
              </div>

              {/* Direct send to their phone / email — recipient doesn't need the app */}
              <div className="mt-3 grid grid-cols-2 gap-2">
                {smsLink ? (
                  <a
                    href={smsLink}
                    className="px-3 py-2.5 rounded-xl text-white text-xs font-bold text-center active:scale-95 flex items-center justify-center gap-1.5"
                    style={{ background: "#34C759" }}
                  >
                    <i className="fa-solid fa-comment-sms"></i> Text {b.person.name}
                  </a>
                ) : (
                  <button
                    onClick={() => showToast(`Add ${b.person.name}'s phone on the People step`)}
                    className="px-3 py-2.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-400 cursor-not-allowed flex items-center justify-center gap-1.5"
                    title="No phone saved for this person"
                  >
                    <i className="fa-solid fa-comment-sms"></i> No phone
                  </button>
                )}
                {emailLink ? (
                  <a
                    href={emailLink}
                    className="px-3 py-2.5 rounded-xl text-white text-xs font-bold text-center active:scale-95 flex items-center justify-center gap-1.5"
                    style={{ background: "#0A84FF" }}
                  >
                    <i className="fa-solid fa-envelope"></i> Email {b.person.name}
                  </a>
                ) : (
                  <button
                    onClick={() => showToast(`Add ${b.person.name}'s email on the People step`)}
                    className="px-3 py-2.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-400 cursor-not-allowed flex items-center justify-center gap-1.5"
                    title="No email saved for this person"
                  >
                    <i className="fa-solid fa-envelope"></i> No email
                  </button>
                )}
              </div>

              <pre className="mt-3 bg-slate-50 rounded-xl p-3 text-[12px] leading-relaxed text-slate-700 whitespace-pre-wrap font-sans">
{messageFor(b)}
              </pre>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button onClick={() => copyMessage(b)} className="btn-secondary">
                  <i className={`fa-regular ${copied === b.person.id ? "fa-circle-check text-emerald-600" : "fa-copy"} mr-2`}></i>
                  {copied === b.person.id ? "Copied!" : "Copy message"}
                </button>
                <button onClick={() => shareNative(b)} className="btn-secondary">
                  <i className="fa-solid fa-share-nodes mr-2"></i> Share
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex-1"></div>

      <div className="action-bar">
        <button className="btn-primary" onClick={onDone}>
          <i className="fa-solid fa-check mr-2"></i> Done
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   Screen 0a — Google Sign-In
   ========================================================================= */
function GoogleG() {
  // Official Google "G" mark (4-color), inline SVG so we don't need a network image.
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.95 4 4 12.95 4 24s8.95 20 20 20 20-8.95 20-20c0-1.3-.1-2.3-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.6 39.5 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4 5.6l6.2 5.2C41.9 35.8 44 30.3 44 24c0-1.3-.1-2.3-.4-3.5z"/>
    </svg>
  );
}

function SignInScreen({ onSignedIn }) {
  const [loading, setLoading] = useState(false);

  /* Mocked Google sign-in.
     For App Store builds replace with:
       - iOS: @codetrix-studio/capacitor-google-auth  (and add Sign in with Apple — Apple requires it if you offer Google)
       - Web: Google Identity Services (GIS) one-tap prompt */
  const signIn = () => {
    setLoading(true);
    setTimeout(() => {
      const user = {
        name: "Demo User",
        email: "demo@gmail.com",
        avatar: null, // we render initials when no photo
        provider: "google"
      };
      onSignedIn(user);
    }, 900);
  };

  return (
    <div className="app-shell flex flex-col">
      <div className="px-5 pt-16 text-center">
        <div className="inline-flex w-14 h-14 rounded-2xl bg-brand-600 items-center justify-center shadow-pop mb-5">
          <i className="fa-solid fa-receipt text-white text-xl"></i>
        </div>
        <h1 className="text-3xl font-black tracking-tight leading-tight">
          Welcome to <span className="text-brand-600">SplitRight</span>
        </h1>
        <p className="mt-3 text-slate-500 text-base max-w-xs mx-auto">
          Sign in to start your <b className="text-ink-900">7-day free trial</b>. No charge today.
        </p>
      </div>

      <div className="px-5 mt-10">
        <div className="card p-5 space-y-3">
          <button onClick={signIn} disabled={loading} className="btn-google">
            {loading ? (
              <><i className="fa-solid fa-circle-notch fa-spin"></i> Signing in…</>
            ) : (
              <><GoogleG /> Continue with Google</>
            )}
          </button>

          <button onClick={signIn} disabled={loading} className="btn-google" style={{ background: '#000', color: '#fff', borderColor: '#000' }}>
            <i className="fa-brands fa-apple text-lg"></i>
            <span>Continue with Apple</span>
          </button>

          <div className="flex items-center gap-3 my-1">
            <span className="flex-1 h-px bg-slate-200"></span>
            <span className="text-xs text-slate-400 font-semibold">OR</span>
            <span className="flex-1 h-px bg-slate-200"></span>
          </div>

          <button onClick={signIn} disabled={loading} className="btn-secondary">
            <i className="fa-regular fa-envelope mr-2"></i> Continue with email
          </button>
        </div>

        <p className="text-[11px] text-slate-400 text-center mt-4 leading-relaxed">
          By continuing you agree to our{" "}
          <a href="#" className="text-brand-600 font-semibold">Terms</a> and{" "}
          <a href="#" className="text-brand-600 font-semibold">Privacy Policy</a>.
        </p>
      </div>

      <div className="flex-1"></div>

      <div className="px-5 pb-8 grid grid-cols-3 gap-3">
        <Feature icon="fa-bolt"        label="Instant OCR" />
        <Feature icon="fa-users"       label="Fair split" />
        <Feature icon="fa-paper-plane" label="One-tap pay" />
      </div>
    </div>
  );
}

/* =========================================================================
   Screen 0b — Paywall (7-day free trial → monthly / yearly)
   ========================================================================= */
function PaywallScreen({ user, onSubscribed, onSignOut }) {
  const { currency, region } = useCurrency();
  const cur = CURRENCIES[currency] || CURRENCIES.USD;
  const localPrice = (planId) => (planId === "yearly" ? cur.yearly : cur.monthly);
  const fmt = useMemo(() => makeFormatter(currency), [currency]);

  const [selected, setSelected] = useState("yearly"); // default to best value
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  /* Mocked purchase. On iOS:
       import { InAppPurchases } from '@capacitor-community/in-app-purchases';
       const result = await InAppPurchases.purchaseProduct({ productIdentifier });
     productIdentifier should match what you register in App Store Connect, e.g.:
       com.yourcompany.splitright.monthly
       com.yourcompany.splitright.yearly
     and both should have a 7-day Free Trial introductory offer attached. */
  const startTrial = () => {
    setLoading(true);
    setTimeout(() => {
      const now = Date.now();
      const sub = {
        plan: selected,
        status: "trial",
        trialStartedAt: now,
        trialEndsAt: now + TRIAL_MS,
        renewsAt: now + TRIAL_MS, // first charge happens at trial end
        productId: `com.yourcompany.splitright.${selected}`
      };
      onSubscribed(sub);
    }, 900);
  };

  const restore = () => {
    setRestoring(true);
    // On iOS: await InAppPurchases.restorePurchases();
    setTimeout(() => {
      setRestoring(false);
      alert("No previous purchase found on this account.");
    }, 800);
  };

  const plan = PLANS[selected];
  const firstCharge = new Date(Date.now() + TRIAL_MS).toLocaleDateString(cur.locale, { month: "short", day: "numeric" });
  const price = localPrice(selected);

  return (
    <div className="app-shell flex flex-col">
      <div className="px-5 pt-10">
        <div className="flex items-center justify-between">
          <button onClick={onSignOut} className="text-xs text-slate-400 font-semibold">
            <i className="fa-solid fa-chevron-left mr-1"></i> Sign out
          </button>
          <button onClick={restore} className="text-xs text-brand-600 font-semibold">
            {restoring ? "Restoring…" : "Restore purchases"}
          </button>
        </div>

        <div className="mt-8 text-center pop-in">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 items-center justify-center shadow-pop mb-4">
            <i className="fa-solid fa-crown text-white text-2xl"></i>
          </div>
          <h1 className="text-[28px] font-black leading-tight tracking-tight">
            Try SplitRight free<br/>for 7 days
          </h1>
          <p className="mt-2 text-slate-500 text-sm max-w-xs mx-auto">
            Unlimited receipts, unlimited splits, every payment method.
          </p>
        </div>
      </div>

      <div className="px-5 mt-6 space-y-3">
        <PlanRow
          plan={PLANS.yearly}
          price={cur.yearly}
          fmt={fmt}
          selected={selected === "yearly"}
          onSelect={() => setSelected("yearly")}
          highlight="Best value"
        />
        <PlanRow
          plan={PLANS.monthly}
          price={cur.monthly}
          fmt={fmt}
          selected={selected === "monthly"}
          onSelect={() => setSelected("monthly")}
        />
      </div>

      <div className="px-5 mt-5">
        <div className="card p-4">
          <BenefitRow icon="fa-receipt"   text="Scan unlimited receipts with OCR" />
          <BenefitRow icon="fa-users"     text="Split with unlimited people per bill" />
          <BenefitRow icon="fa-credit-card" text="Send Venmo, Cash App & PayPal requests" />
          <BenefitRow icon="fa-clock-rotate-left" text="Save & re-open past splits" />
          <BenefitRow icon="fa-ban" text="No ads. Ever." last />
        </div>
      </div>

      <div className="flex-1"></div>

      <div className="action-bar">
        <button className="btn-primary" onClick={startTrial} disabled={loading}>
          {loading ? (
            <><i className="fa-solid fa-circle-notch fa-spin mr-2"></i> Starting trial…</>
          ) : (
            <>Start 7-day free trial</>
          )}
        </button>
        <p className="text-[11px] text-slate-500 text-center mt-2 leading-relaxed px-2">
          Free for 7 days, then <b>{fmt(price)}/{plan.per}</b> starting <b>{firstCharge}</b>.<br/>
          Region: <b>{REGIONS[region]?.flag} {REGIONS[region]?.name}</b> · Cancel anytime · Auto-renews until canceled.
        </p>
      </div>
    </div>
  );
}

function PlanRow({ plan, price, fmt, selected, onSelect, highlight }) {
  const monthlyEquiv = plan.id === "yearly" ? (price / 12) : null;
  return (
    <button onClick={onSelect} className={`plan-card text-left w-full ${selected ? "is-on" : ""}`}>
      <div className="flex items-center gap-3">
        <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? "border-brand-600 bg-brand-600" : "border-slate-300"}`}>
          {selected && <i className="fa-solid fa-check text-white text-[10px]"></i>}
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-bold text-ink-900">{plan.label}</span>
            {plan.savePct && <span className="badge badge-save">Save {plan.savePct}%</span>}
            {highlight && plan.savePct && <span className="badge badge-trial">{highlight}</span>}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            7-day free trial, then {fmt(price)}/{plan.per}
            {monthlyEquiv && <> · just {fmt(monthlyEquiv)}/mo</>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-extrabold">{fmt(price)}</div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wider">/{plan.per}</div>
        </div>
      </div>
    </button>
  );
}

function BenefitRow({ icon, text, last }) {
  return (
    <div className={`flex items-center gap-3 py-2.5 ${last ? "" : "border-b border-slate-100"}`}>
      <span className="w-8 h-8 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
        <i className={`fa-solid ${icon} text-sm`}></i>
      </span>
      <span className="text-sm font-semibold text-ink-900">{text}</span>
    </div>
  );
}

/* =========================================================================
   Account screen — manage subscription
   ========================================================================= */
function AccountScreen({ user, subscription, onClose, onSignOut, onCancel }) {
  const { currency, region, setCurrency, setRegion } = useCurrency();
  const cur = CURRENCIES[currency] || CURRENCIES.USD;
  const regionInfo = REGIONS[region] || REGIONS.US;
  const fmt = useFmt();
  const plan = subscription && PLANS[subscription.plan];
  const subPrice = plan ? (plan.id === "yearly" ? cur.yearly : cur.monthly) : 0;
  const daysLeft = subscription
    ? Math.max(0, Math.ceil((subscription.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0;
  const endsLabel = subscription
    ? new Date(subscription.renewsAt).toLocaleDateString(cur.locale, { month: "long", day: "numeric", year: "numeric" })
    : "";

  const [showRegion, setShowRegion] = useState(false);
  const [showCurrency, setShowCurrency] = useState(false);

  return (
    <div className="app-shell flex flex-col">
      <Header title="Account" onBack={onClose} />

      <div className="px-5 mt-2">
        <div className="card p-5 flex items-center gap-4">
          <span className="avatar lg" style={{ background: "#6366F1" }}>
            {initialsOf(user.name)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-ink-900 truncate">{user.name}</div>
            <div className="text-sm text-slate-500 truncate">{user.email}</div>
          </div>
          <span className="chip" style={{ background: "#EEF2FF", color: "#4338CA" }}>
            <i className="fa-brands fa-google text-[10px]"></i> Google
          </span>
        </div>
      </div>

      <div className="px-5 mt-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">Subscription</h2>
        <div className="card p-5">
          {subscription?.status === "trial" && (
            <>
              <div className="flex items-center justify-between">
                <span className="badge badge-trial">Free trial</span>
                <span className="text-xs font-semibold text-slate-500">{daysLeft} day{daysLeft === 1 ? "" : "s"} left</span>
              </div>
              <div className="mt-3 font-bold text-ink-900">{plan?.label} plan</div>
              <div className="text-sm text-slate-500 mt-0.5">
                First charge of <b className="text-ink-900">{fmt(subPrice)}</b> on <b className="text-ink-900">{endsLabel}</b>
              </div>
            </>
          )}
          {subscription?.status === "active" && (
            <>
              <div className="flex items-center justify-between">
                <span className="badge badge-save">Active</span>
                <span className="text-xs font-semibold text-slate-500">Renews {endsLabel}</span>
              </div>
              <div className="mt-3 font-bold text-ink-900">{plan?.label} plan</div>
              <div className="text-sm text-slate-500 mt-0.5">{fmt(subPrice)} / {plan?.per}</div>
            </>
          )}
          {subscription?.status === "canceled" && (
            <>
              <div className="flex items-center justify-between">
                <span className="badge" style={{ background: "#FEE2E2", color: "#991B1B" }}>Canceled</span>
              </div>
              <div className="mt-3 font-bold text-ink-900">Access until {endsLabel}</div>
              <div className="text-sm text-slate-500 mt-0.5">No further charges.</div>
            </>
          )}

          {subscription?.status !== "canceled" && (
            <button onClick={onCancel} className="btn-secondary mt-4">
              <i className="fa-regular fa-circle-xmark mr-2"></i> Cancel subscription
            </button>
          )}
          <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
            On iOS, manage your subscription in Settings → Apple ID → Subscriptions.
          </p>
        </div>
      </div>

      <div className="px-5 mt-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">Region &amp; currency</h2>
        <div className="card overflow-hidden">
          <button
            onClick={() => { setShowRegion((v) => !v); setShowCurrency(false); }}
            className="flex items-center gap-3 p-4 w-full text-left border-b border-slate-100 active:bg-slate-50"
          >
            <span className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-lg">
              {regionInfo.flag}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Region</div>
              <div className="text-sm font-bold text-ink-900 truncate">{regionInfo.name}</div>
            </div>
            <i className={`fa-solid fa-chevron-${showRegion ? "up" : "down"} text-slate-400 text-xs`}></i>
          </button>
          {showRegion && (
            <div className="bg-slate-50 max-h-72 overflow-y-auto">
              {Object.values(REGIONS).map((r) => (
                <button
                  key={r.code}
                  onClick={() => {
                    setRegion(r.code);
                    setCurrency(r.currency); // auto-switch currency to region default
                    setShowRegion(false);
                  }}
                  className={`flex items-center gap-3 px-4 py-3 w-full text-left border-b border-slate-100 last:border-b-0 active:bg-slate-100 ${region === r.code ? "bg-brand-50" : ""}`}
                >
                  <span className="text-lg">{r.flag}</span>
                  <span className="flex-1 text-sm font-semibold text-ink-900">{r.name}</span>
                  <span className="text-[11px] text-slate-400">{r.currency}</span>
                  {region === r.code && <i className="fa-solid fa-check text-brand-600 text-xs"></i>}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => { setShowCurrency((v) => !v); setShowRegion(false); }}
            className="flex items-center gap-3 p-4 w-full text-left active:bg-slate-50"
          >
            <span className="w-8 h-8 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center font-bold text-sm">
              {cur.symbol}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Currency</div>
              <div className="text-sm font-bold text-ink-900 truncate">{cur.name} <span className="text-slate-400 font-normal">· {cur.code}</span></div>
            </div>
            <div className="text-xs text-slate-500 tabular-nums">{fmt(0)}</div>
            <i className={`fa-solid fa-chevron-${showCurrency ? "up" : "down"} text-slate-400 text-xs ml-2`}></i>
          </button>
          {showCurrency && (
            <div className="bg-slate-50 max-h-72 overflow-y-auto">
              {Object.values(CURRENCIES).map((c) => (
                <button
                  key={c.code}
                  onClick={() => { setCurrency(c.code); setShowCurrency(false); }}
                  className={`flex items-center gap-3 px-4 py-3 w-full text-left border-b border-slate-100 last:border-b-0 active:bg-slate-100 ${currency === c.code ? "bg-brand-50" : ""}`}
                >
                  <span className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center font-bold text-sm text-slate-700">
                    {c.symbol}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-ink-900 truncate">{c.name}</div>
                    <div className="text-[11px] text-slate-400 truncate">{c.code} · {c.locale}</div>
                  </div>
                  {currency === c.code && <i className="fa-solid fa-check text-brand-600 text-xs"></i>}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="text-[11px] text-slate-400 mt-2 px-1 leading-relaxed">
          Region sets your default tax, tip, and which payment apps appear on the Send screen. On iOS, App Store local pricing always overrides the display price here.
        </p>
      </div>

      <div className="px-5 mt-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">Legal</h2>
        <div className="card overflow-hidden">
          <LinkRow icon="fa-file-lines" label="Terms of Service" />
          <LinkRow icon="fa-shield-halved" label="Privacy Policy" />
          <LinkRow icon="fa-headset" label="Contact support" last />
        </div>
      </div>

      <div className="px-5 mt-4">
        <button onClick={onSignOut} className="btn-secondary text-red-600">
          <i className="fa-solid fa-right-from-bracket mr-2"></i> Sign out
        </button>
      </div>

      <div className="flex-1"></div>
      <div className="text-center text-[11px] text-slate-400 pb-6">SplitRight · v1.0.0</div>
    </div>
  );
}

function LinkRow({ icon, label, last }) {
  return (
    <a href="#" className={`flex items-center gap-3 p-4 ${last ? "" : "border-b border-slate-100"} active:bg-slate-50`}>
      <span className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center">
        <i className={`fa-solid ${icon}`}></i>
      </span>
      <span className="flex-1 font-semibold text-sm text-ink-900">{label}</span>
      <i className="fa-solid fa-chevron-right text-slate-400 text-xs"></i>
    </a>
  );
}

/* =========================================================================
   Root app
   ========================================================================= */
function App() {
  /* ---- Auth + subscription + locale (persisted) ---- */
  const initial = loadState() || {};
  const [user, setUser] = useState(initial.user || null);
  const [subscription, setSubscription] = useState(initial.subscription || null);
  const [showAccount, setShowAccount] = useState(false);
  // Region + currency: persisted if present, otherwise auto-detect from browser
  const initialRegion = initial.region && REGIONS[initial.region] ? initial.region : detectRegion();
  const [region, setRegion] = useState(initialRegion);
  const [currency, setCurrency] = useState(
    initial.currency && CURRENCIES[initial.currency]
      ? initial.currency
      : (REGIONS[initialRegion]?.currency || "USD")
  );

  // Persist whenever user/subscription/locale changes
  useEffect(() => { saveState({ user, subscription, region, currency }); }, [user, subscription, region, currency]);

  // Build the currency context value (memoized so child components don't re-render unnecessarily)
  const currencyCtx = useMemo(() => ({
    region, currency, setRegion, setCurrency,
    fmt: makeFormatter(currency)
  }), [region, currency]);

  // Auto-promote a finished trial into "active" so the demo behaves correctly
  // (in production, StoreKit / your backend is the source of truth)
  useEffect(() => {
    if (subscription?.status === "trial" && Date.now() >= subscription.trialEndsAt) {
      const plan = PLANS[subscription.plan];
      const periodMs = plan.per === "year" ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
      setSubscription({ ...subscription, status: "active", renewsAt: Date.now() + periodMs });
    }
  }, [subscription]);

  const hasAccess =
    subscription &&
    (subscription.status === "trial" || subscription.status === "active" ||
     (subscription.status === "canceled" && Date.now() < subscription.renewsAt));

  /* ---- App state ---- */
  const [screen, setScreen] = useState("scan");
  const [people, setPeople] = useState(STARTER_PEOPLE);
  const [items, setItems] = useState(DUMMY_RECEIPT.items);
  const [assignments, setAssignments] = useState(STARTER_ASSIGNMENTS);
  const [tipPct, setTipPct] = useState(0.20);
  const [taxRate, setTaxRate] = useState(DUMMY_RECEIPT.taxRate);
  const [restaurant, setRestaurant] = useState(DUMMY_RECEIPT.restaurant);
  const [pendingScan, setPendingScan] = useState(null); // { restaurant, items, taxRate, source }
  const [toast, setToast] = useState("");

  const showToast = useCallback((m) => setToast(m), []);

  const subtotalPreview = useMemo(
    () => items.reduce((s, i) => s + i.price, 0),
    [items]
  );

  const totals = useMemo(
    () => computeTotals({ items, assignments, people, taxRate, tipPct }),
    [items, assignments, people, taxRate, tipPct]
  );

  /* When the user changes their region, snap the active split's tip /
     tax defaults to the new region's conventions. Users can still
     adjust on the Tip & Tax screen — we just give them sensible
     starting values for the new locale. */
  const lastAppliedRegion = useRef(region);
  useEffect(() => {
    if (lastAppliedRegion.current === region) return;
    const r = REGIONS[region];
    if (r) {
      setTipPct(r.defaultTip);
      setTaxRate(r.defaultTax);
    }
    lastAppliedRegion.current = region;
  }, [region]);

  /* Keep assignments in sync if people are removed */
  useEffect(() => {
    const validIds = new Set(people.map((p) => p.id));
    const cleaned = {};
    let changed = false;
    Object.entries(assignments).forEach(([itemId, pids]) => {
      const next = pids.filter((id) => validIds.has(id));
      if (next.length !== pids.length) changed = true;
      cleaned[itemId] = next;
    });
    if (changed) setAssignments(cleaned);
  }, [people]); // eslint-disable-line

  const reset = () => {
    setPeople(STARTER_PEOPLE);
    setItems(DUMMY_RECEIPT.items);
    setAssignments(STARTER_ASSIGNMENTS);
    setTipPct(0.20);
    setTaxRate(DUMMY_RECEIPT.taxRate);
    setRestaurant(DUMMY_RECEIPT.restaurant);
    setPendingScan(null);
    setScreen("scan");
  };

  /* ---- Scan flow handlers ---- */
  // Called by ScanScreen after either the AI endpoint or Tesseract returns.
  const handleScanned = (payload) => {
    const source = payload.manual ? "ocr" : "ai";
    setPendingScan({
      restaurant: payload.restaurant || "Receipt",
      items: payload.items || [],
      taxRate: Number.isFinite(payload.taxRate) ? payload.taxRate : 0.0875,
      source
    });
    setScreen("review");
  };
  const handleUseSample = () => {
    setPendingScan({
      restaurant: DUMMY_RECEIPT.restaurant,
      items: DUMMY_RECEIPT.items.map((it) => ({ id: it.id, name: it.name, price: it.price })),
      taxRate: DUMMY_RECEIPT.taxRate,
      source: "ai"
    });
    setScreen("review");
  };
  const handleSkipManual = () => {
    setPendingScan({ restaurant: "Receipt", items: [], taxRate: 0.0875, source: "manual" });
    setScreen("review");
  };
  // Called by ReviewItemsScreen when the user confirms the items.
  // 1-tap mode: for a real scan / manual entry, reset the People screen
  // to **2 empty rows** so the user just picks the count + types names.
  // For the "Try sample" demo, keep the pre-filled STARTER_PEOPLE so the
  // demo flows end-to-end without any typing.
  const handleReviewNext = ({ restaurant: r, items: confirmed }) => {
    setRestaurant(r);
    const cleanItems = confirmed.map((it) => ({
      id: it.id || uid(),
      name: it.name.trim(),
      price: Number(it.price) || 0
    }));
    setItems(cleanItems);
    setAssignments({}); // will be auto-filled when transitioning people → items
    setTaxRate(pendingScan?.taxRate ?? taxRate);
    // Sample demo keeps the named people; real scan / manual start fresh.
    const isSample = pendingScan?.source === "ai" &&
                     pendingScan?.restaurant === DUMMY_RECEIPT.restaurant;
    if (!isSample) {
      setPeople([
        { id: uid(), name: "", color: PRESET_COLORS[0], phone: "", email: "" },
        { id: uid(), name: "", color: PRESET_COLORS[1], phone: "", email: "" }
      ]);
    }
    setScreen("people");
  };

  // 1-tap mode: when leaving People → Items, auto-assign every item to
  // every person (even split). The Items screen still lets the user
  // refine per-item if they want, but the default is "everyone shares".
  const handlePeopleNext = () => {
    const everyone = people.map((p) => p.id);
    const fullAssignments = {};
    items.forEach((it) => {
      fullAssignments[it.id] = everyone;
    });
    setAssignments(fullAssignments);
    setScreen("items");
  };

  /* ---- Auth handlers ---- */
  const handleSignedIn = (u) => {
    setUser(u);
    // If they already had a subscription saved (e.g. came back), keep it.
  };
  const handleSubscribed = (sub) => setSubscription(sub);
  const handleSignOut = () => {
    setUser(null);
    setSubscription(null);
    setShowAccount(false);
    saveState({ user: null, subscription: null });
    reset();
  };
  const handleCancel = () => {
    if (!subscription) return;
    if (!confirm("Cancel your subscription? You'll keep access until the end of your current period.")) return;
    setSubscription({ ...subscription, status: "canceled" });
    showToast("Subscription canceled");
  };

  /* ---- Gate: sign-in → paywall → account → main flow ---- */
  let body = null;
  if (!user) {
    body = <SignInScreen onSignedIn={handleSignedIn} />;
  } else if (!hasAccess) {
    body = (
      <PaywallScreen
        user={user}
        onSubscribed={handleSubscribed}
        onSignOut={handleSignOut}
      />
    );
  } else if (showAccount) {
    body = (
      <AccountScreen
        user={user}
        subscription={subscription}
        onClose={() => setShowAccount(false)}
        onSignOut={handleSignOut}
        onCancel={handleCancel}
      />
    );
  } else if (screen === "scan") {
    body = (
      <ScanScreen
        onScanned={handleScanned}
        onUseSample={handleUseSample}
        onSkipManual={handleSkipManual}
        user={user}
        subscription={subscription}
        onOpenAccount={() => setShowAccount(true)}
      />
    );
  } else if (screen === "review") {
    body = (
      <ReviewItemsScreen
        initial={pendingScan}
        source={pendingScan?.source}
        onBack={() => setScreen("scan")}
        onNext={handleReviewNext}
      />
    );
  } else if (screen === "people") {
    body = (
      <PeopleScreen
        people={people}
        setPeople={setPeople}
        onBack={() => setScreen("review")}
        onNext={handlePeopleNext}
      />
    );
  } else if (screen === "items") {
    body = (
      <ItemsScreen
        items={items}
        setItems={setItems}
        people={people}
        assignments={assignments}
        setAssignments={setAssignments}
        restaurant={restaurant}
        onBack={() => setScreen("people")}
        onNext={() => setScreen("tip")}
      />
    );
  } else if (screen === "tip") {
    body = (
      <TipScreen
        tipPct={tipPct}
        setTipPct={setTipPct}
        taxRate={taxRate}
        setTaxRate={setTaxRate}
        subtotalPreview={subtotalPreview}
        onBack={() => setScreen("items")}
        onNext={() => setScreen("summary")}
      />
    );
  } else if (screen === "summary") {
    // 1-tap flow: Summary now folds in the Send actions per person
    // (SMS / Email / PayPal deep links), so this is the final screen.
    body = (
      <SummaryScreen
        totals={totals}
        people={people}
        restaurant={restaurant}
        onBack={() => setScreen("tip")}
        onDone={reset}
        showToast={showToast}
      />
    );
  }

  return (
    <CurrencyContext.Provider value={currencyCtx}>
      {body}
      <Toast message={toast} onDone={() => setToast("")} />
    </CurrencyContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
