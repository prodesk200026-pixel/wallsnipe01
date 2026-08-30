import axios from 'axios';
import { generateTOTP } from './totp.js';
import { config } from '../config/index.js';

const GENERATE_URL = 'https://auth.dhan.co/app/generateAccessToken';

// Dhan access tokens are valid 24h. Refresh a good margin early
// (every 20h) so a slow morning retry never lands on an expired
// token during market hours.
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000;

// Dhan's generateAccessToken endpoint enforces "once every 2
// minutes" — hard rate limit, not a suggestion. AdapterManager's
// disconnect-retry loop calls into this module every ~15s while
// reconnecting, so WITHOUT a guard here, most of those retries were
// hammering this endpoint 8x faster than its own rate limit allows,
// getting rejected, and — worse — the repeated rapid auth attempts
// look like abuse from Dhan's side and were very likely what caused
// the WebSocket to get killed (close code 1006) shortly after each
// connect. This constant is the fix: no matter how often anything
// in this codebase calls refreshDhanToken(), it will never actually
// hit Dhan's network endpoint more than once per this interval —
// padded to 2.5 min for safety margin over Dhan's stated 2 min.
const MIN_REFRESH_INTERVAL_MS = 2.5 * 60 * 1000;

let cachedToken = null;
let cachedAt = 0;
let refreshTimer = null;
let started = false; // guards startDhanTokenAutoRefresh() to run its one-time setup exactly once
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
 *
 * Self-rate-limited: if a real (non-cached) refresh already
 * happened within MIN_REFRESH_INTERVAL_MS, this returns the cached
 * token immediately without making a network call — safe to call
 * as often as needed (e.g. from a reconnect retry loop).
 */
export async function refreshDhanToken() {
  if (!canAutoRefreshDhanToken()) {
    throw new Error('DHAN: cannot auto-refresh — DHAN_PIN / DHAN_TOTP_SECRET not set');
  }

  if (cachedToken && Date.now() - cachedAt < MIN_REFRESH_INTERVAL_MS) {
    return cachedToken; // rate-limit guard — reuse what we already have
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
 * Call at startup (and safely again from every reconnect retry —
 * it only does real setup once). Fetches an initial token and
 * schedules the 20h rotation. Falls back silently to the static
 * DHAN_ACCESS_TOKEN env var if PIN/TOTP aren't set.
 */
export async function startDhanTokenAutoRefresh() {
  if (!canAutoRefreshDhanToken()) return null;

  if (started) {
    // Already initialized — a retry loop calling this again should
    // just get the current cached token, not restart timers or
    // trigger another network call (refreshDhanToken's own rate
    // guard would prevent the network call anyway, but skipping the
    // interval reset here keeps the 20h schedule predictable too).
    return cachedToken || refreshDhanToken().catch((err) => {
      console.error('[DhanTokenManager] Refresh on retry failed', err.message);
      return null;
    });
  }
  started = true;

  try {
    await refreshDhanToken();
  } catch (err) {
    console.error('[DhanTokenManager] Initial token refresh failed', err.message);
  }
  refreshTimer = setInterval(() => {
    refreshDhanToken().catch((err) =>
      console.error('[DhanTokenManager] Scheduled refresh failed', err.message)
    );
  }, REFRESH_INTERVAL_MS);
  return cachedToken;
}
