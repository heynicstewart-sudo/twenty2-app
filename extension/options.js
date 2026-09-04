const $ = (id) => document.getElementById(id);
// Accept a bare host ("foo.up.railway.app") or a full URL - always store a
// scheme, or fetch() treats it as a path relative to the extension origin.
const normBase = (v) => {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
};
const FIELDS = ['apiBase', 'token', 'clientSlug', 'hourlyCap', 'dailyCap', 'activeHoursStart', 'activeHoursEnd'];

(async function load() {
  const s = { ...DEFAULT_SETTINGS, ...((await chrome.storage.local.get('settings')).settings || {}) };
  FIELDS.forEach((f) => { $(f).value = s[f]; });
  $('minGapSec').value = Math.round(s.minGapMs / 1000);
  $('maxGapSec').value = Math.round(s.maxGapMs / 1000);
})();

$('save').addEventListener('click', async () => {
  const cur = (await chrome.storage.local.get('settings')).settings || {};
  const next = { ...cur };
  next.apiBase = normBase($('apiBase').value) || DEFAULT_SETTINGS.apiBase;
  next.token = $('token').value.trim();
  next.clientSlug = $('clientSlug').value.trim();
  next.hourlyCap = Math.max(1, +$('hourlyCap').value || DEFAULT_SETTINGS.hourlyCap);
  next.dailyCap = Math.max(1, +$('dailyCap').value || DEFAULT_SETTINGS.dailyCap);
  next.activeHoursStart = Math.min(23, Math.max(0, +$('activeHoursStart').value));
  next.activeHoursEnd = Math.min(24, Math.max(1, +$('activeHoursEnd').value));
  next.minGapMs = Math.max(30, +$('minGapSec').value || 32) * 1000;
  next.maxGapMs = Math.max(next.minGapMs / 1000, +$('maxGapSec').value || 65) * 1000;
  await chrome.storage.local.set({ settings: next });
  $('saved').textContent = 'Saved.';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
});
