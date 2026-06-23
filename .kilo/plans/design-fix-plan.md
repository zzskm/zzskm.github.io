# Design Fix Plan — Brutalist Visual Alignment

Plan file for visual audit fixes. All changes are deltas only.

---

## HIGH PRIORITY

### 1. Hero number typography is too small
**What:** `.hero-title .title-num` — increase size, ensure weight 900 and letter-spacing `-0.05em`

**style.css → replace `.title-num` block:**
```css
.title-num {
  display: inline-block;
  min-width: 1.2ch;
  font-size: clamp(10rem, 12vw, 12rem);
  font-weight: 900;
  letter-spacing: -0.05em;
}
```

**Rationale:** `clamp(80px, 13vw, 180px)` (current) doesn’t reach the mockup’s `12rem` target on large screens. Explicitly flooring at `10rem` guarantees visual impact.

---

### 2. Card borders are too thin — brutalist weight is missing
**What:** Promote all section containers to `3px solid var(--ink)`

**style.css → changes:**
```css
/* summary-strip-outer */
.summary-strip-outer {
  border: 3px solid var(--ink);
}

/* panels */
.panel {
  border: 3px solid var(--ink);
}

/* hero already 3px — no change */
/* summary-strip outer wrapper — already handled above */
```

**Rationale:** Mockup uses consistent `3px` brutalist borders everywhere. `.hero` is already correct; `.summary-strip-outer` and `.panel` need promotion from `1.5px`.

---

### 3. Left vertical sidebar is absent
**What:** Add a `.sidebar-vertical` inside `.app`, visible only on `min-width: 1024px`

**index.html → inside `<div class="app" data-state="loading">` as first child:**
```html
<div class="sidebar-vertical" aria-hidden="true">FOR HEALTHY INDUSTRIES</div>
```

**style.css → add new rules (near `.app` or topbar):**
```css
.sidebar-vertical {
  position: fixed;
  left: 0; top: 0; bottom: 0;
  width: 64px;
  background: var(--ink);
  color: var(--bg);
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  display: grid;
  place-items: center;
  z-index: 100;
  display: none;
}
@media (min-width: 1024px) {
  .sidebar-vertical { display: grid; }
  .app { margin-left: 64px; }
}
```

**Rationale:** Mockup specifies 64px sidebar with rotated uppercase tracked text. Hidden on smaller screens; main content shifts right on `lg`.

> **Note:** If the user does not want fixed positioning, replace `position: fixed` with `position: sticky` and remove `z-index`.

---

## MEDIUM PRIORITY

### 4. Header visual weight is weak
**What:** Increase brandmark size and scale up logomark circle

**index.html → replace brandmark inner:**
```html
<div class="brandmark">
  <span class="brandmark-dot"></span>
  <span class="brand-text">체중 대시보드</span>
</div>
```

**style.css → changes:**
```css
.brandmark {
  gap: 14px;
  font-size: 32px; /* keep or increase to 36px per mockup taste */
}
.brandmark-dot {
  width: 32px; height: 32px;
  border-radius: 50%;
  background: var(--accent);
}
```

Keep existing `.topbar { border-bottom: 2px solid var(--ink); }` (already present).

---

### 5. Action Scenarios — inactive buttons look disabled
**What:** Remove the blanket opacity reduction on `.scenarios.is-muted`; keep inactive buttons fully contrasted

**style.css → change:**
```css
/* REMOVE or comment out: */
.scenarios.is-muted .scenario { opacity: 0.5; }
.scenarios.is-muted .scenario-val { color: var(--muted); }

/* ADD: */
.scenario.is-active {
  background: var(--ink);
  color: #fff;
}
/* inactive buttons already have background:var(--panel-alt) and border-right */
```

**Rationale:** Mockup has 3 equally distinct buttons; only the active one is filled black. The `is-muted` fade makes inactive ones look disabled.

---

### 6. Activity Logs is missing bar chart and "Good Pace" badge
**What:** Add `.activity-bars` with 7 bars and a `.badge-good-pace` in the panel head

**index.html → inside `<section class="panel">` (Activity Logs), after `.activity-blocks`:**
```html
<div class="activity-bars" aria-hidden="true">
  <div class="bar" style="height:40%"></div>
  <div class="bar" style="height:65%"></div>
  <div class="bar" style="height:35%"></div>
  <div class="bar" style="height:80%"></div>
  <div class="bar" style="height:55%"></div>
  <div class="bar" style="height:90%"></div>
  <div class="bar" style="height:70%"></div>
</div>
```

**index.html → add badge to panel-head (alongside icon/title):**
```html
<div class="panel-head">
  <div class="panel-head-inline">
    <div class="panel-head-icon">B</div>
    <div>
      <p class="eyebrow">Activity Logs</p>
      <h3 class="panel-head-title">Activity Logs</h3>
    </div>
  </div>
  <span class="badge-good-pace">Good Pace</span>
</div>
```

**style.css → add:**
```css
.activity-bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 64px;
  padding: 16px 24px 0;
  border-top: 1.5px solid var(--ink);
}
.bar {
  flex: 1;
  background: var(--ink);
  min-width: 0;
}
.badge-good-pace {
  font-size: 10px;
  font-weight: 800;
  background: var(--accent-ink);
  color: #fff;
  padding: 6px 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
```

**Rationale:** Mockup shows 7-bar mini chart and sienna "Good Pace" pill.

---

### 7. Hero card layout ratio differs
**What:** `.hero-grid` → `2fr 1fr` and `.hero-left` vertical divider should be `2px solid var(--ink)`

**style.css → change:**
```css
.hero-grid {
  grid-template-columns: 2fr 1fr;
}
```

**Rationale:** Current `1.6fr 1fr` doesn’t match mockup’s 2:1 ratio.

---

## LOW PRIORITY

### 8. Button hover state is generic
**What:** Add global hover rule

**style.css → add near the end (before responsive):**
```css
button:hover {
  background-color: var(--ink) !important;
  color: #fff !important;
}
```

**Rationale:** Ensures all buttons (seg, scenario, icon, reload) transition to dark fill + white text on hover.

---

### 9. Details section uses 2-column grid instead of 4-column
**What:** `.details-body` → `repeat(4, 1fr)` at large breakpoints

**style.css → change `.details-body`:**
```css
.details-body {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
}
@media (max-width: 1024px) {
  .details-body {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 520px) {
  .details-body {
    grid-template-columns: 1fr;
  }
}
```

**Rationale:** Mockup shows 4 columns on wide screens; collapse gracefully below 1024px and 520px.

---

## Implementation Order
1. HIGH #1 — typography (quick, high impact)
2. HIGH #2 — border weight (consistent across components)
3. HIGH #3 — sidebar (new structure, verify layout shift)
4. MED #7 — hero grid ratio
5. MED #4 — header weight
6. MED #5 — scenario mute fix
7. MED #6 — activity bars + badge
8. LOW #9 — details columns
9. LOW #8 — global hover

After changes: update `sw.js` CACHE_VERSION and script `?v=` to `20260623` (or next date) for cache bust.
