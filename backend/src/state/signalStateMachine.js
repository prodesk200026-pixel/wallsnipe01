/**
 * ENGINE 17 — SIGNAL STATE MACHINE + SIGNAL OUTPUT
 *
 * States:
 *   NO_SIGNAL     — no directional candidate currently qualifies
 *   WATCHING      — a candidate direction exists but hasn't confirmed
 *                   for enough consecutive evaluations yet
 *   SIGNAL_ACTIVE — confirmed signal, currently live
 *   INVALIDATED   — was active, contradiction/regime flip ended it
 *                   (shown for one cycle, then returns to NO_SIGNAL)
 *
 * This machine NEVER outputs an instruction to place an order. Its
 * output is informational: direction, grade, confidence, and the
 * evidence/contradictions a human should weigh before acting manually.
 *
 * Confirmation requires CONFIRM_STREAK consecutive evaluations
 * agreeing on direction with no MAJOR contradiction — this prevents
 * a single noisy tick from flipping the signal state.
 */
const CONFIRM_STREAK = 3;

export function runSignalStateMachine(symbolStore, engineOutputs) {
  const {
    dataQuality,
    bookPressure,
    marketRegime,
    contradictions,
    microprice,
    depthImbalance,
    optionsPositioning,
    optionContractSelector,
    premiumConfirmation
  } = engineOutputs;

  const sm = symbolStore.signalState;

  // STALE data can never generate or sustain a NEW signal — an
  // already-active signal is preserved but marked stale-affected.
  if (!dataQuality?.gates?.canGenerateNewSignal) {
    if (sm.state === 'SIGNAL_ACTIVE') {
      return buildOutput(symbolStore, { ...sm, staleWarning: true }, engineOutputs, 'ACTIVE_UNDER_STALE_DATA');
    }
    resetState(sm);
    return buildOutput(symbolStore, sm, engineOutputs, 'NO_SIGNAL_STALE_DATA');
  }

  const candidateDirection = deriveCandidateDirection(bookPressure, marketRegime);

  if (!candidateDirection) {
    resetState(sm);
    return buildOutput(symbolStore, sm, engineOutputs, 'NO_CANDIDATE_DIRECTION');
  }

  const contradictionResult = contradictions;
  if (contradictionResult?.overall === 'MAJOR') {
    if (sm.state === 'SIGNAL_ACTIVE') {
      sm.state = 'INVALIDATED';
      sm.enteredAt = Date.now();
      return buildOutput(symbolStore, sm, engineOutputs, 'INVALIDATED_BY_MAJOR_CONTRADICTION');
    }
    resetState(sm);
    return buildOutput(symbolStore, sm, engineOutputs, 'BLOCKED_BY_MAJOR_CONTRADICTION');
  }

  if (sm.state === 'INVALIDATED') {
    // one-cycle cooldown, then fall through to normal evaluation
    resetState(sm);
  }

  if (sm.direction === candidateDirection) {
    sm.consecutiveConfirmations = (sm.consecutiveConfirmations || 0) + 1;
  } else {
    sm.direction = candidateDirection;
    sm.consecutiveConfirmations = 1;
  }

  if (sm.consecutiveConfirmations >= CONFIRM_STREAK) {
    if (sm.state !== 'SIGNAL_ACTIVE') {
      sm.state = 'SIGNAL_ACTIVE';
      sm.enteredAt = Date.now();
      sm.signalId = `SIG-${symbolStore.symbol}-${sm.enteredAt}`;
    }
    sm.grade = computeGrade(dataQuality, contradictionResult, engineOutputs);
    return buildOutput(symbolStore, sm, engineOutputs, 'ACTIVE');
  }

  sm.state = 'WATCHING';
  return buildOutput(symbolStore, sm, engineOutputs, 'ACCUMULATING_CONFIRMATION');
}

function deriveCandidateDirection(bookPressure, marketRegime) {
  if (bookPressure?.status !== 'DERIVED') return null;

  const bullishRegimes = ['UPWARD_PRESSURE', 'BREAKOUT_UP'];
  const bearishRegimes = ['DOWNWARD_PRESSURE', 'BREAKOUT_DOWN'];
  const blockingRegimes = ['HIGH_RISK', 'COMPRESSION', 'EXHAUSTION_UP', 'EXHAUSTION_DOWN', 'ROTATION'];

  if (marketRegime?.status === 'DERIVED' && blockingRegimes.includes(marketRegime.regime)) {
    return null;
  }

  const bookBullish = ['UPWARD_BOOK_PRESSURE', 'STRONG_UPWARD_BOOK_PRESSURE'].includes(bookPressure.classification);
  const bookBearish = ['DOWNWARD_BOOK_PRESSURE', 'STRONG_DOWNWARD_BOOK_PRESSURE'].includes(bookPressure.classification);

  if (bookBullish && (!marketRegime || marketRegime.status !== 'DERIVED' || bullishRegimes.includes(marketRegime.regime) || marketRegime.regime === 'BALANCED')) {
    return 'BULLISH';
  }
  if (bookBearish && (!marketRegime || marketRegime.status !== 'DERIVED' || bearishRegimes.includes(marketRegime.regime) || marketRegime.regime === 'BALANCED')) {
    return 'BEARISH';
  }
  return null;
}

function computeGrade(dataQuality, contradictions, { optionsPositioning, premiumConfirmation }) {
  const maxGrade = dataQuality.gates.maxSignalGrade; // ceiling from data quality
  let grade = maxGrade;

  if (contradictions?.overall === 'MODERATE') grade = downgrade(grade);
  if (optionsPositioning?.status === 'PROXY' && optionsPositioning.classification === 'CONFLICTING_OPTION_CONTEXT') {
    grade = downgrade(grade);
  }
  if (premiumConfirmation?.status === 'OPTIONS_CONFIRMATION_CONFLICT') grade = downgrade(grade);

  return grade;
}

function downgrade(grade) {
  const order = ['A+', 'A', 'B', 'C_ONLY_NO_A_GRADE', 'NONE'];
  const idx = order.indexOf(grade);
  if (idx === -1 || idx >= order.length - 1) return grade;
  // downgrading from A+/A steps into B; anything already at B or below stays.
  if (grade === 'A+') return 'A';
  if (grade === 'A') return 'B';
  return grade;
}

function resetState(sm) {
  sm.state = 'NO_SIGNAL';
  sm.direction = null;
  sm.grade = null;
  sm.enteredAt = null;
  sm.consecutiveConfirmations = 0;
}

function buildOutput(symbolStore, sm, engineOutputs, reason) {
  const { optionContractSelector, premiumConfirmation, contradictions } = engineOutputs;

  const output = {
    status: sm.state,
    signalId: sm.state === 'SIGNAL_ACTIVE' ? sm.signalId : null,
    reason,
    direction: sm.direction,
    grade: sm.grade,
    enteredAt: sm.enteredAt,
    confirmationsAccumulated: sm.consecutiveConfirmations,
    confirmationsRequired: CONFIRM_STREAK,
    contradictions: contradictions?.items ?? [],
    evidence: buildEvidenceStrings(engineOutputs),
    recommendedContract:
      sm.state === 'SIGNAL_ACTIVE' && optionContractSelector?.status === 'INFORMATIONAL_ONLY'
        ? optionContractSelector.recommendedContract
        : null,
    optionsConfirmation: sm.state === 'SIGNAL_ACTIVE' ? premiumConfirmation?.status ?? 'UNAVAILABLE' : null,
    executionNote: 'INFORMATIONAL ONLY — no order is placed automatically. Review and execute manually.'
  };

  if (sm.state === 'SIGNAL_ACTIVE') {
    symbolStore.pushSignal(output);
  }

  return output;
}

// Human-readable evidence strings for the "WHY THIS SIGNAL" panel —
// mirrors the reason[] array pattern from the reference signal output.
function buildEvidenceStrings(engineOutputs) {
  const { bookPressure, marketRegime } = engineOutputs;
  const lines = [];
  if (bookPressure?.status === 'DERIVED') {
    lines.push(`Book pressure: ${bookPressure.classification.replaceAll('_', ' ')}`);
  }
  if (marketRegime?.status === 'DERIVED') {
    lines.push(`Market regime: ${marketRegime.regime.replaceAll('_', ' ')}`);
  }
  return lines;
}
