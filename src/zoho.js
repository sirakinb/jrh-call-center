// Zoho CRM writer — logs human-bridged/queued calls into the Bridged_Calls module.
// Mints access tokens from a stored self-client refresh token (cached in-memory).
// All config via env; if creds are absent the writer is a no-op (safe).

const DC = (process.env.ZOHO_DC || 'com').replace(/^\./, '');
const ACCOUNTS_HOST = `https://accounts.zoho.${DC}`;
const API_DOMAIN = (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com').replace(/\/$/, '');
const MODULE = process.env.ZOHO_MODULE || 'Bridged_Calls';

const creds = {
  clientId: process.env.ZOHO_CLIENT_ID || '',
  clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
  refreshToken: process.env.ZOHO_REFRESH_TOKEN || '',
};

export function zohoEnabled() {
  return Boolean(creds.clientId && creds.clientSecret && creds.refreshToken);
}

let cachedToken = null;
let cachedExp = 0;

async function accessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExp - 60_000) return cachedToken;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
  });
  const resp = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token;
  cachedExp = now + (parseInt(data.expires_in, 10) || 3600) * 1000;
  return cachedToken;
}

// Write one Bridged_Calls record. `fields` uses Zoho api_names.
export async function writeBridgedCall(fields) {
  if (!zohoEnabled()) {
    console.log('[zoho] disabled (no creds) — would write:', JSON.stringify(fields));
    return { skipped: true };
  }
  const token = await accessToken();
  const resp = await fetch(`${API_DOMAIN}/crm/v6/${MODULE}`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [fields], trigger: [] }),
  });
  const data = await resp.json();
  const row = data?.data?.[0];
  if (row?.status !== 'success') {
    throw new Error(`Zoho write failed (HTTP ${resp.status}): ${JSON.stringify(data)}`);
  }
  return { id: row.details.id };
}

// Update an existing Bridged_Calls record by id.
export async function updateBridgedCall(id, fields) {
  if (!zohoEnabled()) return { skipped: true };
  const token = await accessToken();
  const resp = await fetch(`${API_DOMAIN}/crm/v6/${MODULE}/${id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: [fields], trigger: [] }),
  });
  const data = await resp.json();
  const row = data?.data?.[0];
  if (row?.status !== 'success') {
    throw new Error(`Zoho update failed (HTTP ${resp.status}): ${JSON.stringify(data)}`);
  }
  return { id: row.details.id };
}

// Fallback correlation: find a Bridged_Calls record by its Recording SID.
export async function findByRecordingSid(recordingSid) {
  if (!zohoEnabled()) return null;
  const token = await accessToken();
  const criteria = encodeURIComponent(`(Recording_SID:equals:${recordingSid})`);
  const resp = await fetch(`${API_DOMAIN}/crm/v6/${MODULE}/search?criteria=${criteria}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => null);
  return data?.data?.[0]?.id || null;
}
