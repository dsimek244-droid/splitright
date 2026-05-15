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
| 2 | **Scan Receipt screen** with simulated OCR animation (1.8s) + "use sample receipt" shortcut | ✅ |
| 3 | **People screen** — add/remove people, name + 8-color tag picker, edit colors inline | ✅ |
| 4 | **Items screen** — receipt items, multi-person assignment via tap-pills, "Everyone" shortcut, add/remove custom items, live "$/person" preview when shared | ✅ |
| 5 | **Tip selector** — 10% / 15% / 20% / Custom %, live amount preview | ✅ |
| 6 | **Tax** — adjustable slider (0–15%), pre-filled at 8.75% | ✅ |
| 7 | **Summary screen** — per-person breakdown (items + tax share + tip share + total), expandable details, grand total card | ✅ |
| 8 | **Send Requests screen** — generates a payment message per person, "Copy message" + native "Share" + deep links into Venmo / Cash App / PayPal with amount pre-filled | ✅ |
| 9 | **Dummy receipt pre-loaded** — "The Iron Skillet" with 10 items already assigned across 4 people so you can test every screen instantly | ✅ |
| 10 | **PWA manifest + iOS meta tags** — installable to home screen, App-Store-wrapper-ready | ✅ |

## Functional Entry URIs

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Renders the SplitRight React SPA |
| `/static/app.jsx` | GET | The full single-file React app (JSX, compiled in-browser by Babel) |
| `/static/style.css` | GET | Premium component styling |
| `/static/manifest.webmanifest` | GET | PWA manifest for installable web app |
| `/static/favicon.svg` | GET | App icon |

The SPA itself is purely client-side — no server endpoints beyond static asset serving — which keeps it cheap, fast, and 100% Cloudflare-Pages-friendly.

## Data Architecture
- **Data Models**:
  - `Person { id, name, color }`
  - `Item   { id, name, price }`
  - `Assignments { [itemId]: [personId, ...] }`
  - `TipPct: number (0..1)`, `TaxRate: number (0..1)`
- **Storage**: In-memory React state only (no persistence yet — see "Next steps").
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
npm run build
npx cap add ios
npx cap copy ios
npx cap open ios     # opens Xcode on a Mac
```
Then in Xcode:
1. Set the team / bundle id (`com.yourcompany.splitright`).
2. Add app icons (1024×1024 master + the asset catalog set) and a launch screen.
3. Add **`NSCameraUsageDescription`** to `Info.plist` (required for the real-camera OCR you'll wire in to replace the simulated scanner): *"SplitRight uses the camera to scan restaurant receipts."*
4. Archive → Distribute App → App Store Connect.

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
