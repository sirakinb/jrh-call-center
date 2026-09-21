// The server-side queue cap was a production incident: the waitUrl-only check
// let callers hold far past the cap because Twilio re-requests the waitUrl only
// after the ~80s hold-music file ends. These tests exercise the real timer with
// a mocked Twilio REST client and MAX_QUEUE_WAIT_SEC=1.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.PUBLIC_BASE_URL = 'https://jrh.test';
process.env.MAX_QUEUE_WAIT_SEC = '1';

const state = { stillQueued: true };
const updates = [];

vi.mock('twilio', async (importOriginal) => {
  const actual = await importOriginal();
  const real = actual.default;
  const client = {
    queues: Object.assign(() => ({
      members: (callSid) => ({
        fetch: () => (state.stillQueued
          ? Promise.resolve({ callSid })
          : Promise.reject(Object.assign(new Error('member not found'), { status: 404 }))),
      }),
    }), {
      list: async () => [{ friendlyName: 'jrh-queue', sid: 'QU' + 'f'.repeat(32), currentSize: 1, averageWaitTime: 5 }],
    }),
    calls: Object.assign((sid) => ({
      update: async (opts) => { updates.push({ sid, ...opts }); return {}; },
    }), {
      create: async () => ({}),
    }),
  };
  const fake = () => client;
  fake.twiml = real.twiml;
  fake.jwt = real.jwt;
  fake.validateRequest = real.validateRequest;
  return { default: fake };
});

let app;
beforeAll(async () => {
  ({ app } = await import('../src/server.js'));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enterQueue = (callSid) => request(app)
  .post('/voice/wait')
  .type('form')
  .send({ CallSid: callSid, QueueTime: '0', QueuePosition: '1' });

describe('server-side queue cap timer', () => {
  it('redirects a still-waiting caller to /voice/queue-timeout at the cap', async () => {
    state.stillQueued = true;
    const res = await enterQueue('CAwaiting1');
    expect(res.status).toBe(200);
    await sleep(1500);
    const hit = updates.find((u) => u.sid === 'CAwaiting1');
    expect(hit).toBeDefined();
    expect(hit.url).toBe('https://jrh.test/voice/queue-timeout');
    expect(hit.method).toBe('POST');
  });

  it('NEVER redirects a caller who already left the queue (live bridged call)', async () => {
    state.stillQueued = false;
    const res = await enterQueue('CAbridged1');
    expect(res.status).toBe(200);
    await sleep(1500);
    // INVARIANT: the cap timer checks queue membership first — redirecting a
    // bridged caller would hang up on a live conversation.
    expect(updates.find((u) => u.sid === 'CAbridged1')).toBeUndefined();
  });

  it('arms only one timer per CallSid', async () => {
    state.stillQueued = true;
    await enterQueue('CAdupe1');
    await enterQueue('CAdupe1');
    await sleep(1500);
    expect(updates.filter((u) => u.sid === 'CAdupe1')).toHaveLength(1);
  });
});
