// Default settings. Everything here is overridable from the Options page and
// lives in chrome.storage.local under "settings".
const DEFAULT_SETTINGS = {
  // Where the CRM lives. No trailing slash.
  apiBase: 'https://twenty2-app-production.up.railway.app',
  // Shared secret - must match EXTENSION_TOKEN on the server.
  token: '',
  // Multi-tenant: which client this LinkedIn account belongs to. Blank = the
  // server's default/active client.
  clientSlug: '',

  // ---- Pacing & caps. These are the anti-flag guardrails. Lower them, never
  // raise them past sane cold-outreach behaviour. ----
  minGapMs: 32000,        // shortest wait between two profile loads (>=30s: chrome.alarms floor)
  maxGapMs: 65000,        // longest wait between two profile loads
  longBreakEvery: 8,      // after N profiles, take a longer break
  longBreakMinMs: 120000, // 2 min
  longBreakMaxMs: 300000, // 5 min
  hourlyCap: 18,          // max profile loads in a rolling 60 min
  dailyCap: 45,           // max profile loads per calendar day (local)
  activeHoursStart: 7,    // only run batches between these local hours
  activeHoursEnd: 21,
  maxConsecutiveFailures: 2, // stop the whole batch if this many in a row fail
  tabLoadTimeoutMs: 25000,
  renderSettleMs: 4500,     // wait after load for LinkedIn's SDUI to render the main card
  detailsSettleMs: 3000,    // shorter wait for each /details/ sub-page
  deepScrape: true          // also visit /details/experience/ + /details/education/ per contact
};

// A LinkedIn page that means "slow down / verify you're human". If the content
// script sees one of these while a batch is running, the batch aborts for the
// rest of the day.
const CHALLENGE_URL_HINTS = ['/checkpoint/', '/authwall', '/uas/login', '/security/verify'];
const CHALLENGE_TEXT_HINTS = [
  "you're browsing too fast", 'browsing too quickly', 'unusual activity',
  "let's do a quick security check", 'verify it’s you', 'temporarily restricted'
];
