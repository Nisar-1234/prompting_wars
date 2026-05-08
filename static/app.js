// ── STATE ─────────────────────────────────────────────────────
let apiKey = localStorage.getItem('voyager_key') || '';
let currentTrip = null;
let selectedPrefs = [];
let _planning = false;
let _modifying = false;
let _currentAbort = null;
let _retryTimer = null;   // countdown interval reference
let _pendingPlanPayload = null;   // stored so auto-retry can replay it

// ── SETUP ─────────────────────────────────────────────────────
function startApp() {
  const k = document.getElementById('api-key-input').value.trim();
  if (!k || !k.startsWith('AIza')) {
    document.getElementById('setup-error').textContent = 'Please enter a valid Gemini API key (starts with AIza...)';
    return;
  }
  apiKey = k;
  localStorage.setItem('voyager_key', k);
  document.getElementById('setup-modal').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function showSetup() {
  document.getElementById('api-key-input').value = apiKey;
  document.getElementById('setup-modal').classList.remove('hidden');
}

function toggleKey() {
  const inp = document.getElementById('api-key-input');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

window.onload = () => {
  if (apiKey && apiKey.startsWith('AIza')) {
    document.getElementById('setup-modal').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
  }
};

// ── RATE LIMIT HANDLER ─────────────────────────────────────────
/**
 * Shows a live countdown in chat and auto-retries the API when it hits zero.
 * @param {number} seconds  - how long to wait before retrying
 * @param {function} retryFn - zero-arg function to call after countdown
 */
function handleRateLimit(seconds, retryFn) {
  if (_retryTimer) clearInterval(_retryTimer);

  let remaining = seconds;
  const msgId = 'rl-' + Date.now();

  // Show countdown message in chat
  const el = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'msg msg-ai';
  div.id = msgId;
  div.innerHTML = `
    <div class="msg-label">🤖 VOYAGER AI</div>
    <div id="rl-body">
      ⚠️ <strong>Gemini free-tier quota hit</strong> — all models are cooling down.<br><br>
      🔁 Auto-retrying in <strong id="rl-count">${remaining}s</strong>&hellip;
      <br><small style="color:var(--muted)">No action needed. Trying gemini-2.0-flash → flash-lite → flash-8b automatically.</small>
    </div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;

  _retryTimer = setInterval(() => {
    remaining--;
    const counter = document.getElementById('rl-count');
    if (counter) counter.textContent = remaining + 's';

    if (remaining <= 0) {
      clearInterval(_retryTimer);
      _retryTimer = null;
      const body = document.getElementById('rl-body');
      if (body) body.innerHTML = '🔄 <strong>Retrying now…</strong>';
      retryFn();
    }
  }, 1000);
}

// ── CHIPS ─────────────────────────────────────────────────────
function toggleChip(el) {
  const v = el.dataset.v;
  el.classList.toggle('active');
  const on = el.classList.contains('active');
  el.setAttribute('aria-pressed', on);
  if (on) selectedPrefs.push(v);
  else selectedPrefs = selectedPrefs.filter(x => x !== v);
}

// ── PLAN TRIP ─────────────────────────────────────────────────
async function planTrip() {
  if (_planning) return;   // debounce: ignore duplicate clicks

  const dest = document.getElementById('dest-input').value.trim();
  if (!dest) { showToast('Please enter a destination'); return; }

  const days      = document.getElementById('days-sel').value;
  const travelers = document.getElementById('travelers-sel').value;
  const budget    = document.getElementById('budget-sel').value;

  _planning = true;
  const btn = document.getElementById('plan-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>&nbsp; Gemini is planning...';

  // Switch to chat view immediately to show progress
  document.getElementById('quick-start').classList.add('hidden');
  document.getElementById('chat-msgs').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');

  const thinkId = addThinking();

  // 90-second client timeout
  _currentAbort = new AbortController();
  const timeoutId = setTimeout(() => _currentAbort.abort(), 90000);

  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: dest, days: +days, travelers: +travelers, budget: +budget, preferences: selectedPrefs, api_key: apiKey }),
      signal: _currentAbort.signal
    });

    clearTimeout(timeoutId);
    const data = await res.json();
    console.log('API response:', data);
    removeThinking(thinkId);

    if (data.error) {
      // Quota exceeded: show countdown + auto-retry
      if (data.error === 'quota_exceeded') {
        const payload = { destination: dest, days: +days, travelers: +travelers, budget: +budget, preferences: selectedPrefs, api_key: apiKey };
        handleRateLimit(data.retry_after || 60, () => _replayPlan(payload));
        return;
      }
      addMsg('ai', `⚠️ <strong>Error from Gemini API:</strong><br><code>${data.error}</code><br><br>Please check your API key in Settings and try again.`);
      return;
    }

    currentTrip = data;
    renderTrip(data, dest, data._cached);
  } catch (e) {
    clearTimeout(timeoutId);
    removeThinking(thinkId);
    if (e.name === 'AbortError') {
      addMsg('ai', '⚠️ <strong>Request timed out</strong> after 90 seconds.<br>Gemini may be busy — please try again.');
    } else {
      console.error('planTrip error:', e);
      addMsg('ai', `⚠️ <strong>Network Error:</strong><br>${e.message}<br><br>Check your connection or try again.`);
    }
  } finally {
    _planning = false;
    btn.disabled = false;
    btn.innerHTML = '<span>✨ Plan My Trip with Gemini AI</span>';
  }
}

// ── MODIFY TRIP ───────────────────────────────────────────────
async function sendModify(e) {
  e.preventDefault();
  if (_modifying) return;  // debounce

  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg || !currentTrip) return;

  _modifying = true;
  addMsg('user', msg);
  input.value = '';
  const thinkId = addThinking();

  // 90-second client timeout
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), 90000);

  try {
    const res = await fetch('/api/modify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_itinerary: currentTrip, modification: msg, api_key: apiKey }),
      signal: abort.signal
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    removeThinking(thinkId);
    currentTrip = data;
    renderTrip(data, data.destination, false);
    addMsg('ai', `✅ Updated! ${data.summary || 'Your itinerary has been modified.'}`);
  } catch (e) {
    clearTimeout(timeoutId);
    removeThinking(thinkId);
    // Parse quota_exceeded from modify too
    try {
      const parsed = (typeof e.message === 'string') ? JSON.parse(e.message) : null;
      if (parsed && parsed.error === 'quota_exceeded') {
        handleRateLimit(parsed.retry_after || 60, () => sendModify({ preventDefault: () => {}, _replay: { msg } }));
        return;
      }
    } catch (_) {}
    if (e.name === 'AbortError') {
      addMsg('ai', '⚠️ <strong>Request timed out</strong> — please try a simpler modification.');
    } else {
      addMsg('ai', '⚠️ Error: ' + e.message);
    }
  } finally {
    _modifying = false;
  }
}

// Internal: replays a plan request after rate-limit countdown
async function _replayPlan(payload) {
  _planning = false;  // reset guard so planTrip can run
  const thinkId = addThinking();
  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    removeThinking(thinkId);
    if (data.error === 'quota_exceeded') {
      handleRateLimit(data.retry_after || 60, () => _replayPlan(payload));
      return;
    }
    if (data.error) {
      addMsg('ai', `⚠️ <strong>Still failing:</strong><br><code>${data.error}</code>`);
      return;
    }
    currentTrip = data;
    renderTrip(data, payload.destination, data._cached);
  } catch (e) {
    removeThinking(thinkId);
    addMsg('ai', '⚠️ Retry failed: ' + e.message);
  }
}

// ── RENDER ────────────────────────────────────────────────────
function renderTrip(trip, dest, fromCache = false) {
  // Switch to chat view
  document.getElementById('quick-start').classList.add('hidden');
  document.getElementById('chat-msgs').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');
  document.getElementById('save-btn').disabled = false;

  // Trip badge
  document.getElementById('trip-badge').textContent = `${trip.destination || dest} · ${trip.total_days || trip.days?.length || '?'} days`;

  // Map
  const encoded = encodeURIComponent((trip.destination || dest) + ', travel itinerary');
  const mapSrc = `https://maps.google.com/maps?q=${encodeURIComponent(trip.destination || dest)}&output=embed&z=12`;
  const frame = document.getElementById('map-frame');
  frame.src = mapSrc;
  frame.classList.remove('hidden');
  document.getElementById('map-placeholder').classList.add('hidden');

  // Stats
  const total = trip.estimated_budget?.total || 0;
  const days = trip.days || [];
  const acts = days.reduce((s, d) => s + (d.activities?.length || 0), 0);
  document.getElementById('stat-budget').textContent = total ? `$${total.toLocaleString()}` : '—';
  document.getElementById('stat-days').textContent = days.length || '—';
  document.getElementById('stat-acts').textContent = acts || '—';

  // Itinerary
  document.getElementById('itin-title').textContent = `📍 ${trip.trip_title || trip.destination}`;
  const container = document.getElementById('day-cards');
  container.innerHTML = '';
  days.forEach((d, i) => {
    const card = document.createElement('div');
    card.className = 'day-card' + (i === 0 ? ' active' : '');
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Day ${d.day}: ${d.theme}`);
    const pct = total > 0 ? Math.min(100, Math.round((d.day_total_cost || 0) / (total / days.length) * 100)) : 60;
    card.innerHTML = `
      <div class="day-num">Day ${d.day}</div>
      <div class="day-theme">${d.theme || 'Exploration'}</div>
      <div class="day-acts">${d.activities?.length || 0} activities</div>
      <div class="day-cost">$${d.day_total_cost || 0} budget</div>
      <div class="day-bar"><div class="day-bar-fill" style="width:${pct}%"></div></div>`;
    card.onclick = () => selectDay(d, card, trip.destination || dest);
    card.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') selectDay(d, card, trip.destination || dest); };
    container.appendChild(card);
  });

  // Initial AI message
  const highlights  = trip.highlights?.join(' · ') || '';
  const cacheNotice = fromCache ? ' <span style="font-size:0.75rem;background:#10b98133;color:#10b981;padding:2px 7px;border-radius:9px;margin-left:6px;">⚡ Instant</span>' : '';
  addMsg('ai', `✈️ <strong>${trip.trip_title}</strong>${cacheNotice}<br><br>${trip.summary || ''}<br><br>${highlights ? '🌟 ' + highlights : ''}<br><br><em>Ask me to change anything!</em>`);
}

function selectDay(day, card, dest) {
  document.querySelectorAll('.day-card').forEach(c => c.classList.remove('active'));
  card.classList.add('active');

  // Update map to specific day
  const firstPlace = day.activities?.[0]?.name || dest;
  document.getElementById('map-frame').src = `https://maps.google.com/maps?q=${encodeURIComponent(firstPlace + ', ' + dest)}&output=embed&z=14`;

  const actList = day.activities?.map(a => `${a.time || ''} · ${a.name} (${a.duration || ''}, $${a.cost || 0})`).join('<br>') || 'No activities';
  addMsg('ai', `📅 <strong>Day ${day.day} — ${day.theme}</strong><br><br>${actList}<br><br>💰 Day total: <strong>$${day.day_total_cost || 0}</strong>`);
}

// ── CHAT HELPERS ──────────────────────────────────────────────
function addMsg(role, html) {
  const el = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  div.innerHTML = `<div class="msg-label">${role === 'ai' ? '🤖 VOYAGER AI' : '👤 You'}</div>${html}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function addThinking() {
  const el = document.getElementById('chat-msgs');
  const id = 'think-' + Date.now();
  const div = document.createElement('div');
  div.className = 'msg msg-ai'; div.id = id;
  div.innerHTML = `<div class="msg-label">🤖 VOYAGER AI</div><div class="thinking">Thinking with Gemini <span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  el.appendChild(div); el.scrollTop = el.scrollHeight;
  return id;
}

function removeThinking(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ── ACTIONS ───────────────────────────────────────────────────
function saveTrip() {
  if (!currentTrip) return;
  localStorage.setItem('voyager_saved_trip', JSON.stringify(currentTrip));
  showToast('✅ Trip saved locally!');
}

function showQuickStart() {
  document.getElementById('quick-start').classList.remove('hidden');
  document.getElementById('chat-msgs').classList.add('hidden');
  document.getElementById('chat-input-area').classList.add('hidden');
  document.getElementById('chat-msgs').innerHTML = '';
  currentTrip = null;
  document.getElementById('trip-badge').textContent = 'No trip planned yet';
  document.getElementById('map-frame').classList.add('hidden');
  document.getElementById('map-placeholder').classList.remove('hidden');
  document.getElementById('stat-budget').textContent = '—';
  document.getElementById('stat-days').textContent = '—';
  document.getElementById('stat-acts').textContent = '—';
  document.getElementById('day-cards').innerHTML = '';
  document.getElementById('save-btn').disabled = true;
}

function showToast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.borderColor = isErr ? '#f87171' : 'var(--ok)';
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

// Enter key submits plan
document.getElementById('dest-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') planTrip();
});
