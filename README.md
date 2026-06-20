# SplitRight

> Split bills the right way. Scan a receipt, tap who ordered what, send payment requests in seconds.

## Project Overview
- **Name**: SplitRight
- **Goal**: Make it effortless for groups at restaurants to fairly split a bill — including tax and tip — and instantly send payment requests via Venmo, Cash App, or PayPal.
- **Tech**: Single-file React app (with Tailwind via CDN), served from a Hono backend on Cloudflare Pages.

## Currently Completed Features

| # | Feature | Status |
|---|---------|--------|
| 1 | Clean, modern, premium mobile-first UI (Tailwind + Inter, bold colors, rounded cards) | ✅ |
| 2 | **Sign-In screen** — Continue with Google / Apple / Email (mocked, ready to be swapped for real OAuth). State persists in `localStorage`. | ✅ |
| 3 | **Paywall** — 7-day free trial, then **$4.99/month** or **$39.99/year (save 33%)**, with "Restore purchases", legal-compliant disclosure of price, renewal date, and "cancel anytime" | ✅ |
| 4 | **Account screen** — shown via avatar in the top-right; displays user, plan, days left in trial, first-charge date, and Cancel Subscription button | ✅ |
| 5 | **🆕 Real receipt scanning** — opens the camera via `<input type="file" capture="environment">` → photo is downscaled and sent to `POST /api/scan-receipt` (OpenAI vision); when no key is configured, falls back to **Tesseract.js in-browser OCR** with a live progress bar. "Try sample" and "Enter manually" shortcuts also available. | ✅ |
| 6 | **🆕 Review-and-edit screen** — after the scan returns items, every row is inline-editable (name + price), add row / remove row / rename the restaurant. The AI is never expected to be perfect. | ✅ |
| 7 | **People screen** — add/remove people, name + 8-color tag picker, edit colors inline | ✅ |
| 8 | **Items screen** — receipt items, multi-person assignment via tap-pills, "Everyone" shortcut, add/remove custom items, live "$/person" preview when shared | ✅ |
| 9 | **Tip selector** — 10% / 15% / 20% / Custom %, live amount preview | ✅ |
| 10 | **Tax** — adjustable slider (0–15%), pre-filled at 8.75% | ✅ |
| 11 | **Summary screen** — per-person breakdown (items + tax share + tip share + total), expandable details, grand total card | ✅ |
| 12 | **Send Requests screen** — generates a payment message per person, "Copy message" + native "Share". **Only PayPal is wired up — Venmo and Cash App are temporarily disabled** (rendered as "Coming soon" tiles). | ✅ |
| 13 | **Sample receipt** — "The Iron Skillet" with 10 items so you can test every screen instantly | ✅ |
| 14 | **PWA manifest + iOS meta tags** — installable to home screen, App-Store-wrapper-ready | ✅ |
| 15 | **🆕 Region & multi-currency** — 17 regions (US, UK, Ireland, Germany, France, Spain, Italy, Netherlands, Switzerland, Canada, Australia, Japan, South Korea, China, India, Brazil, Mexico) and 12 currencies (USD, EUR, GBP, JPY, CAD, AUD, INR, CNY, KRW, BRL, MXN, CHF). Auto-detected from the browser's locale on first launch, picked manually from the Account screen, persisted in `localStorage`. Changes the symbol, decimal places, locale-correct number formatting (€1.234,56 vs $1,234.56), default tip + VAT/tax rates per country, and which payment apps appear on the Send screen. | ✅ |
| 16 | **🆕 Smarter region detection** — In addition to `navigator.language`, also reads the browser's **IANA timezone** (`Intl.DateTimeFormat().resolvedOptions().timeZone`) so that English-language phones used outside the US still get the right region & currency on first launch. Order of priority: timezone → browser locale country → language → US fallback. | ✅ |
| 17 | **🆕 Per-person phone & email** — On the People screen, each person card has a discrete "address card" button that expands an inline form for **phone** + **email** (optional). Saved into the same person object; the existing color picker / delete / "Continue" UI is unchanged. A small green **`✓ contact`** badge appears next to the name once any contact field is filled. | ✅ |
| 18 | **🆕 SMS & Email send (recipient doesn't need the app)** — On the Send screen, each person's card now shows two prominent buttons: **Text [Name]** (opens the user's native SMS app with the recipient's phone + the full breakdown pre-filled via `sms:` deep link) and **Email [Name]** (opens the mail client with subject + body pre-filled via `mailto:`). If the friend has no phone/email saved, the button greys out with a "No phone"/"No email" label and tapping it shows a toast pointing back to the People step. The recipient just gets a normal text message or email — they don't need to install anything. The existing PayPal button continues to work in parallel. | ✅ |
| 19 | **🐛 Fixed: app failing to render** — Pinned `@babel/standalone` to `7.25.6` (was previously loading whatever was newest from unpkg). The unpinned latest 8.x betas were emitting ESM `import` helpers in the transformed output, which then crashed the classic `<script type="text/babel">` loader with `Cannot use import statement outside a module` and the app never rendered. Also switched the script's `data-presets` from `"env,react"` to just `"react"`, removing the unnecessary ES5 transpile step that triggered the issue. | ✅ |

### Flow on first launch
```
Sign-In  →  Paywall  →  Scan (camera) ──┐
                        Enter manually ─┤→ Review items → People → Items → Tip & Tax → Summary → Send
                        Try sample ─────┘
   ↑           ↑
   └── Sign out / Cancel ──── Account screen (via avatar top-right)
```
Auth + subscription are persisted in `localStorage` under the key `splitright.v1`, so closing and re-opening the tab keeps you signed in and inside your trial. To replay the full first-launch flow, open DevTools → Application → Local Storage → delete `splitright.v1` and refresh.

## Functional Entry URIs

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Renders the SplitRight React SPA (HTML shell + CDNs + Tesseract.js) |
| `/api/scan-receipt` | POST | Body: `{ image: "data:image/jpeg;base64,..." }` → returns `{ ok: true, restaurant, items, taxRate }` from gpt-5-mini vision, OR `{ ok: false, useClientOcr: true, reason }` to signal the client to run Tesseract.js locally |
| `/static/app.jsx` | GET | The full single-file React app (JSX, compiled in-browser by Babel) |
| `/static/style.css` | GET | Premium component styling |
| `/static/manifest.webmanifest` | GET | PWA manifest for installable web app |
| `/static/favicon.svg` | GET | App icon |

### Switching on real OpenAI vision
The endpoint already works — it just needs a key. With no key set, the endpoint returns `{ ok: false, useClientOcr: true, reason: "no-key"}` and the client transparently falls back to Tesseract.js, so the app **always works**.
```bash
# local dev
echo 'OPENAI_API_KEY=sk-...' >> /home/user/webapp/.dev.vars
# production on Cloudflare Pages
cd /home/user/webapp && npx wrangler pages secret put OPENAI_API_KEY --project-name webapp
```

## Data Architecture
- **Data Models**:
  - `Person { id, name, color, phone?, email? }` (phone/email are optional, used for one-tap SMS / mailto deep links on the Send screen — the recipient never has to download the app)
  - `Item   { id, name, price }`
  - `Assignments { [itemId]: [personId, ...] }`
  - `Receipt { restaurant, items, taxRate }` (from the scan)
  - `Currency { code, symbol, name, locale, decimals, monthly, yearly }` (12 entries)
  - `Region { code, flag, name, currency, defaultTip, defaultTax, providers }` (17 entries)
  - `TipPct: number (0..1)`, `TaxRate: number (0..1)`
- **Localization**: All money is formatted through `Intl.NumberFormat(locale, { style: "currency", currency })`, so JPY/KRW render with zero decimals, EUR uses `1.234,56`, INR uses the lakh grouping, etc.
- **Storage**: `localStorage` under `splitright.v1` for user + subscription + region + currency. Per-receipt state is in React only (cleared on Done / Sign out).
- **Math** (`computeTotals` in `app.jsx`):
  - Each item's price is split evenly between its assigned people.
  - Tax and tip are computed against the pre-tax subtotal, then **allocated proportionally** to each person based on their item subtotal share. This is the fairest method (people who ate more pay more tax/tip).

## User Guide

1. **Open the app.** You land on the Scan screen.
2. Tap **"Scan receipt"** (simulated OCR), or skip it via **"Or use sample receipt →"**.
3. **Add people** to the table — type a name, pick a color, tap `+`. The sample data already has 4 people (Alex, Jordan, Sam, Taylor).
4. Tap **Continue**. On the Items screen, **tap a person's pill on each item** to assign it. Multiple people on the same item = shared cost. Use **"Everyone"** for shared starters/drinks.
5. Tap **Next: Tip & Tax**. Pick a tip preset or enter a custom %, adjust tax if needed.
6. Tap **See the split**. Review each person's total. Tap any row to expand the breakdown (items / tax share / tip share / total).
7. Tap **Send payment requests**. Enter your @handle, pick Venmo / Cash App / PayPal.
8. For each person: tap **Copy message** (clipboard) or **Share** (native share sheet), or tap the colored **Request** button to open the chosen payment app pre-filled with the amount.

## Deployment

- **Platform**: Cloudflare Pages (via Hono + Vite + Wrangler)
- **Local URL**: http://localhost:3000
- **Public sandbox URL**: see `GetServiceUrl` output (active session)
- **Production**: not yet deployed (`npm run deploy` is wired up; needs Cloudflare API key)
- **Status**: ✅ Active locally
- **Tech Stack**: Hono · React 18 (CDN) · TailwindCSS (CDN) · FontAwesome · Vite · Wrangler · PM2
- **Last Updated**: 2026-05-15

### Local commands
```bash
npm run build                    # build dist/
pm2 start ecosystem.config.cjs   # run on :3000
pm2 logs webapp --nostream       # check logs
pm2 restart webapp               # restart
```

## Publishing to the App Store

This is a web app, so the App Store path is to **wrap it as a hybrid native iOS app**. Two recommended approaches:

### Option A — Capacitor (recommended, modern, lightweight)
```bash
# from /home/user/webapp
npm install --save @capacitor/core @capacitor/ios
npm install --save-dev @capacitor/cli
npx cap init SplitRight com.yourcompany.splitright --web-dir=dist

# Auth + IAP plugins
npm install --save @codetrix-studio/capacitor-google-auth   # Google Sign-In
npm install --save @capacitor-community/apple-sign-in       # required by Apple if you offer Google
npm install --save @capacitor-community/in-app-purchases    # StoreKit subscriptions

npm run build
npx cap add ios
npx cap copy ios
npx cap open ios     # opens Xcode on a Mac
```
Then in Xcode:
1. Set the team / bundle id (`com.yourcompany.splitright`).
2. Add app icons (1024×1024 master + the asset catalog set) and a launch screen.
3. Add **`NSCameraUsageDescription`** to `Info.plist` (required for the real-camera OCR you'll wire in to replace the simulated scanner): *"SplitRight uses the camera to scan restaurant receipts."*
4. **Enable capabilities**: *Sign in with Apple* and *In-App Purchase*.
5. Archive → Distribute App → App Store Connect.

### Wiring up the real auth + subscription

The current `SignInScreen` and `PaywallScreen` are mocked with `setTimeout` so the demo runs anywhere. Swap the two mocked functions for real calls:

```ts
// SignInScreen.signIn()
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
const result = await GoogleAuth.signIn();
const user = { name: result.name, email: result.email, avatar: result.imageUrl, provider: 'google' };
onSignedIn(user);
```

```ts
// PaywallScreen.startTrial()
import { InAppPurchases } from '@capacitor-community/in-app-purchases';
const productId = `com.yourcompany.splitright.${selected}`;     // 'monthly' | 'yearly'
const result = await InAppPurchases.purchaseProduct({ productIdentifier: productId });
// Then verify result.receipt on your server with Apple's verifyReceipt endpoint,
// and set the local subscription state from that verified response.
```

### App Store Connect setup for the subscription
1. **App Store Connect → Your App → Subscriptions** → create a **Subscription Group** called *SplitRight Premium*.
2. Inside the group add two auto-renewable products:
   - `com.yourcompany.splitright.monthly` — $4.99 / 1 month
   - `com.yourcompany.splitright.yearly`  — $39.99 / 1 year
3. On each product, add an **Introductory Offer → Free Trial → 7 days** (same offer on both so users can switch plans without losing the trial).
4. Fill in localized display name + description (Apple Review will reject if blank).
5. Upload promotional review screenshot of the paywall.

### Why Stripe / your own card form won't pass review
Apple's Guideline 3.1.1 requires **all** digital subscriptions to be processed via StoreKit IAP. The paywall in this build doesn't ship a card form — it just shows the price and a "Start 7-day free trial" CTA — which is exactly what App Review wants. Just connect the button to `InAppPurchases.purchaseProduct(...)` and you're compliant.

### Option B — PWA + PWABuilder
1. Deploy to a real domain (`npm run deploy` to Cloudflare Pages).
2. Go to https://www.pwabuilder.com/, enter your URL, generate the iOS package, submit through App Store Connect.

### App Store requirements already handled in this build
- ✅ `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title` meta tags
- ✅ `theme-color`, `viewport-fit=cover`, safe-area-inset CSS (`env(safe-area-inset-*)`) so the UI respects notches and home indicators
- ✅ Full `manifest.webmanifest` with name, short_name, icons, categories, theme/background color
- ✅ Portrait-locked, no horizontal scroll, mobile-first 460px shell
- ✅ Reduced-motion support
- ✅ No third-party trackers / analytics
- ✅ All payment-app interactions are out-of-app deep links (no in-app purchase of digital goods → no IAP rules to comply with)

### App Store assets you'll still need to produce
- 1024×1024 app icon (master)
- iPhone screenshots (6.7" and 6.5" required — capture the Scan, Items, Summary, and Send screens)
- Short app description, keywords, privacy policy URL
- A real OCR pipeline for the "Scan receipt" button (e.g. Apple Vision `VNRecognizeTextRequest` in a tiny Capacitor plugin, or Google ML Kit, or send the image to an OCR API)

## Features Not Yet Implemented

- Real camera + on-device OCR (currently simulated with a 1.8s scan animation)
- Persistence (save splits to localStorage / iCloud / a backend so you can re-open a past split)
- Currency selection (USD-only right now)
- Multi-receipt support (one bill at a time)
- Group history (recent people you've split with)
- Apple Pay / Google Pay integration (currently deep-links into Venmo/Cash/PayPal only)
- Custom item editing (you can add/remove, but not yet rename/edit price inline)
- Receipt photo storage / sharing the actual receipt image in the request

## Recommended Next Steps

1. **Wire in real OCR** — easiest is Tesseract.js in the browser, but for production iOS use Apple Vision via a small Capacitor plugin (much faster and more accurate on-device).
2. **Add localStorage persistence** for `people`, `items`, `assignments` so refreshing doesn't reset state.
3. **Deploy to Cloudflare Pages** so the public URL is stable (`setup_cloudflare_api_key` + `npm run deploy`).
4. **Wrap with Capacitor** following Option A above, generate icons, submit to App Store Connect.
5. **Polish edge cases**: handle people-removal in the middle of assignment, undo last action, dark mode.
