/**
 * ENGINE — MAX PAIN
 *
 * The strike at which total option-writer payout (across every CE +
 * PE in the chain) is minimized — the price level option sellers
 * collectively benefit from most at expiry. Price often gravitates
 * toward this level as expiry approaches (not guaranteed, but a
 * real, widely-watched effect). No broker API computes this for
 * you — it's a derived calculation over the whole chain's OI.
 */
export function computeMaxPain(chainSnapshot) {
  if (!chainSnapshot?.strikes?.length) return null;

  const strikes = chainSnapshot.strikes.map((s) => s.strike);
  let minPain = Infinity;
  let maxPainStrike = null;
  const painByStrike = [];

  for (const candidateExpiryPrice of strikes) {
    let totalPain = 0;
    for (const row of chainSnapshot.strikes) {
      if (row.CE?.oi) {
        totalPain += Math.max(0, candidateExpiryPrice - row.strike) * row.CE.oi;
      }
      if (row.PE?.oi) {
        totalPain += Math.max(0, row.strike - candidateExpiryPrice) * row.PE.oi;
      }
    }
    painByStrike.push({ strike: candidateExpiryPrice, totalPain: Math.round(totalPain) });
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = candidateExpiryPrice;
    }
  }

  const spot = chainSnapshot.spot;
  const distanceFromSpot = spot != null && maxPainStrike != null ? maxPainStrike - spot : null;

  return {
    maxPainStrike,
    distanceFromSpot: distanceFromSpot != null ? Math.round(distanceFromSpot) : null,
    // Whichever side price would need to move for max pain to "win" —
    // informational framing only, not a directional call by itself.
    pullDirection: distanceFromSpot == null ? null : distanceFromSpot > 0 ? 'UP_TOWARD_MAX_PAIN' : distanceFromSpot < 0 ? 'DOWN_TOWARD_MAX_PAIN' : 'AT_MAX_PAIN',
    painByStrike
  };
}
