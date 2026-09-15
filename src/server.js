import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import twilio from 'twilio';
import { cfg, url } from './config.js';
import * as presence from './presence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { VoiceResponse } = twilio.twiml;
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const rest = twilio(cfg.accountSid, cfg.authToken);

function twilioGuard(req, res, next) {
  if (process.env.VALIDATE_TWILIO !== 'true') return next();
  const sig = req.header('X-Twilio-Signature');
  const valid = twilio.validateRequest(cfg.authToken, sig, url(req.originalUrl), req.body);
  if (!valid) return res.status(403).send('Invalid Twilio signature');
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'jrh-callcenter' }));

// Issue a Voice SDK access token so an agent's browser can send/receive calls.
app.get('/api/token', (req, res) => {
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
app.post('/api/presence', (req, res) => {
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

// INBOUND CALL FLOW (Retell cold-transfers caller into the bridge number)
app.post('/voice/incoming', twilioGuard, async (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, cfg.recordingNotice);
  const enqueue = twiml.enqueue({
    waitUrl: url('/voice/wait'),
    action: url('/voice/queue-result'),
  }, cfg.queueName);
  void enqueue;
  res.type('text/xml').send(twiml.toString());
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

// AGENT CONNECT: both the browser "Answer" and the auto-ring land here.
app.post('/voice/agent-connect', twilioGuard, (req, res) => {
  const identity = (req.body.identity || req.query.identity || '').toString();
  if (identity) presence.setOnCall(identity, true);
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
  const twiml = new VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

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

// RECORDING COMPLETION -> downstream webhook (feeds Zoho reconfig later)
app.post('/voice/recording-status', twilioGuard, async (req, res) => {
  const payload = {
    event: 'call_recording_completed',
    callSid: req.body.CallSid,
    from: req.body.From,
    to: req.body.To,
    recordingSid: req.body.RecordingSid,
    recordingUrl: req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : null,
    recordingDuration: req.body.RecordingDuration,
    recordingChannels: req.body.RecordingChannels,
    timestamp: new Date().toISOString(),
  };
  if (cfg.completionWebhookUrl) {
    try {
      await fetch(cfg.completionWebhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    } catch (e) { console.error('completion webhook failed:', e.message); }
  }
  console.log('recording-status:', JSON.stringify(payload));
  res.sendStatus(204);
});

app.listen(cfg.port, '0.0.0.0', () => {
  console.log(`JRH call center listening on :${cfg.port}`);
  console.log(`Public base URL: ${cfg.publicBaseUrl || '(not set)'}`);
  console.log(`Queue: ${cfg.queueName}, hold music: ${cfg.holdMusicUrl}`);
});
