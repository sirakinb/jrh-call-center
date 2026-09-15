import crypto from 'node:crypto';
import { cfg } from './config.js';

// Shared-password gate (Option 1). One CONSOLE_PASSWORD env var protects the
// endpoints that let a browser take live calls. Sessions are stateless:
// a signed token the server can verify without storing state (survives restarts).

const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Signing secret derived from the password itself — no extra secret to manage.
function secret() {
  return crypto.createHash('sha256').update('jrh-console|' + (cfg.consolePassword || '')).digest();
}

function sign(expiry) {
  return crypto.createHmac('sha256', secret()).update(String(expiry)).digest('hex');
}

// If no password is configured, the gate is OPEN (fail-safe for local/dev).
export function authRequired() {
  return !!cfg.consolePassword;
}

// Constant-time password check.
export function checkPassword(pw) {
  if (!cfg.consolePassword) return true;
  const a = Buffer.from(String(pw || ''));
  const b = Buffer.from(cfg.consolePassword);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Issue a session token: "<expiry>.<hmac>"
export function issueToken() {
  const expiry = Date.now() + TTL_MS;
  return `${expiry}.${sign(expiry)}`;
}

// Verify a session token (valid signature + not expired).
export function verifyToken(token) {
  if (!cfg.consolePassword) return true; // gate open
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiry = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expNum = parseInt(expiry, 10);
  if (!expNum || Date.now() > expNum) return false;
  const expected = sign(expNum);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Express middleware: reject requests without a valid session token.
export function authGuard(req, res, next) {
  if (!authRequired()) return next();
  const hdr = req.header('Authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.query.session || '');
  if (verifyToken(token)) return next();
  return res.status(401).json({ error: 'auth required' });
}
