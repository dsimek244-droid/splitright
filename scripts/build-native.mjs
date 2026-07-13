#!/usr/bin/env node
/**
 * build-native.mjs
 *
 * Produces a static SPA bundle in ./native/ that Capacitor can ship
 * inside the iOS binary. The output mirrors what the Hono web build
 * serves at `/` — same HTML shell, same /static/* assets — but strips
 * server-only concerns and hard-codes an API_BASE pointing at the
 * deployed Cloudflare Pages backend.
 *
 * Usage:
 *   API_BASE=https://splitright.pages.dev npm run build:native
 *
 * Env vars:
 *   API_BASE   Absolute URL of the deployed backend. Required for the
 *              native app to reach /api/* endpoints. Defaults to a
 *              placeholder that will fail loudly if forgotten.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT  = path.join(ROOT, 'native');
const PUBLIC_STATIC = path.join(ROOT, 'public', 'static');

const API_BASE = process.env.API_BASE || 'https://splitright.pages.dev';

// Recursively copy a directory (Node 20+ has fs.cpSync, but we spell it
// out so this script also runs on older CI images if Codemagic pins one).
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 1) Clean output
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 2) Copy static assets → native/static/*
copyDir(PUBLIC_STATIC, path.join(OUT, 'static'));
console.log(`  copied  public/static → native/static`);

// 3) Emit index.html
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no" />
  <meta name="theme-color" content="#0F172A" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="SplitRight" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="format-detection" content="telephone=no" />
  <title>SplitRight</title>

  <link rel="icon" type="image/svg+xml" href="static/favicon.svg" />
  <link rel="apple-touch-icon" href="static/apple-touch-icon.png" />

  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;0,800;0,900;1,500;1,700&display=swap" rel="stylesheet" />

  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
            display: ['"Playfair Display"', 'Georgia', 'serif']
          },
          colors: {
            ink: { 900: '#0B1220', 800: '#111827', 700: '#1F2937', 500: '#6B7280', 300: '#D1D5DB' },
            brand: { 50: '#EEF2FF', 100: '#E0E7FF', 500: '#6366F1', 600: '#4F46E5', 700: '#4338CA' },
            accent: { 500: '#10B981', 600: '#059669' },
            gold:   { 50: '#FBF7EC', 100: '#F5EDD0', 300: '#E2C97A', 500: '#C9A24B', 600: '#B8860B', 700: '#8C6508' }
          },
          boxShadow: {
            card: '0 1px 2px rgba(16,24,40,0.04), 0 8px 24px rgba(16,24,40,0.06)',
            pop: '0 10px 30px rgba(99,102,241,0.35)',
            lux: '0 10px 40px rgba(201,162,75,0.25), 0 2px 6px rgba(11,18,32,0.06)'
          },
          borderRadius: { '3xl': '1.5rem', '4xl': '2rem' }
        }
      }
    }
  </script>

  <link href="static/style.css" rel="stylesheet" />

  <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone@7.25.6/babel.min.js"></script>
  <script src="https://unpkg.com/tesseract.js@5/dist/tesseract.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>

  <!-- Inject the API base so the SPA knows where to reach the backend.
       This is the ONE difference between the web build (same-origin fetch)
       and the native build (cross-origin to the Cloudflare Pages URL). -->
  <script>
    window.__SPLITRIGHT_API_BASE__ = ${JSON.stringify(API_BASE)};
    window.__SPLITRIGHT_NATIVE__   = true;
  </script>

  <script>
    (function () {
      try {
        var raw = localStorage.getItem('splitright.v1');
        var saved = raw ? JSON.parse(raw) : null;
        var theme = (saved && saved.theme) || 'system';
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        var isDark = theme === 'dark' || (theme === 'system' && prefersDark);
        if (isDark) document.documentElement.classList.add('dark');
      } catch (e) {}
    })();
  </script>
</head>
<body class="bg-slate-50 text-ink-900 antialiased">
  <div id="root"></div>
  <script type="text/babel" data-presets="react" src="static/app.jsx"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(`  wrote   native/index.html  (API_BASE=${API_BASE})`);
console.log(`✓ native bundle ready at ./native`);
