# JRH Call Center

Browser-based agent console for Jackson Rental Homes: Twilio queue + WebRTC answering, dual-channel recording, PA two-party consent announcement, hold music, and a completion webhook.

Deployed on the Hostinger VPS as a Docker Compose project (app + cloudflared tunnel). Secrets are injected at deploy time via environment variables — never committed.

## Flow
Retell cold-transfers a caller into the Twilio bridge number -> consent notice -> queue (position + estimated wait + hold music) -> an available agent answers in the browser -> both legs recorded on separate channels -> completion webhook fires with the recording URL.
