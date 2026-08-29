/**
 * ENGINE 14 — OPTION PREMIUM CONFIRMATION
 * Checks whether the selected contract's premium behavior confirms
 * the underlying setup. A non-confirming premium never auto-
 * invalidates the underlying signal — it only downgrades confidence
 * via OPTIONS_CONFIRMATION_WEAK / OPTIONS_CONFIRMATION_CONFLICT.
 */
export function computePremiumConfirmation(symbolStore, recommendedContract, direction) {
  if (!recommendedContract) {
    return { status: 'UNAVAILABLE', reason: 'no recommended contract to confirm' };
  }

  const history = symbolStore.optionSnapshots.toArray();
  const priorLegs = history
    .map((snap) => snap.strikes?.find((s) => s.strike === recommendedContract.strike))
    .filter(Boolean);

  const priorLtp = priorLegs.length >= 2 ? priorLegs[priorLegs.length - 2]?.[legTypeFromDirection(direction)]?.ltp : null;
  const currentLtp = recommendedContract.ltp;

  if (priorLtp == null || currentLtp == null) {
    return { status: 'UNAVAILABLE', reason: 'insufficient premium history for velocity check' };
  }

  const premiumVelocity = currentLtp - priorLtp;
  const spreadOk = recommendedContract.spread != null ? recommendedContract.spread / Math.max(currentLtp, 1) < 0.05 : null;
  const liquidityOk = recommendedContract.liquidityScore != null ? recommendedContract.liquidityScore > 0.4 : null;

  const confirms = premiumVelocity > 0 && spreadOk !== false && liquidityOk !== false;
  const conflicts = premiumVelocity < 0 && (spreadOk === false || liquidityOk === false || premiumVelocity < -currentLtp * 0.03);

  let status;
  if (confirms) status = 'OPTIONS_CONFIRMATION_STRONG';
  else if (conflicts) status = 'OPTIONS_CONFIRMATION_CONFLICT';
  else status = 'OPTIONS_CONFIRMATION_WEAK';

  return {
    status,
    premiumVelocity: round(premiumVelocity),
    spreadOk,
    liquidityOk,
    invalidatesUnderlyingSignal: false // per spec: never automatically invalidate
  };
}

function legTypeFromDirection(direction) {
  return direction === 'BULLISH' ? 'CE' : 'PE';
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
