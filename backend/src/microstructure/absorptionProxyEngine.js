/**
 * ENGINE 7 — ABSORPTION PROXY
 * Never claims exact absorption — only a confidence-scored proxy
 * built from trade-flow intensity, price response, and whether the
 * opposing side of the book persists/refills under that pressure.
 */
export function computeAbsorptionProxy(symbolStore, { tradeFlowProxy, liquidityWithdrawal }) {
  if (tradeFlowProxy?.status !== 'ESTIMATED') {
    return { status: 'UNAVAILABLE', reason: 'trade flow proxy unavailable' };
  }

  const quotes = symbolStore.quotesInWindow('15s');
  if (quotes.length < 3) {
    return { status: 'UNAVAILABLE', reason: 'insufficient tick history' };
  }

  const priceResponseRatio = computePriceResponseRatio(quotes);
  const activityIntensity = computeActivityIntensity(quotes);

  const flow15s = tradeFlowProxy.windows['15s'];
  const netBuy = (flow15s?.tradeFlowProxy ?? 0) > 0;
  const netSell = (flow15s?.tradeFlowProxy ?? 0) < 0;

  // Ask absorption: strong estimated buying + big activity + weak upward
  // price response + ask depth persists/refills (i.e. NOT strongly withdrawn).
  const askWithdrawalStrong = ['MODERATE', 'STRONG'].includes(
    liquidityWithdrawal?.askLiquidityWithdrawal?.classification
  );
  const bidWithdrawalStrong = ['MODERATE', 'STRONG'].includes(
    liquidityWithdrawal?.bidLiquidityWithdrawal?.classification
  );

  let askAbsorption = { classification: 'NONE', confidence: 'LOW' };
  let bidAbsorption = { classification: 'NONE', confidence: 'LOW' };

  if (netBuy && activityIntensity !== 'LOW' && priceResponseRatio < 0.35 && !askWithdrawalStrong) {
    askAbsorption = {
      classification: strengthFrom(activityIntensity, priceResponseRatio),
      confidence: flow15s.unknownRatio != null && flow15s.unknownRatio < 0.4 ? 'MEDIUM' : 'LOW'
    };
  }

  if (netSell && activityIntensity !== 'LOW' && priceResponseRatio < 0.35 && !bidWithdrawalStrong) {
    bidAbsorption = {
      classification: strengthFrom(activityIntensity, priceResponseRatio),
      confidence: flow15s.unknownRatio != null && flow15s.unknownRatio < 0.4 ? 'MEDIUM' : 'LOW'
    };
  }

  return {
    status: 'PROXY',
    activityIntensity,
    priceResponseRatio: round(priceResponseRatio, 3),
    opposingLiquidityPersistence: {
      askPersists: !askWithdrawalStrong,
      bidPersists: !bidWithdrawalStrong
    },
    refillEvidence: {
      ask: liquidityWithdrawal?.askLiquidityWithdrawal?.persistence === 'INTERMITTENT',
      bid: liquidityWithdrawal?.bidLiquidityWithdrawal?.persistence === 'INTERMITTENT'
    },
    askAbsorptionProxy: askAbsorption,
    bidAbsorptionProxy: bidAbsorption
  };
}

function computePriceResponseRatio(quotes) {
  const prices = quotes.map((q) => q.ltp).filter((p) => p != null);
  if (prices.length < 2) return 1;
  const range = Math.max(...prices) - Math.min(...prices);
  const volumeSum = quotes.reduce((s, q, i) => {
    if (i === 0) return s;
    return s + Math.max((q.volume ?? 0) - (quotes[i - 1].volume ?? 0), 0);
  }, 0);
  if (volumeSum === 0) return 1;
  // Normalize: bigger range per unit volume = higher ratio = price moved freely (no absorption)
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  return Math.min((range / Math.max(avgPrice, 1)) * 5000, 1); // heuristic normalization to 0..1
}

function computeActivityIntensity(quotes) {
  const volumeSum = quotes.reduce((s, q, i) => {
    if (i === 0) return s;
    return s + Math.max((q.volume ?? 0) - (quotes[i - 1].volume ?? 0), 0);
  }, 0);
  const perSecond = volumeSum / Math.max((quotes[quotes.length - 1].timestamp - quotes[0].timestamp) / 1000, 1);
  if (perSecond > 5000) return 'HIGH';
  if (perSecond > 1500) return 'MODERATE';
  if (perSecond > 200) return 'LOW';
  return 'MINIMAL';
}

function strengthFrom(activityIntensity, priceResponseRatio) {
  if (activityIntensity === 'HIGH' && priceResponseRatio < 0.15) return 'STRONG';
  if (activityIntensity !== 'MINIMAL' && priceResponseRatio < 0.25) return 'MODERATE';
  return 'WEAK';
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
