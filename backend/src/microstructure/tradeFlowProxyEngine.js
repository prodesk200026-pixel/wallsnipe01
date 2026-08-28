/**
 * ENGINE 5 — TRADE FLOW PROXY
 * Estimated buy/sell pressure inferred from LTP/LTQ/volume/quote
 * context. This is NEVER labeled true order flow — providers here
 * don't expose exchange-level aggressor identity.
 */
export function computeTradeFlowProxy(symbolStore) {
  const quotes = symbolStore.quotesInWindow('60s');
  if (quotes.length < 2) {
    return { status: 'UNAVAILABLE', reason: 'insufficient tick history' };
  }

  const classified = [];
  for (let i = 1; i < quotes.length; i++) {
    classified.push(classifyTick(quotes[i - 1], quotes[i], symbolStore.latestDepth()));
  }

  const windows = { '5s': 5000, '15s': 15000, '60s': 60000 };
  const result = {};
  const now = Date.now();

  for (const [label, ms] of Object.entries(windows)) {
    const inWindow = classified.filter((c) => now - c.timestamp <= ms);
    let buy = 0;
    let sell = 0;
    let unknown = 0;
    for (const c of inWindow) {
      if (c.side === 'ESTIMATED_BUY_PRESSURE') buy += c.volumeDelta;
      else if (c.side === 'ESTIMATED_SELL_PRESSURE') sell += c.volumeDelta;
      else unknown += c.volumeDelta;
    }
    const total = buy + sell + unknown;
    result[label] = {
      buyProxyVolume: buy,
      sellProxyVolume: sell,
      unknownProxyVolume: unknown,
      tradeFlowProxy: buy - sell,
      unknownRatio: total > 0 ? round(unknown / total, 3) : null
    };
  }

  const latest = classified[classified.length - 1];

  return {
    status: 'ESTIMATED',
    tradeFlowState: latest?.side ?? 'UNKNOWN',
    confidence: latest?.confidence ?? 'LOW',
    windows: result
  };
}

function classifyTick(prevQuote, currQuote, depth) {
  const volumeDelta = Math.max((currQuote.volume ?? 0) - (prevQuote.volume ?? 0), 0);
  const priceDelta = (currQuote.ltp ?? 0) - (prevQuote.ltp ?? 0);

  let side = 'UNKNOWN';
  let confidence = 'LOW';

  if (volumeDelta === 0) {
    return { timestamp: currQuote.timestamp, side: 'UNKNOWN', confidence: 'LOW', volumeDelta: 0 };
  }

  const bestAsk = depth?.asks?.[0]?.price;
  const bestBid = depth?.bids?.[0]?.price;

  if (bestAsk != null && currQuote.ltp >= bestAsk) {
    side = 'ESTIMATED_BUY_PRESSURE';
    confidence = 'HIGH'; // traded through/at ask
  } else if (bestBid != null && currQuote.ltp <= bestBid) {
    side = 'ESTIMATED_SELL_PRESSURE';
    confidence = 'HIGH'; // traded through/at bid
  } else if (priceDelta > 0) {
    side = 'ESTIMATED_BUY_PRESSURE';
    confidence = 'MEDIUM';
  } else if (priceDelta < 0) {
    side = 'ESTIMATED_SELL_PRESSURE';
    confidence = 'MEDIUM';
  } else {
    side = 'UNKNOWN';
    confidence = 'LOW';
  }

  return { timestamp: currQuote.timestamp, side, confidence, volumeDelta };
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
