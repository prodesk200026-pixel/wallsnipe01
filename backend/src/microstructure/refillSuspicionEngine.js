/**
 * ENGINE 8 — REFILL SUSPICION
 * Detects repeated visible liquidity returning near the same price
 * level. NEVER states "iceberg confirmed" — only REFILL_SUSPICION or
 * HIDDEN_LIQUIDITY_SUSPICION, both with an attached confidence.
 */
const REPLENISH_THRESHOLD = 3;

export function computeRefillSuspicion(symbolStore) {
  const history = symbolStore.depthInWindow('30s');
  if (history.length < 6) {
    return { status: 'UNAVAILABLE', reason: 'insufficient depth history' };
  }

  const bidCandidates = detectRefill(history, 'bids');
  const askCandidates = detectRefill(history, 'asks');

  const results = [...bidCandidates, ...askCandidates].sort((a, b) => b.replenishmentCount - a.replenishmentCount);

  return {
    status: results.length ? 'SUSPICION_DETECTED' : 'NONE_DETECTED',
    candidates: results.slice(0, 5)
  };
}

function detectRefill(history, side) {
  // Track quantity seen at each rounded price bucket across snapshots.
  const buckets = new Map(); // priceKey -> [{timestamp, quantity, price}]

  for (const snapshot of history) {
    for (const level of snapshot[side] || []) {
      if (!level.price) continue;
      const key = bucketKey(level.price);
      const arr = buckets.get(key) || [];
      arr.push({ timestamp: snapshot.timestamp, quantity: level.quantity, price: level.price });
      buckets.set(key, arr);
    }
  }

  const candidates = [];
  for (const [, series] of buckets.entries()) {
    if (series.length < 4) continue;

    // Count "replenishment events": quantity drops significantly then
    // returns to near its prior level shortly after.
    let replenishCount = 0;
    let executedActivityProxy = 0;
    for (let i = 1; i < series.length - 1; i++) {
      const prev = series[i - 1].quantity;
      const curr = series[i].quantity;
      const next = series[i + 1].quantity;
      if (prev > 0 && curr < prev * 0.4) {
        executedActivityProxy += prev - curr;
        if (next >= prev * 0.7) replenishCount++;
      }
    }

    if (replenishCount >= REPLENISH_THRESHOLD) {
      const strength =
        replenishCount >= REPLENISH_THRESHOLD * 2 ? 'STRONG' : replenishCount >= REPLENISH_THRESHOLD + 1 ? 'MODERATE' : 'WEAK';
      candidates.push({
        side: side === 'bids' ? 'BID' : 'ASK',
        price: series[series.length - 1].price,
        replenishmentCount: replenishCount,
        executedActivityProxy,
        strength,
        confidence: strength === 'STRONG' ? 'MEDIUM' : 'LOW',
        classification: strength === 'STRONG' ? 'HIDDEN_LIQUIDITY_SUSPICION' : 'REFILL_SUSPICION'
      });
    }
  }

  return candidates;
}

// Buckets prices into ~1-tick-equivalent groups so the same resting
// level is tracked across snapshots even with tiny float jitter.
function bucketKey(price) {
  return Math.round(price * 20); // 0.05 tick resolution
}
