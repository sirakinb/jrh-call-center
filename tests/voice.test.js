import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.PUBLIC_BASE_URL = 'https://jrh.test';

let app;
beforeAll(async () => {
  ({ app } = await import('../src/server.js'));
});

const post = (path, body = {}) => request(app).post(path).type('form').send(body);

describe('GET /health', () => {
  it('reports ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /voice/incoming', () => {
  it('plays the consent notice then enqueues with wait + result URLs', async () => {
    const res = await post('/voice/incoming', { From: '+16015550100', To: '+16015550200' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('This call will be recorded');
    expect(res.text).toContain('<Enqueue');
    expect(res.text).toContain('waitUrl="https://jrh.test/voice/wait"');
    expect(res.text).toContain('action="https://jrh.test/voice/queue-result"');
    expect(res.text).toContain('>jrh-queue</Enqueue>');
    // The consent notice must come before the caller enters the queue.
    expect(res.text.indexOf('<Say')).toBeLessThan(res.text.indexOf('<Enqueue'));
  });
});

describe('POST /voice/wait (hold experience)', () => {
  it('announces position and plays hold music while under the cap', async () => {
    const res = await post('/voice/wait', { QueueTime: '10', QueuePosition: '1' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('You are first in line');
    expect(res.text).toContain('<Play>');
  });

  it('says "number N" for callers further back', async () => {
    const res = await post('/voice/wait', { QueueTime: '10', QueuePosition: '3' });
    expect(res.text).toContain('number 3');
  });

  it('skips the announcement when position is unknown', async () => {
    const res = await post('/voice/wait', { QueueTime: '5' });
    expect(res.text).not.toContain('<Say');
    expect(res.text).toContain('<Play>');
  });

  it('returns <Leave/> once QueueTime passes the cap (backstop)', async () => {
    const res = await post('/voice/wait', { QueueTime: '999' });
    expect(res.text).toContain('<Leave/>');
    expect(res.text).not.toContain('<Play>');
  });
});

describe('POST /voice/queue-result (after the caller leaves the queue)', () => {
  it('hangs up quietly when the caller was bridged to an agent', async () => {
    const res = await post('/voice/queue-result', { QueueResult: 'bridged' });
    expect(res.text).toContain('<Hangup/>');
    expect(res.text).not.toContain('<Gather');
  });

  it('hangs up quietly when the caller already hung up', async () => {
    const res = await post('/voice/queue-result', { QueueResult: 'hangup' });
    expect(res.text).toContain('<Hangup/>');
  });

  it('offers a callback with voicemail fallback on queue timeout', async () => {
    const res = await post('/voice/queue-result', { QueueResult: 'leave' });
    expect(res.text).toContain('<Gather');
    expect(res.text).toContain('action="https://jrh.test/voice/callback-menu"');
    expect(res.text).toContain('press 1');
    // INVARIANT: the voicemail fallback must live in the SAME TwiML document,
    // so a Gather timeout can never silently drop the caller.
    expect(res.text).toContain('<Record');
    expect(res.text.indexOf('<Gather')).toBeLessThan(res.text.indexOf('<Record'));
  });

  it('never leaves a caller without a next step on unknown results', async () => {
    const res = await post('/voice/queue-result', { QueueResult: 'system-error' });
    expect(res.text).toContain('<Gather');
    expect(res.text).toContain('<Record');
  });
});

describe('POST /voice/queue-timeout (server-side cap fired)', () => {
  it('offers the same callback + voicemail fallback', async () => {
    const res = await post('/voice/queue-timeout', {});
    expect(res.text).toContain('<Gather');
    expect(res.text).toContain('<Record');
  });
});

describe('POST /voice/callback-menu', () => {
  it('collects a callback number when the caller presses 1', async () => {
    const res = await post('/voice/callback-menu', { Digits: '1' });
    expect(res.text).toContain('<Gather');
    expect(res.text).toContain('action="https://jrh.test/voice/callback-number"');
    expect(res.text).toContain('ten digit phone number');
  });

  it('falls through to voicemail on any other digit', async () => {
    const res = await post('/voice/callback-menu', { Digits: '5' });
    expect(res.text).toContain('<Record');
    expect(res.text).toContain('leave your name');
  });

  it('falls through to voicemail when the gather times out (no digits)', async () => {
    const res = await post('/voice/callback-menu', {});
    expect(res.text).toContain('<Record');
  });
});

describe('POST /voice/callback-number', () => {
  it('confirms a valid 10-digit number and hangs up', async () => {
    const res = await post('/voice/callback-number', { Digits: '6015550123' });
    expect(res.text).toContain('We will call you back');
    expect(res.text).toContain('<Hangup/>');
    expect(res.text).not.toContain('<Record');
  });

  it('accepts an 11-digit number with leading 1', async () => {
    const res = await post('/voice/callback-number', { Digits: '16015550123' });
    expect(res.text).toContain('We will call you back');
    expect(res.text).toContain('6 0 1 5 5 5 0 1 2 3');
  });

  it('falls back to voicemail on an incomplete number', async () => {
    const res = await post('/voice/callback-number', { Digits: '601555' });
    expect(res.text).toContain('did not get a complete number');
    expect(res.text).toContain('<Record');
  });

  it('falls back to voicemail when no digits arrive', async () => {
    const res = await post('/voice/callback-number', {});
    expect(res.text).toContain('<Record');
  });
});

describe('POST /voice/agent-connect (agent answers)', () => {
  it('dequeues the caller with dual-channel recording and a 1h time limit', async () => {
    const res = await post('/voice/agent-connect', { identity: 'aki', CallSid: 'CAagent1' });
    expect(res.text).toContain('<Dial');
    expect(res.text).toContain('record="record-from-answer-dual"');
    expect(res.text).toContain('timeLimit="3600"');
    expect(res.text).toContain('<Queue>jrh-queue</Queue>');
    expect(res.text).toContain('recordingStatusCallback="https://jrh.test/voice/recording-status"');
    expect(res.text).toContain('identity=aki');
  });
});

describe('POST /voice/agent-done', () => {
  it('hangs up the agent leg', async () => {
    const res = await post('/voice/agent-done', { DialCallStatus: 'completed' });
    expect(res.text).toContain('<Hangup/>');
  });
});

describe('POST /voice/voicemail-done', () => {
  it('thanks the caller and hangs up', async () => {
    const res = await post('/voice/voicemail-done', {});
    expect(res.text).toContain('Thank you');
    expect(res.text).toContain('<Hangup/>');
  });
});
