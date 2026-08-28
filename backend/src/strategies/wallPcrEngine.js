/**
 * WALL / PCR STRATEGY ENGINE
 *
 * This is a DELIBERATELY SEPARATE signal path from the 17-engine
 * microstructure chain — not a replacement, not merged into it.
 * It's the classic "OI wall" approach (ported from Wall Sniper):
 *
 *   Resistance (Call Wall) = strike with the highest CALL OI
 *   Support   (Put Wall)   = strike with the highest PUT OI
 *   PCR = total Put OI / total Call OI
 *
 * Verdict logic (same shape Wall Sniper used):
 *   Price at/near the Call Wall + rejection down  -> BUY_PUT
 *   Price at/near the Put Wall  + rejection up     -> BUY_CALL
 *   Price between the walls, no rejection at either -> WAIT
 *
 * Like the microstructure engines, this never claims certainty:
 * OI concentration is a crowd-positioning proxy, not proof of what
 * will happen next, and rejection is read from recent price action
 * only — never fabricated.
 */
const WALL_PROXIMITY_PCT = 0.35; // "at the wall" if within this % of price
const REJECTION_LOOKBACK_TICKS = 6;

export function computeWallPcrSignal(symbolStore, optionChainSnapshot) {
  if (!optionChainSnapshot || !optionChainSnapshot.strikes?.length) {
    return { status: 'UNAVAILABLE', reason: 'no option chain snapshot' };
  }

  const quote = symbolStore.latestQuote();
  if (!quote?.ltp) {
    return { status: 'UNAVAILABLE', reason: 'no underlying price' };
  }
  const spot = quote.ltp;

  let totalCallOI = 0;
  let totalPutOI = 0;
  let resistance = null; // { strike, oi }
  let support = null;

  for (const s of optionChainSnapshot.strikes) {
    const ceOI = s.CE?.oi ?? 0;
    const peOI = s.PE?.oi ?? 0;
    totalCallOI += ceOI;
    totalPutOI += peOI;

    if (s.CE && (!resistance || ceOI > resistance.oi)) resistance = { strike: s.strike, oi: ceOI, leg: s.CE };
    if (s.PE && (!support || peOI > support.oi)) support = { strike: s.strike, oi: peOI, leg: s.PE };
  }

  if (!resistance || !support || totalCallOI === 0) {
    return { status: 'UNAVAILABLE', reason: 'insufficient OI data across chain' };
  }

  const pcr = round(totalPutOI / Math.max(totalCallOI, 1), 3);
  const pcrBias = pcr > 1.2 ? 'BEARISH_TILT' : pcr < 0.8 ? 'BULLISH_TILT' : 'NEUTRAL';

  const distToResistancePct = round((Math.abs(spot - resistance.strike) / spot) * 100, 3);
  const distToSupportPct = round((Math.abs(spot - support.strike) / spot) * 100, 3);

  const atResistance = distToResistancePct <= WALL_PROXIMITY_PCT;
  const atSupport = distToSupportPct <= WALL_PROXIMITY_PCT;

  const rejection = detectRejection(symbolStore);

  const reasoning = [];
  reasoning.push(`PCR ${pcr} (${pcrBias === 'NEUTRAL' ? 'neutral' : pcrBias.replace('_', ' ').toLowerCase()})`);
  reasoning.push(`Resistance / Call Wall: ${resistance.strike}${atResistance ? ' — PRICE IS HERE' : ''}`);
  reasoning.push(`Support / Put Wall: ${support.strike}${atSupport ? ' — PRICE IS HERE' : ''}`);

  let verdict = 'WAIT';
  let confidence = 0;
  let strikeUsed = null;
  let optionType = null;

  if (atResistance && rejection === 'REJECTED_DOWN') {
    verdict = 'BUY_PUT';
    strikeUsed = resistance.strike;
    optionType = 'PE';
    confidence = confidenceScore({ pcrBias, direction: 'BEARISH', wallOI: resistance.oi, totalOI: totalCallOI + totalPutOI });
    reasoning.push('Rejection candle off the CALL WALL (resistance) confirmed');
  } else if (atSupport && rejection === 'REJECTED_UP') {
    verdict = 'BUY_CALL';
    strikeUsed = support.strike;
    optionType = 'CE';
    confidence = confidenceScore({ pcrBias, direction: 'BULLISH', wallOI: support.oi, totalOI: totalCallOI + totalPutOI });
    reasoning.push('Rejection candle off the PUT WALL (support) confirmed');
  } else {
    reasoning.push('Price is between the walls — no trade zone. Wait for it to reach one.');
  }

  const selectedLeg = verdict === 'BUY_PUT' ? resistance.leg : verdict === 'BUY_CALL' ? support.leg : null;

  return {
    status: 'PROXY',
    pcr,
    pcrBias,
    resistance: { strike: resistance.strike, oi: resistance.oi },
    support: { strike: support.strike, oi: support.oi },
    verdict,
    confidence,
    strike: strikeUsed,
    optionType,
    ltp: selectedLeg?.ltp ?? null,
    reasoning,
    exitPlan: verdict !== 'WAIT' && selectedLeg?.ltp ? computeExitPlan(selectedLeg.ltp) : null
  };
}

function detectRejection(symbolStore) {
  const quotes = symbolStore.quotesInWindow('60s').slice(-REJECTION_LOOKBACK_TICKS);
  const prices = quotes.map((q) => q.ltp).filter((p) => p != null);
  if (prices.length < 4) return 'NONE';

  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const last = prices[prices.length - 1];
  const first = prices[0];

  // Rejected down: made a high early, then closed meaningfully below it
  if (high === Math.max(...prices.slice(0, Math.ceil(prices.length / 2))) && last < high - (high - low) * 0.4 && last < first) {
    return 'REJECTED_DOWN';
  }
  // Rejected up: made a low early, then closed meaningfully above it
  if (low === Math.min(...prices.slice(0, Math.ceil(prices.length / 2))) && last > low + (high - low) * 0.4 && last > first) {
    return 'REJECTED_UP';
  }
  return 'NONE';
}

function confidenceScore({ pcrBias, direction, wallOI, totalOI }) {
  let score = 50;
  const pcrAgrees =
    (direction === 'BEARISH' && pcrBias === 'BEARISH_TILT') || (direction === 'BULLISH' && pcrBias === 'BULLISH_TILT');
  if (pcrAgrees) score += 20;
  else if (pcrBias === 'NEUTRAL') score += 5;
  else score -= 10; // PCR actively disagrees with this wall's direction

  const oiConcentration = totalOI > 0 ? wallOI / totalOI : 0;
  score += Math.round(clamp(oiConcentration * 100, 0, 25));

  return Math.round(clamp(score, 0, 100));
}

/**
 * Generic exit plan — SL / target / trailing-stop, the piece the
 * microstructure signal path was missing entirely. Reused by both
 * signal paths (see pipeline.js) so every recommended contract gets
 * the same risk-management numbers regardless of which engine found it.
 */
export function computeExitPlan(entryPremium) {
  if (!entryPremium) return null;
  return {
    entry: round(entryPremium),
    stopLoss: round(entryPremium * 0.65), // -35%, no-questions-asked exit
    target: round(entryPremium * 2), // 2x — book half
    trailFromPeakPct: 30 // once in profit, exit remainder if price falls 30% off its peak
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
