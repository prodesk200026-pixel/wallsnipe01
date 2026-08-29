/**
 * ENGINE 13 — OPTION CONTRACT SELECTOR
 * Ranks CE contracts on a bullish signal, PE on bearish. Purely
 * informational — this never places or prepares an order, it only
 * surfaces which contract a human might look at next.
 */
export function selectOptionContract(optionChainSnapshot, direction) {
  if (!optionChainSnapshot || !optionChainSnapshot.strikes?.length) {
    return { status: 'UNAVAILABLE', reason: 'no option chain snapshot' };
  }
  if (direction !== 'BULLISH' && direction !== 'BEARISH') {
    return { status: 'UNAVAILABLE', reason: 'no directional signal to rank contracts against' };
  }

  const legType = direction === 'BULLISH' ? 'CE' : 'PE';
  const spot = optionChainSnapshot.spot;

  const candidates = optionChainSnapshot.strikes
    .map((s) => ({ strike: s.strike, leg: s[legType] }))
    .filter((c) => c.leg && c.leg.ltp != null)
    .map((c) => scoreContract(c, spot));

  candidates.sort((a, b) => b.confirmationScore - a.confirmationScore);

  const top3 = candidates.slice(0, 3).map((c, i) => ({ rank: i + 1, ...c }));

  return {
    status: 'INFORMATIONAL_ONLY',
    legType,
    topContracts: top3,
    recommendedContract: top3[0] || null
  };
}

function scoreContract(c, spot) {
  const { strike, leg } = c;
  const atmDistance = Math.abs(strike - spot);
  const spread = leg.ask != null && leg.bid != null ? leg.ask - leg.bid : null;
  const spreadRatio = spread != null && leg.ltp ? spread / leg.ltp : 1;
  const liquidity = (leg.bidQty ?? 0) + (leg.askQty ?? 0);

  const liquidityScore = clamp(liquidity / 5000, 0, 1);
  const spreadScore = clamp(1 - spreadRatio * 10, 0, 1);
  const proximityScore = clamp(1 - atmDistance / (spot * 0.02), 0, 1);
  const oiActivityScore = leg.oi ? clamp((leg.volume ?? 0) / Math.max(leg.oi, 1), 0, 1) : 0;

  const liquidityCompositeScore = round((liquidityScore + spreadScore) / 2, 3);
  const confirmationScore = round(
    liquidityScore * 0.35 + spreadScore * 0.25 + proximityScore * 0.25 + oiActivityScore * 0.15,
    3
  );

  return {
    strike,
    ltp: leg.ltp,
    bid: leg.bid,
    ask: leg.ask,
    spread: spread != null ? round(spread) : null,
    volume: leg.volume ?? null,
    oi: leg.oi ?? null,
    iv: leg.iv ?? null,
    premiumVelocity: null, // requires prior snapshot comparison at call site
    liquidityScore: liquidityCompositeScore,
    confirmationScore
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
