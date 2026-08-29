import { RingBuffer } from './RingBuffer.js';
import { config } from '../config/index.js';

const WINDOWS = ['1s', '5s', '15s', '30s', '60s', '5m', 'session'];

/**
 * One instance per symbol. Holds rolling history for every window
 * the spec requires: quotes, depth snapshots, volume/OI deltas,
 * option snapshots, derived microstructure values, and signals.
 *
 * A single high-frequency buffer is the source of truth; each
 * "window" is a query (sinceMs) over that buffer, not a separate
 * copy — this keeps memory bounded and avoids drift between windows.
 */
export class SymbolStore {
  constructor(symbol) {
    this.symbol = symbol;

    this.quotes = new RingBuffer(config.ringBuffer['60s'] * 4); // high-frequency tick buffer
    this.depthSnapshots = new RingBuffer(config.ringBuffer['60s'] * 4);
    this.optionSnapshots = new RingBuffer(config.ringBuffer['5m']);
    this.derivedValues = new RingBuffer(config.ringBuffer['5m']);
    this.signals = new RingBuffer(200);

    this.sessionStart = new Date().setHours(9, 15, 0, 0);
    this.lastUpdate = null;
    this.eventCount = 0;
    this.isStale = false;

    // Signal State Machine persistence (Engine 17) — lives here so it
    // survives across pipeline runs without needing its own registry.
    this.signalState = {
      state: 'NO_SIGNAL', // NO_SIGNAL | WATCHING | SIGNAL_ACTIVE | INVALIDATED
      direction: null,
      grade: null,
      enteredAt: null,
      consecutiveConfirmations: 0
    };
  }

  pushQuote(quote) {
    this.quotes.push(quote);
    this.lastUpdate = quote.timestamp;
    this.eventCount++;
    this.isStale = false;
  }

  pushDepth(depth) {
    this.depthSnapshots.push(depth);
    this.lastUpdate = depth.timestamp;
    this.eventCount++;
    this.isStale = false;
  }

  pushOptionSnapshot(snapshot) {
    this.optionSnapshots.push({ ...snapshot, timestamp: Date.now() });
  }

  pushDerived(name, value) {
    this.derivedValues.push({ name, value, timestamp: Date.now() });
  }

  pushSignal(signal) {
    this.signals.push({ ...signal, timestamp: Date.now() });
  }

  windowMs(window) {
    const map = {
      '1s': 1000,
      '5s': 5000,
      '15s': 15000,
      '30s': 30000,
      '60s': 60000,
      '5m': 300000,
      session: Date.now() - this.sessionStart
    };
    return map[window] ?? 60000;
  }

  quotesInWindow(window) {
    return this.quotes.sinceMs(this.windowMs(window));
  }

  depthInWindow(window) {
    return this.depthSnapshots.sinceMs(this.windowMs(window));
  }

  latestQuote() {
    return this.quotes.last();
  }

  latestDepth() {
    return this.depthSnapshots.last();
  }

  previousDepth() {
    const arr = this.depthSnapshots.toArray();
    return arr.length >= 2 ? arr[arr.length - 2] : null;
  }

  markStaleIfNeeded(staleThresholdMs = 5000) {
    if (this.lastUpdate && Date.now() - this.lastUpdate > staleThresholdMs) {
      this.isStale = true;
    }
    return this.isStale;
  }

  summary() {
    return {
      symbol: this.symbol,
      lastUpdate: this.lastUpdate,
      eventCount: this.eventCount,
      isStale: this.isStale
    };
  }
}

/**
 * Registry of SymbolStores, one per tracked instrument.
 */
export class RollingMarketStore {
  constructor() {
    this._stores = new Map();
  }

  forSymbol(symbol) {
    if (!this._stores.has(symbol)) {
      this._stores.set(symbol, new SymbolStore(symbol));
    }
    return this._stores.get(symbol);
  }

  allSymbols() {
    return [...this._stores.keys()];
  }

  tickStaleCheck() {
    for (const store of this._stores.values()) store.markStaleIfNeeded();
  }
}

export const WINDOW_NAMES = WINDOWS;
