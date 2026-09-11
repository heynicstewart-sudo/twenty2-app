# Design

<!-- impeccable:design-schema 1 -->

Visual world for the Outreach CRM. Mode: **Operate** — an internal work tool for
the agency operator; scanability and calm outrank expression. Brand pinned by
the user from an actual guideline deck (colors + "Kiki" brand personality/tone),
adapted for a B2B SaaS tool — typography deliberately swapped to Plus Jakarta
Sans rather than the source deck's serif/handwriting faces.

## Palette

Warm, human, and grounded rather than corporate-neutral. One functional accent
(blue) for interaction; the rest of the palette carries meaning, used sparingly.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#FFF2E9` | app canvas — soft cream |
| `--surface`, `--card-bg` | `#FFFFFF` | cards, panels |
| `--surface-2` | `#F7E6D9` | insets, hover fills, column tint |
| `--border` / `--border-light` | `#EDDACB` / `#F3E4D8` | hairlines |
| `--ink` / `--text` / `--primary` | `#532822` | headings, primary buttons, dark chips |
| `--muted` | `#7A5A50` | secondary text |
| `--text-dim` | `#7C5C52` | captions, meta (darkened from brand's `#8C6F65` to clear WCAG AA on cream) |
| `--accent` | `#0084C5` | links, active nav, focus, key figures — the one functional accent |
| `--accent-strong` | `#00669C` | accent hover |
| `--sand` / `--sand-soft` | `#FFD05D` / `#FFF3D9` | attention |
| `--mint` / `--mint-soft` | `#A9EA76` / `#E4F5D6` | positive |
| peach `#FF834C`, pink `#FF9299`/`#B34850`, sky `#88BFFF` | | secondary accents — occasional, measured, never a page's dominant color |
| red-orange `#E05228`/`#B23D1B` | | blocked / error |

Color strategy: **Restrained** — the cream ground and brown ink carry the
brand at rest; blue is the only accent doing interactive work; sand/mint/rose
are semantic only (attention/positive/blocked), never decorative.

## Type

**Plus Jakarta Sans** (400/500/600/700/800) for everything — headings and body
alike. The source brand deck specifies a serif display face (Gupter) plus a
handwriting accent face (Belmonte Ballpoint); both were dropped for this
product at the user's direction — a dense B2B tool reads better in one
disciplined grotesque than a serif/handwriting pairing built for a warm
consumer-service brand.

- Base 13.5px / 1.5, tracking `-0.003em`.
- Page titles (`.page-h1`): 24px/600, `-0.02em`.
- Section titles: 14px/600. Micro-labels: 10.5px/700, `0.03em`, uppercase, `--text-dim`.
- Tabular figures on every metric, count, date, and KPI.

## Tone of voice

Adapted from the source brand's personality sliders — personable over
corporate, direct over vague, warm over clinical — scoped to what a B2B
operator tool can carry without becoming twee:

- **Human-first, not systemic.** Say "we couldn't load that" not "an error
  occurred." Talk to the operator like a capable colleague, not a terminal.
- **Direct and clear over clever.** Short sentences. Say what happened and
  what to do next. No jargon where a plain word works.
- **Warm, not bubbly.** A little personality in empty states and confirmations
  is welcome ("Nice — every ICP account has someone in a campaign."); this is
  a sales tool people use all day, not a consumer app, so restraint wins over
  cheerfulness.
- **Honest about limits.** Name what a feature can't do yet rather than
  hiding it behind vague copy.

### Binding copy rules

- Never **"Delete"** — always **"Remove"** (buttons, confirmations, toasts,
  titles). Applied throughout on this pass.
- Avoid the word **"platform"** in UI copy describing this product or its
  parts. (Category-accurate uses like a program-type option — "Cloud / data
  platform" — describing something in the world, not this tool, are fine.)
- "Database" not "Airtable"; "the Engine" not "AI"/"Claude" (pre-existing,
  still binding — see terminology rules below).

## Shape & depth

- Radius: cards 20px; inputs 12px; badges 8px; pills/chips fully round.
- `--shadow-sm` / `--shadow-md` / `--shadow-lg` are hue-matched to `--ink`
  (warm brown), not neutral black — a deliberate, subtle brand touch, not a
  decorative glow. Contact shadow only at rest; hover lifts with a slightly
  stronger version of the same tint.
- No `border-left` accents, no gradient text, no hard offset shadows.

## Components

- **Sidebar** — cream, blends into canvas. Active nav: white pill, `--ink`
  text, `--shadow-sm`. Count badges: solid `--ink` circle, white number.
- **Buttons** — primary: `--ink` fill, white text. Secondary: white, `--border`,
  `--ink` text. Ghost: transparent, hover `--surface-2`.
- **Status chips** — full pill, one per card by default. Positive = mint-soft/
  mint-ink; info = sky-soft/sky-ink (blue-adjacent); attention = sand-soft/
  sand-ink (gold); blocked = the red-orange pair.
- **KPI card** (`.metric-card`) — white, micro-label, big 700 tabular numeral,
  inline mint delta pill, icon tile in `--surface-2`/`--accent`.
- **Directory / worklist cards** — chip row first (ICP badge, program/signal),
  then bold name, then meta, then a hairline-divided footer.
- **Charts** (Chart.js) — series `['#0084C5','#44A574','#FFD05D','#FF834C','#B34850','#88BFFF','#532822']`.
- **Browser surfaces** — selection/caret/focus ring tinted to `--accent`
  (blue); scrollbar thumb warm neutral grey.

## Accepted detector findings (brief overrides default)

Impeccable's slop detector flags three things that are this pass's explicit,
deliberate brand rather than an AI-default reflex: Plus Jakarta Sans (user's
named font), the cream page background (the brand deck's literal primary
color, "soft cream... calm, breathable feel"), and hue-matched (not neutral)
shadows. All three are pinned-brief decisions, not drift.

## Preserved

Single-file `t2c-outreach-crm.html`; all `navigate()` / render-fn / `onclick`
hooks, element ids, class names behaviour depends on. Desktop-first to
~1280px. No light/dark toggle.
