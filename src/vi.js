// Twilio Voice Intelligence — submit recordings for transcription, fetch results.
// ESM, uses global fetch (Node 18+). Config from env.

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const VI_SERVICE_SID = process.env.VI_SERVICE_SID || '';
const BASE = 'https://intelligence.twilio.com';

const AUTH = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');

export function viEnabled() {
  return Boolean(ACCOUNT_SID && AUTH_TOKEN && VI_SERVICE_SID);
}

async function viFetch(method, url, form) {
  const opts = { method, headers: { Authorization: AUTH } };
  if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const resp = await fetch(url.startsWith('http') ? url : `${BASE}${url}`, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`VI ${method} ${url} -> ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Submit a Twilio recording for transcription. Returns transcript sid.
export async function submitRecording(recordingSid) {
  const res = await viFetch('POST', '/v2/Transcripts', {
    ServiceSid: VI_SERVICE_SID,
    Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }),
  });
  return res.sid;
}

// Transcript metadata (status, channel/media info).
export async function getTranscript(transcriptSid) {
  return viFetch('GET', `/v2/Transcripts/${transcriptSid}`);
}

// The recording sid a transcript was created from (for fallback correlation).
export function transcriptSourceSid(transcriptMeta) {
  try {
    return transcriptMeta?.channel?.media_properties?.source_sid || null;
  } catch {
    return null;
  }
}

// All sentences formatted as labeled lines. labels: {1:'Agent',2:'Caller'}.
export async function getTranscriptText(transcriptSid, labels = {}) {
  const sentences = [];
  let page = `/v2/Transcripts/${transcriptSid}/Sentences?PageSize=200`;
  while (page) {
    const res = await viFetch('GET', page);
    (res.sentences || []).forEach((s) => sentences.push(s));
    const next = res.meta?.next_page_url;
    page = next ? next.replace(BASE, '') : null;
  }
  const lines = sentences.map((s) => {
    const who = labels[s.media_channel] || `Ch${s.media_channel}`;
    return `${who}: ${(s.transcript || '').trim()}`;
  });
  return lines.join('\n');
}
