import { AngelAdapter } from './AngelAdapter.js';
import { DhanAdapter } from './DhanAdapter.js';
import { config, hasAngelCredentials, hasDhanCredentials } from '../config/index.js';
import {
  canAutoRefreshDhanToken,
  startDhanTokenAutoRefresh,
  onDhanTokenRefreshed
} from '../auth/dhanTokenManager.js';

/**
 * AdapterManager — DUAL BROKER, whichever genuinely works.
 *
 * Angel One (SmartAPI) and Dhan are both supported. Angel's market
 * data comes included with regular trading access (best-5 depth, no
 * separate subscription needed) — Dhan needs an active paid Data API
 * subscription for its 20-level depth to actually work, so until
 * that's confirmed active, Angel is the more reliable default. Both
 * are wired in so whichever one is genuinely reachable right now
 * gets used, without needing a rebuild when that changes.
 *
 * PRIMARY_BROKER / SECONDARY_BROKER (env) pick the try-order — this
 * loop is generic, not hardcoded to either name, so setting either
 * one to ANGEL or DHAN in either position just works.
 *
 * Never a mock/synthetic tick: if neither broker is reachable, the
 * app surfaces DISCONNECTED honestly and keeps retrying with
 * backoff, rather than fabricating data.
 */
export class AdapterManager {
  constructor() {
    this.active = null;
    this.activeName = null; // 'ANGEL' | 'DHAN' | 'REPLAY' | null
    this._quoteCallbacks = [];
    this._depthCallbacks = [];
    this._statusCallbacks = [];
    this._instruments = [];
    this._depthInstruments = [];
    this._dhanRefreshWired = false;
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

  async _buildDhanAdapter() {
    const dhanConfig = { ...config.dhan };
    if (canAutoRefreshDhanToken()) {
      dhanConfig.accessToken = await startDhanTokenAutoRefresh();
      if (!this._dhanRefreshWired) {
        this._dhanRefreshWired = true;
        onDhanTokenRefreshed(() => {
          if (this.activeName === 'DHAN') {
            this._notifyStatus({ event: 'DHAN_TOKEN_ROTATING', action: 'RECONNECT' });
            this.start();
          }
        });
      }
    }
    return new DhanAdapter(dhanConfig);
  }

  async start() {
    if (config.dataMode === 'REPLAY') {
      this.activeName = 'REPLAY';
      return;
    }

    const order = [config.primaryBroker, config.secondaryBroker].filter(
      (name, i, arr) => name && arr.indexOf(name) === i
    );

    for (const brokerName of order) {
      const isPrimary = brokerName === config.primaryBroker;
      try {
        if (brokerName === 'ANGEL' && hasAngelCredentials()) {
          await this._activate(new AngelAdapter(config.angel), 'ANGEL');
          return;
        }
        if (brokerName === 'DHAN' && hasDhanCredentials()) {
          await this._activate(await this._buildDhanAdapter(), 'DHAN');
          return;
        }
      } catch (err) {
        this._notifyStatus({
          event: isPrimary ? 'PRIMARY_FAILED' : 'SECONDARY_FAILED',
          provider: brokerName,
          error: err.message
        });
      }
    }

    if (!hasAngelCredentials() && !hasDhanCredentials()) {
      this._notifyStatus({
        event: 'MISSING_CREDENTIALS',
        error: 'Neither Angel nor Dhan has complete credentials set'
      });
    }

    // Both unavailable right now. Do NOT fabricate data. Surface
    // DISCONNECTED and keep retrying with backoff.
    this.active = null;
    this.activeName = null;
    this._notifyStatus({ event: 'ALL_PROVIDERS_FAILED', action: 'RETRY_LIVE_ONLY' });
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    // Exponential backoff (capped) — hard-won lesson from the Dhan
    // integration: hammering a broker's login/token endpoint on
    // every fast retry can itself cause the broker to reject or kill
    // the connection. Resets to the base interval on next connect.
    this._retryAttempt += 1;
    const delay = Math.min(
      config.liveRetryIntervalMs * 2 ** (this._retryAttempt - 1),
      2 * 60 * 1000
    );
    this._notifyStatus({ event: 'RETRY_SCHEDULED', delayMs: delay, attempt: this._retryAttempt });
    this._retryTimer = setTimeout(async () => {
      this._retryTimer = null;
      if (this.active) return;
      this._notifyStatus({ event: 'RETRYING_LIVE_PROVIDERS' });
      await this.start();
    }, delay);
  }

  async subscribe(instruments) {
    this._instruments = instruments;
    if (!this.active) return;
    await this.active.subscribeMarketData(instruments);
  }

  async subscribeDepth(instruments, levels) {
    this._depthInstruments = instruments;
    if (!this.active) return;
    const actualLevels = this.activeName === 'DHAN' ? 20 : 5;
    await this.active.subscribeDepth(instruments, levels || actualLevels);
  }

  async getOptionChain(underlying, expiry) {
    if (!this.active) return null;
    return this.active.getOptionChain(underlying, expiry);
  }

  async _activate(adapterInstance, name) {
    if (this.active && this.active !== adapterInstance) {
      try {
        await this.active.disconnect();
      } catch {
        // best-effort — the old socket may already be dead
      }
    }

    this.active = adapterInstance;
    this.activeName = name;

    adapterInstance.onQuote((q) => {
      for (const cb of this._quoteCallbacks) cb(q, name);
    });
    adapterInstance.onDepth((d) => {
      for (const cb of this._depthCallbacks) cb(d, name);
    });
    adapterInstance.onError((err) => this._handleAdapterError(err));

    await adapterInstance.connect();
    const depthLevels = name === 'DHAN' ? 20 : 5;
    if (this._instruments.length) await adapterInstance.subscribeMarketData(this._instruments);
    if (this._depthInstruments.length) await adapterInstance.subscribeDepth(this._depthInstruments, depthLevels);
    this._retryAttempt = 0; // successful connect — reset backoff for next time it drops
    this._notifyStatus({ event: 'CONNECTED', provider: name });
  }

  async _handleAdapterError(err) {
    this._notifyStatus({ event: 'ADAPTER_ERROR', ...err });
    // Preserve last known market state, mark STALE/DISCONNECTED, and
    // retry (trying both brokers again, in order) with backoff.
    this.active = null;
    this.activeName = null;
    this._notifyStatus({ event: 'PROVIDER_DOWN', action: 'PRESERVE_LAST_STATE_MARK_STALE_AND_RETRY' });
    this._scheduleRetry();
  }

  _notifyStatus(payload) {
    // Always print to server logs (Render/PM2/etc). Without this, a
    // failed connect is only ever sent over the socket to the
    // frontend and is invisible when debugging from server logs.
    const level = /FAILED|ERROR|DOWN|MISSING/.test(payload.event) ? 'error' : 'log';
    console[level](`[AdapterManager] ${payload.event}`, payload);
    for (const cb of this._statusCallbacks) cb(payload);
  }
}
