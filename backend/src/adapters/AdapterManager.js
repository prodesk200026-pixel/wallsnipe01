import { DhanAdapter } from './DhanAdapter.js';
import { config, hasDhanCredentials } from '../config/index.js';
import {
  canAutoRefreshDhanToken,
  startDhanTokenAutoRefresh,
  onDhanTokenRefreshed
} from '../auth/dhanTokenManager.js';

/**
 * AdapterManager — DHAN ONLY.
 *
 * By deliberate choice (not a limitation): Dhan's Data API gives
 * 20-level market depth, which the microstructure engines (book
 * pressure, depth imbalance) are built around. There is no fallback
 * broker and never a mock/synthetic tick — if Dhan is unreachable,
 * the app surfaces DISCONNECTED honestly and keeps retrying, rather
 * than silently switching to a shallower data source or fabricating
 * data.
 */
export class AdapterManager {
  constructor() {
    this.active = null; // current DhanAdapter instance, or null
    this.activeName = null; // 'DHAN' | 'REPLAY' | null
    this._quoteCallbacks = [];
    this._depthCallbacks = [];
    this._statusCallbacks = [];
    this._instruments = [];
    this._depthInstruments = [];
    this._dhanRefreshWired = false;
    this._retryTimer = null;
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

    if (!hasDhanCredentials()) {
      this._notifyStatus({
        event: 'MISSING_CREDENTIALS',
        provider: 'DHAN',
        error: 'DHAN_CLIENT_ID + (DHAN_ACCESS_TOKEN or DHAN_PIN+DHAN_TOTP_SECRET) not set'
      });
      this._scheduleRetry();
      return;
    }

    try {
      const dhanConfig = { ...config.dhan };
      if (canAutoRefreshDhanToken()) {
        // Auto-generate a fresh 24h token via TOTP instead of trusting
        // a possibly-stale pasted DHAN_ACCESS_TOKEN.
        dhanConfig.accessToken = await startDhanTokenAutoRefresh();
        if (!this._dhanRefreshWired) {
          this._dhanRefreshWired = true;
          // Every daily refresh, reconnect with the new token so the
          // WebSocket never sits on an expired one.
          onDhanTokenRefreshed(() => {
            if (this.activeName === 'DHAN') {
              this._notifyStatus({ event: 'DHAN_TOKEN_ROTATING', action: 'RECONNECT' });
              this.start();
            }
          });
        }
      }
      await this._activate(new DhanAdapter(dhanConfig));
    } catch (err) {
      this._notifyStatus({ event: 'CONNECT_FAILED', provider: 'DHAN', error: err.message });
      this.active = null;
      this.activeName = null;
      this._scheduleRetry();
    }
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(async () => {
      this._retryTimer = null;
      if (this.active) return; // a connection succeeded via another path meanwhile
      this._notifyStatus({ event: 'RETRYING_DHAN' });
      await this.start();
    }, config.liveRetryIntervalMs);
  }

  async subscribe(instruments) {
    this._instruments = instruments;
    if (!this.active) return;
    await this.active.subscribeMarketData(instruments);
  }

  async subscribeDepth(instruments, levels = 20) {
    this._depthInstruments = instruments;
    if (!this.active) return;
    await this.active.subscribeDepth(instruments, levels);
  }

  async getOptionChain(underlying, expiry) {
    if (!this.active) return null;
    return this.active.getOptionChain(underlying, expiry);
  }

  async _activate(adapterInstance) {
    // If replacing a live connection (e.g. daily Dhan token rotation),
    // cleanly close the old socket first instead of leaking it.
    if (this.active && this.active !== adapterInstance) {
      try {
        await this.active.disconnect();
      } catch {
        // best-effort — the old socket may already be dead
      }
    }

    this.active = adapterInstance;
    this.activeName = 'DHAN';

    adapterInstance.onQuote((q) => {
      for (const cb of this._quoteCallbacks) cb(q, 'DHAN');
    });
    adapterInstance.onDepth((d) => {
      for (const cb of this._depthCallbacks) cb(d, 'DHAN');
    });
    adapterInstance.onError((err) => this._handleAdapterError(err));

    await adapterInstance.connect();
    // Re-subscribe immediately so a token-rotation reconnect doesn't
    // silently sit idle until the next manual subscribe() call.
    if (this._instruments.length) await adapterInstance.subscribeMarketData(this._instruments);
    if (this._depthInstruments.length) await adapterInstance.subscribeDepth(this._depthInstruments, 20);
    this._notifyStatus({ event: 'CONNECTED', provider: 'DHAN' });
  }

  async _handleAdapterError(err) {
    this._notifyStatus({ event: 'ADAPTER_ERROR', ...err });
    // No fallback broker — preserve last known market state in the
    // rolling store, mark the frontend STALE/DISCONNECTED, and retry
    // Dhan on an interval. Never fabricate a tick.
    this.active = null;
    this.activeName = null;
    this._notifyStatus({ event: 'DHAN_DOWN', action: 'PRESERVE_LAST_STATE_MARK_STALE_AND_RETRY' });
    this._scheduleRetry();
  }

  _notifyStatus(payload) {
    // Always print to server logs (Render/PM2/etc). Without this, a
    // failed DHAN connect is only ever sent over the socket to the
    // frontend and is invisible when debugging from server logs.
    const level = /FAILED|ERROR|DOWN|MISSING/.test(payload.event) ? 'error' : 'log';
    console[level](`[AdapterManager] ${payload.event}`, payload);
    for (const cb of this._statusCallbacks) cb(payload);
  }
}
