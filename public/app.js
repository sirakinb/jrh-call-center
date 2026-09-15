let device = null;
let identity = null;
let agentName = null;
let currentCall = null;
let callTimerInt = null;

const $ = (id) => document.getElementById(id);
const log = (m) => { $('log').textContent = `${new Date().toLocaleTimeString()}  ${m}\n` + $('log').textContent; };

function slug(name) {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent') + '-' + Math.random().toString(36).slice(2, 5);
}

$('loginBtn').onclick = async () => {
  agentName = ($('agentName').value || '').trim();
  if (!agentName) { alert('Enter your name'); return; }
  identity = slug(agentName);
  try {
    const r = await fetch(`/api/token?identity=${encodeURIComponent(identity)}&name=${encodeURIComponent(agentName)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'token failed');
    device = new Twilio.Device(data.token, { codecPreferences: ['opus', 'pcmu'], logLevel: 'error' });
    wireDevice();
    await device.register();
    $('loginCard').classList.add('hidden');
    $('consoleCard').classList.remove('hidden');
    $('whoami').textContent = agentName;
    setStatus('available');
    startPolling();
    log(`online as ${identity}`);
  } catch (e) {
    alert('Could not go online: ' + e.message);
    log('login error: ' + e.message);
  }
};

function wireDevice() {
  device.on('registered', () => { $('deviceState').textContent = 'Device: ready'; $('deviceState').className = 'pill pill-on'; });
  device.on('unregistered', () => { $('deviceState').textContent = 'Device: offline'; $('deviceState').className = 'pill pill-off'; });
  device.on('error', (e) => log('device error: ' + e.message));
  device.on('incoming', (call) => {
    currentCall = call;
    $('incoming').classList.remove('hidden');
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
  try { await fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity, name: agentName, status }) }); } catch {}
}

function hideIncoming() { $('incoming').classList.add('hidden'); }
function onCall() {
  $('oncall').classList.remove('hidden');
  $('answerNextBtn').classList.add('hidden');
  let s = 0;
  callTimerInt = setInterval(() => { s++; $('callTimer').textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }, 1000);
}
function endCall() {
  currentCall = null;
  $('oncall').classList.add('hidden');
  $('answerNextBtn').classList.remove('hidden');
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
        li.innerHTML = `<span>${a.name}</span><span class="s s-${a.status}">${a.status}</span>`;
        ul.appendChild(li);
      }
      fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity, name: agentName }) });
    } catch {}
  };
  tick(); setInterval(tick, 3000);
}
