import crypto from 'node:crypto';
import { cfg } from './config.js';

// Per-agent accounts (Option 2). CONSOLE_USERS is a JSON array:
//   [{"id":"aki","name":"Aki","password":"..."}, ...]
// Identity is bound to the session by the server, so the agent name that lands
// in Zoho (Agent_Answered) is verified, not typed by the browser.
// Falls back to the legacy shared CONSOLE_PASSWORD when no users configured.

const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function list() {
  const raw = cfg.consoleUsers;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((u) => u && u.name && u.password)
      .map((u) => ({
        id: String(u.id || u.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: String(u.name),
        password: String(u.password),
        openName: !!u.openName,
      }));
  } catch (e) {
    console.error('CONSOLE_USERS parse failed:', e.message);
    return [];
  }
}

// Public roster (names only, never passwords) for the login suggestions.
export function users() {
  return list().map((u) => ({ id: u.id, name: u.name, openName: u.openName }));
}

export function authRequired() {
  return list().length > 0 || !!cfg.consolePassword;
}

function secret() {
  const base = cfg.consoleSecret || cfg.consolePassword || '';
  return crypto.createHash('sha256').update('jrh-console|' + base).digest();
}

function eq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Validate a name+password pair. Returns {id,name} or null.
export function login(name, password) {
  const arr = list();
  const n = String(name || '').trim();
  const nl = n.toLowerCase();

  if (arr.length) {
    for (const u of arr) {
      if (!eq(password, u.password)) continue;
      // Password identifies the account.
      if (u.openName) return { id: u.id, name: n || u.name };
      // Fixed-name account: the typed name must match.
      if (nl === u.name.toLowerCase() || nl === u.id) return { id: u.id, name: u.name };
      return null;
    }
    return null;
  }

  // Legacy shared password.
  if (cfg.consolePassword && eq(password, cfg.consolePassword)) {
    return { id: 'agent', name: n || 'Agent' };
  }
  return null;
}

function sign(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

// Stateless session token: base64url(payload).hmac
export function issueToken(user) {
  const body = Buffer.from(JSON.stringify({
    sub: user.id, name: user.name, exp: Date.now() + TTL_MS,
  })).toString('base64url');
  return body + '.' + sign(body);
}

// Returns {id,name} or null.
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!eq(mac, sign(body))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!o.exp || Date.now() > o.exp) return null;
    return { id: o.sub, name: o.name };
  } catch { return null; }
}

// Express middleware. On success attaches req.user.
export function authGuard(req, res, next) {
  if (!authRequired()) return next();
  const hdr = req.header('Authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.query.session || '');
  const user = verifyToken(token);
  if (user) { req.user = user; return next(); }
  return res.status(401).json({ error: 'auth required' });
}
