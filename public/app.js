let device = null;
let session = null;
let identity = null;
let agentName = null;
let currentCall = null;
let callTimerInt = null;

const $ = (id) => document.getElementById(id);
const log = (m) => { $('log').textContent = `${new Date().toLocaleTimeString()}  ${m}\n` + $('log').textContent; };

function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (session) h['Authorization'] = 'Bearer ' + session;
  return h;
}

function slug(name) {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent') + '-' + Math.random().toString(36).slice(2, 5);
}

// Roster of known agents, used as name suggestions on the login form.
let roster = [];
async function loadAuthConfig() {
  try {
    const r = await fetch('/api/auth-config');
    const d = await r.json();
    roster = d.users || [];
    const dl = $('agentNames');
    if (dl) dl.innerHTML = roster.map((u) => `<option value="${u.name}"></option>`).join('');
    return d;
  } catch { return { authRequired: false, users: [] }; }
}
loadAuthConfig();

// Remember this browser's display name so it survives reloads and sign-outs.
function rememberName(n) { try { if (n) localStorage.setItem('jrh_name', n); } catch (e) {} }
function rememberedName() { try { return localStorage.getItem('jrh_name') || ''; } catch (e) { return ''; } }
try {
  const rn = rememberedName();
  if (rn && $('agentName') && !$('agentName').value) $('agentName').value = rn;
} catch (e) {}

$('loginBtn').onclick = async () => {
  // Name is optional: blank keeps the account's default (e.g. "Agent 1").
  const typedName = ($('agentName').value || '').trim();
  agentName = typedName;
  try {
    const cfgD = await loadAuthConfig();
    if (cfgD.authRequired) {
      const pw = ($('consolePw').value || '').trim();
      if (!pw) { alert('Enter your password'); return; }
      const lr = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: agentName, password: pw }),
      });
      if (!lr.ok) { alert('Wrong name or password'); log('login denied'); return; }
      const ld = await lr.json();
      session = ld.session;
      agentName = ld.user.name;      // canonical name from the server
      identity = ld.user.id;         // verified identity
      if (typedName) rememberName(ld.user.name);
    } else {
      agentName = agentName || 'Agent';
      identity = slug(agentName);
    }
    const r = await fetch('/api/token', { headers: authHeaders() });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('token request failed (' + r.status + ')'));
    if (!data.token) throw new Error('no access token in response');
    identity = data.identity;
    device = new Twilio.Device(data.token, { codecPreferences: ['opus', 'pcmu'], logLevel: 'error' });
    wireDevice();
    await device.register();
    $('loginCard').classList.add('hidden');
    $('consoleCard').classList.remove('hidden');
    $('whoami').textContent = agentName;
    $('avatar').textContent = agentName.trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase() || 'JR';
    setStatus('available');
    startPolling();
    log(`online as ${agentName}`);
  } catch (e) {
    const msg = (e && e.message) ? e.message : 'connection problem — please try again';
    alert('Could not go online: ' + msg);
    log('login error: ' + msg);
  }
};

function wireDevice() {
  device.on('registered', () => { $('deviceState').innerHTML = '<span class="pill-dot"></span>Ready'; $('deviceState').className = 'pill pill-on'; });
  device.on('unregistered', () => { $('deviceState').innerHTML = '<span class="pill-dot"></span>Offline'; $('deviceState').className = 'pill pill-off'; });
  device.on('error', (e) => log('device error: ' + e.message));
  device.on('incoming', (call) => {
    currentCall = call;
    $('incoming').classList.remove('hidden');
    $('idleState').classList.add('hidden');
    log('incoming call');
    call.on('cancel', () => hideIncoming());
    call.on('disconnect', () => endCall());
  });
}

$('answerBtn').onclick = () => { if (currentCall) { currentCall.accept(); hideIncoming(); onCall(); } };
$('declineBtn').onclick = () => { if (currentCall) { currentCall.reject(); hideIncoming(); } };
$('hangupBtn').onclick = () => { if (currentCall) currentCall.disconnect(); };

$('answerNextBtn').onclick = async () => {
  if (!device) return;
  try {
    currentCall = await device.connect({ params: { identity } });
    currentCall.on('disconnect', () => endCall());
    onCall();
    log('pulling next caller from queue');
  } catch (e) { log('answer-next error: ' + e.message); }
};

$('availBtn').onclick = () => setStatus('available');
$('awayBtn').onclick = () => setStatus('away');

async function setStatus(status) {
  $('availBtn').classList.toggle('on', status === 'available');
  $('awayBtn').classList.toggle('on', status === 'away');
  try { await fetch('/api/presence', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ status }) }); } catch {}
}

function hideIncoming() { $('incoming').classList.add('hidden'); if ($('oncall').classList.contains('hidden')) $('idleState').classList.remove('hidden'); }
function onCall() {
  $('oncall').classList.remove('hidden');
  $('idleState').classList.add('hidden');
  $('incoming').classList.add('hidden');
  let s = 0;
  callTimerInt = setInterval(() => { s++; $('callTimer').textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }, 1000);
}
function endCall() {
  currentCall = null;
  $('oncall').classList.add('hidden');
  $('idleState').classList.remove('hidden');
  clearInterval(callTimerInt); $('callTimer').textContent = '00:00';
  log('call ended');
}

function startPolling() {
  const tick = async () => {
    try {
      const r = await fetch('/api/status'); const d = await r.json();
      $('qSize').textContent = d.queue.size;
      $('qWait').textContent = (d.queue.avgWait || 0) + 's';
      const ul = $('agentList'); ul.innerHTML = '';
      for (const a of d.agents) {
        const li = document.createElement('li');
        const ini = (a.name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
        li.innerHTML = `<span class="a-left"><span class="a-av">${ini}</span><span>${a.name}</span></span><span class="s s-${a.status}"><span class="s-dot"></span>${a.status}</span>`;
        ul.appendChild(li);
      }
      fetch('/api/presence', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({}) });
    } catch {}
  };
  tick(); setInterval(tick, 3000);
}

/* ============ MUTE ============ */
let isMuted = false;
$('muteBtn').onclick = () => {
  if (!currentCall) return;
  isMuted = !isMuted;
  currentCall.mute(isMuted);
  $('muteBtn').textContent = isMuted ? 'Unmute' : 'Mute';
  $('muteBtn').classList.toggle('on', isMuted);
  log(isMuted ? 'Microphone muted' : 'Microphone unmuted');
};

/* ============ SETTINGS ============ */
function openSettings() {
  $('settingsName').value = agentName || '';
  $('settingsName').readOnly = false;
  $('settingsOverlay').classList.remove('hidden');
}
function closeSettings() { $('settingsOverlay').classList.add('hidden'); }
$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = closeSettings;
$('settingsOverlay').addEventListener('click', (e) => { if (e.target === $('settingsOverlay')) closeSettings(); });
$('settingsSave').onclick = async () => {
  const n = ($('settingsName').value || '').trim();
  if (!n) { alert('Enter a display name'); return; }
  if (n === agentName) { closeSettings(); return; }
  try {
    const r = await fetch('/api/rename', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: n }),
    });
    if (!r.ok) throw new Error('rename failed');
    const d = await r.json();
    session = d.session;             // fresh token carrying the new name
    agentName = d.user.name;
    $('whoami').textContent = agentName;
    $('avatar').textContent = agentName.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'JR';
    rememberName(agentName);
    try {
      await fetch('/api/presence', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
    } catch (e) {}
    log(`display name set to ${agentName}`);
    closeSettings();
  } catch (e) { alert('Could not save name: ' + e.message); }
};
$('settingsSignout').onclick = async () => {
  try { await setStatus('away'); } catch (e) {}
  try { if (currentCall) currentCall.disconnect(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  location.reload();
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });
