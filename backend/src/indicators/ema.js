/**
 * INDICATOR — EMA (Exponential Moving Average)
 * Building block reused by MACD and anything else that needs it —
 * this is the extensibility point: new indicators compose from
 * existing ones instead of reimplementing smoothing math each time.
 */
export function computeEMASeries(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const series = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period; // seed with SMA
  series.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    series.push(ema);
  }
  return series; // aligned to values[period-1 ..] — caller handles offset
}
