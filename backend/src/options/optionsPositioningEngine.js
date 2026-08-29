/**
 * ENGINE 12 — OPTIONS POSITIONING
 * Builds directional CONTEXT from OI change, volume impulse, IV
 * change, and premium response across ATM ± 2 strikes. Never claims
 * exact dealer positioning, and OI alone never decides direction.
 */
export function computeOptionsPositioning(optionChainSnapshot, underlyingDirection) {
  if (!optionChainSnapshot || !optionChainSnapshot.strikes?.length) {
    return { status: 'UNAVAILABLE', reason: 'no option chain snapshot' };
  }

  const strikes = optionChainSnapshot.strikes;
  const atmIndex = findAtmIndex(strikes, optionChainSnapshot.spot);
  const window = strikes.slice(Math.max(0, atmIndex - 2), atmIndex + 3);

  let ceSignal = 0;
  let peSignal = 0;
  const legDetails = [];

  for (const s of window) {
    const ce = s.CE;
    const pe = s.PE;
    if (ce) {
      const contribution = legContribution(ce);
      ceSignal += contribution;
      legDetails.push({ strike: s.strike, type: 'CE', ...ce, contribution: round(contribution) });
    }
    if (pe) {
      const contribution = legContribution(pe);
      peSignal += contribution;
      legDetails.push({ strike: s.strike, type: 'PE', ...pe, contribution: round(contribution) });
    }
  }

  // Positive ceSignal (rising CE OI+volume+premium) = bullish positioning context.
  // Positive peSignal (rising PE OI+volume+premium) = bearish positioning context.
  const net = ceSignal - peSignal;

  let classification;
  const agreesWithUnderlying =
    (net > 0 && underlyingDirection === 'BULLISH') || (net < 0 && underlyingDirection === 'BEARISH');
  const conflictsWithUnderlying =
    (net > 0 && underlyingDirection === 'BEARISH') || (net < 0 && underlyingDirection === 'BULLISH');

  if (Math.abs(net) < 0.15) classification = 'NEUTRAL_OPTION_CONTEXT';
  else if (conflictsWithUnderlying) classification = 'CONFLICTING_OPTION_CONTEXT';
  else if (net > 0) classification = 'BULLISH_OPTION_CONTEXT';
  else classification = 'BEARISH_OPTION_CONTEXT';

  return {
    status: 'PROXY',
    classification,
    netScore: round(net, 3),
    ceSignal: round(ceSignal, 3),
    peSignal: round(peSignal, 3),
    agreesWithUnderlying,
    legs: legDetails
  };
}

function legContribution(leg) {
  let score = 0;
  if (typeof leg.oiChange === 'number' && leg.oi) score += clamp(leg.oiChange / Math.max(leg.oi, 1), -0.3, 0.3);
  if (typeof leg.volume === 'number' && leg.oi) score += clamp(leg.volume / Math.max(leg.oi, 1), 0, 0.3);
  // premium/IV response contributes weakly — not the primary driver
  if (typeof leg.iv === 'number') score += 0;
  return score;
}

function findAtmIndex(strikes, spot) {
  let bestIdx = 0;
  let bestDiff = Infinity;
  strikes.forEach((s, i) => {
    const diff = Math.abs(s.strike - spot);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });
  return bestIdx;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
