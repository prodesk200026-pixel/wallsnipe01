import axios from 'axios';
import { generateTOTP } from './totp.js';
import { config } from '../config/index.js';

const GENERATE_URL = 'https://auth.dhan.co/app/generateAccessToken';

// Dhan access tokens are valid 24h. Refresh a good margin early
// (every 20h) so a slow morning retry never lands on an expired
// token during market hours.
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000;

let cachedToken = null;
let cachedAt = 0;
let refreshTimer = null;
const listeners = [];

/**
 * Returns true if PIN + TOTP secret are configured, meaning we can
 * auto-generate a fresh Dhan access token instead of relying on a
 * manually pasted, 24h-expiring DHAN_ACCESS_TOKEN.
 */
export function canAutoRefreshDhanToken() {
  return Boolean(config.dhan.clientId && config.dhan.pin && config.dhan.totpSecret);
}

export function onDhanTokenRefreshed(cb) {
  listeners.push(cb);
}

export function getCachedDhanToken() {
  return cachedToken;
}

/**
 * Calls Dhan's official TOTP-based token endpoint:
 *   POST https://auth.dhan.co/app/generateAccessToken
 *     ?dhanClientId=...&pin=...&totp=<live 6-digit code>
 * See https://dhanhq.co/docs/v2/authentication/
 */
export async function refreshDhanToken() {
  if (!canAutoRefreshDhanToken()) {
    throw new Error('DHAN: cannot auto-refresh — DHAN_PIN / DHAN_TOTP_SECRET not set');
  }
  const totp = generateTOTP(config.dhan.totpSecret);
  const res = await axios.post(GENERATE_URL, null, {
    params: { dhanClientId: config.dhan.clientId, pin: config.dhan.pin, totp },
    timeout: 10000
  });
  const token = res.data?.accessToken || res.data?.access_token;
  if (!token) {
    throw new Error(`DHAN: generateAccessToken returned no token (${JSON.stringify(res.data)})`);
  }
  cachedToken = token;
  cachedAt = Date.now();
  console.log('[DhanTokenManager] Refreshed access token', { at: new Date(cachedAt).toISOString() });
  for (const cb of listeners) cb(token);
  return token;
}

/**
 * Call once at startup. Fetches an initial token (if auto-refresh is
 * configured) and schedules a refresh every REFRESH_INTERVAL_MS.
 * Falls back silently to the static DHAN_ACCESS_TOKEN env var if
 * PIN/TOTP aren't set — this is opt-in, not a breaking change.
 */
export async function startDhanTokenAutoRefresh() {
  if (!canAutoRefreshDhanToken()) return null;
  try {
    await refreshDhanToken();
  } catch (err) {
    console.error('[DhanTokenManager] Initial token refresh failed', err.message);
  }
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshDhanToken().catch((err) =>
      console.error('[DhanTokenManager] Scheduled refresh failed', err.message)
    );
  }, REFRESH_INTERVAL_MS);
  return cachedToken;
}
