/* Batch orchestrator. MV3 service workers get killed between events, so the
 * batch is a state machine driven by chrome.alarms, not a setTimeout loop -
 * every tick processes one item and schedules the next. All state lives in
 * chrome.storage.local so it survives the worker restarting.
 *
 * This worker NEVER sends a message or a connection request. It opens pages in
 * background tabs, reads them via content.js, posts what it read to the CRM,
 * and closes the tab. Pacing + caps + the challenge kill-switch are the only
 * things standing between "helpful" and "flagged", so they are not optional. */

importScripts('config.js');

const ALARM = 't2c-batch-tick';
const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSettings() {
  const s = (await chrome.storage.local.get('settings')).settings || {};
  return { ...DEFAULT_SETTINGS, ...s };
}
async function getState() {
  return (await chrome.storage.local.get('batch')).batch || null;
}
async function setState(patch) {
  const cur = (await chrome.storage.local.get('batch')).batch || {};
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ batch: next });
  return next;
}
async function getCounters() {
  const today = new Date().toISOString().slice(0, 10);
  let c = (await chrome.storage.local.get('counters')).counters || {};
  if (c.day !== today) c = { day: today, dailyLoads: 0, hourStamps: [] };
  return c;
}
async function bumpCounter() {
  const c = await getCounters();
  const now = Date.now();
  c.dailyLoads += 1;
  c.hourStamps = (c.hourStamps || []).filter((t) => now - t < 3600000);
  c.hourStamps.push(now);
  await chrome.storage.local.set({ counters: c });
  return c;
}
async function loadsThisHour() {
  const c = await getCounters();
  const now = Date.now();
  return (c.hourStamps || []).filter((t) => now - t < 3600000).length;
}

// ---------- CRM API ----------
async function api(path, opts = {}) {
  const s = await getSettings();
  if (!s.token) throw new Error('No token set - open the extension Options.');
  let base = String(s.apiBase || '').trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  const url = base + path + (path.includes('?') ? '&' : '?') +
    (s.clientSlug ? 'client=' + encodeURIComponent(s.clientSlug) : '');
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Extension-Token': s.token, ...(opts.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

// ---------- open a bg tab, scrape it, close it ----------
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); fn(); };
    const to = setTimeout(() => finish(() => reject(new Error('tab load timeout'))), timeoutMs);
    const l = (id, info) => { if (id === tabId && info.status === 'complete') finish(resolve); };
    chrome.tabs.onUpdated.addListener(l);
    // catch the case where it finished loading before the listener attached
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') finish(resolve); }).catch(() => {});
  });
}
async function scrapeInBgTab(url, message, settleMs, timeoutMs) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id, timeoutMs);
    await sleep(settleMs);
    await gentleScroll(tab.id);
    const result = await chrome.tabs.sendMessage(tab.id, message);
    return result || { error: 'no response from page' };
  } finally {
    if (tab && tab.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Full-page scroll so LinkedIn's SDUI lazy-renders everything, then back to top.
async function gentleScroll(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const s = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await s(120); }
        window.scrollTo(0, 0);
      }
    });
    await sleep(1200);
  } catch (_) {}
}

// Navigate an existing tab and wait for the load to finish.
function navigateTab(tabId, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); fn(); };
    const to = setTimeout(() => finish(() => reject(new Error('nav timeout'))), timeoutMs);
    const l = (id, info) => { if (id === tabId && info.status === 'complete') finish(resolve); };
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.update(tabId, { url }).catch((e) => finish(() => reject(e)));
  });
}

// Poll the tab until a selector matches (SDUI renders after 'complete' fires).
async function waitForSelector(tabId, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId }, args: [selector], func: (sel) => !!document.querySelector(sel)
      });
      if (r && r.result) return true;
    } catch (_) {}
    await sleep(500);
  }
  return false;
}

// Open a profile, read the main card, then visit the /details/ sub-pages in the
// SAME tab for experience + education. One continuous tab session per contact -
// it reads like "view profile -> Show all experience -> Show all education", so
// it still counts as one profile against the daily/hourly caps.
async function scrapeProfileDeep(url, s) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id, s.tabLoadTimeoutMs);
    await waitForSelector(tab.id, '[id*="Topcard"], main section', 8000);
    await sleep(s.renderSettleMs);
    await gentleScroll(tab.id);
    const profile = await chrome.tabs.sendMessage(tab.id, { type: 'scrapeProfile' })
      .catch(() => ({ error: 'no response from page' }));
    if (profile.error === 'challenge') return profile;

    if (s.deepScrape !== false && !profile.error) {
      const base = url.split('?')[0].replace(/\/+$/, '') + '/';
      for (const kind of ['experience', 'education']) {
        // Some layouts render this inline on the profile - scrapeProfile already
        // grabbed it, so there's nothing to visit.
        if (((kind === 'experience' ? profile.experience : profile.education) || []).length) continue;
        try {
          await navigateTab(tab.id, base + 'details/' + kind + '/', s.tabLoadTimeoutMs);
          const key = kind === 'education' ? 'Education' : 'Experience';
          await waitForSelector(tab.id, '[id*="' + key + 'DetailsSection"], main', 8000);
          await sleep(s.detailsSettleMs || 3000);
          await gentleScroll(tab.id);
          const d = await chrome.tabs.sendMessage(tab.id, { type: 'scrapeDetails', kind }).catch(() => null);
          if (d && d.error === 'challenge') return { error: 'challenge', why: d.why };
          if (d && !d.error) {
            if (kind === 'experience') { profile.experience = d.entries || []; profile.experienceRaw = d.raw || ''; }
            else { profile.education = d.entries || []; profile.educationRaw = d.raw || ''; }
          }
        } catch (_) { /* sub-page is best-effort */ }
      }
    }
    return profile;
  } finally {
    if (tab && tab.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---------- the batch state machine ----------
async function startBatch(kind) {
  const running = await getState();
  if (running && running.running) return { error: 'A batch is already running.' };

  const s = await getSettings();
  const hr = new Date().getHours();
  if (hr < s.activeHoursStart || hr >= s.activeHoursEnd) {
    return { error: `Outside active hours (${s.activeHoursStart}:00-${s.activeHoursEnd}:00). Runs then instead.` };
  }
  const counters = await getCounters();
  if (counters.dailyLoads >= s.dailyCap) return { error: `Daily cap reached (${s.dailyCap}). Try again tomorrow.` };

  let queue = [];
  if (kind === 'profiles') {
    const r = await api('/api/extension/capture-queue');
    queue = (r.items || []).map((i) => ({ ...i, task: 'profile' }));
  } else if (kind === 'connections') {
    queue = [{ task: 'connections', url: 'https://www.linkedin.com/notifications/', name: 'Recent acceptances' }];
  }
  if (!queue.length) return { error: 'Nothing to do - the queue is empty.' };

  const remaining = s.dailyCap - counters.dailyLoads;
  if (queue.length > remaining) queue = queue.slice(0, remaining);

  await setState({
    running: true, aborted: false, kind, queue, index: 0,
    total: queue.length, done: 0, failed: 0, consecFail: 0,
    startedAt: Date.now(), log: [], current: null
  });
  chrome.alarms.create(ALARM, { when: Date.now() + 3000 });
  return { ok: true, total: queue.length };
}

async function stopBatch(reason) {
  chrome.alarms.clear(ALARM);
  const st = await getState();
  if (st) await setState({ running: false, aborted: true, stoppedReason: reason || 'stopped by you', finishedAt: Date.now() });
}

async function tick() {
  const s = await getSettings();
  let st = await getState();
  if (!st || !st.running || st.aborted) { chrome.alarms.clear(ALARM); return; }

  // guardrails re-checked every tick
  const hr = new Date().getHours();
  if (hr < s.activeHoursStart || hr >= s.activeHoursEnd) { await stopBatch('paused - outside active hours'); return; }
  const counters = await getCounters();
  if (counters.dailyLoads >= s.dailyCap) { await stopBatch('daily cap reached'); return; }
  if ((await loadsThisHour()) >= s.hourlyCap) {
    // wait out the hour instead of stopping
    chrome.alarms.create(ALARM, { when: Date.now() + 6 * 60000 });
    await setState({ current: 'hourly cap - cooling down 6 min' });
    return;
  }

  const item = st.queue[st.index];
  if (!item) { await setState({ running: false, finishedAt: Date.now() }); return; }
  await setState({ current: item.name || item.url });

  let ok = false, note = '';
  try {
    if (item.task === 'profile') {
      const scraped = await scrapeProfileDeep(item.url, s);
      if (scraped.error === 'challenge') { await stopBatch('LinkedIn challenge page seen - stopping for the day'); return; }
      const complete = scraped.name && (scraped.about || scraped.headline || (scraped.experience || []).length);
      if (scraped.error || !complete) { note = scraped.error || 'profile not readable'; }
      else {
        const r = await api('/api/extension/profile', { method: 'POST', body: JSON.stringify(scraped) });
        ok = r.matched !== false;
        const roles = (scraped.experience || []).length;
        note = r.matched === false ? 'no CRM contact matched this URL' : ('captured' + (roles ? ' · ' + roles + ' roles' : ''));
      }
      await bumpCounter();
    } else if (item.task === 'connections') {
      const scraped = await scrapeInBgTab(item.url, { type: 'scrapeConnections' }, s.renderSettleMs, s.tabLoadTimeoutMs);
      if (scraped.error === 'challenge') { await stopBatch('LinkedIn challenge page seen - stopping for the day'); return; }
      if (scraped.error) note = scraped.error;
      else {
        const r = await api('/api/extension/connections', { method: 'POST', body: JSON.stringify(scraped) });
        ok = true; note = `advanced ${(r.advanced || []).length}: ${(r.advanced || []).join(', ') || 'none new'}`;
      }
      await bumpCounter();
    }
  } catch (e) {
    note = e.message;
  }

  st = await getState();
  const log = (st.log || []).concat([{ name: item.name || item.url, ok, note, at: Date.now() }]).slice(-60);
  const consecFail = ok ? 0 : (st.consecFail || 0) + 1;
  await setState({
    index: st.index + 1,
    done: st.done + (ok ? 1 : 0),
    failed: st.failed + (ok ? 0 : 1),
    consecFail, log
  });

  if (consecFail >= s.maxConsecutiveFailures) { await stopBatch(`stopped after ${consecFail} failures in a row`); return; }
  if (st.index + 1 >= st.total) { await setState({ running: false, finishedAt: Date.now(), current: null }); return; }

  // schedule the next one - occasional long break
  const doneCount = st.index + 1;
  const gap = (doneCount % s.longBreakEvery === 0)
    ? rnd(s.longBreakMinMs, s.longBreakMaxMs)
    : rnd(s.minGapMs, s.maxGapMs);
  chrome.alarms.create(ALARM, { when: Date.now() + gap });
  await setState({ current: `next in ${Math.round(gap / 1000)}s` });
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) tick(); });

// ---------- messages from popup / content ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'startBatch') sendResponse(await startBatch(msg.kind || 'profiles'));
      else if (msg.type === 'stopBatch') { await stopBatch('stopped by you'); sendResponse({ ok: true }); }
      else if (msg.type === 'getStatus') {
        sendResponse({ batch: await getState(), counters: await getCounters(), settings: await getSettings() });
      } else if (msg.type === 'testConnection') {
        sendResponse(await api('/api/extension/ping'));
      } else if (msg.type === 'passiveProfile') {
        // fire-and-forget; still counts toward the daily cap
        const c = await getCounters();
        const s = await getSettings();
        if (c.dailyLoads < s.dailyCap) {
          await bumpCounter();
          await api('/api/extension/profile', { method: 'POST', body: JSON.stringify(msg.payload) }).catch(() => {});
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'syncThread') {
        // popup asks to sync the thread in the active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !/linkedin\.com\/messaging/.test(tab.url || '')) return sendResponse({ error: 'Open a LinkedIn conversation first.' });
        const scraped = await chrome.tabs.sendMessage(tab.id, { type: 'scrapeThread' });
        if (scraped.error) return sendResponse({ error: scraped.error });
        sendResponse(await api('/api/extension/conversation', { method: 'POST', body: JSON.stringify(scraped) }));
      } else sendResponse({ error: 'unknown message' });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true;
});
