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

$('loginBtn').onclick = async () => {
  agentName = ($('agentName').value || '').trim();
  if (!agentName) { alert('Enter your name'); return; }
  identity = slug(agentName);
  try {
    const cfgR = await fetch('/api/auth-config');
    const cfgD = await cfgR.json().catch(() => ({ authRequired: false }));
    if (cfgD.authRequired) {
      const pw = ($('consolePw').value || '').trim();
      if (!pw) { alert('Enter the team password'); return; }
      const lr = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      if (!lr.ok) { alert('Wrong team password'); log('login denied'); return; }
      session = (await lr.json()).session;
    }
    const r = await fetch(`/api/token?identity=${encodeURIComponent(identity)}&name=${encodeURIComponent(agentName)}`, { headers: authHeaders() });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'token failed');
    device = new Twilio.Device(data.token, { codecPreferences: ['opus', 'pcmu'], logLevel: 'error' });
    wireDevice();
    await device.register();
    $('loginCard').classList.add('hidden');
    $('consoleCard').classList.remove('hidden');
    $('whoami').textContent = agentName;
    $('avatar').textContent = agentName.trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase() || 'JR';
    setStatus('available');
    startPolling();
    log(`online as ${identity}`);
  } catch (e) {
    alert('Could not go online: ' + e.message);
    log('login error: ' + e.message);
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
  try { await fetch('/api/presence', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ identity, name: agentName, status }) }); } catch {}
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
      fetch('/api/presence', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ identity, name: agentName }) });
    } catch {}
  };
  tick(); setInterval(tick, 3000);
}
