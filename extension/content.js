/* Runs on every linkedin.com page. Reads the DOM on request from the
 * background worker (batch), or on its own for passive capture. Never clicks
 * anything that sends a message or a connection request. */

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

// ---------- profile ----------
function sectionByAnchor(id) {
  const anchor = document.getElementById(id);
  if (anchor) {
    let s = anchor.closest('section');
    if (s) return s;
  }
  // fallback: a <section> whose first heading text matches
  const label = id.charAt(0).toUpperCase() + id.slice(1);
  return [...document.querySelectorAll('main section')].find((sec) => {
    const h = sec.querySelector('h2, .pvs-header__title, span[aria-hidden="true"]');
    return h && T(h).toLowerCase().startsWith(label.toLowerCase());
  }) || null;
}

function longestTextBlock(root) {
  if (!root) return '';
  let best = '';
  root.querySelectorAll('span[aria-hidden="true"], .inline-show-more-text, .pv-shared-text-with-see-more, p').forEach((el) => {
    const t = T(el).replace(/\s*…\s*see more\s*$/i, '').replace(/\s*see more\s*$/i, '');
    if (t.length > best.length) best = t;
  });
  return clean(best);
}

function scrapeExperience() {
  const sec = sectionByAnchor('experience');
  if (!sec) return [];
  const items = sec.querySelectorAll('li.artdeco-list__item, li.pvs-list__paged-list-item, .pvs-list__item--line-separated');
  const out = [];
  items.forEach((li) => {
    // Each visible text line inside the item, in order, de-duped
    const lines = [...li.querySelectorAll('span[aria-hidden="true"], .t-bold span, .t-normal span')]
      .map((s) => T(s)).filter(Boolean);
    const uniq = [...new Set(lines)];
    if (!uniq.length) return;
    const entry = { title: uniq[0] || '' };
    if (uniq[1]) entry.company = uniq[1].replace(/\s*·.*$/, '');
    const dateLine = uniq.find((l) => /\b(19|20)\d\d\b/.test(l) && /(present|yr|yrs|mo|mos|–|-|to)/i.test(l));
    if (dateLine) entry.dates = dateLine;
    const desc = uniq.slice(1).filter((l) => l !== entry.company && l !== entry.dates && l.length > 40).join(' ');
    if (desc) entry.description = clean(desc);
    out.push(entry);
  });
  return out.slice(0, 12);
}

function scrapeProfile() {
  const ch = detectChallenge();
  if (ch.challenged) return { error: 'challenge', why: ch.why };
  if (!/\/in\//.test(location.pathname)) return { error: 'not a profile page' };

  const main = document.querySelector('main') || document;
  const name = T(main.querySelector('h1'));
  const headline = T(main.querySelector('.text-body-medium.break-words'))
    || T(main.querySelector('.pv-text-details__left-panel .text-body-medium'));
  const locEl = [...main.querySelectorAll('.pv-text-details__left-panel .text-body-small, .text-body-small.inline')]
    .map((e) => T(e)).find((t) => t && !/contact info|followers|connections/i.test(t));
  const about = longestTextBlock(sectionByAnchor('about'));
  const experience = scrapeExperience();

  const canonical = (document.querySelector('link[rel="canonical"]') || {}).href || location.href.split('?')[0];
  const complete = !!(name && (about || experience.length));
  return {
    url: canonical, name, headline, location: locEl || '',
    about, experience,
    capturedAt: new Date().toISOString(),
    complete
  };
}

// ---------- messaging thread ----------
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

  return { url: location.href.split('?')[0], contactUrl, contactName, messages, capturedAt: new Date().toISOString() };
}

// ---------- who recently accepted ----------
// Works on the notifications page (items reading "X accepted your invitation")
// and on a connections list (cards). Either way -> [{name, url}].
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

  // notifications page
  document.querySelectorAll('.nt-card, article.nt-card, .notification-item, [data-view-name*="notification"]').forEach((card) => {
    const txt = T(card).toLowerCase();
    if (!txt.includes('accepted your invitation') && !txt.includes('is now a connection')) return;
    const a = card.querySelector('a[href*="/in/"]');
    const name = T(card.querySelector('a[href*="/in/"] strong, .nt-card__text strong, strong')) || (a ? T(a).split('\n')[0] : '');
    push(name, a ? a.href : '');
  });

  // connections list cards (fallback)
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
    else if (msg.type === 'scrapeThread') sendResponse(scrapeThread());
    else if (msg.type === 'scrapeConnections') sendResponse(scrapeConnections());
    else sendResponse({ error: 'unknown message' });
  } catch (e) {
    sendResponse({ error: e.message });
  }
  return true;
});

// ---------- passive capture (this tab, when you open a profile yourself) ----------
(async function passive() {
  const store = await chrome.storage.local.get(['settings', 'passiveOn']);
  if (store.passiveOn === false) return;
  if (!/\/in\//.test(location.pathname)) return;
  await sleep(3500); // let the page settle
  const s = scrapeProfile();
  if (s.error || !s.complete) return;
  chrome.runtime.sendMessage({ type: 'passiveProfile', payload: s });
})();
