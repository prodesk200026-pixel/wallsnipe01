import { AngelAdapter } from './AngelAdapter.js';
import { config, hasAngelCredentials } from '../config/index.js';

/**
 * AdapterManager — ANGEL ONE ONLY.
 *
 * By deliberate choice: Angel's SmartAPI market data comes included
 * with regular trading-account API access (no separate paid Data API
 * subscription, unlike Dhan) — chosen specifically to avoid the
 * subscription-entitlement uncertainty that blocked the Dhan
 * integration. Depth is best-5 (not Dhan's 20-level), a known
 * tradeoff. There is no fallback broker and never a mock/synthetic
 * tick — if Angel is unreachable, the app surfaces DISCONNECTED
 * honestly and keeps retrying (with backoff), rather than silently
 * switching data source or fabricating data.
 */
export class AdapterManager {
  constructor() {
    this.active = null; // current AngelAdapter instance, or null
    this.activeName = null; // 'ANGEL' | 'REPLAY' | null
    this._quoteCallbacks = [];
    this._depthCallbacks = [];
    this._statusCallbacks = [];
    this._instruments = [];
    this._depthInstruments = [];
    this._retryTimer = null;
    this._retryAttempt = 0;
  }

  onQuote(cb) {
    this._quoteCallbacks.push(cb);
  }
  onDepth(cb) {
    this._depthCallbacks.push(cb);
  }
  onStatusChange(cb) {
    this._statusCallbacks.push(cb);
  }

  getStatus() {
    return {
      activeProvider: this.activeName,
      connectionStatus: this.active?.getConnectionStatus() || 'DISCONNECTED',
      dataMode: config.dataMode
    };
  }

  async start() {
    if (config.dataMode === 'REPLAY') {
      // Replay mode is wired up in src/replay — AdapterManager just
      // stays idle and lets the replay service push into the store.
      this.activeName = 'REPLAY';
      return;
    }

    if (!hasAngelCredentials()) {
      this._notifyStatus({
        event: 'MISSING_CREDENTIALS',
        provider: 'ANGEL',
        error: 'ANGEL_API_KEY / ANGEL_CLIENT_CODE / ANGEL_PIN / ANGEL_TOTP_SECRET not fully set'
      });
      this._scheduleRetry();
      return;
    }

    try {
      await this._activate(new AngelAdapter(config.angel));
    } catch (err) {
      this._notifyStatus({ event: 'CONNECT_FAILED', provider: 'ANGEL', error: err.message });
      this.active = null;
      this.activeName = null;
      this._scheduleRetry();
    }
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    // Exponential backoff (capped) rather than a fixed fast interval
    // — hard-won lesson from the Dhan integration: hammering a
    // broker's login/token endpoint on every retry can itself cause
    // the broker to reject or kill the connection. Resets to the
    // base interval on the next successful connect.
    this._retryAttempt += 1;
    const delay = Math.min(
      config.liveRetryIntervalMs * 2 ** (this._retryAttempt - 1),
      2 * 60 * 1000 // cap at 2 minutes between attempts
    );
    this._notifyStatus({ event: 'RETRY_SCHEDULED', delayMs: delay, attempt: this._retryAttempt });
    this._retryTimer = setTimeout(async () => {
      this._retryTimer = null;
      if (this.active) return; // a connection succeeded via another path meanwhile
      this._notifyStatus({ event: 'RETRYING_ANGEL' });
      await this.start();
    }, delay);
  }

  async subscribe(instruments) {
    this._instruments = instruments;
    if (!this.active) return;
    await this.active.subscribeMarketData(instruments);
  }

  async subscribeDepth(instruments, levels = 5) {
    this._depthInstruments = instruments;
    if (!this.active) return;
    await this.active.subscribeDepth(instruments, levels);
  }

  async getOptionChain(underlying, expiry) {
    if (!this.active) return null;
    return this.active.getOptionChain(underlying, expiry);
  }

  async _activate(adapterInstance) {
    // If replacing a live connection, cleanly close the old socket
    // first instead of leaking it.
    if (this.active && this.active !== adapterInstance) {
      try {
        await this.active.disconnect();
      } catch {
        // best-effort — the old socket may already be dead
      }
    }

    this.active = adapterInstance;
    this.activeName = 'ANGEL';

    adapterInstance.onQuote((q) => {
      for (const cb of this._quoteCallbacks) cb(q, 'ANGEL');
    });
    adapterInstance.onDepth((d) => {
      for (const cb of this._depthCallbacks) cb(d, 'ANGEL');
    });
    adapterInstance.onError((err) => this._handleAdapterError(err));

    await adapterInstance.connect();
    // Re-subscribe immediately so a reconnect doesn't silently sit
    // idle until the next manual subscribe() call.
    if (this._instruments.length) await adapterInstance.subscribeMarketData(this._instruments);
    if (this._depthInstruments.length) await adapterInstance.subscribeDepth(this._depthInstruments, 5);
    this._retryAttempt = 0; // successful connect — reset backoff for the next time it drops
    this._notifyStatus({ event: 'CONNECTED', provider: 'ANGEL' });
  }

  async _handleAdapterError(err) {
    this._notifyStatus({ event: 'ADAPTER_ERROR', ...err });
    // No fallback broker — preserve last known market state in the
    // rolling store, mark the frontend STALE/DISCONNECTED, and retry
    // Angel on a backoff schedule. Never fabricate a tick.
    this.active = null;
    this.activeName = null;
    this._notifyStatus({ event: 'ANGEL_DOWN', action: 'PRESERVE_LAST_STATE_MARK_STALE_AND_RETRY' });
    this._scheduleRetry();
  }

  _notifyStatus(payload) {
    // Always print to server logs (Render/PM2/etc). Without this, a
    // failed Angel connect is only ever sent over the socket to the
    // frontend and is invisible when debugging from server logs.
    const level = /FAILED|ERROR|DOWN|MISSING/.test(payload.event) ? 'error' : 'log';
    console[level](`[AdapterManager] ${payload.event}`, payload);
    for (const cb of this._statusCallbacks) cb(payload);
  }
}
