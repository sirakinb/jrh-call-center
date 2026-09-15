import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const cfg = {
  accountSid: process.env.TWILIO_ACCOUNT_SID || '',
  authToken: process.env.TWILIO_AUTH_TOKEN || '',
  apiKeySid: process.env.TWILIO_API_KEY_SID || '',
  apiKeySecret: process.env.TWILIO_API_KEY_SECRET || '',
  twimlAppSid: process.env.TWILIO_TWIML_APP_SID || '',
  bridgeNumber: process.env.TWILIO_BRIDGE_NUMBER || '',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  staffCallerId: process.env.STAFF_CALLER_ID || process.env.TWILIO_BRIDGE_NUMBER || '',
  ringStrategy: (process.env.RING_STRATEGY || 'simultaneous').toLowerCase(),
  ringTimeout: parseInt(process.env.RING_TIMEOUT || '25', 10),
  completionWebhookUrl: process.env.COMPLETION_WEBHOOK_URL || '',
  recordingNotice: process.env.RECORDING_NOTICE || 'This call will be recorded.',
  holdMusicUrl: process.env.HOLD_MUSIC_URL || 'http://demo.twilio.com/docs/classic.mp3',
  queueName: process.env.QUEUE_NAME || 'jrh-queue',
  maxWaitSeconds: parseInt(process.env.MAX_WAIT_SECONDS || '600', 10),
  consolePassword: process.env.CONSOLE_PASSWORD || '',
  consoleUsers: process.env.CONSOLE_USERS || '',
  consoleSecret: process.env.CONSOLE_SECRET || '',
  port: parseInt(process.env.PORT || '3000', 10),
};

export function loadStaff() {
  const p = path.join(__dirname, '..', 'config', 'staff.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (raw.staff || []).filter((s) => s.enabled && /^\+\d{8,15}$/.test(s.number || ''));
}

export function url(pathname) {
  return `${cfg.publicBaseUrl}${pathname}`;
}
