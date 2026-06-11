import { Hono } from 'hono'

type Bindings = { OPENAI_API_KEY?: string; OPENAI_BASE_URL?: string }
const app = new Hono<{ Bindings: Bindings }>()

/* ──────────────────────────────────────────────────────────────────
   POST /api/scan-receipt
   Body: { image: "data:image/jpeg;base64,..." }
   On success:  { ok: true, restaurant, items: [{name, price}], taxRate? }
   On failure:  { ok: false, useClientOcr: true, reason }  →  client falls
   back to Tesseract.js in-browser OCR.
   ────────────────────────────────────────────────────────────────── */
app.post('/api/scan-receipt', async (c) => {
  const apiKey =
    c.env?.OPENAI_API_KEY ||
    (globalThis as any).process?.env?.OPENAI_API_KEY ||
    ''
  const baseUrl =
    c.env?.OPENAI_BASE_URL ||
    (globalThis as any).process?.env?.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'

  let body: any = null
  try { body = await c.req.json() } catch { /* noop */ }
  const image = body?.image
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return c.json({ ok: false, useClientOcr: true, reason: 'bad-image' })
  }

  if (!apiKey) {
    return c.json({ ok: false, useClientOcr: true, reason: 'no-key' })
  }

  const prompt = [
    'You are reading a restaurant receipt photo. Extract structured data.',
    'Return ONLY valid minified JSON, no prose, no markdown fences, matching exactly:',
    '{"restaurant": string, "items": [{"name": string, "price": number}], "taxRate": number}',
    '- name: a short human-readable item name (Title Case, no quantity prefix like "1x")',
    '- price: the per-line total in the receipt currency, as a positive number',
    '- DO NOT include subtotal, tax, tip, total, gratuity, service charge, or discount lines as items',
    '- taxRate: tax / subtotal, expressed as a decimal (e.g. 0.0875). If unknown, use 0.0875.',
    '- restaurant: the merchant / restaurant name printed on the receipt. If unknown, use "Receipt".',
    'If the image is not a receipt or unreadable, return {"restaurant":"Receipt","items":[],"taxRate":0.0875}.'
  ].join('\n')

  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: image } }
          ]
        }],
        max_completion_tokens: 1500
      })
    })

    if (!r.ok) {
      return c.json({ ok: false, useClientOcr: true, reason: `upstream-${r.status}` })
    }
    const data: any = await r.json()
    const content: string = data?.choices?.[0]?.message?.content || ''
    // Strip possible code fences just in case the model wraps the JSON.
    const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    let parsed: any = null
    try { parsed = JSON.parse(cleaned) } catch {
      // Try to find the first { ... } block
      const m = cleaned.match(/\{[\s\S]*\}/)
      if (m) { try { parsed = JSON.parse(m[0]) } catch {} }
    }
    if (!parsed || !Array.isArray(parsed.items)) {
      return c.json({ ok: false, useClientOcr: true, reason: 'parse-failed' })
    }
    const items = parsed.items
      .map((it: any) => ({
        name: String(it?.name || '').trim().slice(0, 80),
        price: Number(it?.price)
      }))
      .filter((it: any) => it.name && Number.isFinite(it.price) && it.price > 0)

    return c.json({
      ok: true,
      restaurant: String(parsed.restaurant || 'Receipt').slice(0, 80),
      items,
      taxRate: Number.isFinite(parsed.taxRate) ? Number(parsed.taxRate) : 0.0875
    })
  } catch (e: any) {
    return c.json({ ok: false, useClientOcr: true, reason: 'fetch-error' })
  }
})

// SplitRight - single-page React app served from Hono on Cloudflare Pages.
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
  <script src="https://unpkg.com/tesseract.js@5/dist/tesseract.min.js"></script>
</head>
<body class="bg-slate-50 text-ink-900 antialiased">
  <div id="root"></div>
  <script type="text/babel" data-presets="env,react" src="/static/app.jsx"></script>
</body>
</html>`)
})

export default app
