const EPSILON = 1e-6;

/**
 * ENGINE 2 — DEPTH IMBALANCE
 * Computed at L1/L3/L5 always; L10/L20/L50/L100/L200 when the
 * connected provider's depth actually supports that many levels.
 */
export function computeDepthImbalance(symbolStore) {
  const depth = symbolStore.latestDepth();
  if (!depth || !depth.bids?.length || !depth.asks?.length) {
    return { status: 'UNAVAILABLE', reason: 'no depth data' };
  }

  const levelsToTry = [1, 3, 5, 10, 20, 50, 100, 200];
  const byLevel = {};
  for (const L of levelsToTry) {
    if (depth.levelsAvailable < L && L > depth.levelsAvailable) continue;
    const usable = Math.min(L, depth.bids.length, depth.asks.length);
    if (usable === 0) continue;
    byLevel[`L${L}`] = imbalanceAtDepth(depth, usable);
  }

  const primary = byLevel.L5 || byLevel.L3 || byLevel.L1;

  const history = symbolStore.depthInWindow('60s');
  const velocity = computeVelocity(history);
  const persistence = computePersistence(history);

  return {
    status: 'EXACT',
    byLevel,
    current: primary?.imbalance ?? null,
    classification: primary?.classification ?? 'BALANCED',
    change5s: velocity['5s'],
    change15s: velocity['15s'],
    change60s: velocity['60s'],
    imbalanceVelocity: velocity.instantaneous,
    persistence
  };
}

function imbalanceAtDepth(depth, levels) {
  let bidQty = 0;
  let askQty = 0;
  for (let i = 0; i < levels; i++) {
    bidQty += depth.bids[i]?.quantity ?? 0;
    askQty += depth.asks[i]?.quantity ?? 0;
  }
  const imbalance = (bidQty - askQty) / Math.max(bidQty + askQty, EPSILON);
  return {
    bidQty,
    askQty,
    imbalance: round(imbalance, 4),
    classification: classify(imbalance)
  };
}

function classify(imbalance) {
  if (imbalance > 0.15) return 'BID_DOMINANT';
  if (imbalance < -0.15) return 'ASK_DOMINANT';
  return 'BALANCED';
}

function computeVelocity(history) {
  if (history.length < 2) return { '5s': null, '15s': null, '60s': null, instantaneous: null };
  const now = Date.now();
  const withImbalance = history.map((d) => ({
    timestamp: d.timestamp,
    imbalance: imbalanceAtDepth(d, Math.min(5, d.bids.length, d.asks.length)).imbalance
  }));

  const findClosestBefore = (ms) => {
    const target = now - ms;
    let best = null;
    for (const h of withImbalance) {
      if (h.timestamp <= target) best = h;
    }
    return best;
  };

  const latest = withImbalance[withImbalance.length - 1];
  const prev = withImbalance[withImbalance.length - 2];

  const at5s = findClosestBefore(5000);
  const at15s = findClosestBefore(15000);
  const at60s = findClosestBefore(60000);

  return {
    '5s': at5s ? round(latest.imbalance - at5s.imbalance, 4) : null,
    '15s': at15s ? round(latest.imbalance - at15s.imbalance, 4) : null,
    '60s': at60s ? round(latest.imbalance - at60s.imbalance, 4) : null,
    instantaneous: prev ? round(latest.imbalance - prev.imbalance, 4) : null
  };
}

function computePersistence(history) {
  if (history.length < 3) return { strength: 'INSUFFICIENT_DATA', consistentDirectionRatio: null };
  const classifications = history.map((d) =>
    classify(imbalanceAtDepth(d, Math.min(5, d.bids.length, d.asks.length)).imbalance)
  );
  const last = classifications[classifications.length - 1];
  if (last === 'BALANCED') return { strength: 'NONE', consistentDirectionRatio: 0, dominantSide: 'BALANCED' };

  const matching = classifications.filter((c) => c === last).length;
  const ratio = matching / classifications.length;

  let strength;
  if (ratio >= 0.8) strength = 'STRONG';
  else if (ratio >= 0.55) strength = 'MODERATE';
  else strength = 'WEAK';

  return { strength, consistentDirectionRatio: round(ratio, 2), dominantSide: last };
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
