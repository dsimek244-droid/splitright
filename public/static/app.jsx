/* =========================================================================
   SplitRight — single-file React app
   - Screens: Splash/Scan → People → Items → Tip & Tax → Summary → Send
   - Pre-loaded with dummy receipt data so it's testable instantly
   - All in one file as requested
   ========================================================================= */

const { useState, useMemo, useEffect, useRef, useCallback } = React;

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

const STARTER_PEOPLE = [
  { id: "p1", name: "Alex",   color: PRESET_COLORS[0] },
  { id: "p2", name: "Jordan", color: PRESET_COLORS[1] },
  { id: "p3", name: "Sam",    color: PRESET_COLORS[2] },
  { id: "p4", name: "Taylor", color: PRESET_COLORS[3] }
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
const fmt = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
const initialsOf = (name) =>
  (name || "?")
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const uid = () => Math.random().toString(36).slice(2, 9);

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
   ========================================================================= */
function ScanScreen({ onScan }) {
  const [scanning, setScanning] = useState(false);

  const startScan = () => {
    setScanning(true);
    // Simulate OCR — in a real native build this would call a camera + OCR pipeline.
    setTimeout(() => {
      setScanning(false);
      onScan();
    }, 1800);
  };

  return (
    <div className="app-shell flex flex-col">
      <div className="px-5 pt-10">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-2xl bg-brand-600 flex items-center justify-center shadow-pop">
            <i className="fa-solid fa-receipt text-white"></i>
          </div>
          <span className="font-extrabold text-lg tracking-tight">SplitRight</span>
        </div>

        <h1 className="mt-10 text-4xl font-black leading-[1.05] tracking-tight">
          Split the bill,<br/>
          <span className="text-brand-600">the right way.</span>
        </h1>
        <p className="mt-3 text-slate-500 text-base">
          Scan the receipt. Tap who ordered what. Send payment requests in seconds.
        </p>
      </div>

      <div className="px-5 mt-8">
        <div className="card p-4">
          <div className="relative rounded-2xl overflow-hidden bg-slate-900 aspect-[4/5]">
            {/* Faux receipt preview */}
            <div className="absolute inset-4 bg-white rounded-xl p-4 text-[11px] leading-relaxed text-slate-700 shadow-xl font-mono">
              <div className="text-center font-bold tracking-widest">THE IRON SKILLET</div>
              <div className="text-center text-slate-400">123 Main St · Table 14</div>
              <div className="border-t border-dashed my-2"></div>
              {DUMMY_RECEIPT.items.slice(0, 6).map((it) => (
                <div key={it.id} className="flex justify-between">
                  <span className="truncate pr-2">{it.name}</span>
                  <span>{fmt(it.price)}</span>
                </div>
              ))}
              <div className="border-t border-dashed my-2"></div>
              <div className="flex justify-between font-bold">
                <span>Subtotal</span><span>{fmt(DUMMY_RECEIPT.subtotal)}</span>
              </div>
            </div>

            {/* Frame corners */}
            <div className="absolute inset-3 pointer-events-none">
              <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-white/80 rounded-tl-lg"></span>
              <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-white/80 rounded-tr-lg"></span>
              <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-white/80 rounded-bl-lg"></span>
              <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-white/80 rounded-br-lg"></span>
            </div>

            {scanning && <div className="scanline"></div>}

            <div className="absolute bottom-3 left-0 right-0 text-center text-white/90 text-xs font-semibold">
              {scanning ? "Reading items…" : "Align receipt within the frame"}
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 mt-6 grid grid-cols-3 gap-3">
        <Feature icon="fa-bolt"        label="Instant OCR" />
        <Feature icon="fa-users"       label="Fair split" />
        <Feature icon="fa-paper-plane" label="One-tap pay" />
      </div>

      <div className="flex-1"></div>

      <div className="action-bar">
        <button className="btn-primary" onClick={startScan} disabled={scanning}>
          {scanning ? (
            <span><i className="fa-solid fa-circle-notch fa-spin mr-2"></i> Scanning receipt…</span>
          ) : (
            <span><i className="fa-solid fa-camera mr-2"></i> Scan receipt</span>
          )}
        </button>
        <button className="mt-2 btn-ghost w-full text-center" onClick={onScan}>
          Or use sample receipt →
        </button>
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
   Screen 2 — People at the table
   ========================================================================= */
function PeopleScreen({ people, setPeople, onBack, onNext }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[people.length % PRESET_COLORS.length]);
  const inputRef = useRef(null);

  const addPerson = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPeople([...people, { id: uid(), name: trimmed, color }]);
    setName("");
    setColor(PRESET_COLORS[(people.length + 1) % PRESET_COLORS.length]);
    inputRef.current?.focus();
  };

  const removePerson = (id) => setPeople(people.filter((p) => p.id !== id));

  const updateColor = (id, newColor) =>
    setPeople(people.map((p) => (p.id === id ? { ...p, color: newColor } : p)));

  return (
    <div className="app-shell flex flex-col">
      <Header
        title="Who's at the table?"
        subtitle="Add everyone splitting the bill."
        onBack={onBack}
      />
      <Stepper step={0} />

      <div className="px-5 mt-2">
        <div className="card p-4">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Add person</label>
          <div className="mt-2 flex items-center gap-2">
            <span className="avatar lg" style={{ background: color }}>
              {initialsOf(name || "?")}
            </span>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPerson()}
              placeholder="e.g. Riley"
              className="flex-1 bg-slate-100 rounded-xl px-4 py-3 text-base font-medium outline-none focus:ring-2 focus:ring-brand-500/40"
            />
            <button
              onClick={addPerson}
              className="w-12 h-12 rounded-xl bg-brand-600 text-white font-bold shadow-pop active:scale-95"
              aria-label="Add person"
            >
              <i className="fa-solid fa-plus"></i>
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-full transition-transform ${color === c ? "ring-2 ring-offset-2 ring-ink-900 scale-110" : ""}`}
                style={{ background: c }}
                aria-label={`Pick color ${c}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="px-5 mt-4 mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">
          At the table · {people.length}
        </h2>
      </div>

      <div className="px-5 space-y-2">
        {people.length === 0 && (
          <div className="card p-6 text-center text-slate-500">
            <i className="fa-solid fa-users text-2xl mb-2"></i>
            <div className="font-semibold">No one added yet</div>
            <div className="text-sm">Add at least 2 people to split the bill.</div>
          </div>
        )}

        {people.map((p) => (
          <div key={p.id} className="card p-3 flex items-center gap-3">
            <Avatar person={p} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-ink-900 truncate">{p.name}</div>
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => updateColor(p.id, c)}
                    className={`w-5 h-5 rounded-full transition ${p.color === c ? "ring-2 ring-offset-1 ring-ink-900" : "opacity-60"}`}
                    style={{ background: c }}
                    aria-label={`Set color ${c}`}
                  />
                ))}
              </div>
            </div>
            <button
              onClick={() => removePerson(p.id)}
              className="w-10 h-10 rounded-xl bg-slate-100 text-slate-500 active:scale-95"
              aria-label="Remove person"
            >
              <i className="fa-solid fa-trash"></i>
            </button>
          </div>
        ))}
      </div>

      <div className="flex-1"></div>

      <div className="action-bar">
        <button
          className="btn-primary"
          onClick={onNext}
          disabled={people.length < 2}
        >
          Continue with {people.length} {people.length === 1 ? "person" : "people"}
          <i className="fa-solid fa-arrow-right ml-2"></i>
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   Screen 3 — Receipt Items: assign to one or more people
   ========================================================================= */
function ItemsScreen({ items, setItems, people, assignments, setAssignments, onBack, onNext }) {
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
          {DUMMY_RECEIPT.restaurant}
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
   Screen 5 — Summary: what each person owes
   ========================================================================= */
function SummaryScreen({ totals, people, restaurant, onBack, onSend }) {
  const [expanded, setExpanded] = useState(null);

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

      <div className="px-5 mt-4 mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Per person</h2>
        <span className="text-xs text-slate-400">{people.length} people</span>
      </div>

      <div className="px-5 space-y-2">
        {totals.breakdown.map((b) => {
          const open = expanded === b.person.id;
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
                <div className="px-4 pb-4 -mt-1">
                  <div className="bg-slate-50 rounded-xl p-3">
                    <Row label="Items subtotal" value={fmt(b.subtotal)} />
                    <Row label="Tax share"      value={fmt(b.tax)} />
                    <Row label="Tip share"      value={fmt(b.tip)} />
                    <div className="border-t border-slate-200 my-2"></div>
                    <Row label="Total"          value={fmt(b.total)} bold />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex-1"></div>

      <div className="action-bar">
        <button className="btn-primary" onClick={onSend}>
          <i className="fa-solid fa-paper-plane mr-2"></i> Send payment requests
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   Screen 6 — Send: per-person payment message + Venmo/Cash/PayPal links
   ========================================================================= */
function SendScreen({ totals, restaurant, onBack, onDone, showToast }) {
  const [yourHandle, setYourHandle] = useState("@you");
  const [provider, setProvider] = useState("venmo");
  const [copied, setCopied] = useState(null);

  const providers = [
    { id: "venmo",   label: "Venmo",    icon: "fa-v",          color: "#3D95CE" },
    { id: "cashapp", label: "Cash App", icon: "fa-dollar-sign", color: "#00D632" },
    { id: "paypal",  label: "PayPal",   icon: "fa-paypal",     color: "#003087" }
  ];

  const messageFor = (b) =>
    `Hey ${b.person.name}! 👋\n` +
    `Your share of ${restaurant} comes to ${fmt(b.total)}.\n` +
    `(Items ${fmt(b.subtotal)} + Tax ${fmt(b.tax)} + Tip ${fmt(b.tip)})\n` +
    `Please send to ${yourHandle} on ${providers.find((p) => p.id === provider).label}. Thanks!\n` +
    `— Split with SplitRight`;

  /* Build a deep link that opens the chosen app pre-filled with the amount.
     Falls back to web URLs which work on desktop too. */
  const linkFor = (b) => {
    const amount = b.total.toFixed(2);
    const note = encodeURIComponent(`${restaurant} · split with SplitRight`);
    const handle = encodeURIComponent(yourHandle.replace(/^@/, ""));
    switch (provider) {
      case "venmo":
        // Venmo "charge" link
        return `https://venmo.com/?txn=charge&audience=private&recipients=${handle}&amount=${amount}&note=${note}`;
      case "cashapp":
        // Cash App pay link (user adds note manually)
        return `https://cash.app/$${handle}/${amount}`;
      case "paypal":
        return `https://paypal.me/${handle}/${amount}`;
      default:
        return "#";
    }
  };

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
      <Header title="Send requests" subtitle="Copy each message or share directly." onBack={onBack} />

      <div className="px-5 mt-2">
        <div className="card p-4">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Your handle</label>
          <input
            value={yourHandle}
            onChange={(e) => setYourHandle(e.target.value)}
            placeholder="@your-handle"
            className="mt-1 w-full bg-slate-100 rounded-xl px-4 py-3 text-base font-semibold outline-none focus:ring-2 focus:ring-brand-500/40"
          />

          <div className="mt-3 grid grid-cols-3 gap-2">
            {providers.map((p) => (
              <button
                key={p.id}
                onClick={() => setProvider(p.id)}
                className={`tip-option ${provider === p.id ? "is-on" : ""}`}
              >
                <div
                  className="w-8 h-8 rounded-lg mx-auto flex items-center justify-center text-white text-sm"
                  style={{ background: p.color }}
                >
                  <i className={`fa-solid ${p.icon}`}></i>
                </div>
                <div className="text-xs mt-1">{p.label}</div>
              </button>
            ))}
          </div>
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
        {totals.breakdown.map((b) => (
          <div key={b.person.id} className="card p-4">
            <div className="flex items-center gap-3">
              <Avatar person={b.person} size="lg" />
              <div className="flex-1 min-w-0">
                <div className="font-bold">{b.person.name}</div>
                <div className="text-xs text-slate-500">owes {fmt(b.total)}</div>
              </div>
              <a
                href={linkFor(b)}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-2 rounded-xl text-white text-xs font-bold active:scale-95"
                style={{ background: providers.find((p) => p.id === provider).color }}
              >
                Request <i className="fa-solid fa-arrow-up-right-from-square ml-1 text-[10px]"></i>
              </a>
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
        ))}
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
   Root app
   ========================================================================= */
function App() {
  /* Screens: scan → people → items → tip → summary → send */
  const [screen, setScreen] = useState("scan");
  const [people, setPeople] = useState(STARTER_PEOPLE);
  const [items, setItems] = useState(DUMMY_RECEIPT.items);
  const [assignments, setAssignments] = useState(STARTER_ASSIGNMENTS);
  const [tipPct, setTipPct] = useState(0.20);
  const [taxRate, setTaxRate] = useState(DUMMY_RECEIPT.taxRate);
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
    setScreen("scan");
  };

  let body = null;
  if (screen === "scan") {
    body = <ScanScreen onScan={() => setScreen("people")} />;
  } else if (screen === "people") {
    body = (
      <PeopleScreen
        people={people}
        setPeople={setPeople}
        onBack={() => setScreen("scan")}
        onNext={() => setScreen("items")}
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
    body = (
      <SummaryScreen
        totals={totals}
        people={people}
        restaurant={DUMMY_RECEIPT.restaurant}
        onBack={() => setScreen("tip")}
        onSend={() => setScreen("send")}
      />
    );
  } else if (screen === "send") {
    body = (
      <SendScreen
        totals={totals}
        restaurant={DUMMY_RECEIPT.restaurant}
        onBack={() => setScreen("summary")}
        onDone={reset}
        showToast={showToast}
      />
    );
  }

  return (
    <>
      {body}
      <Toast message={toast} onDone={() => setToast("")} />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
