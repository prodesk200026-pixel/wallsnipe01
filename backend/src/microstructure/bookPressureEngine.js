/**
 * ENGINE 4 — BOOK PRESSURE
 * Composite of microprice pressure + depth imbalance + persistence +
 * liquidity withdrawal + spread/price response. Deliberately does
 * NOT produce a trade signal on its own — that's the state machine's
 * job, after the contradiction engine has had a chance to veto.
 */
export function computeBookPressure({ microprice, depthImbalance, liquidityWithdrawal, priceResponse }) {
  if (microprice?.status !== 'EXACT' || depthImbalance?.status !== 'EXACT') {
    return { status: 'UNAVAILABLE', reason: 'requires microprice + depth imbalance' };
  }

  let score = 0;

  // Microprice pressure
  const microScore = { STRONG_BULLISH: 2, BULLISH: 1, NEUTRAL: 0, BEARISH: -1, STRONG_BEARISH: -2 };
  score += microScore[microprice.pressureDirection] ?? 0;

  // Depth imbalance
  const imbScore = { BID_DOMINANT: 1, BALANCED: 0, ASK_DOMINANT: -1 };
  score += imbScore[depthImbalance.classification] ?? 0;
  if (depthImbalance.persistence?.strength === 'STRONG') {
    score += depthImbalance.persistence.dominantSide === 'BID_DOMINANT' ? 1 : depthImbalance.persistence.dominantSide === 'ASK_DOMINANT' ? -1 : 0;
  }

  // Liquidity withdrawal — ask withdrawal is bullish evidence (less resistance above), bid withdrawal bearish
  const askW = liquidityWithdrawal?.askLiquidityWithdrawal;
  const bidW = liquidityWithdrawal?.bidLiquidityWithdrawal;
  if (askW && ['MODERATE', 'STRONG'].includes(askW.classification)) score += askW.classification === 'STRONG' ? 1.5 : 0.75;
  if (bidW && ['MODERATE', 'STRONG'].includes(bidW.classification)) score -= bidW.classification === 'STRONG' ? 1.5 : 0.75;

  // Price response confirmation (optional input, e.g. recent price delta)
  if (typeof priceResponse === 'number') {
    if (priceResponse > 0) score += 0.5;
    else if (priceResponse < 0) score -= 0.5;
  }

  let classification;
  if (score >= 3) classification = 'STRONG_UPWARD_BOOK_PRESSURE';
  else if (score >= 1) classification = 'UPWARD_BOOK_PRESSURE';
  else if (score <= -3) classification = 'STRONG_DOWNWARD_BOOK_PRESSURE';
  else if (score <= -1) classification = 'DOWNWARD_BOOK_PRESSURE';
  else classification = 'BALANCED_BOOK';

  return {
    status: 'DERIVED',
    score: round(score, 2),
    classification
  };
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
