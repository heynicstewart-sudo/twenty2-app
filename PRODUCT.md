# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the agency outreach operator (VA).** Works the tool most days to execute
outreach — clearing the daily worklist, sending the next sequence step, approving
Engine-drafted replies, updating contact stages, pinning and sorting target
companies. Values speed, density, and always knowing the next action.

**Secondary: the agency principal.** Fewer, higher-level sessions — choosing target
accounts, setting campaign strategy and message sequences, reviewing pipeline and
campaign performance.

The end client (the business whose outreach is being run) rarely or never logs in;
the tool is an internal agency instrument, not a client-facing dashboard.

## Product Purpose

A white-label outreach and account-development workspace that a go-to-market /
transformation consulting agency uses to run B2B outreach on behalf of its clients.
One deployment serves multiple client accounts (agency mode with a client
switcher). Success is the operator moving target companies from "worth watching"
to booked conversations efficiently, without losing track of where each account
and contact stands.

## Positioning

- **Transformation programs are the buying trigger.** The tool tracks live
  change/transformation programs inside target companies and treats them as the
  signal that an account is in-market — including an agent that scans for and files
  new programs. Generic CRMs track contacts and deals; this tracks the client's
  reason to buy.
- **Fit before volume.** A codified ICP gates who enters a campaign and is wired
  through company scoring, campaign build, and message drafting.
- **Stage-1 outreach offers to map the prospect's change, not to pitch.** Each
  target company gets a freeform "account canvas" (change architecture: current
  state, pain, change, future, risk) used as collaborative free value.
- **Progress follows real events.** A sequence advances only on a send; a reply is
  recorded as history and gates the next draft but never advances the stage.
- **Mirrors the agency's own CRM.** Intended as a one-way mirror of the agency's
  Monday.com CRM (contacts, companies, deals, activities) — partially built.

## Operating Context

- Two outreach channels: LinkedIn (connect → message 1/2/3, send-only advance) and
  email (to-contact → emailed → in conversation → booked). Campaigns are typed per
  channel.
- A read-only Chrome extension (MV3) scrapes LinkedIn profile data, reply threads,
  and accepted invitations into the workspace.
- The operator's day starts on a prioritised worklist ("Today's Actions"):
  buying-trigger accounts, contacts with a fresh role change, sequence steps due,
  reply drafts to approve.
- Data lives in a per-client Airtable base; the app is an Express server serving a
  single HTML file, deployed on Railway behind basic auth.
- Per-client configuration: display name, slug, logo badge (1–2 chars), accent
  colour, home tagline, city/region, rep first name and message sign-off,
  industry, and a language note (some clients require UK English with no em
  dashes).

## Capabilities and Constraints

- **Surfaces (visible nav):** Targets (landing — Kanban pin board of companies by
  warmth), Company Universe (map/grid of target companies with ICP fit and active
  program), Funnel (outreach-stage funnel + analytics), Campaigns (list with
  status, ICP %, KPI tiles; opens a message-sequence roadmap), Profile (per-company
  account canvas + org map).
- **Secondary surfaces (currently hidden):** GTM Motion, ICP Builder, Competitor
  Map, Replies queue, Logger, Sales/calendar, Engine (ambient insights), Settings,
  content Calendar, Grids / Grid (contact-search grids).
- **Hard architectural constraint:** the entire front end is one file,
  `t2c-outreach-crm.html` — inline `<style>` + vanilla JS with a global `state`
  object, `navigate()` / page-render functions, and `onclick` string handlers. No
  framework, no build step, no bundler. Redesign work must preserve this structure
  and the existing JS hooks, class names, and element ids that behaviour depends
  on. External libs are CDN-loaded: Plus Jakarta Sans, Tabler icons webfont,
  Chart.js, jsPDF, html2canvas.
- **Terminology (binding):** the UI never surfaces the word "Airtable" (say
  "database") and never surfaces "AI" or "Claude" (the assistant is "the Engine").
  This is front-end copy only; server logs are unaffected.
- **Device range:** desktop-first, must stay usable down to ~1280px laptop widths.
  Tablet and phone are not target use cases.
- Collapsible left sidebar; sticky top bar with page title and a client switcher.

## Brand Commitments

- **Brand-neutral white-label.** The design carries no Twenty2 Collective identity
  of its own. Every client should experience the tool as theirs — name, logo
  badge, accent colour and tagline come from per-client config and the client
  switcher. Nothing Twenty2-specific may be baked into the chrome.
- Current build uses a deep-teal accent (`#2A6B7C`), a cool zinc/stone neutral
  palette, Plus Jakarta Sans, ~16px card radius, soft shadows, uppercase
  micro-labels, and a white sidebar with a near-black active pill. This is the
  incumbent look, treated as evidence — not a fixed commitment — for the redesign.
- No light/dark toggle; single light theme.

## Evidence on Hand

- **Real clients:** Twenty2 Collective (Perth / WA — GTM and transformation
  consulting; the default client, slug `twenty2`) and The Shed Guru (first email
  campaign client — sheds/patios). Real target-company data exists for the WA
  market (Woodside, Rio Tinto, Chevron, Fortescue, Water Corporation, ATCO, and
  more).
- **Demo fixture:** `gtm-demo.html` (gitignored) is a self-contained portfolio
  demo — "Arcadia Advisory" — that stubs every API endpoint with realistic data.
  Useful as a fully-populated screenshot fixture for design work when the live app
  has no API keys.
- No fabricated testimonials, customer counts, benchmarks, or pricing exist or
  should be invented.

## Product Principles

1. **The worklist is the product.** The operator should always see the next action
   without hunting for it; every surface feeds or clears that queue.
2. **Right accounts before volume.** ICP fit and a live transformation program
   decide who enters a campaign — targeting quality outranks throughput.
3. **Lead with free value.** Stage-1 contact offers to map the prospect's change,
   not to sell; the pitch comes later and only after a reply.
4. **Stage reflects what actually happened.** Advance on a send, never on optimism;
   replies are history that informs the next message.
5. **It's the client's tool.** White-label is absolute — the vendor names behind
   the data and the assistant stay invisible, and no agency branding leaks into
   what the operator sees.

## Accessibility & Inclusion

No product-specific standard has been established. Baseline expectations only:
keyboard-operable controls, visible focus, and text contrast that holds on the
light theme at laptop and desktop widths.
