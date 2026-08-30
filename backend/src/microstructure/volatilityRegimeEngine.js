/**
 * ENGINE 10 — VOLATILITY AND EXPANSION
 * Classifies COMPRESSION / NORMAL / EXPANSION / EXTREME_VOLATILITY and
 * flags the COMPRESSION_TO_EXPANSION transition specifically.
 */
export function computeVolatilityRegime(symbolStore) {
  const q1m = symbolStore.quotesInWindow('60s');
  const q5m = symbolStore.quotesInWindow('5m');

  if (q1m.length < 5 || q5m.length < 10) {
    return { status: 'UNAVAILABLE', reason: 'insufficient tick history' };
  }

  const range1m = rangeOf(q1m);
  const range5m = rangeOf(q5m);
  const realizedVol = realizedVolatility(q1m);
  const activityIntensity = activityOf(q1m);
  const spreadChange = null; // requires depth-history spread series; left null when not computed by caller

  const avgPrice = average(q1m.map((q) => q.ltp).filter((p) => p != null));
  const normalizedRange1m = avgPrice ? range1m / avgPrice : 0;
  const normalizedRange5m = avgPrice ? range5m / avgPrice : 0;

  let classification;
  if (normalizedRange1m < 0.0008) classification = 'COMPRESSION';
  else if (normalizedRange1m > 0.004) classification = 'EXTREME_VOLATILITY';
  else if (normalizedRange1m > 0.002) classification = 'EXPANSION';
  else classification = 'NORMAL';

  const history = symbolStore.derivedValues.toArray().filter((d) => d.name === 'volatilityRegime');
  const previousClassification = history.length ? history[history.length - 1].value.classification : null;
  const transition = previousClassification === 'COMPRESSION' && classification === 'EXPANSION'
    ? 'COMPRESSION_TO_EXPANSION'
    : 'NONE';

  const result = {
    status: 'DERIVED',
    range1m: round(range1m),
    range5m: round(range5m),
    realizedVolatility: round(realizedVol, 5),
    activityIntensity,
    classification,
    transition
  };

  symbolStore.pushDerived('volatilityRegime', result);
  return result;
}

function rangeOf(quotes) {
  const prices = quotes.map((q) => q.ltp).filter((p) => p != null);
  if (!prices.length) return 0;
  return Math.max(...prices) - Math.min(...prices);
}

function realizedVolatility(quotes) {
  const prices = quotes.map((q) => q.ltp).filter((p) => p != null);
  if (prices.length < 3) return 0;
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (!returns.length) return 0;
  const mean = average(returns);
  const variance = average(returns.map((r) => (r - mean) ** 2));
  return Math.sqrt(variance);
}

function activityOf(quotes) {
  const volumeSum = quotes.reduce((s, q, i) => (i === 0 ? s : s + Math.max((q.volume ?? 0) - (quotes[i - 1].volume ?? 0), 0)), 0);
  const perSecond = volumeSum / Math.max((quotes[quotes.length - 1].timestamp - quotes[0].timestamp) / 1000, 1);
  if (perSecond > 5000) return 'HIGH';
  if (perSecond > 1500) return 'MODERATE';
  return 'LOW';
}

function average(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
