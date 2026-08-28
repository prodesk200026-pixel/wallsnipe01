/**
 * ENGINE 3 — LIQUIDITY WITHDRAWAL
 * Compares successive depth snapshots. This is an observable depth
 * fact (EXACT DEPTH-BASED OBSERVATION) — it never claims *why*
 * liquidity disappeared, only that it did.
 */
export function computeLiquidityWithdrawal(symbolStore) {
  const current = symbolStore.latestDepth();
  const previous = symbolStore.previousDepth();

  if (!current || !previous) {
    return { status: 'UNAVAILABLE', reason: 'need at least two depth snapshots' };
  }

  const askResult = sideWithdrawal(previous.asks, current.asks);
  const bidResult = sideWithdrawal(previous.bids, current.bids);

  const history = symbolStore.depthInWindow('30s');
  const askPersistence = persistenceOfWithdrawal(history, 'asks');
  const bidPersistence = persistenceOfWithdrawal(history, 'bids');

  return {
    status: 'EXACT_DEPTH_OBSERVATION',
    askLiquidityWithdrawal: { ...askResult, persistence: askPersistence },
    bidLiquidityWithdrawal: { ...bidResult, persistence: bidPersistence },
    intervalMs: current.timestamp - previous.timestamp
  };
}

function sideWithdrawal(prevLevels, currLevels) {
  const prevTotal = sumQty(prevLevels);
  const currTotal = sumQty(currLevels);
  const quantityRemoved = Math.max(prevTotal - currTotal, 0);
  const percentRemoved = prevTotal > 0 ? round((quantityRemoved / prevTotal) * 100, 1) : 0;

  let affectedLevels = 0;
  const n = Math.min(prevLevels?.length ?? 0, currLevels?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const before = prevLevels[i]?.quantity ?? 0;
    const after = currLevels[i]?.quantity ?? 0;
    if (before > 0 && after < before * 0.5) affectedLevels++;
  }

  let classification = 'NONE';
  if (percentRemoved >= 60) classification = 'STRONG';
  else if (percentRemoved >= 30) classification = 'MODERATE';
  else if (percentRemoved >= 12) classification = 'WEAK';

  return {
    quantityRemoved,
    percentRemoved,
    removalVelocity: null, // filled at higher level using interval if needed
    affectedLevels,
    classification
  };
}

function persistenceOfWithdrawal(history, side) {
  if (history.length < 3) return 'INSUFFICIENT_DATA';
  let withdrawalCount = 0;
  for (let i = 1; i < history.length; i++) {
    const r = sideWithdrawal(history[i - 1][side], history[i][side]);
    if (r.classification !== 'NONE') withdrawalCount++;
  }
  const ratio = withdrawalCount / (history.length - 1);
  if (ratio >= 0.6) return 'PERSISTENT';
  if (ratio >= 0.3) return 'INTERMITTENT';
  return 'ISOLATED';
}

function sumQty(levels) {
  return (levels || []).reduce((s, l) => s + (l.quantity || 0), 0);
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
