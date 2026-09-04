/* Runs on every linkedin.com page. Reads the DOM on request from the
 * background worker (batch), or on its own for passive capture. Never clicks
 * anything that sends a message or a connection request.
 *
 * LinkedIn's profile is now server-driven UI (SDUI): every CSS class is a
 * per-deploy hash and means nothing. The only durable hooks are:
 *   - card containers, keyed by a stable id suffix:
 *       [id*="Topcard"], [id*="AboutDetailsSection"] / [id*="About"],
 *       [id*="ExperienceDetailsSection"], [id*="EducationDetailsSection"]
 *   - the order of visible text (headings, list rows)
 * Experience and Education no longer render on /in/<slug>/ at all - they live on
 * /in/<slug>/details/experience/ and /details/education/, which the background
 * worker opens in the same tab and reads via scrapeDetails(). */

const T = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
const clean = (s) => (s || '').replace(/\s*\n\s*/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- challenge / restriction detection ----------
function detectChallenge() {
  const url = location.href.toLowerCase();
  const bad = ['/checkpoint/', '/authwall', '/uas/login', '/security/verify'];
  if (bad.some((h) => url.includes(h))) return { challenged: true, why: 'url:' + url };
  const body = (document.body && document.body.innerText || '').toLowerCase().slice(0, 4000);
  const hints = ["you're browsing too fast", 'browsing too quickly', 'unusual activity',
    'quick security check', 'verify it', 'temporarily restricted', 'we restricted your account'];
  const hit = hints.find((h) => body.includes(h));
  return hit ? { challenged: true, why: 'text:' + hit } : { challenged: false };
}

// ---------- SDUI helpers ----------
// First element whose id contains any of the given fragments (case-insensitive).
function cardById(...frags) {
  const els = document.querySelectorAll('[id*="sdui.profile"], [id*="DetailsSection"], [id*="Topcard"]');
  for (const el of els) {
    const id = (el.id || '').toLowerCase();
    if (frags.some((f) => id.includes(f.toLowerCase()))) return el;
  }
  return null;
}
// Fallback: a section/card whose first heading text matches a label exactly.
function sectionByHeading(label) {
  const re = new RegExp('^' + label + '$', 'i');
  return [...document.querySelectorAll('section, div[id]')].find((s) => {
    const h = s.querySelector('h2, h3');
    return h && re.test(T(h));
  }) || null;
}
// Visible text of a subtree, in document order, consecutive duplicates dropped.
function orderedText(root) {
  if (!root) return [];
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = [];
  let n;
  while ((n = tw.nextNode())) {
    const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t !== out[out.length - 1]) out.push(t);
  }
  return out;
}

const isDateRange = (s) => !!s && /\b(19|20)\d{2}\b/.test(s) && (/[-–—]/.test(s) || /present/i.test(s));
const isBareDuration = (s) => !!s &&
  /^(\d+\s*(yr|yrs|year|years|mo|mos|month|months)\b\s*)+$/i.test(String(s).trim()) &&
  !/\b(19|20)\d{2}\b/.test(s);
const isLongProse = (s) => s.length > 55 || (/[.!?]$/.test(s) && s.split(/\s+/).length > 4);
const isControl = (s) => /^(load more|show all|show \d+ more|see more|see less|…?\s*see more|experience|education|skills|licenses & certifications)$/i.test(s.trim());

// ---------- profile (main /in/<slug>/ page) ----------
function scrapeProfile() {
  const ch = detectChallenge();
  if (ch.challenged) return { error: 'challenge', why: ch.why };
  if (!/\/in\//.test(window.location.pathname)) return { error: 'not a profile page' };

  const topcard = cardById('Topcard') || document.querySelector('main section');
  const lines = topcard ? T(topcard).split('\n').map((x) => x.trim()).filter(Boolean) : [];
  const name = lines[0] || T(document.querySelector('h1')) || '';

  const isPronoun = (s) => /^(she|he|they|ze|xe)\/[a-z]+$/i.test(s);
  const isDegree = (s) => s === '.' || /^·?\s*(1st|2nd|3rd|\d+(st|nd|rd|th))\b/i.test(s);

  let headline = '';
  let hi = 1;
  for (; hi < lines.length; hi++) {
    const l = lines[hi];
    if (l === name || isPronoun(l) || isDegree(l)) continue;
    headline = l;
    break;
  }

  // Location: after the headline, before the "Contact info"/"connections" block,
  // the line that reads like a place (has a comma, and isn't the
  // "Current Company · School" join line).
  const rest = lines.slice(hi + 1);
  const stop = rest.findIndex((l) => /contact info|connections|followers/i.test(l));
  const pool = (stop >= 0 ? rest.slice(0, stop) : rest).filter((l) => l && l !== '.');
  const place = pool.find((l) => l.includes(',') && !l.includes(' · '))
    || pool.find((l) => !l.includes(' · ')) || '';

  // Headline is usually "Title at Company".
  let currentTitle = '';
  let currentCompany = '';
  const m = headline.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
  if (m) { currentTitle = m[1].trim(); currentCompany = m[2].trim(); }

  const aboutCard = cardById('AboutDetailsSection', 'AboutCard') || sectionByHeading('About');
  let about = '';
  if (aboutCard) {
    about = clean(T(aboutCard)
      .replace(/^\s*About\s*/i, '')
      .replace(/…?\s*see more\s*$/i, '')
      .replace(/\bShow all\b[\s\S]*$/i, ''));
  }

  const canonical = (document.querySelector('link[rel="canonical"]') || {}).href
    || window.location.href.split('?')[0];
  const complete = !!(name && (about || headline));
  return {
    url: canonical,
    name,
    headline,
    location: place,
    currentTitle,
    currentCompany,
    about,
    capturedAt: new Date().toISOString(),
    complete
  };
}

// ---------- experience / education (the /details/<kind>/ sub-pages) ----------
function parseExperience(seq) {
  const a = seq.filter((t) => t && !isControl(t));
  const entries = [];
  let company = null; // inherited from the current grouped-employer header
  let i = 0;

  const structural = (k) => isDateRange(a[k]) || isBareDuration(a[k]);
  const leadsToStructure = (k) =>
    isDateRange(a[k + 1]) || isBareDuration(a[k + 1]) ||
    isDateRange(a[k + 2]) || isBareDuration(a[k + 2]);

  const consumeTail = (e) => {
    let guard = 0;
    while (i < a.length && guard++ < 5) {
      const l = a[i];
      if (!l || isControl(l) || structural(i) || leadsToStructure(i)) break;
      if (!e.location && !isLongProse(l)) e.location = l;
      else e.description = (e.description ? e.description + ' ' : '') + l;
      i++;
    }
  };

  while (i < a.length) {
    const line = a[i];
    if (!line || isControl(line)) { i++; continue; }

    // A stray blurb/description line left behind by the previous entry.
    if (isLongProse(line) && !isDateRange(a[i + 1]) && !isBareDuration(a[i + 1])) { i++; continue; }

    // Grouped-employer header: [group title?] <company> <bare duration> [location...]
    let groupJustSet = false;
    if (isBareDuration(a[i + 1])) { company = line; i += 2; groupJustSet = true; }
    else if (isBareDuration(a[i + 2]) && !isDateRange(a[i + 1])) { company = a[i + 1]; i += 3; groupJustSet = true; }
    if (groupJustSet) {
      // skip the header's own location line(s) - a sub-role title is always
      // followed immediately by a date range, a location line is not.
      while (i < a.length && a[i] && !structural(i) && !isControl(a[i]) &&
             !isDateRange(a[i + 1]) && !isBareDuration(a[i + 1])) i++;
      continue;
    }

    // Flat entry: <title> <company> <date range>
    if (isDateRange(a[i + 2]) && !isDateRange(a[i + 1]) && !isBareDuration(a[i + 1])) {
      const e = { title: line, company: a[i + 1], dates: a[i + 2] };
      company = e.company;
      i += 3;
      consumeTail(e);
      if (e.title && e.dates) entries.push(e);
      continue;
    }
    // Sub-role under the current grouped employer: <title> <date range>
    if (isDateRange(a[i + 1])) {
      const e = { title: line, company, dates: a[i + 1] };
      i += 2;
      consumeTail(e);
      if (e.title && e.dates) entries.push(e);
      continue;
    }
    i++; // unclassifiable line
  }
  return entries.slice(0, 15);
}

function parseEducation(seq) {
  const a = seq.filter((t) => t && !isControl(t));
  const out = [];
  for (let i = 0; i < a.length && out.length < 10; i++) {
    if (structuralEdu(a[i])) continue;
    const school = a[i];
    const degree = a[i + 1] && !structuralEdu(a[i + 1]) ? a[i + 1] : '';
    const dates = [a[i + 1], a[i + 2], a[i + 3]].find((x) => x && /\b(19|20)\d{2}\b/.test(x)) || '';
    out.push({ school, degree, dates });
    i += degree ? 1 : 0;
  }
  return out;
  function structuralEdu(s) { return isDateRange(s) || isBareDuration(s) || (!!s && /^\s*(19|20)\d{2}\s*(–|-|to)?\s*((19|20)\d{2})?\s*$/.test(s)); }
}

function scrapeDetails(kind) {
  const ch = detectChallenge();
  if (ch.challenged) return { error: 'challenge', why: ch.why };
  const isEdu = kind === 'education';
  const card = cardById(isEdu ? 'EducationDetailsSection' : 'ExperienceDetailsSection')
    || sectionByHeading(isEdu ? 'Education' : 'Experience')
    || document.querySelector('main');
  if (!card) return { error: kind + ' section not found' };

  const seq = orderedText(card).filter((t) => !/^chevron[- ]?(right|down|left|up)$/i.test(t));
  const raw = seq.filter((t) => !isControl(t)).join('\n').slice(0, 4000);
  const entries = isEdu ? parseEducation(seq) : parseExperience(seq);
  return { kind, entries, raw, count: entries.length };
}

// ---------- messaging thread (unchanged - class names here still live) ----------
function myName() {
  return T(document.querySelector('.global-nav__me-photo'))
    || (document.querySelector('.global-nav__me-photo') || {}).alt
    || T(document.querySelector('.feed-identity-module__actor-meta a'))
    || '';
}

function scrapeThread() {
  const ch = detectChallenge();
  if (ch.challenged) return { error: 'challenge', why: ch.why };

  const container = document.querySelector('.msg-s-message-list-container, .msg-s-message-list');
  if (!container) return { error: 'no thread open' };

  const headerLink = document.querySelector('.msg-thread__link-to-profile, .msg-title-bar a[href*="/in/"], a.msg-thread__link-to-profile');
  const contactUrl = headerLink ? headerLink.href.split('?')[0] : '';
  const contactName = T(document.querySelector('.msg-entity-lockup__entity-title, .msg-thread__title'))
    || (headerLink ? T(headerLink) : '');
  const me = (myName() || '').toLowerCase();

  const events = container.querySelectorAll('.msg-s-event-listitem');
  let lastFrom = null;
  const messages = [];
  events.forEach((ev) => {
    const groupName = T(ev.querySelector('.msg-s-message-group__name'));
    const time = T(ev.querySelector('.msg-s-message-group__timestamp, time'));
    const bodyEl = ev.querySelector('.msg-s-event-listitem__body, .msg-s-event__content .msg-s-event-listitem__body');
    const text = clean(T(bodyEl));
    if (!text) return;
    let from = lastFrom;
    if (groupName) {
      from = (me && groupName.toLowerCase().includes(me)) ? 'me'
        : ev.classList.contains('msg-s-event-listitem--other') ? 'them'
        : (contactName && groupName.toLowerCase().includes(contactName.toLowerCase())) ? 'them' : 'me';
      lastFrom = from;
    } else if (ev.classList.contains('msg-s-event-listitem--other')) {
      from = 'them'; lastFrom = 'them';
    }
    messages.push({ from: from || 'them', text, time });
  });

  return { url: window.location.href.split('?')[0], contactUrl, contactName, messages, capturedAt: new Date().toISOString() };
}

// ---------- who recently accepted ----------
function scrapeConnections() {
  const ch = detectChallenge();
  if (ch.challenged) return { error: 'challenge', why: ch.why };
  const out = [];
  const seen = new Set();
  const push = (name, url) => {
    const u = (url || '').split('?')[0];
    const key = u || name;
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push({ name: name.trim(), url: u });
  };

  document.querySelectorAll('.nt-card, article.nt-card, .notification-item, [data-view-name*="notification"]').forEach((card) => {
    const txt = T(card).toLowerCase();
    if (!txt.includes('accepted your invitation') && !txt.includes('is now a connection')) return;
    const a = card.querySelector('a[href*="/in/"]');
    const name = T(card.querySelector('a[href*="/in/"] strong, .nt-card__text strong, strong')) || (a ? T(a).split('\n')[0] : '');
    push(name, a ? a.href : '');
  });

  if (!out.length) {
    document.querySelectorAll('.mn-connection-card, li.reusable-search__result-container').forEach((card) => {
      const a = card.querySelector('a[href*="/in/"]');
      if (!a) return;
      const name = T(card.querySelector('.mn-connection-card__name, .entity-result__title-text a, .t-16')) || T(a).split('\n')[0];
      push(name, a.href);
    });
  }

  return { connections: out.slice(0, 60), capturedAt: new Date().toISOString() };
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg.type === 'checkChallenge') sendResponse(detectChallenge());
    else if (msg.type === 'scrapeProfile') sendResponse(scrapeProfile());
    else if (msg.type === 'scrapeDetails') sendResponse(scrapeDetails(msg.kind || 'experience'));
    else if (msg.type === 'scrapeThread') sendResponse(scrapeThread());
    else if (msg.type === 'scrapeConnections') sendResponse(scrapeConnections());
    else sendResponse({ error: 'unknown message' });
  } catch (e) {
    sendResponse({ error: e.message });
  }
  return true;
});

// ---------- passive capture (this tab, when you open a profile yourself) ----------
// Main page only - name / headline / location / about. Experience and education
// need the /details/ sub-pages, which only the paced batch visits.
(async function passive() {
  const store = await chrome.storage.local.get(['settings', 'passiveOn']);
  if (store.passiveOn === false) return;
  if (!/\/in\//.test(window.location.pathname)) return;
  if (/\/details\//.test(window.location.pathname)) return;
  await sleep(3500);
  const s = scrapeProfile();
  if (s.error || !s.complete) return;
  chrome.runtime.sendMessage({ type: 'passiveProfile', payload: s });
})();
