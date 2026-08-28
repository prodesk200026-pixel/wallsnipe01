/**
 * BaseMarketDataAdapter
 *
 * Provider-independent contract. The signal engine never talks to a
 * provider directly — only to this interface via normalized events.
 * The concrete DhanAdapter must implement all
 * methods below and emit normalized objects (see normalizers/).
 */
export class BaseMarketDataAdapter {
  constructor(name) {
    if (new.target === BaseMarketDataAdapter) {
      throw new Error('BaseMarketDataAdapter is abstract and cannot be instantiated directly');
    }
    this.providerName = name;
    this._quoteCallbacks = [];
    this._depthCallbacks = [];
    this._errorCallbacks = [];
    this._connectionStatus = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | CONNECTED | ERROR
  }

  // --- lifecycle ---
  async connect() {
    throw new Error(`${this.providerName}: connect() not implemented`);
  }

  async disconnect() {
    throw new Error(`${this.providerName}: disconnect() not implemented`);
  }

  getConnectionStatus() {
    return this._connectionStatus;
  }

  // --- REST-style data ---
  async getQuote(instrument) {
    throw new Error(`${this.providerName}: getQuote() not implemented`);
  }

  async getHistoricalCandles(instrument, timeframe) {
    throw new Error(`${this.providerName}: getHistoricalCandles() not implemented`);
  }

  async getOptionChain(underlying, expiry) {
    throw new Error(`${this.providerName}: getOptionChain() not implemented`);
  }

  // --- streaming subscriptions ---
  async subscribeMarketData(instruments) {
    throw new Error(`${this.providerName}: subscribeMarketData() not implemented`);
  }

  async unsubscribeMarketData(instruments) {
    throw new Error(`${this.providerName}: unsubscribeMarketData() not implemented`);
  }

  async subscribeDepth(instruments, levels) {
    throw new Error(`${this.providerName}: subscribeDepth() not implemented`);
  }

  async unsubscribeDepth(instruments) {
    throw new Error(`${this.providerName}: unsubscribeDepth() not implemented`);
  }

  // --- event registration ---
  onQuote(callback) {
    this._quoteCallbacks.push(callback);
  }

  onDepth(callback) {
    this._depthCallbacks.push(callback);
  }

  onError(callback) {
    this._errorCallbacks.push(callback);
  }

  // --- internal emit helpers (used by subclasses) ---
  _emitQuote(normalizedQuote) {
    for (const cb of this._quoteCallbacks) cb(normalizedQuote);
  }

  _emitDepth(normalizedDepth) {
    for (const cb of this._depthCallbacks) cb(normalizedDepth);
  }

  _emitError(err) {
    for (const cb of this._errorCallbacks) cb(err);
  }
}
