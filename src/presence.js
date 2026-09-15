// In-memory agent presence + call state. Fine for a 2-3 agent prototype.

const agents = new Map();

export const STATUS = { AVAILABLE: 'available', AWAY: 'away', ONCALL: 'oncall', OFFLINE: 'offline' };

export function upsertAgent(identity, name) {
  const a = agents.get(identity) || { identity, name, status: STATUS.OFFLINE, onCall: false };
  a.name = name || a.name || identity;
  a.lastSeen = Date.now();
  agents.set(identity, a);
  return a;
}

export function setStatus(identity, status) {
  const a = agents.get(identity);
  if (!a) return null;
  a.status = status;
  a.lastSeen = Date.now();
  return a;
}

export function setOnCall(identity, onCall) {
  const a = agents.get(identity);
  if (!a) return null;
  a.onCall = onCall;
  a.status = onCall ? STATUS.ONCALL : STATUS.AVAILABLE;
  a.lastSeen = Date.now();
  return a;
}

export function listAgents() {
  const now = Date.now();
  for (const a of agents.values()) {
    if (now - a.lastSeen > 30000 && a.status !== STATUS.OFFLINE) a.status = STATUS.OFFLINE;
  }
  return [...agents.values()];
}

export function firstAvailable() {
  return listAgents().find((a) => a.status === STATUS.AVAILABLE && !a.onCall) || null;
}
