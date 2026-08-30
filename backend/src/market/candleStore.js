/**
 * CandleStore
 *
 * Builds rolling OHLC candles for every requested timeframe directly
 * from the live tick stream (the same normalized quotes that feed
 * the microstructure engines) — not a separate/fake data source.
 * If ticks stop, candles simply stop updating; nothing is fabricated.
 */
const TIMEFRAMES_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '60m': 3_600_000,
  '75m': 4_500_000
};

const MAX_CANDLES_PER_TIMEFRAME = 300; // bounded, ~5-12 hours of history depending on tf

export class CandleStore {
  constructor() {
    // symbol -> timeframe -> { candles: [...], current: {...}|null }
    this._data = new Map();
  }

  _stateFor(symbol) {
    if (!this._data.has(symbol)) {
      const perTimeframe = new Map();
      for (const tf of Object.keys(TIMEFRAMES_MS)) {
        perTimeframe.set(tf, { candles: [], current: null });
      }
      this._data.set(symbol, perTimeframe);
    }
    return this._data.get(symbol);
  }

  /**
   * Feed one tick (normalized quote) into every timeframe bucket.
   * Called on every quote the adapter emits — this is the tick-by-
   * tick data you asked about; if it's flowing, it's used here.
   */
  onTick(symbol, quote) {
    if (quote.ltp == null) return;
    const perTimeframe = this._stateFor(symbol);

    for (const [tf, ms] of Object.entries(TIMEFRAMES_MS)) {
      const bucket = perTimeframe.get(tf);
      const bucketStart = Math.floor(quote.timestamp / ms) * ms;

      if (!bucket.current || bucket.current.timestamp !== bucketStart) {
        // close out the previous candle, open a new one
        if (bucket.current) {
          bucket.candles.push(bucket.current);
          if (bucket.candles.length > MAX_CANDLES_PER_TIMEFRAME) bucket.candles.shift();
        }
        bucket.current = {
          timestamp: bucketStart,
          open: quote.ltp,
          high: quote.ltp,
          low: quote.ltp,
          close: quote.ltp,
          volume: 0
        };
      }

      const c = bucket.current;
      c.high = Math.max(c.high, quote.ltp);
      c.low = Math.min(c.low, quote.ltp);
      c.close = quote.ltp;
      if (quote.ltq) c.volume += quote.ltq;
    }
  }

  getCandles(symbol, timeframe, limit = 100) {
    const perTimeframe = this._data.get(symbol);
    if (!perTimeframe || !perTimeframe.has(timeframe)) return [];
    const bucket = perTimeframe.get(timeframe);
    const all = bucket.current ? [...bucket.candles, bucket.current] : bucket.candles;
    return all.slice(-limit);
  }

  static get supportedTimeframes() {
    return Object.keys(TIMEFRAMES_MS);
  }
}
