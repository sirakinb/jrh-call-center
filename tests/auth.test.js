import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32);
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_API_KEY_SID = 'SK' + 'b'.repeat(32);
process.env.TWILIO_API_KEY_SECRET = 'test-api-secret';
process.env.TWILIO_TWIML_APP_SID = 'AP' + 'c'.repeat(32);
process.env.PUBLIC_BASE_URL = 'https://jrh.test';
process.env.CONSOLE_SECRET = 'test-signing-secret';
process.env.CONSOLE_USERS = JSON.stringify([
  { id: 'aki', name: 'Aki', password: 'pw-aki' },
  { name: 'Front Desk', password: 'pw-desk', openName: true },
]);

let app;
beforeAll(async () => {
  ({ app } = await import('../src/server.js'));
});

async function loginAs(name, password) {
  const res = await request(app).post('/api/login').send({ name, password });
  return res;
}

describe('GET /api/auth-config', () => {
  it('exposes the roster without passwords', async () => {
    const res = await request(app).get('/api/auth-config');
    expect(res.status).toBe(200);
    expect(res.body.authRequired).toBe(true);
    expect(res.body.users).toHaveLength(2);
    for (const u of res.body.users) expect(u.password).toBeUndefined();
  });
});

describe('POST /api/login', () => {
  it('accepts a valid fixed-name account', async () => {
    const res = await loginAs('Aki', 'pw-aki');
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: 'aki', name: 'Aki' });
    expect(res.body.session).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it('rejects a wrong password', async () => {
    const res = await loginAs('Aki', 'nope');
    expect(res.status).toBe(401);
  });

  it('rejects the right password with the wrong fixed name', async () => {
    const res = await loginAs('Somebody Else', 'pw-aki');
    expect(res.status).toBe(401);
  });

  it('lets an openName account choose its display name', async () => {
    const res = await loginAs('Darryl', 'pw-desk');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('front-desk');
    expect(res.body.user.name).toBe('Darryl');
  });
});

describe('auth guard on console APIs', () => {
  it('blocks /api/token without a session', async () => {
    const res = await request(app).get('/api/token');
    expect(res.status).toBe(401);
  });

  it('blocks /api/presence without a session', async () => {
    const res = await request(app).post('/api/presence').send({ status: 'available' });
    expect(res.status).toBe(401);
  });

  it('rejects a tampered session token', async () => {
    const { body } = await loginAs('Aki', 'pw-aki');
    const forged = body.session.slice(0, -2) + 'xx';
    const res = await request(app).get('/api/token').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/token (Voice SDK)', () => {
  it('issues a token bound to the session identity, not client input', async () => {
    const { body } = await loginAs('Aki', 'pw-aki');
    const res = await request(app)
      .get('/api/token?identity=spoofed')
      .set('Authorization', `Bearer ${body.session}`);
    expect(res.status).toBe(200);
    expect(res.body.identity).toBe('aki');
    expect(res.body.token.split('.')).toHaveLength(3); // JWT
  });
});

describe('POST /api/presence + /api/status', () => {
  it('registers the agent and reflects status changes', async () => {
    const { body } = await loginAs('Aki', 'pw-aki');
    const res = await request(app)
      .post('/api/presence')
      .set('Authorization', `Bearer ${body.session}`)
      .send({ status: 'away' });
    expect(res.status).toBe(200);
    const me = res.body.agents.find((a) => a.identity === 'aki');
    expect(me.status).toBe('away');
  });
});

describe('POST /api/rename', () => {
  it('rebinds the display name into a fresh server-signed session', async () => {
    const { body } = await loginAs('Darryl', 'pw-desk');
    const res = await request(app)
      .post('/api/rename')
      .set('Authorization', `Bearer ${body.session}`)
      .send({ name: 'Darryl M.' });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: 'front-desk', name: 'Darryl M.' });
    expect(res.body.session).not.toBe(body.session);
  });

  it('rejects an empty name', async () => {
    const { body } = await loginAs('Aki', 'pw-aki');
    const res = await request(app)
      .post('/api/rename')
      .set('Authorization', `Bearer ${body.session}`)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });
});
