const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

$('openOpts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

async function refresh() {
  const st = await send({ type: 'getStatus' });
  const s = st.settings || {};
  const c = st.counters || {};
  const b = st.batch || null;

  $('capDay').textContent = c.dailyLoads || 0;
  $('capDayMax').textContent = s.dailyCap;
  $('capHr').textContent = (c.hourStamps || []).filter((t) => Date.now() - t < 3600000).length;
  $('capHrMax').textContent = s.hourlyCap;

  // connection / queue
  if (!s.token) {
    $('acct').innerHTML = 'Not connected. <a href="#" id="o">Set token</a>';
    $('o').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
    $('queueN').textContent = '';
  } else {
    try {
      const ping = await send({ type: 'testConnection' });
      if (ping.error) $('acct').textContent = 'CRM error: ' + ping.error;
      else {
        $('acct').textContent = `Connected — ${ping.account}`;
        $('queueN').textContent = `${ping.queueCount} due`;
      }
    } catch (e) { $('acct').textContent = 'CRM unreachable'; }
  }

  // batch state
  const running = b && b.running;
  $('startProfiles').disabled = running;
  $('syncConns').disabled = running;
  $('stop').style.display = running ? 'block' : 'none';
  if (b) {
    const pct = b.total ? Math.round(((b.index || 0) / b.total) * 100) : 0;
    $('prog').style.width = pct + '%';
    if (running) $('status').textContent = `${b.done}/${b.total} done · ${b.failed} skipped · ${b.current || ''}`;
    else if (b.finishedAt) $('status').textContent = `Finished: ${b.done}/${b.total} captured, ${b.failed} skipped.`;
    else if (b.stoppedReason) $('status').textContent = b.stoppedReason;
    const log = $('log');
    log.innerHTML = (b.log || []).slice().reverse().map((l) =>
      `<div class="${l.ok ? 'ok' : 'bad'}">${l.ok ? '✓' : '–'} ${l.name} <span class="muted">${l.note || ''}</span></div>`).join('');
  }
}

$('startProfiles').addEventListener('click', async () => {
  $('status').textContent = 'Building the queue…';
  const r = await send({ type: 'startBatch', kind: 'profiles' });
  if (r.error) $('status').textContent = r.error;
  refresh();
});
$('stop').addEventListener('click', async () => { await send({ type: 'stopBatch' }); refresh(); });
$('syncConns').addEventListener('click', async () => {
  $('status').textContent = 'Reading your connections list…';
  const r = await send({ type: 'startBatch', kind: 'connections' });
  if (r.error) $('status').textContent = r.error;
  refresh();
});
$('syncThread').addEventListener('click', async () => {
  $('syncThread').disabled = true; $('syncThread').textContent = 'Reading thread…';
  const r = await send({ type: 'syncThread' });
  $('syncThread').disabled = false; $('syncThread').textContent = 'Sync the open conversation';
  $('status').textContent = r.error ? r.error
    : r.matched === false ? 'No CRM contact matched this conversation.'
    : `Synced ${r.name}${r.replyLogged ? ' — reply logged, follow-up ready' : ''}.`;
});

refresh();
setInterval(refresh, 3000);
