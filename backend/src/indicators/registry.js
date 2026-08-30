import { computeRSI } from './rsi.js';
import { computeMACD } from './macd.js';

/**
 * INDICATOR REGISTRY — this is the actual answer to "ek aisa backend
 * banao ki wo kisi bhi strategy ya logic mein live data ke hisaab se
 * kaam karwa sake."
 *
 * Every entry is `name: (candles) => result`. Every indicator here
 * receives REAL candles built from live ticks (CandleStore) for
 * whichever timeframe the caller asks for — never synthetic data,
 * never a formula run once on a static array.
 *
 * TO ADD A NEW STRATEGY/INDICATOR:
 *   1. Write a new file in this folder, e.g. `supertrend.js`,
 *      exporting a `compute___(candles, ...params)` function that
 *      takes the same `candles` shape (array of {timestamp, open,
 *      high, low, close, volume}) RSI/MACD already use.
 *   2. Import it here and add one line to REGISTRY below.
 *   3. It's now available at every timeframe, on every symbol,
 *      automatically — nothing else in the codebase needs to change.
 *
 * That's the whole extension point. No special-casing per-indicator
 * elsewhere in the pipeline.
 */
const REGISTRY = {
  rsi: (candles) => computeRSI(candles, 14),
  macd: (candles) => computeMACD(candles, 12, 26, 9)
  // Add more here: supertrend, bollingerBands, stochastic, vwap, etc.
  // — same pattern, same one-line registration.
};

/**
 * Runs every registered indicator against one timeframe's candles.
 * Returns e.g. { rsi: {...}, macd: {...} } — one call per timeframe
 * the caller cares about (see runIndicatorsAllTimeframes below for
 * the common case of wanting all of them).
 */
export function runIndicators(candles) {
  const out = {};
  for (const [name, fn] of Object.entries(REGISTRY)) {
    try {
      out[name] = fn(candles);
    } catch (err) {
      out[name] = { status: 'ERROR', error: err.message };
    }
  }
  return out;
}

/**
 * Runs every registered indicator across every CandleStore timeframe
 * for one symbol — this is what pipeline.js calls per broadcast tick
 * so the frontend can show "RSI(5m): 28.4 — just crossed oversold"
 * right on the entry card, not a static number computed once.
 */
export function runIndicatorsAllTimeframes(candleStore, symbol) {
  const out = {};
  for (const tf of candleStore.constructor.supportedTimeframes) {
    const candles = candleStore.getCandles(symbol, tf, 200);
    out[tf] = runIndicators(candles);
  }
  return out;
}

export function listAvailableIndicators() {
  return Object.keys(REGISTRY);
}
