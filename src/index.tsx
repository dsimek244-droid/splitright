import { Hono } from 'hono'

const app = new Hono()

// SplitRight - single-page React app served from Hono on Cloudflare Pages.
// We deliver React/ReactDOM/Babel/Tailwind via CDN and load /static/app.jsx
// which contains the entire React app in one file (per user requirements).
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no" />
  <meta name="theme-color" content="#0F172A" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="SplitRight" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="description" content="SplitRight — Scan a receipt, split the bill, send payment requests in seconds." />
  <title>SplitRight — Split Bills the Right Way</title>

  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
  <link rel="apple-touch-icon" href="/static/apple-touch-icon.png" />
  <link rel="manifest" href="/static/manifest.webmanifest" />

  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />

  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'] },
          colors: {
            ink: { 900: '#0B1220', 800: '#111827', 700: '#1F2937', 500: '#6B7280', 300: '#D1D5DB' },
            brand: { 50: '#EEF2FF', 100: '#E0E7FF', 500: '#6366F1', 600: '#4F46E5', 700: '#4338CA' },
            accent: { 500: '#10B981', 600: '#059669' }
          },
          boxShadow: {
            card: '0 1px 2px rgba(16,24,40,0.04), 0 8px 24px rgba(16,24,40,0.06)',
            pop: '0 10px 30px rgba(99,102,241,0.35)'
          },
          borderRadius: { '3xl': '1.5rem', '4xl': '2rem' }
        }
      }
    }
  </script>

  <link href="/static/style.css" rel="stylesheet" />

  <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body class="bg-slate-50 text-ink-900 antialiased">
  <div id="root"></div>
  <script type="text/babel" data-presets="env,react" src="/static/app.jsx"></script>
</body>
</html>`)
})

export default app
