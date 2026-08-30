import { computeEMASeries } from './ema.js';

/**
 * INDICATOR — MACD (12/26/9 standard, on real live closes)
 * Second proof-of-extensibility indicator alongside RSI — built by
 * composing computeEMASeries() rather than duplicating EMA math.
 */
export function computeMACD(candles, fast = 12, slow = 26, signalPeriod = 9) {
  if (!candles || candles.length < slow + signalPeriod) {
    return { status: 'INSUFFICIENT_DATA', candlesNeeded: slow + signalPeriod, candlesAvailable: candles?.length || 0 };
  }

  const closes = candles.map((c) => c.close);
  const fastEma = computeEMASeries(closes, fast);
  const slowEma = computeEMASeries(closes, slow);

  // Align: fastEma starts `fast-1` into closes, slowEma starts
  // `slow-1` into closes — trim the fast series to match the slow
  // series' start so we're comparing the same timestamps.
  const offset = slow - fast;
  const macdLine = slowEma.map((slowVal, i) => fastEma[i + offset] - slowVal);
  const signalLine = computeEMASeries(macdLine, signalPeriod);
  const histogram = signalLine.map((sig, i) => macdLine[i + (macdLine.length - signalLine.length)] - sig);

  const current = {
    macd: round(macdLine[macdLine.length - 1], 3),
    signal: round(signalLine[signalLine.length - 1], 3),
    histogram: round(histogram[histogram.length - 1], 3)
  };
  const previous = histogram.length > 1
    ? { histogram: round(histogram[histogram.length - 2], 3) }
    : null;

  let crossSignal = null;
  if (previous) {
    if (previous.histogram <= 0 && current.histogram > 0) crossSignal = 'BULLISH_CROSS';
    else if (previous.histogram >= 0 && current.histogram < 0) crossSignal = 'BEARISH_CROSS';
  }

  return { status: 'OK', ...current, crossSignal };
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
