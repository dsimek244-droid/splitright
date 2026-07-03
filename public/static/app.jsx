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

/* ----------------------------- Haptics ---------------------------------- */
/* Lightweight haptic helpers. On iOS Safari (and the App Store / Capacitor
   wrapper) navigator.vibrate is a no-op — Capacitor's @capacitor/haptics
   plugin should be wired in for real Taptic Engine support before ship.
   On Android Chrome / desktop Chrome this provides real vibration / nothing. */
const canVibrate = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
const hapticTap     = () => { try { canVibrate && navigator.vibrate(10); } catch {} };
const hapticSuccess = () => { try { canVibrate && navigator.vibrate([15, 40, 15]); } catch {} };
const hapticError   = () => { try { canVibrate && navigator.vibrate([40, 80, 40]); } catch {} };

/* ----------------------------- Pricing ---------------------------------- */
const PLANS = {
  monthly: { id: "monthly", label: "Monthly",  price: 4.99,  per: "month", trialDays: 7 },
  yearly:  { id: "yearly",  label: "Yearly",   price: 39.99, per: "year",  trialDays: 7, savePct: 33 }
};
const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;

/* ----------------------------- Payment methods -------------------------- */
/* Each method knows how to deep-link a "please pay $X" request.
   `link(handle, amount, personName, restaurant)` returns a URL the user's
   phone can open natively; if the URL isn't a real scheme (e.g. Zelle has
   no public deep link), we set `link` to null and the message just
   includes the handle text instead. `placeholder` is what shows in the
   handle input field. `matchRegex` is used by the message template so
   we mention the handle in a format the recipient will recognize. */
const PAYMENT_METHODS = [
  {
    id: "paypal",
    label: "PayPal",
    icon: "fa-brands fa-paypal",
    color: "#003087",
    placeholder: "@handle",
    strip: (h) => h.replace(/^@/, "").trim(),
    link: (h, amt) => `https://paypal.me/${encodeURIComponent(h)}/${amt.toFixed(2)}`,
    messageLine: (h) => `PayPal: paypal.me/${h}`
  },
  {
    id: "venmo",
    label: "Venmo",
    icon: "fa-brands fa-v",
    color: "#3D95CE",
    placeholder: "@handle",
    strip: (h) => h.replace(/^@/, "").trim(),
    // Venmo web fallback works cross-platform: opens app on mobile, web on desktop.
    link: (h, amt, personName, restaurant) =>
      `https://venmo.com/${encodeURIComponent(h)}?txn=pay&amount=${amt.toFixed(2)}&note=${encodeURIComponent(`${restaurant} split`)}`,
    messageLine: (h) => `Venmo: @${h}`
  },
  {
    id: "cashapp",
    label: "Cash App",
    icon: "fa-solid fa-dollar-sign",
    color: "#00D632",
    placeholder: "$cashtag",
    strip: (h) => h.replace(/^\$/, "").trim(),
    link: (h, amt) => `https://cash.app/$${encodeURIComponent(h)}/${amt.toFixed(2)}`,
    messageLine: (h) => `Cash App: $${h}`
  },
  {
    id: "revolut",
    label: "Revolut",
    icon: "fa-solid fa-r",
    color: "#0075EB",
    placeholder: "@username",
    strip: (h) => h.replace(/^@/, "").trim(),
    // Revolut Pay Me — public link. Amount + currency picked up on the page.
    link: (h, amt, personName, restaurant, currency) =>
      `https://revolut.me/${encodeURIComponent(h)}/${(currency || "eur").toLowerCase()}${amt.toFixed(2)}`,
    messageLine: (h) => `Revolut: revolut.me/${h}`
  },
  {
    id: "wise",
    label: "Wise",
    icon: "fa-solid fa-globe",
    color: "#9FE870",
    placeholder: "@wisetag",
    strip: (h) => h.replace(/^@/, "").trim(),
    // Wise doesn't expose a deep-link with amount, but the profile URL works.
    link: (h) => `https://wise.com/pay/me/${encodeURIComponent(h)}`,
    messageLine: (h) => `Wise: wise.com/pay/me/${h}`
  },
  {
    id: "zelle",
    label: "Zelle",
    icon: "fa-solid fa-z",
    color: "#6D1ED4",
    placeholder: "email or phone",
    strip: (h) => h.trim(),
    // Zelle has no public deep-link; we surface the handle in the message
    // so the recipient can open their bank app and Zelle to it manually.
    link: null,
    messageLine: (h) => `Zelle: ${h}`
  },
  {
    id: "applecash",
    label: "Apple Cash",
    icon: "fa-brands fa-apple-pay",
    color: "#000000",
    placeholder: "phone or email",
    strip: (h) => h.trim(),
    // Apple Cash is peer-to-peer inside Messages; can't deep-link from web.
    link: null,
    messageLine: (h) => `Apple Cash: ${h}`
  },
  {
    id: "iban",
    label: "Bank / IBAN",
    icon: "fa-solid fa-building-columns",
    color: "#334155",
    placeholder: "IBAN or account #",
    strip: (h) => h.replace(/\s+/g, " ").trim(),
    link: null,
    messageLine: (h) => `Bank: ${h}`
  }
];
const PAYMENT_METHOD_BY_ID = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.id, m]));

/* ----------------------------- Card helpers ----------------------------- */
/* Client-side validation only — mirrors Apple's IAP flow (which itself
   uses the payment method already attached to the Apple ID). For real
   card-based billing outside iOS you'd tokenize this via Stripe Elements
   or Braintree before it ever hits your backend; we NEVER store or
   transmit a raw PAN. */
const CARD_BRANDS = [
  { id: "visa",       name: "Visa",             re: /^4/,                       icon: "fa-cc-visa",       color: "#1A1F71" },
  { id: "mastercard", name: "Mastercard",       re: /^(5[1-5]|2[2-7])/,         icon: "fa-cc-mastercard", color: "#EB001B" },
  { id: "amex",       name: "American Express", re: /^3[47]/,                   icon: "fa-cc-amex",       color: "#006FCF" },
  { id: "discover",   name: "Discover",         re: /^6(?:011|5)/,              icon: "fa-cc-discover",   color: "#FF6000" },
  { id: "jcb",        name: "JCB",              re: /^35(2[89]|[3-8])/,         icon: "fa-cc-jcb",        color: "#0E4C96" },
  { id: "diners",     name: "Diners Club",      re: /^3(0[0-5]|[689])/,         icon: "fa-cc-diners-club",color: "#0079BE" }
];
function detectCardBrand(digits) {
  return CARD_BRANDS.find((b) => b.re.test(digits)) || null;
}
function formatCardNumber(raw) {
  const d = raw.replace(/\D/g, "").slice(0, 19);
  // Amex uses 4-6-5 grouping; everyone else uses 4-4-4-4(-3).
  const brand = detectCardBrand(d);
  if (brand && brand.id === "amex") {
    return d.replace(/^(\d{0,4})(\d{0,6})(\d{0,5}).*$/, (_, a, b, c) =>
      [a, b, c].filter(Boolean).join(" ")
    );
  }
  return d.replace(/(.{4})/g, "$1 ").trim();
}
function formatExpiry(raw) {
  const d = raw.replace(/\D/g, "").slice(0, 4);
  if (d.length <= 2) return d;
  return d.slice(0, 2) + "/" + d.slice(2);
}
function luhnValid(digits) {
  if (!digits || digits.length < 12) return false;
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
function expiryValid(mmYY) {
  const m = mmYY.match(/^(\d{2})\/(\d{2})$/);
  if (!m) return false;
  const mm = parseInt(m[1], 10);
  const yy = parseInt(m[2], 10);
  if (mm < 1 || mm > 12) return false;
  const now = new Date();
  const currentYY = now.getFullYear() % 100;
  const currentMM = now.getMonth() + 1;
  if (yy < currentYY) return false;
  if (yy === currentYY && mm < currentMM) return false;
  if (yy > currentYY + 20) return false;
  return true;
}
function cvvValid(cvv, brand) {
  const d = cvv.replace(/\D/g, "");
  if (brand?.id === "amex") return d.length === 4;
  return d.length === 3;
}

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

/* App-wide context for theme, history, and haptics, kept separate from
   CurrencyContext so screens can subscribe to only what they need. */
const AppContext = React.createContext({
  theme: "system",
  setTheme: () => {},
  history: [],
  addHistoryEntry: () => {},
  updateHistoryEntry: () => {},
  removeHistoryEntry: () => {},
  clearHistory: () => {}
});
const useApp = () => React.useContext(AppContext);

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

/* OCR preprocessing pipeline. Tesseract.js v5 needs HIGH-CONTRAST, sharp
   black-on-white text to do its best work. Raw phone photos of receipts
   tend to be low-contrast (thermal-paper grey on white) and slightly blurry,
   which is exactly the regime where Tesseract returns "random letters".

   This pipeline runs entirely client-side:
     1. Render the original image to a canvas at high resolution (up to 2200px
        on the long edge) — Tesseract benefits more from resolution than
        from JPEG quality.
     2. Convert to grayscale using luminance weights.
     3. Apply contrast stretching (auto-levels): compute the 5th and 95th
        percentile of luminance, then linearly remap to 0..255.
     4. Apply a mild local sharpening (unsharp mask via convolution).
     5. Return a high-quality JPEG dataURL ready for Tesseract.
*/
async function preprocessForOcr(file, maxDim = 2200) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);

  let img;
  try {
    img = ctx.getImageData(0, 0, w, h);
  } catch {
    // Some browsers may throw on huge canvases — fall back to the plain image.
    return canvas.toDataURL("image/jpeg", 0.92);
  }
  const data = img.data;
  const N = w * h;

  // (1) Grayscale + collect histogram
  const lum = new Uint8ClampedArray(N);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const y = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    lum[j] = y;
    hist[y]++;
  }

  // (2) Auto-levels: find 5th and 95th percentile of luminance
  let lo = 0, hi = 255;
  const loCount = N * 0.05, hiCount = N * 0.95;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loCount) { lo = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= hiCount) { hi = v; break; } }
  if (hi - lo < 30) { lo = Math.max(0, lo - 15); hi = Math.min(255, hi + 15); }
  const range = Math.max(1, hi - lo);

  // (3) Apply contrast stretch + slight gamma to deepen blacks
  const stretched = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) {
    let v = ((lum[i] - lo) / range) * 255;
    if (v < 0) v = 0; else if (v > 255) v = 255;
    // gentle gamma 0.85 to deepen text
    v = 255 * Math.pow(v / 255, 0.85);
    stretched[i] = v;
  }

  // (4) Mild unsharp mask: write back to data, then output
  for (let y = 1, idx = w; y < h - 1; y++, idx += w) {
    for (let x = 1; x < w - 1; x++) {
      const p = idx + x;
      const center = stretched[p];
      const blur = (
        stretched[p - 1] + stretched[p + 1] +
        stretched[p - w] + stretched[p + w]
      ) / 4;
      const sharpened = center + (center - blur) * 0.6;
      stretched[p] = sharpened < 0 ? 0 : sharpened > 255 ? 255 : sharpened;
    }
  }

  // Write grayscale back as RGB
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const v = stretched[j];
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.92);
}

/* Heuristic parser used when we fall back to Tesseract.js client-OCR.

   Robustness rules (learned from real-world receipts):
   - Tesseract often mis-reads "$" as "S", "8", or "$ " — accept any of these.
   - Prices may appear at the END of a line ("Burger 12.99"), at the START
     ("12.99  Burger"), or split across lines (price on the next line).
   - European receipts use "12,99" — accept both decimal separators.
   - Some receipts use "12.99 A" or "12.99 T" (tax flags) trailing the price.
   - Lines that are ONLY garbage characters or only digits are dropped.
   - Lines without at least 2 letters in the name part are dropped (likely junk).
   - Multi-language skip list now includes Spanish, French, German, Italian. */
function parseReceiptText(text) {
  const rawLines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Drop lines that are obvious garbage (all symbols, only single chars).
  const lines = rawLines.filter((l) => {
    if (l.length < 2) return false;
    // Require at least 1 letter OR 1 digit
    if (!/[A-Za-z0-9\u00C0-\u024F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(l)) return false;
    return true;
  });

  // Multilingual SKIP regex — matches the leading word of a totals/tax/tip line
  const SKIP = /^(sub[-\s]?total|subtotal|total\s|grand\s*total|net|tax|gst|hst|vat|iva|tva|mwst|tip|gratuity|service[\s-]?(charge|fee)|servicio|charge|change|cash|visa|mastercard|amex|debit|credit|amount\s|balance|due|paid|thank|approval|auth|order\s*#|receipt|table|server|guest|date|time|tender|tendered|invoice|cust|store|merchant|terminal|register|loyalty|points|discount|coupon|promo|소계|합계|消費税|小計|合計|服务费|importe|importe\s*total|total\s*a\s*pagar|impuesto)/i;

  // Price patterns: "$12.34", "12.34", "12,99 €", "12.99 A" (with trailing flag),
  // or just "12.34" alone on a line. We also accept currency in front.
  const PRICE_END = /([$€£¥₹₩]?\s*\d{1,4}[.,]\d{2})\s*[A-Z]?\s*$/;
  const PRICE_START = /^([$€£¥₹₩]?\s*\d{1,4}[.,]\d{2})\s+/;
  const PRICE_ONLY = /^[$€£¥₹₩]?\s*(\d{1,4}[.,]\d{2})\s*[A-Z]?\s*$/;

  const cleanPrice = (s) => {
    const v = parseFloat(String(s).replace(/[^\d.,-]/g, "").replace(",", "."));
    return Number.isFinite(v) ? v : NaN;
  };

  const items = [];
  let restaurant = null;
  let taxRate = 0.0875;

  // Restaurant name: first non-empty line with letters, not a price, not all caps junk
  for (const l of lines.slice(0, 5)) {
    if (l.length < 3) continue;
    if (PRICE_ONLY.test(l)) continue;
    const letters = (l.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;
    if (letters < 2) continue;
    restaurant = l.slice(0, 60);
    break;
  }

  let subtotal = 0, taxAmt = 0;
  let pendingName = null; // for the "price on next line" case

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern A: price at end of line
    let m = line.match(PRICE_END);
    let namePart = "";
    let price = NaN;

    if (m) {
      price = cleanPrice(m[1]);
      namePart = line.slice(0, line.length - m[0].length).trim();
    } else if ((m = line.match(PRICE_START))) {
      // Pattern B: price at start, name after
      price = cleanPrice(m[1]);
      namePart = line.slice(m[0].length).trim();
    } else if (PRICE_ONLY.test(line) && pendingName) {
      // Pattern C: pure price on its own line, name was on the previous line
      price = cleanPrice(line);
      namePart = pendingName;
      pendingName = null;
    } else {
      // Could be a "name-only" line preceding a price-only line — remember it
      const looksLikeName = /[A-Za-z\u00C0-\u024F]{3,}/.test(line) && !SKIP.test(line);
      if (looksLikeName) pendingName = line;
      continue;
    }

    if (!Number.isFinite(price) || price <= 0) continue;

    // Clean the name
    namePart = namePart
      .replace(/^\d{1,3}\s*[xX×]\s+/, "")   // "2x Burger"
      .replace(/^\d+\s+(?=[A-Za-z])/, "")   // "01 Burger" (PLU prefix)
      .replace(/[#@$]+\s*$/, "")
      .replace(/[*+]+/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\W_]+/, "")
      .trim();

    if (!namePart) { pendingName = null; continue; }

    // Drop lines whose name part has < 2 letters (likely OCR garbage)
    const letterCount = (namePart.match(/[A-Za-z\u00C0-\u024F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
    if (letterCount < 2) { pendingName = null; continue; }

    if (SKIP.test(namePart)) {
      const lower = namePart.toLowerCase();
      if (/sub[\s-]?total|subtotal|net\b/.test(lower)) subtotal = price;
      else if (/^(tax|gst|hst|vat|iva|tva|mwst)\b/.test(lower)) taxAmt = price;
      pendingName = null;
      continue;
    }

    // Sanity: cap single-item price at $1000 (real items go higher rarely;
    // anything above is probably a misread "total" line).
    if (price > 1000) { pendingName = null; continue; }

    items.push({ name: namePart.slice(0, 80), price });
    pendingName = null;
  }

  if (subtotal > 0 && taxAmt > 0) taxRate = +(taxAmt / subtotal).toFixed(4);

  return {
    restaurant: restaurant || "Receipt",
    items,
    taxRate: Math.max(0, Math.min(0.25, taxRate))
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
function ScanScreen({ onScanned, onUseSample, onSkipManual, user, subscription, onOpenAccount, onOpenHistory, hasHistory }) {
  const [phase, setPhase] = useState("idle"); // idle | reading | ocr | success | error
  const [progress, setProgress] = useState(0);
  const [statusLabel, setStatusLabel] = useState("");
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState(null);
  const fileRef = useRef(null);

  const daysLeft = subscription?.status === "trial"
    ? Math.max(0, Math.ceil((subscription.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  /* Flash a green checkmark + buzz, then hand off to the Review screen.
     The brief delay lets the user actually see the success state. */
  const finishWithSuccess = (payload) => {
    setProgress(100);
    setPhase("success");
    hapticSuccess();
    setTimeout(() => onScanned(payload), 700);
  };

  const openCamera = () => {
    hapticTap();
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

    // Small preview for the UI (fast, low-res).
    let previewDataUrl;
    try {
      previewDataUrl = await downscaleImage(file, 1280, 0.82);
    } catch (err) {
      setPhase("error");
      hapticError();
      setError("Couldn't read that photo. Try another shot.");
      return;
    }
    setPreviewUrl(previewDataUrl);
    setProgress(20);
    setStatusLabel("Reading items with AI…");

    // 1) Try the server endpoint (vision LLM via OpenRouter)
    try {
      const r = await fetch("/api/scan-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: previewDataUrl })
      });
      const data = await r.json();
      if (data?.ok && Array.isArray(data.items) && data.items.length > 0) {
        const items = data.items.map((it) => ({
          id: uid(), name: it.name, price: Number(it.price) || 0
        }));
        finishWithSuccess({ restaurant: data.restaurant || "Receipt", items, taxRate: data.taxRate ?? 0.0875 });
        return;
      }
      // Server-side AI didn't return items — surface the reason so the
      // on-device fallback shows a friendlier "AI quota / try again" hint
      // rather than silently producing garbage.
      const reason = data?.reason;
      if (reason === "no-ai-credits") {
        setStatusLabel("AI quota reached — reading on device…");
      } else {
        setStatusLabel("Reading items on device…");
      }
      // 2) Fall back to in-browser Tesseract with HEAVY preprocessing on the
      //    ORIGINAL file (not the downscaled preview) — high-resolution +
      //    contrast stretch + unsharp mask gives Tesseract a much better shot.
      await runClientOcr(file);
    } catch (err) {
      setStatusLabel("Reading items on device…");
      await runClientOcr(file);
    }
  };

  const runClientOcr = async (file) => {
    setPhase("ocr");
    setProgress(25);
    if (typeof window.Tesseract === "undefined") {
      setPhase("error");
      hapticError();
      setError("OCR engine didn't load. Check your connection and try again.");
      return;
    }
    try {
      // Build the high-contrast image from the original file. This is the
      // single biggest accuracy win for client-OCR on phone photos.
      setStatusLabel("Enhancing photo…");
      let ocrImage;
      try {
        ocrImage = await preprocessForOcr(file, 2200);
      } catch {
        ocrImage = await downscaleImage(file, 1600, 0.92);
      }
      setProgress(35);
      setStatusLabel("Reading items on device…");

      const res = await window.Tesseract.recognize(ocrImage, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text") {
            setProgress(35 + Math.round(m.progress * 60));
          } else if (m.status) {
            setStatusLabel(m.status[0].toUpperCase() + m.status.slice(1) + "…");
          }
        },
        // PSM 6 = "Assume a single uniform block of text" — works best for receipts.
        tessedit_pageseg_mode: 6,
        // Bias the character set toward what receipts actually contain.
        // (Tesseract treats this as a soft preference, not a hard filter.)
        preserve_interword_spaces: "1"
      });
      const text = res?.data?.text || "";
      const parsed = parseReceiptText(text);
      if (parsed.items.length === 0) {
        // OCR ran but found nothing parseable — send empty list with a flag
        // so the Review screen can show the user a "we couldn't read it,
        // add items manually" message instead of silently going forward.
        finishWithSuccess({
          restaurant: parsed.restaurant,
          items: [],
          taxRate: parsed.taxRate,
          manual: true,
          ocrFailed: true
        });
        return;
      }
      const items = parsed.items.map((it) => ({ id: uid(), name: it.name, price: it.price }));
      finishWithSuccess({ restaurant: parsed.restaurant, items, taxRate: parsed.taxRate });
    } catch (err) {
      setPhase("error");
      hapticError();
      setError("Couldn't read the receipt. Try a clearer photo, or enter items manually.");
    }
  };

  const busy = phase === "reading" || phase === "ocr";
  const successPhase = phase === "success";

  return (
    <div className="app-shell flex flex-col">
      <div className="px-5 pt-10">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-2xl bg-brand-600 flex items-center justify-center shadow-pop">
            <i className="fa-solid fa-receipt text-white"></i>
          </div>
          <span className="font-extrabold text-lg tracking-tight">SplitRight</span>
          {daysLeft !== null && (
            <span className="ml-1 badge badge-trial relative overflow-hidden">
              <i className="fa-solid fa-gift text-[9px]"></i> Trial · {daysLeft}d left
              <span className="lux-shimmer absolute inset-0"></span>
            </span>
          )}
          <div className="flex-1"></div>
          {hasHistory && onOpenHistory && (
            <button
              onClick={() => { hapticTap(); onOpenHistory(); }}
              className="w-10 h-10 rounded-full bg-white border border-slate-200 flex items-center justify-center active:scale-95 mr-2 dark:bg-slate-800 shadow-card"
              aria-label="History"
            >
              <i className="fa-solid fa-clock-rotate-left text-gold"></i>
            </button>
          )}
          {user && onOpenAccount && (
            <button
              onClick={() => { hapticTap(); onOpenAccount(); }}
              className="w-10 h-10 rounded-full bg-white border border-slate-200 flex items-center justify-center active:scale-95 dark:bg-slate-800 shadow-card"
              aria-label="Account"
              style={{ boxShadow: "0 0 0 2px rgba(201,162,75,0.30)" }}
            >
              <span className="avatar sm" style={{ background: "#6366F1" }}>{initialsOf(user.name)}</span>
            </button>
          )}
        </div>

        {/* Luxury greeting — pulls the user's first name. Personal, premium. */}
        {user && (
          <div className="mt-8 lux-rise">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold">
              <i className="fa-solid fa-star text-[9px] mr-1.5"></i>
              Welcome back
            </p>
            <p className="mt-1 text-base font-semibold text-slate-700 dark:text-slate-300">
              {user.name?.split(" ")[0] || "Friend"}
            </p>
          </div>
        )}

        <h1 className={`${user ? "mt-3" : "mt-10"} font-display text-[44px] font-bold leading-[1.02] tracking-tight text-ink-900 dark:text-white lux-rise-1`}>
          Split the bill,<br/>
          <span className="italic text-gold">the right way.</span>
        </h1>
        <div className="lux-rule mt-4 lux-rise-2"></div>
        <p className="mt-3 text-slate-500 text-base lux-rise-2">
          Snap a photo of the receipt. We'll read every item — you tap who ordered what.
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

            {successPhase && (
              <div className="scan-success-overlay" aria-live="polite">
                <div className="check">
                  <i className="fa-solid fa-check"></i>
                </div>
              </div>
            )}

            {!busy && !successPhase && !previewUrl && (
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
          <button className="btn-ghost text-center" onClick={() => { hapticTap(); onSkipManual(); }} disabled={busy}>
            Enter manually
          </button>
          <button className="btn-ghost text-center" onClick={() => { hapticTap(); onUseSample(); }} disabled={busy}>
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
    source === "failed" ? "Couldn't read the photo" :
                          "Review the items";
  const subhead =
    source === "ai"     ? "Tap any row to fix it. Add or remove anything that's wrong." :
    source === "ocr"    ? "OCR isn't perfect — double-check names and prices, then continue." :
    source === "manual" ? "Type each item from the receipt. Tap Add when you're done." :
    source === "failed" ? "No worries — just type the items below. It only takes a moment." :
                          "Make sure everything looks right before you split.";

  return (
    <div className="app-shell flex flex-col">
      <Header title={headline} subtitle={subhead} onBack={onBack} />

      {source === "failed" && (
        <div className="px-5 mb-2">
          <div className="rounded-2xl px-4 py-3 flex items-start gap-3"
               style={{ background: "rgba(245, 158, 11, 0.10)", border: "1px solid rgba(245, 158, 11, 0.30)" }}>
            <i className="fa-solid fa-circle-info text-amber-500 mt-0.5"></i>
            <div className="text-[13px] text-amber-900 dark:text-amber-200 leading-relaxed">
              The photo was hard to read. Try again with a flatter, brighter shot — or just type the items below. The math is the same either way.
            </div>
          </div>
        </div>
      )}

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
              <i className="fa-solid fa-lock mr-2"></i>
              Add name + phone or email for everyone
            </>
          )}
        </button>
        {!allComplete && (
          <p className="text-[11px] text-center text-slate-500 mt-2 font-medium">
            <i className="fa-solid fa-circle-info mr-1 text-amber-500"></i>
            {people.length < 2
              ? "Add at least 2 people to split a bill."
              : `${people.length - completeCount} ${people.length - completeCount === 1 ? "person is" : "people are"} missing a name or contact (phone or email is required so we can send them their share).`}
          </p>
        )}
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
function SummaryScreen({ totals, people, items, assignments, taxRate, tipPct, restaurant, onBack, onDone, showToast }) {
  const fmt = useFmt();
  const { currency } = useCurrency();
  const { history, addHistoryEntry, updateHistoryEntry } = useApp();
  const [expanded, setExpanded] = useState(null);
  /* Handles the current user has configured for receiving payments.
     Stored per-method in one object so we can iterate them + persist
     them in localStorage under `splitright.v1.payHandles` (below). */
  const [handles, setHandles] = useState(() => {
    try {
      const raw = localStorage.getItem("splitright.v1.payHandles");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [showMethods, setShowMethods] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [paidIds, setPaidIds] = useState({}); // { personId: true } — Mark-as-paid toggle
  const [sharing, setSharing] = useState(false);
  const shareCardRef = useRef(null);

  // Persist handles so the user doesn't have to re-enter them every split.
  useEffect(() => {
    try { localStorage.setItem("splitright.v1.payHandles", JSON.stringify(handles)); } catch {}
  }, [handles]);

  // Convenience: list of methods the user has actually configured, in the
  // catalog's declared order (PayPal first, then Venmo, etc.).
  const activeMethods = useMemo(
    () => PAYMENT_METHODS.filter((m) => (handles[m.id] || "").trim().length > 0),
    [handles]
  );

  /* Save this split into history on mount so the user can revisit it.
     We dedupe by storing the generated id in a ref so subsequent toggles
     (paid/unpaid) update the same record rather than creating duplicates. */
  const historyIdRef = useRef(null);
  useEffect(() => {
    if (historyIdRef.current) return;
    // Don't save totally-empty splits (e.g. after a reset)
    if (!totals?.breakdown?.length) return;
    const id = uid();
    historyIdRef.current = id;
    addHistoryEntry({
      id,
      restaurant,
      currency,
      taxRate,
      tipPct,
      grandTotal: totals.grandTotal,
      subtotal: totals.subtotal,
      tax: totals.tax,
      tip: totals.tip,
      items: items.map((it) => ({ id: it.id, name: it.name, price: it.price })),
      people: people.map((p) => ({ id: p.id, name: p.name, color: p.color, phone: p.phone || "", email: p.email || "" })),
      assignments,
      breakdown: totals.breakdown.map((b) => ({
        personId: b.person.id,
        name: b.person.name,
        color: b.person.color,
        subtotal: b.subtotal,
        tax: b.tax,
        tip: b.tip,
        total: b.total,
        paid: false
      }))
    });
    // eslint-disable-next-line
  }, []);

  /* Keep the history entry's paid flags in sync as the user toggles. */
  useEffect(() => {
    if (!historyIdRef.current) return;
    updateHistoryEntry(historyIdRef.current, {
      breakdown: totals.breakdown.map((b) => ({
        personId: b.person.id,
        name: b.person.name,
        color: b.person.color,
        subtotal: b.subtotal,
        tax: b.tax,
        tip: b.tip,
        total: b.total,
        paid: !!paidIds[b.person.id]
      }))
    });
    // eslint-disable-next-line
  }, [paidIds]);

  const paidCount = totals.breakdown.filter((b) => paidIds[b.person.id]).length;
  const paidAmount = totals.breakdown.reduce((s, b) => s + (paidIds[b.person.id] ? b.total : 0), 0);
  const remainingAmount = totals.grandTotal - paidAmount;
  const allPaid = paidCount > 0 && paidCount === totals.breakdown.length;

  const togglePaid = (personId) => {
    const wasPaid = !!paidIds[personId];
    if (!wasPaid) hapticSuccess(); else hapticTap();
    setPaidIds((cur) => ({ ...cur, [personId]: !wasPaid }));
  };

  const messageFor = (b) => {
    const lines = [
      `Hey ${b.person.name}! 👋`,
      `Your share of ${restaurant} is ${fmt(b.total)}.`,
      `(Items ${fmt(b.subtotal)} + Tax ${fmt(b.tax)} + Tip ${fmt(b.tip)})`
    ];
    // Include EVERY payment option the user has configured so the recipient
    // can pick whichever they already use.
    if (activeMethods.length > 0) {
      lines.push("");
      lines.push("Pay however works for you:");
      for (const m of activeMethods) {
        const h = m.strip(handles[m.id]);
        if (h) lines.push(`• ${m.messageLine(h)}`);
      }
    } else {
      lines.push("");
      lines.push("Thanks!");
    }
    lines.push("");
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
  /* Build a payment-app deep link for a specific method + person. Returns
     null when the method doesn't have a native deep-link (Zelle, Apple
     Cash, IBAN) — those still show up in the message body. */
  const payLinkFor = (methodId, b) => {
    const m = PAYMENT_METHOD_BY_ID[methodId];
    if (!m || !m.link) return null;
    const raw = (handles[methodId] || "").trim();
    if (!raw) return null;
    const h = m.strip(raw);
    if (!h) return null;
    return m.link(h, b.total, b.person.name, restaurant, currency);
  };

  const copyMessage = async (b) => {
    hapticTap();
    try {
      await navigator.clipboard.writeText(messageFor(b));
      setCopiedId(b.person.id);
      showToast(`Copied ${b.person.name}'s message`);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      showToast("Couldn't copy");
    }
  };

  /* Share as image — renders the off-screen <ShareCard> via html2canvas to
     a PNG, then either uses navigator.share() with a File (modern mobile
     browsers + iOS Safari 16.4+) or falls back to triggering a download. */
  const shareAsImage = async () => {
    hapticTap();
    if (!shareCardRef.current) return;
    if (typeof window.html2canvas !== "function") {
      showToast("Image library didn't load");
      return;
    }
    setSharing(true);
    try {
      const isDark = document.documentElement.classList.contains("dark");
      const canvas = await window.html2canvas(shareCardRef.current, {
        backgroundColor: isDark ? "#0B1220" : "#FFFFFF",
        scale: 2,
        useCORS: true,
        logging: false
      });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.95));
      if (!blob) { setSharing(false); showToast("Couldn't make image"); return; }
      const file = new File([blob], `${restaurant.replace(/[^a-z0-9]+/gi, "-") || "split"}.png`, { type: "image/png" });

      // Try the Web Share API with files first (works on iOS Safari & Chrome Android)
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({
            files: [file],
            title: `${restaurant} — split with SplitRight`,
            text: `Our split for ${restaurant}: ${fmt(totals.grandTotal)} total.`
          });
          setSharing(false);
          return;
        } catch (e) {
          // user canceled — fall through to download
          if (e?.name === "AbortError") { setSharing(false); return; }
        }
      }
      // Fallback: trigger download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast("Saved image — paste it into the group chat");
    } catch (e) {
      showToast("Couldn't make image");
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="app-shell flex flex-col">
      <Header title="The split" subtitle={restaurant} onBack={onBack} />
      <Stepper step={3} />

      <div className="px-5 mt-2 lux-rise">
        <div className="lux-hero">
          <div className="flex items-center justify-between relative z-10">
            <span className="text-white/70 text-[11px] font-bold uppercase tracking-[0.18em]">
              <i className="fa-solid fa-star text-gold-light text-[9px] mr-1.5"></i>
              Grand total
            </span>
            <i className="fa-solid fa-wallet text-gold-light/70"></i>
          </div>
          <div className="font-display text-[44px] leading-tight font-bold mt-2 tracking-tight text-white relative z-10 tabular-nums break-all">{fmt(totals.grandTotal)}</div>
          <div className="lux-rule mt-3 mb-3 relative z-10" style={{ background: "linear-gradient(90deg, transparent 0%, rgba(201,162,75,0.55) 50%, transparent 100%)" }}></div>
          <div className="flex items-center justify-between text-[12px] relative z-10">
            <span className="text-white/70">Subtotal <b className="text-white/95">{fmt(totals.subtotal)}</b></span>
            <span className="text-white/70">Tax <b className="text-white/95">{fmt(totals.tax)}</b></span>
            <span className="text-white/70">Tip <b className="text-white/95">{fmt(totals.tip)}</b></span>
          </div>

          {/* Paid tracker — only after at least 1 person is marked paid */}
          {paidCount > 0 && (
            <div className="mt-4 pt-3 border-t border-white/15 relative z-10">
              <div className="flex items-center justify-between gap-2 text-[12px] font-semibold">
                <span className="text-white/90 shrink-0">
                  <i className="fa-solid fa-circle-check mr-1.5"></i>
                  {paidCount} of {totals.breakdown.length} paid
                </span>
                <span className="text-white/90 tabular-nums truncate text-right">
                  {fmt(paidAmount)} <span className="text-white/60">/ {fmt(totals.grandTotal)}</span>
                </span>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full bg-emerald-300"
                  style={{ width: `${(paidAmount / Math.max(totals.grandTotal, 0.01)) * 100}%`, transition: "width 250ms ease" }}
                />
              </div>
              {!allPaid && (
                <div className="mt-1.5 text-[11px] text-white/70">
                  {fmt(remainingAmount)} still owed
                </div>
              )}
              {allPaid && (
                <div className="mt-1.5 text-[11px] font-bold text-emerald-200">
                  <i className="fa-solid fa-party-horn mr-1"></i> Everyone paid up. Nice!
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Share + payment methods toolbar */}
      <div className="px-5 mt-3 grid grid-cols-2 gap-2">
        <button onClick={shareAsImage} disabled={sharing} className="btn-secondary !py-3 flex items-center justify-center">
          {sharing ? (
            <><i className="fa-solid fa-circle-notch fa-spin mr-2"></i> Making image…</>
          ) : (
            <><i className="fa-solid fa-share-nodes mr-2 text-brand-600"></i> Share as image</>
          )}
        </button>
        <button
          onClick={() => { hapticTap(); setShowMethods((v) => !v); }}
          className="btn-secondary !py-3 flex items-center justify-center relative"
        >
          <i className="fa-solid fa-wallet mr-2 text-gold"></i>
          <span className="truncate">
            {activeMethods.length === 0 ? "Payment methods" : `${activeMethods.length} method${activeMethods.length === 1 ? "" : "s"}`}
          </span>
          <i className={`fa-solid fa-chevron-${showMethods ? "up" : "down"} text-slate-400 text-[10px] ml-2`}></i>
        </button>
      </div>

      {/* Collapsible: configure your own payment handles. Persists across splits. */}
      {showMethods && (
        <div className="px-5 mt-2 lux-rise">
          <div className="card p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="font-bold text-sm text-ink-900">Your payment methods</div>
                <div className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                  Add the handles friends can use to pay you back. They'll appear as one-tap buttons on each person and in the message.
                </div>
              </div>
            </div>
            <div className="space-y-2 mt-3">
              {PAYMENT_METHODS.map((m) => {
                const val = handles[m.id] || "";
                const hasVal = val.trim().length > 0;
                return (
                  <div
                    key={m.id}
                    className={`flex items-center gap-2 rounded-xl px-2.5 py-2 transition ${
                      hasVal
                        ? "bg-slate-50 dark:bg-slate-800 ring-1 ring-slate-200 dark:ring-slate-700"
                        : "bg-transparent"
                    }`}
                  >
                    <span
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0"
                      style={{ background: m.color }}
                    >
                      <i className={`${m.icon} text-sm`}></i>
                    </span>
                    <label className="text-xs font-bold text-ink-900 w-20 shrink-0 dark:text-white">
                      {m.label}
                    </label>
                    <input
                      value={val}
                      onChange={(e) => setHandles((cur) => ({ ...cur, [m.id]: e.target.value }))}
                      placeholder={m.placeholder}
                      autoCapitalize="off"
                      autoCorrect="off"
                      className="flex-1 min-w-0 bg-white dark:bg-slate-900 rounded-lg px-2.5 py-2 text-xs font-medium outline-none focus:ring-2 focus:ring-brand-500/40 border border-slate-200 dark:border-slate-700"
                    />
                    {hasVal && (
                      <button
                        onClick={() => setHandles((cur) => { const n = { ...cur }; delete n[m.id]; return n; })}
                        className="w-7 h-7 flex items-center justify-center text-slate-400 active:text-red-500"
                        aria-label={`Remove ${m.label}`}
                      >
                        <i className="fa-solid fa-xmark text-xs"></i>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-400 mt-3 leading-relaxed">
              <i className="fa-solid fa-lock text-emerald-600 mr-1"></i>
              Handles are stored only on this device.
            </p>
          </div>
        </div>
      )}

      <div className="px-5 mt-4 mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Per person</h2>
        <span className="text-xs text-slate-400">{people.length} people · tap to expand</span>
      </div>

      <div className="px-5 space-y-2">
        {totals.breakdown.map((b) => {
          const open = expanded === b.person.id;
          const sms = smsLinkFor(b);
          const email = emailLinkFor(b);
          const isPaid = !!paidIds[b.person.id];
          return (
            <div key={b.person.id} className={`card overflow-hidden transition ${isPaid ? "paid-row" : ""}`}>
              <div className="w-full flex items-center gap-1 pl-2 pr-1">
                {/* Mark-as-paid checkbox — large tap target, visible without expanding */}
                <button
                  onClick={() => togglePaid(b.person.id)}
                  className="w-10 h-10 flex items-center justify-center active:scale-90"
                  aria-label={isPaid ? `Mark ${b.person.name} unpaid` : `Mark ${b.person.name} paid`}
                >
                  <span className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition ${isPaid ? "bg-emerald-500 border-emerald-500" : "border-slate-300 dark:border-slate-600"}`}>
                    {isPaid && <i className="fa-solid fa-check text-white text-[11px]"></i>}
                  </span>
                </button>

                <button
                  onClick={() => { hapticTap(); setExpanded(open ? null : b.person.id); }}
                  className="flex-1 min-w-0 py-4 pr-3 flex items-center gap-3 text-left active:opacity-80"
                >
                  <Avatar person={b.person} size="lg" />
                  <div className="flex-1 min-w-0">
                    <div className={`font-bold text-ink-900 truncate ${isPaid ? "paid-strike" : ""}`}>
                      {b.person.name}
                      {isPaid && (
                        <span className="ml-2 inline-flex items-center gap-1 align-middle text-[10px] font-bold uppercase tracking-wider text-emerald-600">
                          <i className="fa-solid fa-circle-check"></i> Paid
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      Items {fmt(b.subtotal)} · Tax {fmt(b.tax)} · Tip {fmt(b.tip)}
                    </div>
                  </div>
                  <div className="text-right shrink-0 max-w-[42%]">
                    <div className={`text-lg font-extrabold tabular-nums truncate ${isPaid ? "paid-strike" : ""}`}>{fmt(b.total)}</div>
                    <div className="text-[11px] text-slate-400 uppercase tracking-wider">{isPaid ? "paid" : "owes"}</div>
                  </div>
                  <i className={`fa-solid fa-chevron-${open ? "up" : "down"} text-slate-400 ml-1 shrink-0`}></i>
                </button>
              </div>
              {open && (
                <div className="px-4 pb-4 -mt-1 space-y-3">
                  {/* Send-message row — SMS + Email side-by-side */}
                  <div className="grid grid-cols-2 gap-2">
                    {sms ? (
                      <a
                        href={sms}
                        onClick={hapticTap}
                        className="px-2 py-2.5 rounded-xl text-white text-xs font-bold text-center active:scale-95 flex items-center justify-center gap-1.5"
                        style={{ background: "#34C759" }}
                      >
                        <i className="fa-solid fa-comment-sms"></i> Text request
                      </a>
                    ) : (
                      <button
                        disabled
                        className="px-2 py-2.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-400 cursor-not-allowed flex items-center justify-center gap-1.5 dark:bg-slate-800"
                      >
                        <i className="fa-solid fa-comment-sms"></i> No phone
                      </button>
                    )}
                    {email ? (
                      <a
                        href={email}
                        onClick={hapticTap}
                        className="px-2 py-2.5 rounded-xl text-white text-xs font-bold text-center active:scale-95 flex items-center justify-center gap-1.5"
                        style={{ background: "#0A84FF" }}
                      >
                        <i className="fa-solid fa-envelope"></i> Email request
                      </a>
                    ) : (
                      <button
                        disabled
                        className="px-2 py-2.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-400 cursor-not-allowed flex items-center justify-center gap-1.5 dark:bg-slate-800"
                      >
                        <i className="fa-solid fa-envelope"></i> No email
                      </button>
                    )}
                  </div>

                  {/* Payment-app deep links — one per configured handle */}
                  {activeMethods.length > 0 ? (
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5 flex items-center gap-2">
                        <span>Pay via</span>
                        <span className="lux-rule flex-1"></span>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {activeMethods.map((m) => {
                          const link = payLinkFor(m.id, b);
                          const inner = (
                            <>
                              <i className={m.icon}></i> {m.label}
                            </>
                          );
                          const style = { background: m.color };
                          if (link) {
                            return (
                              <a
                                key={m.id}
                                href={link}
                                onClick={hapticTap}
                                target="_blank"
                                rel="noreferrer"
                                className="px-2 py-2.5 rounded-xl text-white text-[11px] font-bold text-center active:scale-95 flex items-center justify-center gap-1.5"
                                style={style}
                              >
                                {inner}
                              </a>
                            );
                          }
                          // Method has no deep link (Zelle / Apple Cash / IBAN) —
                          // show a button that copies the handle-line so the
                          // recipient sees it clearly.
                          return (
                            <button
                              key={m.id}
                              onClick={async () => {
                                hapticTap();
                                const h = m.strip(handles[m.id] || "");
                                try {
                                  await navigator.clipboard.writeText(m.messageLine(h));
                                  showToast(`Copied ${m.label} details`);
                                } catch { showToast("Couldn't copy"); }
                              }}
                              className="px-2 py-2.5 rounded-xl text-white text-[11px] font-bold text-center active:scale-95 flex items-center justify-center gap-1.5"
                              style={style}
                              title={`No deep link for ${m.label} — tap to copy`}
                            >
                              {inner}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { hapticTap(); setShowMethods(true); }}
                      className="w-full rounded-xl border border-dashed border-slate-300 dark:border-slate-600 py-3 text-sm font-semibold text-slate-500 active:opacity-70"
                    >
                      <i className="fa-solid fa-plus mr-1.5"></i> Add a payment method
                    </button>
                  )}

                  <div className="bg-slate-50 rounded-xl p-3">
                    <Row label="Items subtotal" value={fmt(b.subtotal)} />
                    <Row label="Tax share"      value={fmt(b.tax)} />
                    <Row label="Tip share"      value={fmt(b.tip)} />
                    <div className="border-t border-slate-200 my-2"></div>
                    <Row label="Total"          value={fmt(b.total)} bold />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => copyMessage(b)}
                      className="btn-secondary !py-2.5"
                    >
                      <i className={`fa-regular ${copiedId === b.person.id ? "fa-circle-check text-emerald-600" : "fa-copy"} mr-2`}></i>
                      {copiedId === b.person.id ? "Copied!" : "Copy message"}
                    </button>
                    <button
                      onClick={() => togglePaid(b.person.id)}
                      className={`!py-2.5 rounded-2xl font-bold text-sm transition ${isPaid ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"}`}
                    >
                      <i className={`fa-solid ${isPaid ? "fa-rotate-left" : "fa-check"} mr-2`}></i>
                      {isPaid ? "Mark unpaid" : "Mark as paid"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-1 min-h-[80px]"></div>

      <div className="action-bar">
        <button className="btn-primary" onClick={() => { hapticTap(); onDone(); }}>
          <i className="fa-solid fa-check mr-2"></i> Done
        </button>
      </div>

      {/* Off-screen card that html2canvas renders into the shareable PNG.
          Always rendered (not gated by `sharing`) so the ref is mounted. */}
      <div className="share-card-host" aria-hidden="true">
        <ShareCard
          ref={shareCardRef}
          restaurant={restaurant}
          totals={totals}
          paidIds={paidIds}
          fmt={fmt}
        />
      </div>
    </div>
  );
}

/* Compact, screenshot-friendly summary card. Rendered off-screen at fixed
   width and snapped into a PNG by html2canvas. Inline styles ONLY — no
   Tailwind utility classes — because some browsers' html2canvas implementation
   chokes on JIT-generated stylesheets. */
const ShareCard = React.forwardRef(function ShareCard({ restaurant, totals, paidIds, fmt }, ref) {
  const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return (
    <div
      ref={ref}
      style={{
        width: 600,
        background: "#FFFFFF",
        fontFamily: "Inter, system-ui, -apple-system, sans-serif",
        color: "#0B1220",
        padding: 36,
        borderRadius: 28,
        boxSizing: "border-box"
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 14,
          background: "linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)",
          color: "white", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 22, fontWeight: 800
        }}>
          $
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#6B7280", letterSpacing: 1, textTransform: "uppercase" }}>
            SplitRight
          </div>
          <div style={{ fontSize: 12, color: "#94A3B8" }}>{today}</div>
        </div>
      </div>

      {/* Restaurant + total */}
      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1.1 }}>
          {restaurant || "Receipt"}
        </div>
        <div style={{
          marginTop: 14,
          background: "linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)",
          color: "white",
          borderRadius: 20,
          padding: 22
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.85, textTransform: "uppercase", letterSpacing: 1.2 }}>
            Grand total
          </div>
          <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: -1, marginTop: 2 }}>
            {fmt(totals.grandTotal)}
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 10, fontSize: 13, opacity: 0.95 }}>
            <span>Subtotal {fmt(totals.subtotal)}</span>
            <span>Tax {fmt(totals.tax)}</span>
            <span>Tip {fmt(totals.tip)}</span>
          </div>
        </div>
      </div>

      {/* Per-person breakdown */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "#6B7280", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 8 }}>
          Per person
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {totals.breakdown.map((b) => {
            const paid = !!paidIds[b.person.id];
            return (
              <div key={b.person.id} style={{
                display: "flex", alignItems: "center", gap: 14,
                padding: "12px 16px",
                background: paid ? "#ECFDF5" : "#F8FAFC",
                border: `1px solid ${paid ? "#A7F3D0" : "#E2E8F0"}`,
                borderRadius: 16,
                opacity: paid ? 0.85 : 1
              }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 9999,
                  background: b.person.color || "#6366F1",
                  color: "white", display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 800, fontSize: 14
                }}>
                  {(b.person.name || "?").trim().split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 16, textDecoration: paid ? "line-through" : "none" }}>
                    {b.person.name}
                    {paid && (
                      <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 800, color: "#059669", textDecoration: "none", letterSpacing: 0.8 }}>
                        ✓ PAID
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>
                    Items {fmt(b.subtotal)} · Tax {fmt(b.tax)} · Tip {fmt(b.tip)}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontWeight: 900, fontSize: 18, textDecoration: paid ? "line-through" : "none" }}>
                    {fmt(b.total)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px dashed #CBD5E1", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "#94A3B8" }}>
        <span>Split with SplitRight · splitright.app</span>
        <span>{totals.breakdown.length} people</span>
      </div>
    </div>
  );
});

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
/* =========================================================================
   CardCaptureSheet — bottom-sheet modal that collects a payment method
   before starting the free trial. On the App Store build this is bypassed
   because Apple IAP uses the payment method already on the Apple ID; on
   the web preview we mimic the flow so users understand the trial → charge
   commitment before they opt in (Apple Guideline 3.1.2 compliance).

   Security: we NEVER transmit or store a raw PAN. In production this
   component should be replaced by Stripe Elements / Braintree Hosted
   Fields, which tokenize the card client-side and hand you back an
   opaque token to store server-side. Here we only keep the last-4
   digits and the brand for display.
   ========================================================================= */
function CardCaptureSheet({ open, onClose, onConfirm, plan, price, firstCharge, currencyFmt }) {
  const [number, setNumber]   = useState("");
  const [expiry, setExpiry]   = useState("");
  const [cvv, setCvv]         = useState("");
  const [name, setName]       = useState("");
  const [zip, setZip]         = useState("");
  const [processing, setProcessing] = useState(false);
  const [errors, setErrors]   = useState({});

  const digits = number.replace(/\D/g, "");
  const brand = detectCardBrand(digits);
  const cvvLen = brand?.id === "amex" ? 4 : 3;

  // Reset the form whenever the sheet is re-opened.
  useEffect(() => {
    if (open) {
      setNumber(""); setExpiry(""); setCvv("");
      setName(""); setZip(""); setErrors({}); setProcessing(false);
    }
  }, [open]);

  if (!open) return null;

  const validate = () => {
    const e = {};
    if (!luhnValid(digits))        e.number = "Enter a valid card number";
    if (!expiryValid(expiry))      e.expiry = "MM/YY, in the future";
    if (!cvvValid(cvv, brand))     e.cvv    = `${cvvLen} digits`;
    if (name.trim().length < 2)    e.name   = "Name required";
    if (zip.trim().length < 3)     e.zip    = "Postal code required";
    return e;
  };

  const submit = () => {
    hapticTap();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) { hapticError(); return; }
    setProcessing(true);
    // Simulate a tokenization roundtrip (Stripe / Braintree / etc).
    setTimeout(() => {
      onConfirm({
        brand: brand?.id || "unknown",
        brandName: brand?.name || "Card",
        brandIcon: brand?.icon || "fa-credit-card",
        brandColor: brand?.color || "#334155",
        last4: digits.slice(-4),
        expMonth: expiry.slice(0, 2),
        expYear: expiry.slice(3),
        cardholder: name.trim(),
        zip: zip.trim(),
        // In production, this comes from Stripe. Here we fake it so the
        // UI has something to display and the flow feels real.
        token: `tok_demo_${Math.random().toString(36).slice(2, 10)}`
      });
    }, 900);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: "rgba(11,18,32,0.55)", backdropFilter: "blur(6px)" }}>
      <div
        className="w-full max-w-[460px] rounded-t-3xl overflow-hidden lux-rise"
        style={{ background: "var(--card-bg, #FFFFFF)", maxHeight: "92vh", overflowY: "auto" }}
      >
        {/* Handle */}
        <div className="pt-3 pb-1 flex justify-center">
          <span className="block w-10 h-1 rounded-full bg-slate-300"></span>
        </div>

        <div className="px-5 pt-2 pb-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-2xl font-bold text-ink-900">Start your free trial</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                7 days free — then {currencyFmt(price)}/{plan.per} starting {firstCharge}
              </p>
            </div>
            <button onClick={onClose} className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center active:scale-95 dark:bg-slate-800" aria-label="Close">
              <i className="fa-solid fa-xmark text-slate-500"></i>
            </button>
          </div>

          {/* Card preview — gold-accented navy card, updates live */}
          <div className="mt-4 lux-hero" style={{ padding: 20, borderRadius: 20 }}>
            <div className="flex items-center justify-between relative z-10">
              <span className="text-white/70 text-[10px] font-bold uppercase tracking-[0.18em]">
                <i className="fa-solid fa-lock text-gold-light text-[9px] mr-1.5"></i> Secured
              </span>
              {brand ? (
                <i className={`fa-brands ${brand.icon} text-2xl text-white`}></i>
              ) : (
                <i className="fa-solid fa-credit-card text-white/70"></i>
              )}
            </div>
            <div className="mt-4 font-mono text-lg text-white tabular-nums tracking-widest relative z-10">
              {formatCardNumber(number) || "•••• •••• •••• ••••"}
            </div>
            <div className="mt-3 flex items-end justify-between text-[11px] relative z-10">
              <div>
                <div className="text-white/50 uppercase tracking-wider">Cardholder</div>
                <div className="text-white font-semibold mt-0.5 truncate max-w-[180px]">
                  {name.trim() || "YOUR NAME"}
                </div>
              </div>
              <div>
                <div className="text-white/50 uppercase tracking-wider">Expires</div>
                <div className="text-white font-semibold mt-0.5 tabular-nums">
                  {expiry || "MM/YY"}
                </div>
              </div>
            </div>
          </div>

          {/* Fields */}
          <div className="mt-4 space-y-3">
            <CardField
              label="Card number"
              value={formatCardNumber(number)}
              onChange={(v) => { setNumber(v); if (errors.number) setErrors({ ...errors, number: null }); }}
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder="1234 5678 9012 3456"
              error={errors.number}
              rightIcon={brand ? <i className={`fa-brands ${brand.icon} text-lg`} style={{ color: brand.color }}></i> : null}
            />
            <div className="grid grid-cols-2 gap-3">
              <CardField
                label="Expiry"
                value={expiry}
                onChange={(v) => { setExpiry(formatExpiry(v)); if (errors.expiry) setErrors({ ...errors, expiry: null }); }}
                inputMode="numeric"
                autoComplete="cc-exp"
                placeholder="MM/YY"
                error={errors.expiry}
              />
              <CardField
                label="CVV"
                value={cvv}
                onChange={(v) => { setCvv(v.replace(/\D/g, "").slice(0, cvvLen)); if (errors.cvv) setErrors({ ...errors, cvv: null }); }}
                inputMode="numeric"
                autoComplete="cc-csc"
                placeholder={cvvLen === 4 ? "1234" : "123"}
                error={errors.cvv}
                secure
              />
            </div>
            <CardField
              label="Cardholder name"
              value={name}
              onChange={(v) => { setName(v); if (errors.name) setErrors({ ...errors, name: null }); }}
              autoComplete="cc-name"
              placeholder="Full name on card"
              error={errors.name}
            />
            <CardField
              label="Postal / ZIP code"
              value={zip}
              onChange={(v) => { setZip(v.slice(0, 10)); if (errors.zip) setErrors({ ...errors, zip: null }); }}
              autoComplete="postal-code"
              placeholder="e.g. 90210"
              error={errors.zip}
            />
          </div>

          {/* Reassurance strip */}
          <div className="mt-4 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            <i className="fa-solid fa-lock text-emerald-600"></i>
            <span>256-bit encryption · Card is not charged today · Cancel anytime before {firstCharge}</span>
          </div>

          {/* Terms */}
          <p className="mt-3 text-[10px] text-slate-400 leading-relaxed">
            By starting, you authorize SplitRight to charge <b className="text-slate-600 dark:text-slate-300">{currencyFmt(price)}</b> to your card on <b className="text-slate-600 dark:text-slate-300">{firstCharge}</b> unless you cancel before that date. The subscription auto-renews at the same price every {plan.per} until you cancel. You can cancel from Account → Cancel subscription at any time.
          </p>

          <button
            onClick={submit}
            disabled={processing}
            className="btn-lux mt-4"
          >
            {processing ? (
              <><i className="fa-solid fa-circle-notch fa-spin mr-2"></i> Verifying card…</>
            ) : (
              <><i className="fa-solid fa-lock mr-2"></i> Start free trial</>
            )}
          </button>

          <button onClick={onClose} className="w-full mt-2 py-3 text-sm font-semibold text-slate-500 active:opacity-60">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* Small reusable field for the card sheet. */
function CardField({ label, value, onChange, error, rightIcon, secure, ...rest }) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <div className={`mt-1 relative rounded-xl border ${error ? "border-red-400" : "border-slate-200 dark:border-slate-700"} bg-slate-50 dark:bg-slate-800 focus-within:ring-2 focus-within:ring-brand-500/40`}>
        <input
          type={secure ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent px-4 py-3 text-base font-semibold outline-none tabular-nums"
          {...rest}
        />
        {rightIcon && <span className="absolute right-3 top-1/2 -translate-y-1/2">{rightIcon}</span>}
      </div>
      {error && <span className="text-[11px] text-red-500 font-semibold mt-0.5 block">{error}</span>}
    </label>
  );
}

function PaywallScreen({ user, onSubscribed, onSignOut }) {
  const { currency, region } = useCurrency();
  const cur = CURRENCIES[currency] || CURRENCIES.USD;
  const localPrice = (planId) => (planId === "yearly" ? cur.yearly : cur.monthly);
  const fmt = useMemo(() => makeFormatter(currency), [currency]);

  const [selected, setSelected] = useState("yearly"); // default to best value
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showCard, setShowCard] = useState(false);

  /* Two-step trial start:
       1) User taps "Start free trial" → CardCaptureSheet opens.
       2) User enters card + submits → onCardConfirmed() completes the flow.
     On iOS this is short-circuited by Apple IAP, which uses the card
     already on the Apple ID; leave this component in place but wrap the
     StoreKit call inside onCardConfirmed. */
  const openCardSheet = () => {
    hapticTap();
    setShowCard(true);
  };

  const onCardConfirmed = (card) => {
    setShowCard(false);
    setLoading(true);
    setTimeout(() => {
      hapticSuccess();
      const now = Date.now();
      const sub = {
        plan: selected,
        status: "trial",
        trialStartedAt: now,
        trialEndsAt: now + TRIAL_MS,
        renewsAt: now + TRIAL_MS, // first charge happens at trial end
        productId: `com.yourcompany.splitright.${selected}`,
        // Only the *safe* card details are persisted — never the full PAN.
        paymentMethod: {
          brand: card.brand,
          brandName: card.brandName,
          brandIcon: card.brandIcon,
          brandColor: card.brandColor,
          last4: card.last4,
          expMonth: card.expMonth,
          expYear: card.expYear,
          token: card.token
        }
      };
      onSubscribed(sub);
    }, 700);
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

        {/* DEMO MODE banner — clearly disclose this is not a real charge.
            Remove this block when wiring real StoreKit / Capacitor IAP for App Store release. */}
        <div className="mt-5 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
          <i className="fa-solid fa-circle-info text-amber-600 mt-0.5"></i>
          <div className="flex-1">
            <div className="text-[13px] font-bold text-amber-900">Demo mode — no real charges</div>
            <div className="text-[11px] text-amber-800 leading-relaxed mt-0.5">
              This preview lets you try every feature free. Real billing turns on when the app ships on the App Store via Apple In-App Purchase.
            </div>
          </div>
        </div>

        <div className="mt-6 text-center pop-in">
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
        <button className="btn-primary" onClick={openCardSheet} disabled={loading}>
          {loading ? (
            <><i className="fa-solid fa-circle-notch fa-spin mr-2"></i> Starting trial…</>
          ) : (
            <><i className="fa-solid fa-lock mr-2"></i> Start 7-day free trial</>
          )}
        </button>
        <p className="text-[11px] text-slate-500 text-center mt-2 leading-relaxed px-2">
          Free for 7 days, then <b>{fmt(price)}/{plan.per}</b> starting <b>{firstCharge}</b>.<br/>
          Region: <b>{REGIONS[region]?.flag} {REGIONS[region]?.name}</b> · Cancel anytime · Auto-renews until canceled.
        </p>
        {/* Required by Apple Guideline 3.1.2: subscription paywalls must link to Terms + Privacy. */}
        <p className="text-[10px] text-slate-400 text-center mt-1.5 leading-relaxed">
          By starting, you agree to our{" "}
          <a href="/legal/terms" target="_blank" rel="noopener noreferrer" className="text-brand-600 font-semibold underline">Terms</a>
          {" "}and{" "}
          <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-brand-600 font-semibold underline">Privacy Policy</a>.
          Payment is charged to the card you provide. Subscription auto-renews unless canceled at least 24h before the period ends. Manage from Account → Cancel subscription. On iOS, App Store IAP replaces this flow.
        </p>
      </div>

      {/* Card capture bottom sheet — opens when the user taps "Start free trial". */}
      <CardCaptureSheet
        open={showCard}
        onClose={() => setShowCard(false)}
        onConfirm={onCardConfirmed}
        plan={plan}
        price={price}
        firstCharge={firstCharge}
        currencyFmt={fmt}
      />
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
function AccountScreen({ user, subscription, onClose, onSignOut, onCancel, onOpenHistory }) {
  const { theme, setTheme, history } = useApp();
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
          {subscription?.paymentMethod && (
            <div className="mt-4 flex items-center gap-3 rounded-2xl p-3"
                 style={{ background: "rgba(201,162,75,0.10)", border: "1px solid rgba(201,162,75,0.25)" }}>
              <span className="w-10 h-10 rounded-lg flex items-center justify-center bg-white shadow-sm dark:bg-slate-800">
                <i className={`fa-brands ${subscription.paymentMethod.brandIcon} text-xl`}
                   style={{ color: subscription.paymentMethod.brandColor }}></i>
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Payment method</div>
                <div className="text-sm font-bold text-ink-900 truncate">
                  {subscription.paymentMethod.brandName} · •••• {subscription.paymentMethod.last4}
                </div>
              </div>
              <span className="text-[11px] font-semibold text-slate-500 tabular-nums">
                exp {subscription.paymentMethod.expMonth}/{subscription.paymentMethod.expYear}
              </span>
            </div>
          )}
          <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
            On iOS, manage your subscription in Settings → Apple ID → Subscriptions.
          </p>
        </div>
      </div>

      {/* Activity — opens the full history list */}
      <div className="px-5 mt-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">Activity</h2>
        <div className="card overflow-hidden">
          <button
            onClick={() => { hapticTap(); onOpenHistory && onOpenHistory(); }}
            className="flex items-center gap-3 p-4 w-full text-left active:bg-slate-50"
          >
            <span className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ background: "rgba(212, 175, 55, 0.12)", color: "#B8860B" }}>
              <i className="fa-solid fa-clock-rotate-left"></i>
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm text-ink-900">Split history</div>
              <div className="text-[11px] text-slate-400">
                {history.length === 0 ? "Your past splits will appear here" :
                 `${history.length} split${history.length === 1 ? "" : "s"} saved`}
              </div>
            </div>
            <i className="fa-solid fa-chevron-right text-slate-400 text-xs"></i>
          </button>
        </div>
      </div>

      {/* Appearance — System / Light / Dark */}
      <div className="px-5 mt-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">Appearance</h2>
        <div className="card p-3">
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: "system", label: "System", icon: "fa-circle-half-stroke" },
              { id: "light",  label: "Light",  icon: "fa-sun" },
              { id: "dark",   label: "Dark",   icon: "fa-moon" }
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setTheme(opt.id)}
                className={`rounded-xl py-3 px-2 text-center transition active:scale-95 ${
                  theme === opt.id
                    ? "bg-brand-600 text-white shadow-pop"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800"
                }`}
              >
                <i className={`fa-solid ${opt.icon} block mb-1 text-base`}></i>
                <span className="text-[11px] font-bold">{opt.label}</span>
              </button>
            ))}
          </div>
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
          <LinkRow icon="fa-file-lines"    label="Terms of Service" href="/legal/terms" />
          <LinkRow icon="fa-shield-halved" label="Privacy Policy"   href="/legal/privacy" />
          <LinkRow icon="fa-headset"       label="Contact support"  href="/legal/support" last />
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

function LinkRow({ icon, label, last, href = "#", external = true }) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className={`flex items-center gap-3 p-4 ${last ? "" : "border-b border-slate-100"} active:bg-slate-50`}
    >
      <span className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center">
        <i className={`fa-solid ${icon}`}></i>
      </span>
      <span className="flex-1 font-semibold text-sm text-ink-900">{label}</span>
      <i className="fa-solid fa-arrow-up-right-from-square text-slate-400 text-[10px]"></i>
    </a>
  );
}

/* =========================================================================
   HistoryScreen — list of past splits, with two views:
     1. List view  — every saved split, newest first, with a friends panel
                     showing per-friend cumulative totals.
     2. Detail view — full breakdown of one historical split (items, people,
                     totals, per-person paid status).
   The user can mark/unmark people as paid retroactively, delete one entry,
   or clear everything. All data lives in `splitright.v1.history` in
   localStorage.
   ========================================================================= */
function HistoryScreen({ onClose, showToast }) {
  const { history, updateHistoryEntry, removeHistoryEntry, clearHistory } = useApp();
  const fmt = useFmt();
  const [openId, setOpenId] = useState(null);
  const [showFriends, setShowFriends] = useState(false);

  /* Aggregate per-friend totals across every saved split.
     Friends are identified by their name (case-insensitive trimmed) since
     ids are regenerated on every split. We also track:
       - splits[]   — list of past splits they appeared in
       - paidTotal  — sum of their shares already marked as paid
       - openTotal  — sum of their shares still unpaid
   */
  const friendsAgg = useMemo(() => {
    const map = new Map();
    for (const entry of history) {
      for (const b of entry.breakdown || []) {
        const key = (b.name || "").trim().toLowerCase();
        if (!key) continue;
        if (!map.has(key)) {
          map.set(key, {
            name: b.name.trim(),
            color: b.color || "#6366F1",
            total: 0,
            paidTotal: 0,
            openTotal: 0,
            count: 0,
            splits: []
          });
        }
        const f = map.get(key);
        f.total += b.total;
        if (b.paid) f.paidTotal += b.total;
        else f.openTotal += b.total;
        f.count += 1;
        f.splits.push({
          historyId: entry.id,
          restaurant: entry.restaurant,
          savedAt: entry.savedAt,
          amount: b.total,
          paid: !!b.paid
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [history]);

  const openEntry = history.find((h) => h.id === openId);

  const dateLabel = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yest.toDateString();
    if (sameDay) return "Today · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (isYesterday) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  };

  const togglePaid = (entry, personId) => {
    const wasPaid = entry.breakdown.find((b) => b.personId === personId)?.paid;
    if (!wasPaid) hapticSuccess(); else hapticTap();
    const next = entry.breakdown.map((b) =>
      b.personId === personId ? { ...b, paid: !b.paid } : b
    );
    updateHistoryEntry(entry.id, { breakdown: next });
  };

  const deleteEntry = (entry) => {
    if (!confirm(`Delete the split for ${entry.restaurant}?`)) return;
    hapticTap();
    removeHistoryEntry(entry.id);
    if (openId === entry.id) setOpenId(null);
    showToast && showToast("Split deleted");
  };

  const clearAll = () => {
    if (history.length === 0) return;
    if (!confirm("Clear your entire split history? This can't be undone.")) return;
    hapticTap();
    clearHistory();
    setOpenId(null);
    setShowFriends(false);
    showToast && showToast("History cleared");
  };

  /* -------------------- Detail view -------------------- */
  if (openEntry) {
    const paidCount = openEntry.breakdown.filter((b) => b.paid).length;
    const totalCount = openEntry.breakdown.length;
    const allPaid = paidCount > 0 && paidCount === totalCount;
    return (
      <div className="app-shell flex flex-col">
        <Header
          title={openEntry.restaurant}
          subtitle={dateLabel(openEntry.savedAt)}
          onBack={() => setOpenId(null)}
        />

        <div className="px-5 mt-2">
          <div className="card p-5 bg-gradient-to-br from-brand-600 to-brand-700 text-white">
            <div className="flex items-center justify-between">
              <span className="text-white/80 text-sm font-semibold uppercase tracking-wider">Grand total</span>
              <i className="fa-solid fa-receipt text-white/70"></i>
            </div>
            <div className="text-4xl font-black mt-1 tracking-tight">{fmt(openEntry.grandTotal)}</div>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-white/80">Subtotal {fmt(openEntry.subtotal || 0)}</span>
              <span className="text-white/80">Tax {fmt(openEntry.tax || 0)}</span>
              <span className="text-white/80">Tip {fmt(openEntry.tip || 0)}</span>
            </div>
            {allPaid && (
              <div className="mt-3 pt-3 border-t border-white/20 flex items-center gap-2 text-sm font-bold">
                <i className="fa-solid fa-circle-check"></i> Everyone paid
              </div>
            )}
          </div>
        </div>

        <div className="px-5 mt-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">People &amp; what they paid</h2>
          <div className="card overflow-hidden">
            {openEntry.breakdown.map((b, idx) => (
              <div
                key={b.personId}
                className={`flex items-center gap-3 p-4 ${idx < openEntry.breakdown.length - 1 ? "border-b border-slate-100" : ""} ${b.paid ? "paid-row" : ""}`}
              >
                <span className="avatar" style={{ background: b.color }}>{initialsOf(b.name)}</span>
                <div className="flex-1 min-w-0">
                  <div className={`font-bold text-sm text-ink-900 ${b.paid ? "paid-strike" : ""}`}>{b.name}</div>
                  <div className="text-[11px] text-slate-400">
                    Items {fmt(b.subtotal)} · Tax {fmt(b.tax)} · Tip {fmt(b.tip)}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-black text-base tabular-nums ${b.paid ? "paid-strike text-slate-400" : "text-ink-900"}`}>
                    {fmt(b.total)}
                  </div>
                  <button
                    onClick={() => togglePaid(openEntry, b.personId)}
                    className={`mt-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                      b.paid
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-slate-100 text-slate-500 active:bg-slate-200"
                    }`}
                  >
                    {b.paid ? "✓ Paid" : "Mark paid"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {openEntry.items && openEntry.items.length > 0 && (
          <div className="px-5 mt-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">Items ordered</h2>
            <div className="card overflow-hidden">
              {openEntry.items.map((it, idx) => {
                const assignedIds = (openEntry.assignments && openEntry.assignments[it.id]) || [];
                const assignedNames = assignedIds
                  .map((pid) => (openEntry.people || []).find((p) => p.id === pid)?.name)
                  .filter(Boolean);
                return (
                  <div
                    key={it.id || idx}
                    className={`flex items-center gap-3 p-3.5 ${idx < openEntry.items.length - 1 ? "border-b border-slate-100" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm text-ink-900 truncate">{it.name}</div>
                      {assignedNames.length > 0 && (
                        <div className="text-[11px] text-slate-400 truncate">
                          <i className="fa-solid fa-user-group mr-1 text-[9px]"></i>
                          {assignedNames.join(", ")}
                        </div>
                      )}
                    </div>
                    <div className="font-bold text-sm text-ink-900 tabular-nums">{fmt(it.price)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="px-5 mt-4 mb-6">
          <button onClick={() => deleteEntry(openEntry)} className="btn-secondary text-red-600">
            <i className="fa-solid fa-trash mr-2"></i> Delete this split
          </button>
        </div>
      </div>
    );
  }

  /* -------------------- List view -------------------- */
  return (
    <div className="app-shell flex flex-col">
      <Header
        title="History"
        subtitle={history.length === 0 ? "Your past splits will appear here" : `${history.length} split${history.length === 1 ? "" : "s"}`}
        onBack={onClose}
        right={history.length > 0 ? (
          <button
            onClick={clearAll}
            className="text-[11px] font-bold text-red-500 uppercase tracking-wider px-2 py-1 active:scale-95"
          >
            Clear
          </button>
        ) : null}
      />

      {history.length === 0 ? (
        <div className="px-5 mt-8">
          <div className="card p-8 text-center">
            <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center mb-3"
                 style={{ background: "rgba(212, 175, 55, 0.15)", color: "#B8860B" }}>
              <i className="fa-solid fa-clock-rotate-left text-2xl"></i>
            </div>
            <div className="font-bold text-ink-900 mb-1">No splits yet</div>
            <div className="text-sm text-slate-500">
              Every bill you split will show up here so you can revisit who ordered what.
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Friends toggle */}
          {friendsAgg.length > 0 && (
            <div className="px-5 mt-1 mb-3">
              <div className="flex bg-slate-100 dark:bg-slate-800 rounded-2xl p-1">
                <button
                  onClick={() => setShowFriends(false)}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold transition ${!showFriends ? "bg-white text-ink-900 shadow-sm dark:bg-slate-700 dark:text-white" : "text-slate-500"}`}
                >
                  <i className="fa-solid fa-receipt mr-1.5"></i> Splits
                </button>
                <button
                  onClick={() => setShowFriends(true)}
                  className={`flex-1 py-2 rounded-xl text-xs font-bold transition ${showFriends ? "bg-white text-ink-900 shadow-sm dark:bg-slate-700 dark:text-white" : "text-slate-500"}`}
                >
                  <i className="fa-solid fa-user-group mr-1.5"></i> Friends ({friendsAgg.length})
                </button>
              </div>
            </div>
          )}

          {showFriends ? (
            /* ─── Friends aggregate view ─── */
            <div className="px-5 space-y-2 pb-6">
              {friendsAgg.map((f) => (
                <div key={f.name} className="card p-4">
                  <div className="flex items-center gap-3">
                    <span className="avatar" style={{ background: f.color }}>{initialsOf(f.name)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-ink-900 truncate">{f.name}</div>
                      <div className="text-[11px] text-slate-400">
                        {f.count} split{f.count === 1 ? "" : "s"} · lifetime {fmt(f.total)}
                      </div>
                    </div>
                    <div className="text-right">
                      {f.openTotal > 0.005 ? (
                        <>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-amber-600">Owes</div>
                          <div className="font-black text-amber-600 tabular-nums">{fmt(f.openTotal)}</div>
                        </>
                      ) : (
                        <>
                          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-600">Settled</div>
                          <div className="font-black text-emerald-600 tabular-nums">{fmt(f.paidTotal)}</div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Mini list of splits this friend appeared in */}
                  <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 space-y-1.5">
                    {f.splits.slice(0, 4).map((s, i) => (
                      <button
                        key={i}
                        onClick={() => { hapticTap(); setOpenId(s.historyId); setShowFriends(false); }}
                        className="w-full flex items-center gap-2 text-left active:opacity-60"
                      >
                        <i className={`fa-solid ${s.paid ? "fa-circle-check text-emerald-500" : "fa-circle text-slate-300"} text-[10px]`}></i>
                        <span className="text-xs text-slate-600 dark:text-slate-300 truncate flex-1">{s.restaurant}</span>
                        <span className="text-[10px] text-slate-400">{dateLabel(s.savedAt).split(" ·")[0]}</span>
                        <span className={`text-xs font-bold tabular-nums ${s.paid ? "text-slate-400 paid-strike" : "text-ink-900 dark:text-white"}`}>{fmt(s.amount)}</span>
                      </button>
                    ))}
                    {f.splits.length > 4 && (
                      <div className="text-[10px] text-slate-400 text-center pt-1">+ {f.splits.length - 4} more</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* ─── Splits list view ─── */
            <div className="px-5 space-y-2 pb-6">
              {history.map((entry) => {
                const paidCount = entry.breakdown.filter((b) => b.paid).length;
                const totalCount = entry.breakdown.length;
                const allPaid = paidCount > 0 && paidCount === totalCount;
                const someUnpaid = totalCount > 0 && paidCount < totalCount;
                return (
                  <button
                    key={entry.id}
                    onClick={() => { hapticTap(); setOpenId(entry.id); }}
                    className="card p-4 w-full text-left active:scale-[0.99] transition"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                           style={{ background: "rgba(212, 175, 55, 0.12)", color: "#B8860B" }}>
                        <i className="fa-solid fa-utensils"></i>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-bold text-ink-900 truncate flex-1">{entry.restaurant}</div>
                          {allPaid && (
                            <span className="badge" style={{ background: "#D1FAE5", color: "#065F46" }}>
                              <i className="fa-solid fa-check text-[9px]"></i> Settled
                            </span>
                          )}
                          {someUnpaid && (
                            <span className="badge" style={{ background: "#FEF3C7", color: "#92400E" }}>
                              {totalCount - paidCount} owe
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">{dateLabel(entry.savedAt)}</div>

                        {/* Person chips */}
                        <div className="mt-2 flex items-center gap-1 flex-wrap">
                          {entry.breakdown.slice(0, 6).map((b) => (
                            <span
                              key={b.personId}
                              className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                              style={{
                                background: b.paid ? "rgba(16, 185, 129, 0.12)" : "rgba(148, 163, 184, 0.12)",
                                color: b.paid ? "#047857" : "#475569"
                              }}
                            >
                              <span className="w-3 h-3 rounded-full" style={{ background: b.color }}></span>
                              {b.name.split(" ")[0]}
                            </span>
                          ))}
                          {entry.breakdown.length > 6 && (
                            <span className="text-[10px] text-slate-400">+{entry.breakdown.length - 6}</span>
                          )}
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="font-black text-ink-900 tabular-nums">{fmt(entry.grandTotal)}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {totalCount} {totalCount === 1 ? "person" : "people"}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      <div className="flex-1"></div>
    </div>
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
  const [showHistory, setShowHistory] = useState(false);
  // Region + currency: persisted if present, otherwise auto-detect from browser
  const initialRegion = initial.region && REGIONS[initial.region] ? initial.region : detectRegion();
  const [region, setRegion] = useState(initialRegion);
  const [currency, setCurrency] = useState(
    initial.currency && CURRENCIES[initial.currency]
      ? initial.currency
      : (REGIONS[initialRegion]?.currency || "USD")
  );
  /* Theme: "system" | "light" | "dark". The pre-React inline script in
     index.tsx already applied the correct class on <html> to avoid flash;
     here we just keep React state in sync and react to changes. */
  const [theme, setThemeState] = useState(initial.theme || "system");
  useEffect(() => {
    const apply = () => {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const isDark = theme === "dark" || (theme === "system" && prefersDark);
      document.documentElement.classList.toggle("dark", isDark);
    };
    apply();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => apply();
      mq.addEventListener?.("change", handler);
      return () => mq.removeEventListener?.("change", handler);
    }
  }, [theme]);
  const setTheme = (t) => { hapticTap(); setThemeState(t); };

  /* History — list of past splits. Each entry:
       { id, savedAt, restaurant, currency, grandTotal, taxRate, tipPct,
         items: [{id,name,price}],
         people: [{id,name,color,phone,email}],
         assignments: { itemId: [personId,...] },
         breakdown: [{ personId, name, color, subtotal, tax, tip, total, paid }] } */
  const [history, setHistory] = useState(Array.isArray(initial.history) ? initial.history : []);

  // Persist whenever user/subscription/locale/theme/history changes
  useEffect(() => { saveState({ user, subscription, region, currency, theme, history }); }, [user, subscription, region, currency, theme, history]);

  // Build the currency context value (memoized so child components don't re-render unnecessarily)
  const currencyCtx = useMemo(() => ({
    region, currency, setRegion, setCurrency,
    fmt: makeFormatter(currency)
  }), [region, currency]);

  // History helpers (memoized to keep AppContext stable)
  const addHistoryEntry = useCallback((entry) => {
    setHistory((cur) => [{ ...entry, id: entry.id || uid(), savedAt: entry.savedAt || Date.now() }, ...cur].slice(0, 100));
  }, []);
  const updateHistoryEntry = useCallback((id, patch) => {
    setHistory((cur) => cur.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  }, []);
  const removeHistoryEntry = useCallback((id) => {
    setHistory((cur) => cur.filter((h) => h.id !== id));
  }, []);
  const clearHistory = useCallback(() => setHistory([]), []);

  const appCtx = useMemo(() => ({
    theme, setTheme,
    history, addHistoryEntry, updateHistoryEntry, removeHistoryEntry, clearHistory
  }), [theme, history, addHistoryEntry, updateHistoryEntry, removeHistoryEntry, clearHistory]);

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
    // "ai"     → vision LLM returned items
    // "ocr"    → Tesseract returned items
    // "failed" → neither produced anything; show the user a friendly note
    let source = "ai";
    if (payload.ocrFailed) source = "failed";
    else if (payload.manual) source = "ocr";
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
  } else if (showHistory) {
    body = (
      <HistoryScreen
        onClose={() => setShowHistory(false)}
        showToast={showToast}
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
        onOpenHistory={() => { setShowAccount(false); setShowHistory(true); }}
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
        onOpenHistory={() => setShowHistory(true)}
        hasHistory={history.length > 0}
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
        items={items}
        assignments={assignments}
        taxRate={taxRate}
        tipPct={tipPct}
        restaurant={restaurant}
        onBack={() => setScreen("tip")}
        onDone={reset}
        showToast={showToast}
      />
    );
  }

  return (
    <AppContext.Provider value={appCtx}>
      <CurrencyContext.Provider value={currencyCtx}>
        {body}
        <Toast message={toast} onDone={() => setToast("")} />
      </CurrencyContext.Provider>
    </AppContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
