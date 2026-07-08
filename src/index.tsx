import { Hono } from 'hono'

type Bindings = {
  // Preferred: OpenRouter (unified gateway, has free vision models)
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  // Legacy: direct OpenAI-compatible endpoint
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  // KV — tracks abuse: which emails came from which IPs, and IPs we've banned.
  // Bound in wrangler.jsonc as "ABUSE_KV". On local dev, wrangler creates a
  // local KV store automatically under .wrangler/state so the binding works
  // without a Cloudflare API token.
  ABUSE_KV?: KVNamespace
}

/* ──────────────────────────────────────────────────────────────────
   Abuse-tracking constants
   ────────────────────────────────────────────────────────────────── */
const MAX_EMAILS_PER_IP = 3           // >3 distinct emails from one IP → ban
const IP_RECORD_TTL_SEC = 60 * 60 * 24 * 90  // 90-day rolling window
const BAN_TTL_SEC       = 60 * 60 * 24 * 365 // ban lasts 1 year
const app = new Hono<{ Bindings: Bindings }>()

/* ──────────────────────────────────────────────────────────────────
   POST /api/scan-receipt
   Body: { image: "data:image/jpeg;base64,..." }
   On success:  { ok: true, restaurant, items: [{name, price}], taxRate? }
   On failure:  { ok: false, useClientOcr: true, reason }  →  client falls
   back to Tesseract.js in-browser OCR.

   Provider preference:
     1. OpenRouter (free Gemini 2.0 Flash vision — accurate + zero cost)
     2. Legacy OPENAI_API_KEY pointing at a compatible endpoint
   ────────────────────────────────────────────────────────────────── */
app.post('/api/scan-receipt', async (c) => {
  const orKey =
    c.env?.OPENROUTER_API_KEY ||
    (globalThis as any).process?.env?.OPENROUTER_API_KEY ||
    ''
  const orBase =
    c.env?.OPENROUTER_BASE_URL ||
    (globalThis as any).process?.env?.OPENROUTER_BASE_URL ||
    'https://openrouter.ai/api/v1'

  const openaiKey =
    c.env?.OPENAI_API_KEY ||
    (globalThis as any).process?.env?.OPENAI_API_KEY ||
    ''
  const openaiBase =
    c.env?.OPENAI_BASE_URL ||
    (globalThis as any).process?.env?.OPENAI_BASE_URL ||
    'https://api.openai.com/v1'

  // Resolve the provider we'll actually call
  const useOpenRouter = !!orKey
  const apiKey = useOpenRouter ? orKey : openaiKey
  const baseUrl = useOpenRouter ? orBase : openaiBase

  let body: any = null
  try { body = await c.req.json() } catch { /* noop */ }
  const image = body?.image
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return c.json({ ok: false, useClientOcr: true, reason: 'bad-image' })
  }

  if (!apiKey) {
    return c.json({ ok: false, useClientOcr: true, reason: 'no-key' })
  }

  /* High-precision multilingual receipt reader.
     The model must return only billable line items priced by the merchant
     (food, drinks, groceries, fuel litres, hotel nights, taxi fare, etc).
     It must NEVER include subtotal / tax / VAT / tip / gratuity / service
     charge / discount / coupon / loyalty / change / cash / card / total
     lines as items, because the app calculates those itself. */
  const prompt = [
    'TASK: Read this receipt photo and return ONLY a minified JSON object.',
    'No prose. No markdown fences. No commentary. Just the JSON.',
    '',
    'OUTPUT SCHEMA (exact keys, exact types):',
    '{"restaurant": string, "items": [{"name": string, "price": number}], "taxRate": number, "currency": string}',
    '',
    'EXTRACTION RULES:',
    '1. items[] must contain ONLY billable line items the customer was charged for:',
    '   - restaurant dishes / drinks',
    '   - grocery products',
    '   - retail products',
    '   - hotel room nights, taxi fare, fuel litres, etc.',
    '2. items[] must EXCLUDE all of these (the app computes them itself):',
    '   - Subtotal / Sub Total / Net / Net Amount',
    '   - Tax / VAT / GST / HST / IVA / TVA / IGV / MwSt / 消費税 / 부가세 / GST',
    '   - Tip / Gratuity / Service Charge / Service / Servicio / 服务费',
    '   - Total / Grand Total / Amount Due / Balance / Total a Pagar',
    '   - Discount / Coupon / Promo / Loyalty / Rewards / Points',
    '   - Cash / Card / Visa / Mastercard / Change / Tendered / Payment / Auth Code',
    '   - Table number, server name, order number, store number, time, date, address, phone',
    '3. price: per-line total the customer paid for that item, as a positive number.',
    '   - If the line shows quantity × unit price = line total, use the line total.',
    '   - Strip currency symbols and group separators. Use a dot as decimal separator.',
    '   - For European format "12,50" return 12.5. For "1.234,56" return 1234.56.',
    '4. name: clean human-readable item name in the receipt language.',
    '   - Title Case for Latin scripts. Preserve original characters for non-Latin.',
    '   - Remove quantity prefixes like "2x", "×3", "2 @". The qty is reflected in price.',
    '   - Remove SKU codes, PLU numbers, leading dashes, trailing dots.',
    '   - Translate nothing. Keep the original language as printed.',
    '5. taxRate: tax_amount / subtotal_amount as a decimal (0.20 = 20%).',
    '   - If you can see both tax and subtotal lines, compute it exactly.',
    '   - If only a percent is printed (e.g. "VAT 19%"), return 0.19.',
    '   - If unknown, use 0 (do NOT guess).',
    '6. currency: 3-letter ISO code if you can tell from symbols / region',
    '   ($→USD, €→EUR, £→GBP, ¥→JPY or CNY, ₹→INR, ₩→KRW, A$→AUD, C$/CA$→CAD).',
    '   If unknown, return "".',
    '7. restaurant: the merchant / store / restaurant name printed at the top.',
    '   Often the largest text, sometimes the logo. Strip address / phone / "RESTAURANT" labels.',
    '   If unknown, use "Receipt".',
    '',
    'LANGUAGE SUPPORT:',
    'The receipt may be in any language (English, Spanish, French, German,',
    'Italian, Portuguese, Dutch, Polish, Japanese, Chinese, Korean, Hindi,',
    'Arabic, Hebrew, Thai, Vietnamese, Turkish, Russian, etc).',
    'Read it natively. Do not translate. Keep item names in their original script.',
    '',
    'QUALITY:',
    '- Be conservative: if a line is ambiguous or unreadable, OMIT it (better to miss',
    '  one item than to invent a wrong one).',
    '- If the image is rotated, mentally rotate it before reading.',
    '- If the image is not a receipt or completely unreadable, return:',
    '  {"restaurant":"Receipt","items":[],"taxRate":0,"currency":""}'
  ].join('\n')

  /* Model ladder. Tested on real receipts on OpenRouter:
     - gemini-2.5-flash-lite reads a 9-item receipt perfectly for $0.00024.
       (~4,000 scans per dollar — basically free for an indie app.)
     - free tier models (:free suffix) often hit upstream 429 rate limits,
       so they're tried AFTER the reliable cheap one to avoid user-visible
       OCR failures.
     - Legacy OpenAI path keeps gpt-4o-mini → gpt-5-mini. */
  const modelLadder = useOpenRouter
    ? [
        'google/gemini-2.5-flash-lite',                  // reliable + ~$0.0002/scan
        'google/gemini-2.5-flash',                       // higher quality if lite struggles
        'google/gemma-4-31b-it:free',                    // free, but rate-limited
        'nvidia/nemotron-nano-12b-v2-vl:free',           // free fallback
      ]
    : [
        'gpt-4o-mini',
        'gpt-5-mini',
      ]

  // Extra headers OpenRouter likes (for rate-limit / attribution).
  const extraHeaders: Record<string, string> = useOpenRouter
    ? {
        'HTTP-Referer': 'https://splitright.app',
        'X-Title': 'SplitRight'
      }
    : {}

  const callModel = async (model: string) => {
    const reqBody: any = {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image } }
        ]
      }],
      max_tokens: 2000,
      temperature: 0.1
    }
    // Only request strict JSON mode for models that support it.
    // Gemini family + GPT support it; Llama/Gemma/Nemotron don't always.
    if (model.includes('gemini') || model.includes('gpt')) {
      reqBody.response_format = { type: 'json_object' }
    }
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders
      },
      body: JSON.stringify(reqBody)
    })
  }

  try {
    let lastStatus = 0
    for (const model of modelLadder) {
      try {
        const r = await callModel(model)
        if (r.ok) {
          const data = await r.json()
          const result = await parseAndReturn(c, data)
          // parseAndReturn returns a Response. If it signaled parse-failed,
          // try the next model in the ladder — the current one might have
          // refused or hallucinated.
          const cloned = result.clone()
          let json: any = null
          try { json = await cloned.json() } catch {}
          if (json?.ok) return result
          if (json?.reason === 'no-ai-credits') return result // hard stop
          // else: continue to next model
          lastStatus = 200
        } else {
          lastStatus = r.status
          // 401/403 means the key is bad — stop trying.
          if (r.status === 401 || r.status === 403) break
        }
      } catch {
        // network blip on this model — try the next one
      }
    }
    return c.json({ ok: false, useClientOcr: true, reason: `upstream-${lastStatus || 'err'}` })
  } catch (e: any) {
    return c.json({ ok: false, useClientOcr: true, reason: 'fetch-error' })
  }
})

/* Parse the model's JSON response and normalize. Extracted so we can call
   it twice (gpt-5 first, gpt-5-mini fallback) without duplicating logic. */
async function parseAndReturn(c: any, data: any) {
  const content: string = data?.choices?.[0]?.message?.content || ''
  const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()

  // Detect upstream proxy paywall / quota messages (HTTP 200 with a plain-text
  // "credits exhausted" body). These look like normal text, never start with
  // "{", so JSON.parse always fails — give the client a specific reason so it
  // can show a useful error instead of just silently fallback-OCRing.
  if (!cleaned.startsWith('{')) {
    const lower = cleaned.toLowerCase()
    if (/credit|quota|subscribe|free[-\s]?plan|insufficient|rate limit/i.test(lower)) {
      return c.json({ ok: false, useClientOcr: true, reason: 'no-ai-credits' })
    }
    return c.json({ ok: false, useClientOcr: true, reason: 'parse-failed' })
  }

  let parsed: any = null
  try { parsed = JSON.parse(cleaned) } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) { try { parsed = JSON.parse(m[0]) } catch {} }
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    return c.json({ ok: false, useClientOcr: true, reason: 'parse-failed' })
  }

  // Server-side junk filter as a belt-and-suspenders defense in case the
  // model slips a "subtotal" / "tax" / "tip" / "total" line into items[].
  const JUNK_PATTERNS = [
    /\bsub[\s-]*total\b/i, /\btotal\b/i, /\bbalance\b/i, /\bamount[\s-]*(due|paid)\b/i,
    /\btax\b/i, /\bvat\b/i, /\bgst\b/i, /\bhst\b/i, /\bpst\b/i, /\bqst\b/i, /\biva\b/i, /\btva\b/i, /\bmwst\b/i,
    /\btip\b/i, /\bgratuity\b/i, /\bservice[\s-]*(charge|fee)\b/i, /\bservicio\b/i,
    /\bdiscount\b/i, /\bcoupon\b/i, /\bpromo(tion)?\b/i, /\bloyalty\b/i, /\brewards?\b/i,
    /\bcash\b/i, /\bchange\b/i, /\bcard\b/i, /\bvisa\b/i, /\bmaster[\s-]*card\b/i, /\bdebit\b/i, /\bcredit\b/i,
    /\btendered?\b/i, /\bauth(orization)?\b/i,
    /消費税/, /小計/, /合計/, /부가세/, /합계/, /소계/, /服务费/, /小计/, /合计/
  ]
  const isJunk = (name: string) => JUNK_PATTERNS.some((re) => re.test(name))

  const items = parsed.items
    .map((it: any) => ({
      name: String(it?.name || '').trim().slice(0, 80),
      price: Number(it?.price)
    }))
    .filter((it: any) =>
      it.name &&
      Number.isFinite(it.price) &&
      it.price > 0 &&
      !isJunk(it.name)
    )

  return c.json({
    ok: true,
    restaurant: String(parsed.restaurant || 'Receipt').slice(0, 80),
    items,
    taxRate: Number.isFinite(parsed.taxRate) ? Number(parsed.taxRate) : 0,
    currency: typeof parsed.currency === 'string' ? parsed.currency.toUpperCase().slice(0, 3) : ''
  })
}

/* ──────────────────────────────────────────────────────────────────
   Legal pages — required for App Store submission.
   Apple Guideline 5.1.1 mandates a privacy policy. Guideline 3.1.2
   requires terms of service for subscription apps.
   Linked from the Account screen + the paywall.
   ────────────────────────────────────────────────────────────────── */
function legalShell(title: string, bodyHtml: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0F172A" />
  <meta name="robots" content="index,follow" />
  <title>${title} — SplitRight</title>
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
  <style>
    :root { --ink: #0B1220; --muted: #475569; --line: #E2E8F0; --brand: #4F46E5; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Inter', system-ui, -apple-system, sans-serif; color: var(--ink); background: #fff; line-height: 1.55; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; }
    header { display: flex; align-items: center; gap: 12px; padding-bottom: 16px; border-bottom: 1px solid var(--line); margin-bottom: 24px; }
    .logo { width: 36px; height: 36px; border-radius: 10px; background: var(--brand); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; }
    h1 { font-size: 28px; font-weight: 800; margin: 0 0 4px; letter-spacing: -0.01em; }
    h2 { font-size: 18px; font-weight: 700; margin: 28px 0 8px; }
    h3 { font-size: 15px; font-weight: 700; margin: 20px 0 6px; }
    p, li { font-size: 15px; color: #1F2937; }
    .meta { color: var(--muted); font-size: 13px; }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }
    ul { padding-left: 22px; }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #F1F5F9; padding: 1px 6px; border-radius: 4px; }
    footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); display: flex; gap: 16px; flex-wrap: wrap; }
    .back { display: inline-block; margin-bottom: 16px; color: var(--brand); font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <a class="back" href="/">← Back to app</a>
    <header>
      <span class="logo">S</span>
      <div>
        <h1>${title}</h1>
        <div class="meta">SplitRight · Last updated June 20, 2026</div>
      </div>
    </header>
    ${bodyHtml}
    <footer>
      <a href="/legal/privacy">Privacy Policy</a>
      <a href="/legal/terms">Terms of Service</a>
      <a href="/legal/support">Support</a>
      <span>© 2026 SplitRight</span>
    </footer>
  </div>
</body>
</html>`
}

/* ──────────────────────────────────────────────────────────────────
   POST /api/auth/register
   Body: { email: string }

   Abuse defense — one device (IP) can register up to MAX_EMAILS_PER_IP
   distinct email accounts. After that, the IP is banned and every sign-in
   from it returns 403 { banned: true }.

   This works because Cloudflare Workers see the true client IP in the
   CF-Connecting-IP header (unspoofable — set by Cloudflare's edge, not
   the browser). localStorage tricks and incognito windows all funnel to
   the same public IP, so the ban survives them.

   Subscribed users bypass this check on the client side — if you're
   paying we don't care how many aliases you use.

   KV data model:
     ip:<hash>          → JSON { emails: string[], firstSeenAt: ISO }
     ban:<hash>         → "1" (presence means banned)
   Keys are SHA-256 of the IP so raw IPs never sit in KV plaintext (GDPR
   principle of minimization).
   ────────────────────────────────────────────────────────────────── */
async function hashIp(ip: string): Promise<string> {
  const enc = new TextEncoder().encode(ip + '|splitright-salt-v1')
  const buf = await crypto.subtle.digest('SHA-256', enc)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

app.post('/api/auth/register', async (c) => {
  // Get the true client IP. On Cloudflare this is set by the edge and
  // cannot be spoofed by the browser. Fall back to x-forwarded-for /
  // 'unknown' for local wrangler runs.
  const ip =
    c.req.header('CF-Connecting-IP') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'local-dev'

  let body: any = null
  try { body = await c.req.json() } catch { /* noop */ }
  const rawEmail = String(body?.email || '').trim().toLowerCase()

  // Basic email shape check — no need for RFC-full validation, just enough
  // to reject empty / junk values.
  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    return c.json({ ok: false, reason: 'bad-email' }, 400)
  }

  // Normalize: gmail-style dots + plus-tags get folded so
  // "abuser+1@gmail.com" and "abuser+2@gmail.com" count as ONE account.
  // This closes the most common abuse loophole.
  const [local, domain] = rawEmail.split('@')
  const strippedLocal = local.split('+')[0].replace(/\./g, '')
  const normalizedEmail = `${strippedLocal}@${domain}`

  const kv = c.env?.ABUSE_KV
  if (!kv) {
    // KV unavailable (e.g. plain node dev without wrangler). Fail OPEN so
    // developers aren't locked out. Production must have KV configured.
    return c.json({ ok: true, emailCount: 1, degraded: true })
  }

  const ipKey = 'ip:' + await hashIp(ip)
  const banKey = 'ban:' + await hashIp(ip)

  // 1) If already banned, short-circuit.
  const isBanned = await kv.get(banKey)
  if (isBanned) {
    return c.json({ ok: false, banned: true, reason: 'ip-banned' }, 403)
  }

  // 2) Load prior emails for this IP.
  const prior = await kv.get(ipKey, 'json') as { emails: string[]; firstSeenAt: string } | null
  const emails = new Set<string>(prior?.emails || [])
  const wasAlreadyKnown = emails.has(normalizedEmail)
  emails.add(normalizedEmail)

  // 3) If this pushes the IP over the limit, ban it.
  if (emails.size > MAX_EMAILS_PER_IP) {
    await kv.put(banKey, '1', { expirationTtl: BAN_TTL_SEC })
    return c.json({
      ok: false,
      banned: true,
      reason: 'too-many-accounts',
      emailCount: emails.size,
      limit: MAX_EMAILS_PER_IP
    }, 403)
  }

  // 4) Otherwise record the (potentially new) email and let them through.
  if (!wasAlreadyKnown) {
    await kv.put(
      ipKey,
      JSON.stringify({
        emails: [...emails],
        firstSeenAt: prior?.firstSeenAt || new Date().toISOString()
      }),
      { expirationTtl: IP_RECORD_TTL_SEC }
    )
  }

  return c.json({
    ok: true,
    emailCount: emails.size,
    limit: MAX_EMAILS_PER_IP,
    isNew: !wasAlreadyKnown
  })
})

app.get('/legal/privacy', (c) => c.html(legalShell('Privacy Policy', `
<p>SplitRight ("we", "us", "the app") is a bill-splitting tool. This Privacy Policy
explains exactly what data we collect, how we use it, who we share it with, and
your rights. We designed SplitRight to collect as little as possible.</p>

<h2>1. Data We Collect</h2>

<h3>a. Account information</h3>
<p>When you sign in with Google or Apple, we receive your <b>name</b> and <b>email
address</b> from the identity provider. We do not receive your password.</p>

<h3>b. Receipt photos</h3>
<p>When you scan a receipt, the photo is sent to our server-side OCR endpoint
(<code class="mono">/api/scan-receipt</code>) and then forwarded to our AI model
provider (OpenAI) for the sole purpose of extracting the list of items and prices.
We do <b>not</b> store the photo on our servers after the response is returned. The
photo is processed in memory and discarded within seconds.</p>

<h3>c. Contact information you type for friends</h3>
<p>To send payment requests, you may enter your friends' phone numbers and email
addresses. This information is stored <b>only on your device</b>, in your browser's
local storage. It is never uploaded to our servers and is never shared with any
third party. Deleting the app or clearing site data removes it permanently.</p>

<h3>d. Subscription &amp; purchase data</h3>
<p>If you subscribe through Apple's App Store or Google Play, the platform
processes your payment. We receive only the receipt confirming the transaction
status. We do not receive your full payment-card number or billing address.</p>

<h3>e. Crash &amp; diagnostic data</h3>
<p>We collect anonymized crash logs (no personal content) to fix bugs. You can opt
out in your device's system privacy settings (iOS: Settings → Privacy → Analytics).</p>

<h2>2. What We Do NOT Collect</h2>
<ul>
  <li>We do not collect your contacts list, photos library, or files outside what
      you explicitly choose.</li>
  <li>We do not track your location.</li>
  <li>We do not use third-party advertising trackers, analytics SDKs, or
      cross-app identifiers.</li>
  <li>We do not sell your data. Ever.</li>
</ul>

<h2>3. How We Use Your Data</h2>
<ul>
  <li>Your name + email: to recognize you across sessions and bill you correctly.</li>
  <li>Receipt photos: to extract items and prices for that single scan.</li>
  <li>Contact info you type: stored locally so you can send a text or email to a
      friend in one tap. The recipient's number / email is only used to compose a
      message in your device's native SMS or mail app — SplitRight itself never
      sends the message.</li>
</ul>

<h2>4. Sharing</h2>
<p>We share data with the following service providers, strictly for the operation
of the app:</p>
<ul>
  <li><b>OpenAI</b> — receipt photo + extraction prompt, for the duration of the
      OCR request only. OpenAI's policy is not to train on API data.</li>
  <li><b>Cloudflare</b> — hosts our application code and routes traffic.</li>
  <li><b>Apple / Google</b> — process subscription payments when you purchase.</li>
</ul>
<p>We do not share data with anyone else. We will only disclose data when legally
required (subpoena, court order) and will notify you when permitted.</p>

<h2>5. Data Retention</h2>
<ul>
  <li>Receipt photos: not retained — discarded after the OCR response.</li>
  <li>Account email + subscription status: retained until you delete your
      account.</li>
  <li>Friend contacts you typed: stored on your device only, until you delete them
      or uninstall.</li>
</ul>

<h2>6. Your Rights</h2>
<p>You have the right to:</p>
<ul>
  <li>Request a copy of the data we hold about you.</li>
  <li>Correct inaccurate data.</li>
  <li>Delete your account and all associated data.</li>
  <li>Withdraw consent at any time by signing out and deleting the app.</li>
</ul>
<p>To exercise any of these rights, email <a href="mailto:privacy@splitright.app">privacy@splitright.app</a>.
We respond within 30 days. GDPR, CCPA, and Apple App Tracking Transparency rights
apply.</p>

<h2>7. Children</h2>
<p>SplitRight is not directed at children under 13 (or 16 in the EU). We do not
knowingly collect data from children. If you believe a child has provided us
data, email <a href="mailto:privacy@splitright.app">privacy@splitright.app</a> and
we will delete it.</p>

<h2>8. Security</h2>
<p>All traffic to and from SplitRight is encrypted with TLS. Account credentials
are handled by Google or Apple Sign-In — we never see your password. Receipt
photos travel encrypted and are not stored. Local data on your device is
protected by your device's encryption and your screen lock.</p>

<h2>9. International Users</h2>
<p>Our servers are operated on Cloudflare's global edge network. Your data may be
processed in any country where Cloudflare or OpenAI operate, all of which provide
contractual safeguards (Standard Contractual Clauses for EU residents).</p>

<h2>10. Changes</h2>
<p>If we materially change this policy we will notify you in-app before the change
takes effect. The "Last updated" date at the top of this page always reflects the
current version.</p>

<h2>11. Contact</h2>
<p>Privacy questions: <a href="mailto:privacy@splitright.app">privacy@splitright.app</a><br/>
Support: <a href="mailto:support@splitright.app">support@splitright.app</a></p>
`)))

app.get('/legal/terms', (c) => c.html(legalShell('Terms of Service', `
<p>By using SplitRight you agree to these Terms. If you do not agree, do not use
the app. These Terms form a binding contract between you and SplitRight.</p>

<h2>1. The Service</h2>
<p>SplitRight is a mobile-and-web application that helps you photograph a
restaurant or store receipt, split the bill between people, and send each
person a payment request by SMS, email, or PayPal deep link. SplitRight does
<b>not</b> process or hold any money — payment apps (PayPal, your phone's SMS
client, your mail app) do that.</p>

<h2>2. Eligibility</h2>
<p>You must be at least 13 years old (16 in the EU) and able to form a binding
contract. If you use SplitRight on behalf of a business, you confirm you have
authority to bind that business.</p>

<h2>3. Account</h2>
<p>You sign in with Google or Apple. You are responsible for keeping that
account secure. Notify us immediately at
<a href="mailto:support@splitright.app">support@splitright.app</a> if you suspect
unauthorized access.</p>

<h2>4. Subscriptions, Free Trial &amp; Auto-Renewal</h2>
<p>SplitRight offers a 7-day free trial followed by a paid subscription
("SplitRight Pro"):</p>
<ul>
  <li><b>Monthly</b>: US $4.99 / month (or local equivalent)</li>
  <li><b>Yearly</b>: US $39.99 / year (or local equivalent) — 33% saved vs. monthly</li>
</ul>
<p><b>Auto-renewal disclosure (required by Apple Guideline 3.1.2):</b></p>
<ul>
  <li>Your free trial begins when you start it and lasts 7 days.</li>
  <li>If you do not cancel <b>at least 24 hours before the trial ends</b>, your
      subscription will <b>automatically renew</b> at the price stated above and
      your payment method on file will be charged.</li>
  <li>Subscriptions renew automatically for the same period (monthly or yearly)
      until you cancel. You will be notified at least 30 days before any price
      change.</li>
  <li>You can cancel anytime in your device settings:
      <i>iOS: Settings → [Your Name] → Subscriptions → SplitRight → Cancel.
      Android: Google Play → Subscriptions → SplitRight → Cancel.</i></li>
  <li>Cancellation takes effect at the end of the current billing period; you
      keep access until then. No refunds for partial periods, except where
      required by law.</li>
</ul>

<h2>5. Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
  <li>Upload anyone else's personal information without their consent;</li>
  <li>Use SplitRight to harass, defraud, or send spam;</li>
  <li>Reverse-engineer, decompile, or attempt to extract API keys;</li>
  <li>Use automated tools to scrape or abuse the service;</li>
  <li>Use SplitRight to violate any law or third party's rights.</li>
</ul>

<h2>6. OCR Accuracy</h2>
<p>SplitRight uses AI to read receipt photos. The result is best-effort, not
guaranteed. You are responsible for reviewing items and prices before sending
requests. SplitRight is not liable for amounts requested incorrectly because of
an OCR mistake.</p>

<h2>7. Payment Requests</h2>
<p>SplitRight builds a pre-filled message and a deep link to PayPal, your phone's
SMS app, or your email client. <b>SplitRight itself does not transfer money.</b>
All payments happen entirely inside the third-party app. Disputes about
payments must be resolved with that third party.</p>

<h2>8. Intellectual Property</h2>
<p>SplitRight, its logo, and its code are owned by us and protected by copyright
and trademark law. You receive a limited, revocable, non-exclusive,
non-transferable license to use the app for personal, non-commercial purposes.</p>

<h2>9. Termination</h2>
<p>We may suspend or terminate your account if you breach these Terms or use the
service abusively. You may stop using the app at any time. Sections that by
their nature should survive (e.g. IP, disclaimers, liability) survive
termination.</p>

<h2>10. Disclaimers</h2>
<p>SplitRight is provided "as is" and "as available". To the maximum extent
permitted by law, we disclaim all warranties, including merchantability, fitness
for a particular purpose, and non-infringement. We do not warrant that the
service will be uninterrupted, error-free, or that OCR results will be
accurate.</p>

<h2>11. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, SplitRight's total liability for any
claim is capped at the amount you paid us in the 12 months preceding the claim,
or US $50, whichever is greater. We are not liable for indirect, incidental,
special, consequential, or punitive damages.</p>

<h2>12. Governing Law</h2>
<p>These Terms are governed by the laws of the State of California, USA, without
regard to its conflict-of-laws rules. Any dispute will be resolved in the state
or federal courts located in San Francisco County, California, except where
applicable consumer-protection laws give you stronger rights.</p>

<h2>13. Changes</h2>
<p>We may update these Terms. If we materially change them we will notify you
in-app at least 30 days before they take effect. Continued use of the service
after the effective date constitutes acceptance.</p>

<h2>14. Apple-Specific Terms (App Store)</h2>
<p>If you obtained SplitRight from the Apple App Store:</p>
<ul>
  <li>This is an agreement between you and SplitRight, not Apple. Apple is not
      responsible for the app or its content.</li>
  <li>Apple has no obligation to provide support or maintenance.</li>
  <li>Apple is a third-party beneficiary of these Terms and may enforce them
      against you.</li>
  <li>You confirm you are not located in a country subject to a US Government
      embargo and not on a US Government list of prohibited or restricted
      parties.</li>
</ul>

<h2>15. Contact</h2>
<p>Questions about these Terms: <a href="mailto:legal@splitright.app">legal@splitright.app</a><br/>
Support: <a href="mailto:support@splitright.app">support@splitright.app</a></p>
`)))

app.get('/legal/support', (c) => c.html(legalShell('Support', `
<p>We're a small team and we read every email. Here are the fastest ways to
get help.</p>

<h2>Email us</h2>
<ul>
  <li>General questions / bugs: <a href="mailto:support@splitright.app">support@splitright.app</a></li>
  <li>Billing &amp; subscriptions: <a href="mailto:billing@splitright.app">billing@splitright.app</a></li>
  <li>Privacy requests (GDPR / CCPA): <a href="mailto:privacy@splitright.app">privacy@splitright.app</a></li>
</ul>
<p>We respond within 2 business days.</p>

<h2>Common questions</h2>

<h3>How do I cancel my subscription?</h3>
<p><b>iOS:</b> Settings → [Your Name] → Subscriptions → SplitRight → Cancel.<br/>
<b>Android:</b> Google Play → Profile → Payments &amp; Subscriptions → Subscriptions →
SplitRight → Cancel.<br/>
You keep access until the end of the current billing period.</p>

<h3>Will my friend need the app?</h3>
<p>No. SplitRight uses your phone's built-in SMS or mail app to send the request.
Your friend just receives a normal text or email.</p>

<h3>Is SplitRight a payment processor?</h3>
<p>No. We only build a pre-filled link to PayPal or to your phone's SMS / mail
client. All money moves through PayPal or whatever app the friend uses to pay
you back. SplitRight never sees or touches the money.</p>

<h3>How accurate is the receipt scanner?</h3>
<p>Very accurate on most receipts, but always review the items and prices on the
Review screen before continuing. Faded thermal paper, crumpled receipts, and
glare can occasionally cause mistakes.</p>

<h3>Does it work in my country / currency?</h3>
<p>SplitRight supports 17 regions and 12 currencies, auto-detected from your
phone. You can change them anytime from the Account screen.</p>

<h2>Delete my account</h2>
<p>Email <a href="mailto:privacy@splitright.app">privacy@splitright.app</a> from
your account address. We delete everything within 7 days and confirm by email.</p>
`)))

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
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;0,800;0,900;1,500;1,700&display=swap" rel="stylesheet" />

  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
            // Used by the .font-display class for premium serif headlines.
            display: ['"Playfair Display"', 'Georgia', 'serif']
          },
          colors: {
            ink: { 900: '#0B1220', 800: '#111827', 700: '#1F2937', 500: '#6B7280', 300: '#D1D5DB' },
            brand: { 50: '#EEF2FF', 100: '#E0E7FF', 500: '#6366F1', 600: '#4F46E5', 700: '#4338CA' },
            accent: { 500: '#10B981', 600: '#059669' },
            // Luxury accent palette — champagne / gold.
            gold:   { 50: '#FBF7EC', 100: '#F5EDD0', 300: '#E2C97A', 500: '#C9A24B', 600: '#B8860B', 700: '#8C6508' }
          },
          boxShadow: {
            card: '0 1px 2px rgba(16,24,40,0.04), 0 8px 24px rgba(16,24,40,0.06)',
            pop: '0 10px 30px rgba(99,102,241,0.35)',
            // Soft gold glow for premium hero elements.
            lux: '0 10px 40px rgba(201,162,75,0.25), 0 2px 6px rgba(11,18,32,0.06)'
          },
          borderRadius: { '3xl': '1.5rem', '4xl': '2rem' }
        }
      }
    }
  </script>

  <link href="/static/style.css" rel="stylesheet" />

  <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
  <!-- Pinned to 7.25.x — latest 8.x betas can emit ESM imports that crash
       a classic <script type="text/babel"> with "Cannot use import
       statement outside a module" and prevent the app from rendering. -->
  <script src="https://unpkg.com/@babel/standalone@7.25.6/babel.min.js"></script>
  <script src="https://unpkg.com/tesseract.js@5/dist/tesseract.min.js"></script>
  <!-- html2canvas: used by SummaryScreen to render the "Share as image" card to a PNG. -->
  <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
  <!-- Set the dark/light theme BEFORE React paints, to avoid a white flash for dark-mode users.
       Persists under splitright.v1 -> theme: "light" | "dark" | "system". -->
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
  <!-- IMPORTANT: only use the "react" preset here. Adding "env" makes Babel
       try to emit ES-module imports for runtime helpers, which then fails
       in a classic <script type="text/babel"> with "Cannot use import
       statement outside a module" and the app never renders. -->
  <script type="text/babel" data-presets="react" src="/static/app.jsx"></script>
</body>
</html>`)
})

export default app
