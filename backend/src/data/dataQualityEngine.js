/**
 * Data Quality Engine
 *
 * Every engine and every signal is gated by this score. Nothing
 * downstream is allowed to present estimated/proxy data as exact,
 * and nothing may generate a fresh signal on stale or poor data.
 */

const FRESHNESS_STALE_MS = 5000;
const FRESHNESS_POOR_MS = 2000;

export function assessDataQuality(symbolStore, { requiredDepthLevels = 5, requireOptions = false } = {}) {
  const quote = symbolStore.latestQuote();
  const depth = symbolStore.latestDepth();
  const now = Date.now();

  let score = 100;
  const factors = {};

  // Provider connection / freshness
  const age = quote ? now - quote.timestamp : Infinity;
  factors.messageFreshnessMs = Number.isFinite(age) ? age : null;
  if (age > FRESHNESS_STALE_MS) {
    score -= 60;
  } else if (age > FRESHNESS_POOR_MS) {
    score -= 25;
  }

  // Depth availability
  const levelsAvailable = depth?.levelsAvailable ?? 0;
  factors.depthLevelsAvailable = levelsAvailable;
  if (levelsAvailable === 0) {
    score -= 25;
  } else if (levelsAvailable < requiredDepthLevels) {
    score -= 15;
  }

  // Timestamp continuity (gap detection on the quote stream)
  const recent = symbolStore.quotesInWindow('15s');
  let maxGap = 0;
  for (let i = 1; i < recent.length; i++) {
    maxGap = Math.max(maxGap, recent[i].timestamp - recent[i - 1].timestamp);
  }
  factors.maxGapMs = maxGap;
  if (maxGap > 3000) score -= 10;

  // Missing fields
  const missingFields = [];
  if (quote) {
    for (const f of ['ltp', 'volume']) {
      if (quote[f] === null || quote[f] === undefined) missingFields.push(f);
    }
  } else {
    missingFields.push('quote');
  }
  factors.missingFields = missingFields;
  score -= missingFields.length * 5;

  // Options data, if required by the caller (e.g. contract selector)
  if (requireOptions) {
    const opt = symbolStore.optionSnapshots.last();
    factors.optionDataAvailable = Boolean(opt);
    if (!opt) score -= 20;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let classification;
  if (age > FRESHNESS_STALE_MS) classification = 'STALE';
  else if (score >= 85) classification = 'EXCELLENT';
  else if (score >= 65) classification = 'GOOD';
  else if (score >= 40) classification = 'LIMITED';
  else classification = 'POOR';

  return {
    overallDataQuality: score,
    classification,
    factors,
    gates: {
      canGenerateNewSignal: classification !== 'STALE',
      maxSignalGrade: gradeForClassification(classification),
      depthEvidenceEnabled: levelsAvailable > 0,
      optionConfirmationAvailable: requireOptions ? Boolean(symbolStore.optionSnapshots.last()) : null
    }
  };
}

function gradeForClassification(classification) {
  switch (classification) {
    case 'EXCELLENT':
      return 'A+';
    case 'GOOD':
      return 'A';
    case 'LIMITED':
      return 'B';
    case 'POOR':
      return 'C_ONLY_NO_A_GRADE';
    case 'STALE':
    default:
      return 'NONE';
  }
}
