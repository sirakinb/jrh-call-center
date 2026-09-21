import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as presence from '../src/presence.js';

describe('presence lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
    // Fresh identity per test since the module keeps a shared in-memory map.
  });

  it('a new agent starts available', () => {
    const a = presence.upsertAgent('p1', 'P One');
    expect(a.status).toBe('available');
    expect(a.onCall).toBe(false);
  });

  it('going on call flips status to oncall and back to available after', () => {
    presence.upsertAgent('p2', 'P Two');
    expect(presence.setOnCall('p2', true).status).toBe('oncall');
    expect(presence.setOnCall('p2', false).status).toBe('available');
  });

  it('firstAvailable skips away and on-call agents and finds the free one', () => {
    // The module map is shared across tests: park everyone else first.
    for (const a of presence.listAgents()) presence.setStatus(a.identity, 'away');
    presence.upsertAgent('p3', 'Away Agent');
    presence.setStatus('p3', 'away');
    presence.upsertAgent('p4', 'Busy Agent');
    presence.setOnCall('p4', true);
    expect(presence.firstAvailable()).toBeNull();
    presence.upsertAgent('p3b', 'Free Agent');
    expect(presence.firstAvailable()?.identity).toBe('p3b');
  });

  it('marks a silent agent offline after 90s, and a heartbeat revives them', () => {
    vi.useFakeTimers();
    presence.upsertAgent('p5', 'Flaky Wifi');
    vi.advanceTimersByTime(91_000);
    let a = presence.listAgents().find((x) => x.identity === 'p5');
    expect(a.status).toBe('offline');
    // INVARIANT: logged in + heartbeating IS online. A backgrounded tab must
    // not leave an agent stuck offline for the rest of the shift.
    presence.upsertAgent('p5', 'Flaky Wifi');
    a = presence.listAgents().find((x) => x.identity === 'p5');
    expect(a.status).toBe('available');
    vi.useRealTimers();
  });

  it('a revived agent who was mid-call comes back as oncall, not available', () => {
    vi.useFakeTimers();
    presence.upsertAgent('p6', 'On A Call');
    presence.setOnCall('p6', true);
    vi.advanceTimersByTime(91_000);
    expect(presence.listAgents().find((x) => x.identity === 'p6').status).toBe('offline');
    presence.upsertAgent('p6', 'On A Call');
    expect(presence.listAgents().find((x) => x.identity === 'p6').status).toBe('oncall');
    vi.useRealTimers();
  });
});
