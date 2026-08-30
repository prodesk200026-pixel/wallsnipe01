import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '10000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendOrigin: process.env.FRONTEND_ORIGIN || '*',

  // LIVE | REPLAY — mock/synthetic data mode does not exist in this
  // codebase. Replay is real recorded tick data, not fabricated data.
  dataMode: (process.env.DATA_MODE || 'LIVE').toUpperCase(),

  // Which broker to try first, then which to try second. Any
  // combination of ANGEL/DHAN works — AdapterManager reads these
  // generically, not hardcoded to either name.
  primaryBroker: (process.env.PRIMARY_BROKER || 'ANGEL').toUpperCase(),
  secondaryBroker: (process.env.SECONDARY_BROKER || 'DHAN').toUpperCase(),

  // How often (ms) to retry connecting after a disconnect — this is
  // the BASE interval; actual retries use exponential backoff from
  // here (15s, 30s, 60s, capped at 2 min).
  liveRetryIntervalMs: parseInt(process.env.LIVE_RETRY_INTERVAL_MS || '15000', 10),

  // Angel One / SmartAPI — market data included with regular trading
  // access, no separate paid subscription. Depth is best-5.
  angel: {
    apiKey: process.env.ANGEL_API_KEY || '',
    clientCode: process.env.ANGEL_CLIENT_CODE || '',
    pin: process.env.ANGEL_PIN || '',
    totpSecret: process.env.ANGEL_TOTP_SECRET || ''
  },

  // Dhan — 20-level depth, but requires an active paid Data API
  // subscription on the account or its WebSocket will accept the
  // handshake and then silently drop (code 1006). Included so it's
  // used automatically the moment that subscription is active,
  // without needing another rebuild.
  dhan: {
    clientId: process.env.DHAN_CLIENT_ID || '',
    accessToken: process.env.DHAN_ACCESS_TOKEN || '',
    pin: process.env.DHAN_PIN || '',
    totpSecret: process.env.DHAN_TOTP_SECRET || ''
  },

  // Web Push (alarm notifications) — generate a keypair once with
  // `npx web-push generate-vapid-keys` and set both below. Optional:
  // signal alarms are simply disabled if these aren't set.
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    contactEmail: process.env.VAPID_CONTACT_EMAIL || ''
  },

  ringBuffer: {
    '1s': parseInt(process.env.RING_BUFFER_1S || '120', 10),
    '5s': parseInt(process.env.RING_BUFFER_5S || '180', 10),
    '15s': parseInt(process.env.RING_BUFFER_15S || '240', 10),
    '30s': parseInt(process.env.RING_BUFFER_30S || '240', 10),
    '60s': parseInt(process.env.RING_BUFFER_60S || '300', 10),
    '5m': parseInt(process.env.RING_BUFFER_5M || '300', 10)
  },

  // Signal-only safety flag. Must never become true from env alone.
  AUTO_TRADING_ENABLED: false
};

export function hasAngelCredentials() {
  return Boolean(
    config.angel.apiKey && config.angel.clientCode && config.angel.pin && config.angel.totpSecret
  );
}

export function hasDhanCredentials() {
  // Either a manually pasted access token, OR the pieces needed to
  // auto-generate one daily (clientId + PIN + TOTP secret).
  return Boolean(
    config.dhan.clientId &&
    (config.dhan.accessToken || (config.dhan.pin && config.dhan.totpSecret))
  );
}
