import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import twilio from 'twilio';
import { cfg, url } from './config.js';
import * as presence from './presence.js';
import * as tracker from './calltracker.js';
import { writeBridgedCall, updateBridgedCall, findByRecordingSid, zohoEnabled } from './zoho.js';
import * as vi from './vi.js';
import { authGuard, checkPassword, issueToken, authRequired } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { VoiceResponse } = twilio.twiml;
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.html?$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  }
}));

const rest = twilio(cfg.accountSid, cfg.authToken);

function twilioGuard(req, res, next) {
  if (process.env.VALIDATE_TWILIO !== 'true') return next();
  const sig = req.header('X-Twilio-Signature');
  const valid = twilio.validateRequest(cfg.authToken, sig, url(req.originalUrl), req.body);
  if (!valid) return res.status(403).send('Invalid Twilio signature');
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'jrh-callcenter' }));

// Shared-password login: returns a stateless session token used as Bearer on
// the endpoints that let a browser take live calls.
app.get('/api/auth-config', (_req, res) => res.json({ authRequired: authRequired() }));
app.post('/api/login', (req, res) => {
  const pw = (req.body && req.body.password) || '';
  if (!checkPassword(pw)) return res.status(401).json({ error: 'wrong password' });
  res.json({ session: issueToken() });
});

// ---------------------------------------------------------------------------
// AGENT CONSOLE APIs
// ---------------------------------------------------------------------------

// Issue a Voice SDK access token so an agent's browser can send/receive calls.
app.get('/api/token', authGuard, (req, res) => {
  const identity = (req.query.identity || '').toString().trim();
  const name = (req.query.name || identity).toString().trim();
  if (!identity) return res.status(400).json({ error: 'identity required' });
  if (!cfg.apiKeySid || !cfg.apiKeySecret || !cfg.twimlAppSid) {
    return res.status(500).json({ error: 'Voice SDK not provisioned (missing API key / TwiML app)' });
  }
  presence.upsertAgent(identity, name);
  const token = new AccessToken(cfg.accountSid, cfg.apiKeySid, cfg.apiKeySecret, {
    identity,
    ttl: 3600,
  });
  token.addGrant(new VoiceGrant({ outgoingApplicationSid: cfg.twimlAppSid, incomingAllow: true }));
  res.json({ identity, token: token.toJwt() });
});

// Agent sets presence (available/away). Also serves as heartbeat.
app.post('/api/presence', authGuard, (req, res) => {
  const { identity, name, status } = req.body;
  if (!identity) return res.status(400).json({ error: 'identity required' });
  presence.upsertAgent(identity, name);
  if (status) presence.setStatus(identity, status);
  res.json({ ok: true, agents: presence.listAgents() });
});

// Live queue + agent snapshot for the console dashboard.
app.get('/api/status', async (_req, res) => {
  let queue = { current_size: 0, average_wait_time: 0 };
  try {
    const qs = await rest.queues.list({ limit: 20 });
    const q = qs.find((x) => x.friendlyName === cfg.queueName);
    if (q) queue = { current_size: q.currentSize, average_wait_time: q.averageWaitTime };
  } catch (e) { /* queue may not exist until first caller */ }
  res.json({
    queue: { size: queue.current_size, avgWait: queue.average_wait_time },
    agents: presence.listAgents(),
  });
});

// ---------------------------------------------------------------------------
// INBOUND CALL FLOW (Retell cold-transfers caller into the bridge number)
// ---------------------------------------------------------------------------

app.post('/voice/incoming', twilioGuard, async (req, res) => {
  const twiml = new VoiceResponse();
  // PA two-party consent notice, then place caller in the queue.
  twiml.say({ voice: 'Polly.Joanna' }, cfg.recordingNotice);
  const enqueue = twiml.enqueue({
    waitUrl: url('/voice/wait'),
    action: url('/voice/queue-result'),
  }, cfg.queueName);
  void enqueue;
  res.type('text/xml').send(twiml.toString());

  // Track this caller for correlation with the agent leg + recording.
  try { tracker.callerEnqueued({ callSid: req.body.CallSid, from: req.body.From, to: req.body.To }); } catch (e) { console.error('track enqueue:', e.message); }

  // Fire-and-forget: try to ring an available agent's browser to pick up.
  try { await ringNextAvailableAgent(); } catch (e) { console.error('ring agent:', e.message); }
});

// Hold experience: position + estimated wait + music, looped by Twilio.
app.post('/voice/wait', twilioGuard, (req, res) => {
  const twiml = new VoiceResponse();
  const pos = parseInt(req.body.QueuePosition || '0', 10);
  const avg = parseInt(req.body.AverageQueueTime || req.body.CurrentQueueSize || '0', 10);
  if (pos > 0) {
    const mins = Math.max(1, Math.round((pos * Math.max(avg, 60)) / 60));
    const ordinal = pos === 1 ? 'first' : `number ${pos}`;
    twiml.say({ voice: 'Polly.Joanna' },
      `You are ${ordinal} in line. Your estimated wait is about ${mins} ${mins === 1 ? 'minute' : 'minutes'}. Please stay on the line.`);
  }
  twiml.play(cfg.holdMusicUrl);
  res.type('text/xml').send(twiml.toString());
});

// After the caller leaves the queue (bridged, or gave up / timed out).
app.post('/voice/queue-result', twilioGuard, (req, res) => {
  const twiml = new VoiceResponse();
  const result = req.body.QueueResult;
  if (result === 'bridged' || result === 'redirected') {
    twiml.hangup();
  } else {
    // hung-up, error, or system: offer voicemail fallback.
    twiml.say({ voice: 'Polly.Joanna' }, 'We are sorry for the wait. Please leave a message after the tone and our team will call you back.');
    twiml.record({
      action: url('/voice/voicemail-done'),
      recordingStatusCallback: url('/voice/recording-status'),
      recordingStatusCallbackEvent: 'completed',
      maxLength: 180,
      playBeep: true,
    });
  }
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/voicemail-done', twilioGuard, (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say('Thank you. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ---------------------------------------------------------------------------
// AGENT CONNECT: both the browser "Answer" and the auto-ring land here.
// Dequeues the oldest waiting caller and bridges, recording dual-channel.
// ---------------------------------------------------------------------------
app.post('/voice/agent-connect', twilioGuard, (req, res) => {
  const identity = (req.body.identity || req.query.identity || '').toString();
  if (identity) presence.setOnCall(identity, true);
  try { tracker.agentConnected({ agentCallSid: req.body.CallSid, identity }); } catch (e) { console.error('track connect:', e.message); }
  const twiml = new VoiceResponse();
  const dial = twiml.dial({
    record: 'record-from-answer-dual',
    recordingStatusCallback: url('/voice/recording-status'),
    recordingStatusCallbackEvent: 'completed',
    action: url('/voice/agent-done') + (identity ? `?identity=${encodeURIComponent(identity)}` : ''),
  });
  dial.queue(cfg.queueName);
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/agent-done', twilioGuard, (req, res) => {
  const identity = (req.query.identity || '').toString();
  if (identity) presence.setOnCall(identity, false);
  try { tracker.agentDone({ agentCallSid: req.body.CallSid, dialCallStatus: req.body.DialCallStatus, dialCallDuration: req.body.DialCallDuration }); } catch (e) { console.error('track done:', e.message); }
  const twiml = new VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// Ring the first available agent's browser client; on answer Twilio requests
// the TwiML App voice URL (-> /voice/agent-connect) which dequeues the caller.
async function ringNextAvailableAgent() {
  const agent = presence.firstAvailable();
  if (!agent) return;
  if (!cfg.publicBaseUrl) return;
  await rest.calls.create({
    to: `client:${agent.identity}`,
    from: cfg.staffCallerId || cfg.bridgeNumber,
    url: url('/voice/agent-connect') + `?identity=${encodeURIComponent(agent.identity)}`,
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// RECORDING COMPLETION -> downstream webhook (feeds Zoho reconfig later)
// ---------------------------------------------------------------------------
app.post('/voice/recording-status', twilioGuard, async (req, res) => {
  const callSid = req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : null;

  // Correlate: bridged call (agent leg) vs. voicemail (caller leg).
  let ctx = tracker.takeContextForRecording(callSid);
  let isVoicemail = false;
  if (!ctx) {
    const vm = tracker.takeWaitingByCallSid(callSid);
    if (vm) { isVoicemail = true; ctx = { callerNumber: vm.from, bridgeNumber: vm.to }; }
  }

  const payload = {
    event: 'call_recording_completed',
    callSid,
    from: req.body.From,
    to: req.body.To,
    recordingSid: req.body.RecordingSid,
    recordingUrl,
    recordingDuration: req.body.RecordingDuration,
    recordingChannels: req.body.RecordingChannels,
    callerNumber: ctx?.callerNumber || null,
    bridgeNumber: ctx?.bridgeNumber || cfg.bridgeNumber || null,
    agentAnswered: ctx?.identity || null,
    queueWaitSec: ctx?.queueWaitSec ?? null,
    talkDurationSec: ctx?.talkDurationSec ?? (req.body.RecordingDuration ? parseInt(req.body.RecordingDuration, 10) : null),
    outcome: isVoicemail ? 'Voicemail' : (ctx?.outcome || 'Answered'),
    timestamp: new Date().toISOString(),
  };

  // Optional downstream webhook (kept for compatibility).
  if (cfg.completionWebhookUrl) {
    try {
      await fetch(cfg.completionWebhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    } catch (e) { console.error('completion webhook failed:', e.message); }
  }

  // Write a Bridged_Calls record to Zoho CRM.
  try {
    const nowIso = new Date().toISOString();
    const label = `${payload.callerNumber || payload.from || 'Caller'} ${payload.outcome} ${nowIso.slice(0, 16)}Z`;
    const record = {
      Name: label.slice(0, 120),
      Caller_Number: payload.callerNumber || payload.from || undefined,
      Bridge_Number: payload.bridgeNumber || undefined,
      Bridge_Outcome: payload.outcome,
      Agent_Answered: payload.agentAnswered || undefined,
      Queue_Wait_sec: payload.queueWaitSec ?? undefined,
      Talk_Duration_sec: payload.talkDurationSec ?? undefined,
      Recording_URL: payload.recordingUrl || undefined,
      Recording_SID: payload.recordingSid || undefined,
      Twilio_Call_SID: payload.callSid || undefined,
      Call_Time: nowIso.slice(0, 19) + '+00:00',
    };
    Object.keys(record).forEach((k) => record[k] === undefined && delete record[k]);
    const result = await writeBridgedCall(record);
    console.log('zoho Bridged_Calls write:', JSON.stringify(result));
    // Submit for transcription; transcript lands in the record via /voice/vi-callback.
    if (vi.viEnabled() && payload.recordingSid && result.id) {
      try {
        const tSid = await vi.submitRecording(payload.recordingSid);
        viPending.set(tSid, { zohoId: result.id, isVoicemail });
        console.log('VI transcript submitted:', tSid);
      } catch (e) { console.error('VI submit failed:', e.message); }
    }
  } catch (e) {
    console.error('zoho write failed:', e.message);
  }

  console.log('recording-status:', JSON.stringify(payload));
  res.sendStatus(204);
});

// transcriptSid -> { zohoId, isVoicemail } (in-memory; fallback = Zoho search)
const viPending = new Map();

// Voice Intelligence webhook: transcript ready -> write into the Zoho record.
app.post('/voice/vi-callback', async (req, res) => {
  res.sendStatus(200);
  const tSid = req.body.transcript_sid || req.body.TranscriptSid || req.body.sid;
  if (!tSid) return;
  try {
    let entry = viPending.get(tSid);
    if (entry) viPending.delete(tSid);
    if (!entry) {
      // Restart-safe fallback: correlate through the source recording sid.
      const meta = await vi.getTranscript(tSid);
      const recSid = vi.transcriptSourceSid(meta);
      const zohoId = recSid ? await findByRecordingSid(recSid) : null;
      if (!zohoId) { console.error('VI callback: no Zoho match for', tSid); return; }
      entry = { zohoId, isVoicemail: false };
    }
    const labels = entry.isVoicemail ? { 1: 'Caller' } : { 1: 'Caller', 2: 'Agent' };
    const text = await vi.getTranscriptText(tSid, labels);
    if (!text) { console.log('VI callback: empty transcript', tSid); return; }
    await updateBridgedCall(entry.zohoId, { Transcript: text.slice(0, 30000) });
    console.log('VI transcript written to Zoho record', entry.zohoId, `(${text.length} chars)`);
  } catch (e) {
    console.error('VI callback failed:', e.message);
  }
});

app.listen(cfg.port, '0.0.0.0', () => {
  console.log(`JRH call center listening on :${cfg.port}`);
  console.log(`Public base URL: ${cfg.publicBaseUrl || '(not set)'}`);
  console.log(`Queue: ${cfg.queueName}, hold music: ${cfg.holdMusicUrl}`);
});
