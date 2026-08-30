/**
 * ENGINE 16 — CONTRADICTION ENGINE
 * Actively searches for evidence that conflicts with a candidate
 * direction. MAJOR contradictions block a new signal; MODERATE
 * reduces confidence; MINOR is informational only. Every
 * contradiction found must be visible in the frontend.
 */
export function computeContradictions({
  candidateDirection, // 'BULLISH' | 'BEARISH' | null
  microprice,
  depthImbalance,
  absorptionProxy,
  priceAcceptance,
  optionsPositioning,
  tradeFlowProxy
}) {
  if (!candidateDirection) {
    return { status: 'NO_CANDIDATE', overall: 'NONE', items: [] };
  }

  const items = [];
  const isBullish = candidateDirection === 'BULLISH';

  // microprice vs candidate
  if (microprice?.status === 'EXACT') {
    const opposingStrong = isBullish
      ? microprice.pressureDirection === 'STRONG_BEARISH'
      : microprice.pressureDirection === 'STRONG_BULLISH';
    if (opposingStrong) {
      items.push({
        severity: 'MAJOR',
        description: `${candidateDirection} candidate but microprice shows ${microprice.pressureDirection}`
      });
    }
  }

  // depth imbalance vs candidate
  if (depthImbalance?.status === 'EXACT') {
    const opposing = isBullish
      ? depthImbalance.classification === 'ASK_DOMINANT'
      : depthImbalance.classification === 'BID_DOMINANT';
    if (opposing && depthImbalance.persistence?.strength === 'STRONG') {
      items.push({
        severity: 'MODERATE',
        description: `${candidateDirection} candidate but persistent ${depthImbalance.classification} depth imbalance`
      });
    }
  }

  // opposing absorption
  const opposingAbsorption = isBullish
    ? absorptionProxy?.askAbsorptionProxy?.classification
    : absorptionProxy?.bidAbsorptionProxy?.classification;
  if (['MODERATE', 'STRONG'].includes(opposingAbsorption)) {
    items.push({
      severity: opposingAbsorption === 'STRONG' ? 'MAJOR' : 'MODERATE',
      description: `${candidateDirection} candidate but ${opposingAbsorption.toLowerCase()} opposing-side absorption proxy detected`
    });
  }

  // failed acceptance
  if (isBullish && priceAcceptance?.classification === 'FAILED_BREAKOUT') {
    items.push({ severity: 'MAJOR', description: 'Bullish candidate but breakout already failed acceptance' });
  }
  if (!isBullish && priceAcceptance?.classification === 'FAILED_BREAKDOWN') {
    items.push({ severity: 'MAJOR', description: 'Bearish candidate but breakdown already failed acceptance' });
  }

  // options conflict
  if (optionsPositioning?.classification === 'CONFLICTING_OPTION_CONTEXT') {
    items.push({ severity: 'MODERATE', description: 'Options positioning context conflicts with underlying candidate' });
  }

  // trade flow proxy directly opposing
  const opposingFlow = isBullish
    ? tradeFlowProxy?.tradeFlowState === 'ESTIMATED_SELL_PRESSURE'
    : tradeFlowProxy?.tradeFlowState === 'ESTIMATED_BUY_PRESSURE';
  if (opposingFlow && tradeFlowProxy?.confidence === 'HIGH') {
    items.push({
      severity: 'MODERATE',
      description: `${candidateDirection} candidate but high-confidence opposing trade flow proxy`
    });
  }

  const overall = items.some((i) => i.severity === 'MAJOR')
    ? 'MAJOR'
    : items.some((i) => i.severity === 'MODERATE')
      ? 'MODERATE'
      : items.length
        ? 'MINOR'
        : 'NONE';

  return { status: 'EVALUATED', overall, items };
}
