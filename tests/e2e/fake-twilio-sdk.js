// Served by Playwright in place of vendor/twilio.min.js. Mirrors the slice of
// the Twilio Voice SDK surface that app.js touches, and exposes the live
// instances on window.__device / window.__FakeCall so specs can ring the
// console on demand.
(() => {
  class Emitter {
    constructor() { this.handlers = {}; }
    on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
    emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
  }

  class FakeCall extends Emitter {
    constructor(params) {
      super();
      this.parameters = params || {};
      this.accepted = false;
      this.rejected = false;
      this.mutedState = null;
    }
    accept() { this.accepted = true; }
    reject() { this.rejected = true; }
    disconnect() { this.emit('disconnect'); }
    mute(m) { this.mutedState = m; }
  }

  class FakeDevice extends Emitter {
    constructor(token, opts) {
      super();
      this.token = token;
      this.opts = opts;
      window.__device = this;
    }
    async register() { this.emit('registered'); }
    async unregister() { this.emit('unregistered'); }
    updateToken(t) { this.token = t; }
    async connect(opts) {
      this.lastConnect = opts;
      const call = new FakeCall();
      window.__outboundCall = call;
      return call;
    }
  }

  window.__FakeCall = FakeCall;
  window.Twilio = { Device: FakeDevice };
})();
