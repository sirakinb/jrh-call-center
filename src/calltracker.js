// In-memory call-lifecycle tracker. Twilio fires separate webhooks for the
// caller (enqueue), the agent bridge (dial), and the recording. This stitches
// them together so we can log one complete Bridged_Calls record.
//
// Best-effort correlation:
//  - /voice/incoming pushes each caller onto a FIFO of waiting callers.
//  - /voice/agent-connect pops the oldest waiter and binds it to the agent
//    call's CallSid (the leg that owns the <Dial> + recording).
//  - /voice/agent-done and /voice/recording-status update/finalize by CallSid.
// Concurrency note: with multiple simultaneous callers this FIFO can mis-order
// caller<->agent binding; acceptable for the current 2-3 agent volume.

const waiting = []; // { callSid, from, to, enqueuedAt }
const byAgentCall = new Map(); // agentCallSid -> context
const TTL_MS = 2 * 60 * 60 * 1000;

export function callerEnqueued({ callSid, from, to }) {
  waiting.push({ callSid, from, to, enqueuedAt: Date.now() });
  prune();
}

// Bind the oldest waiting caller to this agent bridge call.
export function agentConnected({ agentCallSid, identity }) {
  const caller = waiting.shift() || null;
  const ctx = {
    agentCallSid,
    identity: identity || '',
    callerNumber: caller?.from || '',
    bridgeNumber: caller?.to || '',
    enqueuedAt: caller?.enqueuedAt || null,
    connectedAt: Date.now(),
    queueWaitSec: caller?.enqueuedAt ? Math.round((Date.now() - caller.enqueuedAt) / 1000) : null,
    talkDurationSec: null,
    outcome: null,
  };
  byAgentCall.set(agentCallSid, ctx);
  return ctx;
}

export function agentDone({ agentCallSid, dialCallStatus, dialCallDuration }) {
  const ctx = byAgentCall.get(agentCallSid);
  if (!ctx) return null;
  if (dialCallDuration != null) ctx.talkDurationSec = parseInt(dialCallDuration, 10) || 0;
  // Map Twilio dial status -> our outcome vocabulary.
  if (dialCallStatus === 'completed' || dialCallStatus === 'answered') ctx.outcome = 'Answered';
  else if (dialCallStatus === 'no-answer' || dialCallStatus === 'busy' || dialCallStatus === 'failed') ctx.outcome = 'No-answer';
  return ctx;
}

export function takeContextForRecording(callSid) {
  // Recording-status CallSid equals the agent bridge call for bridged calls.
  const ctx = byAgentCall.get(callSid);
  if (ctx) { byAgentCall.delete(callSid); return ctx; }
  return null;
}

// A voicemail recording belongs to the caller's own leg (no agent bind).
export function takeWaitingByCallSid(callSid) {
  const idx = waiting.findIndex((w) => w.callSid === callSid);
  if (idx >= 0) return waiting.splice(idx, 1)[0];
  return null;
}

function prune() {
  const cutoff = Date.now() - TTL_MS;
  while (waiting.length && waiting[0].enqueuedAt < cutoff) waiting.shift();
  for (const [k, v] of byAgentCall) {
    if ((v.connectedAt || 0) < cutoff) byAgentCall.delete(k);
  }
}
