/**
 * ENGINE 6 — ESTIMATED CVD
 * Built entirely on top of the trade-flow proxy. Named ESTIMATED_CVD
 * throughout — never TRUE_CVD. Returns CVD_STATUS=UNAVAILABLE rather
 * than fabricating a number when confidence is too low.
 */
export function computeEstimatedCVD(symbolStore, tradeFlowProxy) {
  if (tradeFlowProxy?.status !== 'ESTIMATED') {
    return { status: 'UNAVAILABLE', reason: 'trade flow proxy unavailable' };
  }

  const unknownRatio1m = tradeFlowProxy.windows['60s']?.unknownRatio;
  if (unknownRatio1m !== null && unknownRatio1m > 0.6) {
    return { status: 'UNAVAILABLE', reason: 'unknown-classified volume too high for reliable CVD' };
  }

  const derived = symbolStore.derivedValues.toArray().filter((d) => d.name === 'estimatedCVD');
  const prevCVD = derived.length ? derived[derived.length - 1].value.estimatedCVD : 0;
  const currentDelta = tradeFlowProxy.windows['5s']?.tradeFlowProxy ?? 0;
  const estimatedCVD = prevCVD + currentDelta;

  const prevValue = derived.length ? derived[derived.length - 1].value.estimatedCVD : estimatedCVD;
  const velocity = estimatedCVD - prevValue;
  const prevVelocity = derived.length >= 2 ? derived[derived.length - 1].value.velocity ?? 0 : 0;
  const acceleration = velocity - prevVelocity;

  const quotes5m = symbolStore.quotesInWindow('5m');
  const divergence = detectDivergence(quotes5m, estimatedCVD, derived);

  const result = {
    status: 'ESTIMATED',
    estimatedCVD: round(estimatedCVD),
    velocity: round(velocity),
    acceleration: round(acceleration),
    classificationConfidence: tradeFlowProxy.confidence,
    divergence
  };

  symbolStore.pushDerived('estimatedCVD', result);
  return result;
}

function detectDivergence(quotes, currentCVD, derivedHistory) {
  if (quotes.length < 10 || derivedHistory.length < 10) return 'NONE';

  const prices = quotes.map((q) => q.ltp).filter((p) => p != null);
  if (prices.length < 10) return 'NONE';

  const recentLow = Math.min(...prices.slice(-10));
  const earlierLow = Math.min(...prices.slice(0, -10));
  const recentCVDs = derivedHistory.slice(-10).map((d) => d.value.estimatedCVD);
  const cvdTrendFlat = recentCVDs.length
    ? Math.abs(recentCVDs[recentCVDs.length - 1] - recentCVDs[0]) < Math.abs(recentCVDs[0] || 1) * 0.1
    : false;

  if (recentLow < earlierLow && cvdTrendFlat) return 'POSSIBLE_BULLISH_CVD_DIVERGENCE';

  const recentHigh = Math.max(...prices.slice(-10));
  const earlierHigh = Math.max(...prices.slice(0, -10));
  if (recentHigh > earlierHigh && cvdTrendFlat) return 'POSSIBLE_BEARISH_CVD_DIVERGENCE';

  return 'NONE';
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
