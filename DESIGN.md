# Design

<!-- impeccable:design-schema 1 -->

Visual world for the Outreach CRM. Pinned brief: the user's Urbanist branding
sheet + LeadNest dashboard reference, and the "Calm Operational Canvas" system
Stitch generated (`.design-ref/stitch_b2b_outreach_crm_platform/`). Mode:
**Operate** — an internal work tool for the agency operator; scanability and calm
outrank expression. This is a **reskin only**: no feature, IA, page, copy, or JS
change. Every existing surface, nav item, and behaviour is preserved.

## Direction

Warm-modern / soft-functional. A calm sage-tinted canvas with white work cards
floating on fine hairline borders and almost no shadow. One confident blue accent
used sparingly; lime reserved for positive signals; charcoal for headings, primary
buttons, and count chips. Generous corner radii, full-pill metadata badges,
circular count markers. The opposite of a dense loud enterprise dashboard.

## Palette

| Token | Value | Role |
|---|---|---|
| `--bg` | `#F4F7F3` | app canvas — faint sage-neutral |
| `--surface`, `--card-bg` | `#FFFFFF` | work cards, panels |
| `--surface-2` | `#ECF1EC` | column tint, insets, hover fills |
| `--border` | `#E4EAE2` | card + control hairline |
| `--border-light` | `#EEF1ED` | internal dividers |
| `--sidebar-bg` | `#FBFCFA` | sidebar, near-blends with canvas |
| `--sidebar-active-bg` | `#FFFFFF` | active nav pill (soft shadow, not black) |
| `--ink` / `--text` / `--primary` | `#1F2421` | headings, primary buttons, count chips |
| `--muted` | `#66706A` | secondary text (warm grey, never cold) |
| `--text-dim` | `#8A948A` | captions, meta, icons |
| `--accent` | `#5880DA` | links, active state, key figures, charts |
| `--accent-strong` | `#3E63C4` | accent hover / focus ring base |
| `--accent-dim` | `rgba(88,128,218,0.12)` | focus ring, selected-card fill |
| `--lime` / `--lime-soft` / `--lime-ink` | `#C9F17E` / `#E5F9C0` / `#3B5A0E` | positive deltas, "new" chips, chart fill |
| `--sky` / `--sky-soft` / `--sky-ink` | `#BCDBFA` / `#D6E4FD` / `#1E3A8A` | info chips, highlighted cards |
| peach chip | `#FFEAD6` / `#8F4500` | follow-up / warning chips |
| red chip | `#FFDAD6` / `#93000A` | error / blocked (unchanged role) |

Color strategy: **Restrained** — neutrals + one accent. Blue is the default
per-client accent and stays swappable via client branding; lime, sky, peach are
fixed system-signal colours.

## Type

- **Urbanist** (400/500/600/700/800), self-loaded from Google Fonts; fallback
  `'Plus Jakarta Sans', -apple-system, 'Segoe UI', system-ui, sans-serif`.
- Base 14px / 1.45, tracking `-0.006em`.
- Display / key metrics: 700, tracking `-0.02em` (e.g. campaign KPIs, funnel counts).
- Section + column titles: 600–700, `-0.01em`, sat next to a circular count chip.
- Card titles: 600.
- Micro-labels: 11px, 700, `0.04em`, uppercase, `--text-dim`.
- Tabular figures (`font-variant-numeric: tabular-nums`) on every metric, count,
  date, and KPI.

## Shape & depth

- Radius: cards / modules `18px`; inputs / search `12px`; chips + badges + count
  markers `999px`; small badges `8px`.
- `--shadow-sm`: `0 1px 3px rgba(31,36,33,.04), 0 4px 12px rgba(31,36,33,.03)` —
  contact shadow only.
- `--shadow-lg`: `0 12px 32px rgba(31,36,33,.10)` — menus, modals, drag.
- Selected / highlighted card: fill `#EBF2FD`, border `--sky`, shadow
  `0 4px 16px rgba(88,128,218,.10)`.
- No `border-left` accents, no gradient text, no hard offset shadows.

## Components

- **Sidebar nav** — line icons (Tabler). Active item: white fill, `--ink` text,
  blue icon, `--shadow-sm`. Hover: `--surface-2` fill. Count badge: solid charcoal
  circle, white 11px bold number, right-aligned.
- **Buttons** — primary: `--ink` fill, white text, pill or 12px radius, hover
  `#2E3531`. Secondary: white, `--border`, `--ink` text. Ghost: transparent, hover
  `--surface-2`. Leading icon where it clarifies the action.
- **Status chips** — full pill, `3px 10px`, 12px/700. New = `--lime-soft`/`--lime-ink`;
  Returning/Info = `--sky-soft`/`--sky-ink`; Priority = `--ink`/white;
  Follow-up = peach. One chip per card by default.
- **KPI card** — white, title micro-label, big 700 tabular numeral, inline
  `--lime-soft` delta pill (`+6%`). No sparkline standing in for content.
- **Kanban column** — `--surface-2` fill, `18px` radius, no top accent bar.
  Header: title + circular count chip. Cards: white, `--border`, one status chip,
  bold title, muted sub, pill meta row, hairline footer with date + counts.
- **Charts** (Chart.js) — series `['#5880DA','#C9F17E','#BCDBFA','#3E63C4','#8FB84E','#A9C9F5']`;
  area fills at low alpha; rounded bar caps; charcoal floating tooltip; no gridline
  clutter.
- **Browser surfaces** — selection `--accent-dim`, caret `--accent`, focus ring
  `0 0 0 3px --accent-dim`, scrollbars tinted to `--border`.

## Preserved

Single-file `t2c-outreach-crm.html`; all `navigate()` / render-fn / `onclick`
hooks, element ids, class names behaviour depends on. "database" / "the Engine"
terminology. Desktop-first to ~1280px. No light/dark toggle.
