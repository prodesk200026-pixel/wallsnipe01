/**
 * INDICATOR — RSI (Wilder's original smoothing, not a naive SMA)
 *
 * WHY THIS MATTERS: a "basic equation of RSI" run once over a fixed
 * window gives a different, noisier number than what every charting
 * platform (TradingView, broker terminals) actually shows — those
 * all use Wilder's exponential smoothing, which weights recent
 * average gains/losses against the ENTIRE prior history, not just
 * the last N candles. Getting this wrong is exactly how an indicator
 * stops being real edge and becomes a number that looks like RSI but
 * disagrees with what a trader sees everywhere else.
 *
 * Input: real closes from CandleStore for the requested symbol +
 * timeframe — this is live tick-built data, not synthetic.
 */
const DEFAULT_PERIOD = 14;

export function computeRSI(candles, period = DEFAULT_PERIOD) {
  if (!candles || candles.length < period + 1) {
    return { status: 'INSUFFICIENT_DATA', candlesNeeded: period + 1, candlesAvailable: candles?.length || 0 };
  }

  const closes = candles.map((c) => c.close);

  // Wilder's method: seed with a simple average of the first `period`
  // gains/losses, then exponentially smooth every candle after that
  // with a 1/period weight — this is what makes it "Wilder's RSI"
  // rather than a plain moving-average RSI.
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const series = [];
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
    series.push({ timestamp: candles[i].timestamp, rsi: round(rsi, 2) });
  }

  const current = series[series.length - 1]?.rsi ?? null;
  const previous = series[series.length - 2]?.rsi ?? null;

  // The actual "edge" part: not just the number, but whether it just
  // crossed a threshold THIS candle — a static "RSI is 28" tells you
  // less than "RSI just crossed below 30 this candle", which is the
  // signal most RSI-based entries actually trade off.
  let crossSignal = null;
  if (previous != null && current != null) {
    if (previous >= 30 && current < 30) crossSignal = 'CROSSED_BELOW_OVERSOLD';
    else if (previous <= 30 && current > 30) crossSignal = 'CROSSED_ABOVE_OVERSOLD';
    else if (previous <= 70 && current > 70) crossSignal = 'CROSSED_ABOVE_OVERBOUGHT';
    else if (previous >= 70 && current < 70) crossSignal = 'CROSSED_BELOW_OVERBOUGHT';
    else if (previous <= 50 && current > 50) crossSignal = 'CROSSED_ABOVE_MIDLINE';
    else if (previous >= 50 && current < 50) crossSignal = 'CROSSED_BELOW_MIDLINE';
  }

  return {
    status: 'OK',
    period,
    value: current,
    previousValue: previous,
    crossSignal,
    zone: current == null ? null : current >= 70 ? 'OVERBOUGHT' : current <= 30 ? 'OVERSOLD' : 'NEUTRAL',
    series: series.slice(-50) // recent history for a sparkline if the frontend wants one, bounded so payloads stay small
  };
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
