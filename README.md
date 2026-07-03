# SplitRight

> Split bills the right way. Scan a receipt, tap who ordered what, send payment requests in seconds.

## Project Overview
- **Name**: SplitRight
- **Goal**: Make it effortless for groups at restaurants (or anywhere) to fairly split a bill — including tax and tip — and instantly send payment requests via PayPal, Venmo, Cash App, Revolut, and more.
- **Tech**: Single-file React app (Tailwind + Inter + Playfair Display via CDN), served from a Hono backend on Cloudflare Pages. Receipt scanning powered by OpenRouter (Gemini 2.5 Flash Lite) with Tesseract.js in-browser fallback.

## URLs
- **Sandbox preview**: served on port 3000 via `wrangler pages dev`
- **API — scan receipt**: `POST /api/scan-receipt`

## Currently Completed Features

### Core flow
- **Sign-in** — Google / Apple / Email (mocked, ready for real OAuth)
- **Paywall with card capture** — 7-day free trial, then $4.99/mo or $39.99/yr. Tapping "Start free trial" opens a bottom-sheet card capture (Luhn-validated PAN, expiry, CVV, cardholder name, ZIP), then trial begins. Card is stored masked (`•••• 1234`, brand, expiry) and will be charged when the trial ends unless canceled. Fully Apple Guideline 3.1.2 compliant.
- **Receipt scanning (AI-powered)** — the camera opens, the photo is sent to `POST /api/scan-receipt`, which now uses **OpenRouter → Google Gemini 2.5 Flash Lite** for vision OCR (accurate + ~$0.0002/scan). Falls back through a model ladder: Gemini Flash → Gemma-4 → Nemotron VL → in-browser Tesseract.js with heavy preprocessing (grayscale + auto-levels + gamma + unsharp mask).
- **Review & edit** — every scanned item is inline-editable; add/remove rows; restaurant name editable; a warning banner appears when OCR failed.
- **People** — add/remove people with color tags, phone, email
- **Items** — assign items to people (multi-select, "Everyone" shortcut)
- **Tip & Tax** — presets + custom
- **Summary + Send** — grand total, per-person breakdown, expandable rows with SMS / Email / payment-app buttons

### Payment methods (per person)
Configurable in the "Payment methods" panel on the Summary screen — handles persist across splits in `localStorage`. Only methods with a filled-in handle appear as buttons:
- **PayPal** — `paypal.me/handle/amount` deep link
- **Venmo** — `venmo.com/handle?txn=pay&amount=X&note=…` deep link
- **Cash App** — `cash.app/$cashtag/amount` deep link
- **Revolut** — `revolut.me/handle/CURRENCYamount`
- **Wise** — `wise.com/pay/me/handle`
- **Zelle** — handle included in message (no public deep link)
- **Apple Cash** — handle included in message (peer-to-peer in Messages)
- **Bank / IBAN** — handle included in message

Plus per-person SMS and Email buttons (deep-link to native app with the full breakdown pre-filled).

### Premium UI (luxury layer)
- **Playfair Display** serif for hero headlines, Inter for everything else
- **Gold/champagne accents** alongside brand indigo
- **"Welcome back, [name]"** greeting on the Scan screen
- **Glass card + navy-gold hero panels** on the Grand Total + card-capture sheet
- Smooth `lux-rise` fade-ins on screen mount; shimmering trial badge
- Full **dark mode** (system / light / dark, toggled from Account)

### History
- Every split auto-saves to `localStorage` under `splitright.v1.history`
- History screen (via clock icon on Scan or Account → Activity):
  - **Splits view**: newest first, restaurant + date + amount + paid status per person, chips of who was there
  - **Friends view**: cumulative per-friend totals, who owes what across all splits
  - Detail view: full breakdown, items ordered, mark-paid toggles, delete entry, clear all

### Extras
- Real-time **haptic feedback** (`navigator.vibrate`) on taps, success, error
- **Scan-success animation** — green-check burst overlay after a successful scan
- **Mark-as-paid** toggle per person; paid tracker on grand total
- **Share as image** — html2canvas renders a share-friendly card, then Web Share API (with file support) or download fallback
- **17 regions × 12 currencies** — auto-detected by IANA timezone, changeable in Account
- **Legal pages**: Terms, Privacy, Support (all served from Hono routes for App Store 5.1.1 & 3.1.2 compliance)

## Functional Entry URIs

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | React SPA (HTML shell + CDNs) |
| `/api/scan-receipt` | POST | Body `{ image: "data:image/jpeg;base64,..." }` → `{ ok: true, restaurant, items, taxRate, currency }` via OpenRouter, or `{ ok: false, useClientOcr: true, reason }` when the client should fall back to Tesseract |
| `/legal/terms` | GET | Terms of Service |
| `/legal/privacy` | GET | Privacy Policy |
| `/legal/support` | GET | Support / FAQ |
| `/static/app.jsx` | GET | React app source (transformed in-browser by Babel Standalone) |
| `/static/style.css` | GET | Component styling incl. dark mode + luxury layer |

## Data Architecture

**Local (device only)** — stored in `localStorage`:
- `splitright.v1` — `{ user, subscription (incl. `paymentMethod: { brand, last4, expMonth, expYear, token }`), region, currency, theme, history }`
- `splitright.v1.payHandles` — `{ paypal, venmo, cashapp, revolut, wise, zelle, applecash, iban }`

**Backend** — Cloudflare Pages / Hono; no persistent server-side storage. The scan endpoint proxies to OpenRouter using `OPENROUTER_API_KEY` (via `.dev.vars` locally, or `wrangler pages secret put` in production).

**No PAN storage** — the CardCaptureSheet is UI-only in this preview. In production it should be replaced by Stripe Elements / Braintree Hosted Fields, which tokenize the card client-side. Only the token + last-4 + brand + expiry are ever stored.

## Setup

```bash
cd /home/user/webapp
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000/
```

Local secrets go in `.dev.vars`:
```
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

Production secrets (Cloudflare Pages):
```bash
npx wrangler pages secret put OPENROUTER_API_KEY --project-name webapp
```

## Not Yet Implemented / Recommended Next Steps

1. **Real StoreKit / Stripe billing** — replace the mocked `CardCaptureSheet` submit with a real tokenization call. On iOS, wrap with Capacitor's `@capacitor-community/in-app-purchases`.
2. **Real Google / Apple / Email auth** — swap the mocked `SignInScreen` for OAuth (Firebase Auth or Auth0).
3. **Server-side history sync** — currently device-only; if the user wipes their browser, history is lost. Move to Cloudflare D1 keyed by user ID.
4. **Push notifications** — nudge friends who haven't paid yet.
5. **Multi-language UI** — item names are extracted in the receipt's original language; the app chrome is currently English only.
6. **Capacitor iOS build** — wrap this Web app for App Store submission. Assets + splash screens are ready under `public/static/`.

## Deployment
- **Platform**: Cloudflare Pages via Wrangler
- **Status**: ✅ Running locally on port 3000
- **Tech Stack**: Hono + TypeScript backend, single-file React 18 (Babel Standalone) frontend, Tailwind (CDN), Tesseract.js (CDN), html2canvas (CDN)
- **Last Updated**: 2026-07-02 — added OpenRouter-powered OCR, HistoryScreen, luxury UI makeover, card capture for trial signup, 8 payment methods
