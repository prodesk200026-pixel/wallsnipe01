import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '10000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendOrigin: process.env.FRONTEND_ORIGIN || '*',

  // LIVE | REPLAY — mock/synthetic data mode does not exist in this
  // codebase. Replay is real recorded tick data, not fabricated data.
  dataMode: (process.env.DATA_MODE || 'LIVE').toUpperCase(),

  // How often (ms) to retry connecting to Angel after a disconnect.
  // No fallback broker, no mock — just silence + retry.
  liveRetryIntervalMs: parseInt(process.env.LIVE_RETRY_INTERVAL_MS || '15000', 10),

  // ANGEL ONE ONLY. Angel's SmartAPI market data comes included with
  // regular trading-account API access — no separate paid Data API
  // subscription like Dhan requires. Depth is best-5 (not 20-level).
  angel: {
    apiKey: process.env.ANGEL_API_KEY || '',
    clientCode: process.env.ANGEL_CLIENT_CODE || '',
    pin: process.env.ANGEL_PIN || '',
    totpSecret: process.env.ANGEL_TOTP_SECRET || ''
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
