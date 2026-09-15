# Development Guide — JRH Call Center

Browser-based call center for Jackson Rental Homes: Retell AI hands callers to a
Twilio queue, agents answer in the browser (Twilio Voice SDK/WebRTC), calls are
recorded dual-channel, logged to Zoho CRM (`Bridged_Calls` module), and
transcribed by Twilio Voice Intelligence.

A visual architecture doc lives at [`docs/architecture.html`](docs/architecture.html) —
open it in a browser.

## Repo layout (READ THIS FIRST)

```
src/          ← the server that RUNS IN PRODUCTION. Edit here.
public/       ← the agent console UI that RUNS IN PRODUCTION. Edit here.
config/       ← staff list (staff.json)
docker-compose.yml  ← reference compose (production uses its own stored copy)
docs/         ← architecture documentation
```

Key files:

| File | Purpose |
|---|---|
| `src/server.js` | All routes: Twilio webhooks, queue, agent connect, Zoho write, VI callback, auth |
| `src/auth.js` | Shared-password gate → stateless HMAC session tokens |
| `src/calltracker.js` | Correlates caller leg ↔ agent leg ↔ recording across webhooks |
| `src/zoho.js` | Zoho CRM writer (token mint/cache, create/update/search records) |
| `src/vi.js` | Twilio Voice Intelligence transcript submit/fetch |
| `src/config.js` | Reads ALL configuration from environment variables |
| `public/app.js` | Agent console logic (login → token → Twilio.Device) |

## Secrets — none are in this repo

All credentials (Twilio, Zoho, Cloudflare tunnel token, console password) are
injected as **environment variables** at deploy time. See `.env.example` for the
variable names. You can read, edit, and push code without any secrets.

To run locally you'd need a `.env` with real values (ask the operator), then:

```
npm install
node src/server.js
```

Note: Twilio webhooks need a public URL to reach your machine (e.g. a
cloudflared quick tunnel) — local runs without that only exercise the web UI.

## How deployment works

Production runs on a Hostinger VPS as a Docker project (`jrh-call-center`).
The container **clones this repo's `main` branch at startup** and runs
`node src/server.js`. Public traffic arrives via a Cloudflare Tunnel at
`https://jrh-agents.agentworkspace.cloud`.

**Auto-deploy:** pushing to `main` triggers `.github/workflows/deploy.yml`,
which calls the Hostinger API to restart the container (it re-clones the repo),
waits, and verifies `/health`. So: **merge/push to main = live in ~2 minutes.**

Environment variable *values* are stored in the Hostinger project config, not
in this repo. Changing/adding an env var requires a full project re-create via
the Hostinger API (ask the operator) — a plain redeploy reuses the stored ones.

## Gotchas

1. **Auth:** `/api/token` and `/api/presence` require a session from
   `POST /api/login` (shared team password, `CONSOLE_PASSWORD` env var).
2. **Voice SDK:** served locally from `public/vendor/twilio.min.js`, with an
   unpkg CDN fallback baked into `index.html`.
3. **Dual-channel recordings:** channel 1 = caller, channel 2 = agent.
4. **Zoho datetime fields** require `YYYY-MM-DDTHH:mm:ss+00:00` (no millis).
5. **Recording webhooks** carry the *caller* leg CallSid; the tracker indexes
   context by both caller and agent CallSids.
