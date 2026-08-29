const MIN_TICK = 0.05;

/**
 * ENGINE 1 — MICROPRICE
 * All values EXACT when depth is present (derived directly from L1/LN book).
 */
export function computeMicroprice(depth) {
  if (!depth || !depth.bids?.length || !depth.asks?.length) {
    return { status: 'UNAVAILABLE', reason: 'no depth data' };
  }

  const bestBid = depth.bids[0];
  const bestAsk = depth.asks[0];
  if (!bestBid?.price || !bestAsk?.price) {
    return { status: 'UNAVAILABLE', reason: 'missing best bid/ask' };
  }

  const midPrice = (bestBid.price + bestAsk.price) / 2;
  const microPrice =
    (bestAsk.price * bestBid.quantity + bestBid.price * bestAsk.quantity) /
    Math.max(bestBid.quantity + bestAsk.quantity, 1);

  const microPriceDelta = microPrice - midPrice;
  const spread = bestAsk.price - bestBid.price;
  const fairValuePressure = microPriceDelta / Math.max(spread, MIN_TICK);

  const weighted = weightedMicroprice(depth);

  const { direction, strength } = classifyPressure(fairValuePressure);

  return {
    status: 'EXACT',
    midPrice: round(midPrice),
    microPrice: round(microPrice),
    weightedMicroPrice: weighted !== null ? round(weighted) : null,
    microPriceDelta: round(microPriceDelta),
    spread: round(spread),
    fairValuePressure: round(fairValuePressure, 4),
    pressureDirection: direction,
    pressureStrength: strength
  };
}

function weightedMicroprice(depth, levels = Math.min(depth.bids.length, depth.asks.length, 10)) {
  if (levels === 0) return null;
  let num = 0;
  let den = 0;
  for (let i = 0; i < levels; i++) {
    const bid = depth.bids[i];
    const ask = depth.asks[i];
    if (!bid || !ask) break;
    const distanceWeight = 1 / (i + 1); // nearer levels weigh more
    const bidWeight = bid.quantity * distanceWeight;
    const askWeight = ask.quantity * distanceWeight;
    num += ask.price * bidWeight + bid.price * askWeight;
    den += bidWeight + askWeight;
  }
  return den > 0 ? num / den : null;
}

function classifyPressure(fairValuePressure) {
  const abs = Math.abs(fairValuePressure);
  let strength;
  if (abs >= 0.6) strength = 'STRONG';
  else if (abs >= 0.25) strength = 'MODERATE';
  else if (abs >= 0.08) strength = 'WEAK';
  else strength = 'NEGLIGIBLE';

  let direction;
  if (strength === 'NEGLIGIBLE') direction = 'NEUTRAL';
  else if (fairValuePressure > 0) direction = strength === 'STRONG' ? 'STRONG_BULLISH' : 'BULLISH';
  else direction = strength === 'STRONG' ? 'STRONG_BEARISH' : 'BEARISH';

  return { direction, strength };
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
