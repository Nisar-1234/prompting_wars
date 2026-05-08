// ── STATE ─────────────────────────────────────────────────────
let apiKey = localStorage.getItem('voyager_key') || '';
let currentTrip = null;
let selectedPrefs = [];

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
  const dest = document.getElementById('dest-input').value.trim();
  if (!dest) { showToast('Please enter a destination'); return; }

  const days = document.getElementById('days-sel').value;
  const travelers = document.getElementById('travelers-sel').value;
  const budget = document.getElementById('budget-sel').value;

  const btn = document.getElementById('plan-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';

  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: dest, days: +days, travelers: +travelers, budget: +budget, preferences: selectedPrefs, api_key: apiKey })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentTrip = data;
    renderTrip(data, dest);
  } catch (e) {
    showToast('Error: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>✨ Plan My Trip with Gemini AI</span>';
  }
}

// ── MODIFY TRIP ───────────────────────────────────────────────
async function sendModify(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg || !currentTrip) return;

  addMsg('user', msg);
  input.value = '';
  const thinkId = addThinking();

  try {
    const res = await fetch('/api/modify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_itinerary: currentTrip, modification: msg, api_key: apiKey })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    removeThinking(thinkId);
    currentTrip = data;
    renderTrip(data, data.destination);
    addMsg('ai', `✅ Updated! ${data.summary || 'Your itinerary has been modified.'}`);
  } catch (e) {
    removeThinking(thinkId);
    addMsg('ai', '⚠️ Error: ' + e.message);
  }
}

// ── RENDER ────────────────────────────────────────────────────
function renderTrip(trip, dest) {
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
  const highlights = trip.highlights?.join(' · ') || '';
  addMsg('ai', `✈️ <strong>${trip.trip_title}</strong><br><br>${trip.summary || ''}<br><br>${highlights ? '🌟 ' + highlights : ''}<br><br><em>Ask me to change anything!</em>`);
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
