/**
 * ENGINE 11 — PRICE ACCEPTANCE
 * Detects genuine acceptance of a new range vs a failed breakout/
 * breakdown that snapped back inside the prior range.
 */
const MIN_ACCEPTANCE_EVENTS = 6; // minimum tick count to call acceptance genuine

export function computePriceAcceptance(symbolStore, { bookPressure } = {}) {
  const quotes = symbolStore.quotesInWindow('60s');
  if (quotes.length < MIN_ACCEPTANCE_EVENTS + 2) {
    return { status: 'UNAVAILABLE', reason: 'insufficient tick history' };
  }

  const prices = quotes.map((q) => q.ltp).filter((p) => p != null);
  if (prices.length < MIN_ACCEPTANCE_EVENTS + 2) {
    return { status: 'UNAVAILABLE', reason: 'insufficient price data' };
  }

  // Reference range = first half of the window; test range = second half.
  const mid = Math.floor(prices.length / 2);
  const referenceRange = { high: Math.max(...prices.slice(0, mid)), low: Math.min(...prices.slice(0, mid)) };
  const testSlice = prices.slice(mid);
  const latest = prices[prices.length - 1];

  const brokeAbove = testSlice.some((p) => p > referenceRange.high);
  const brokeBelow = testSlice.some((p) => p < referenceRange.low);

  const remainsAbove = testSlice.filter((p) => p > referenceRange.high).length;
  const remainsBelow = testSlice.filter((p) => p < referenceRange.low).length;

  const bearishBookNow = ['DOWNWARD_BOOK_PRESSURE', 'STRONG_DOWNWARD_BOOK_PRESSURE'].includes(bookPressure?.classification);
  const bullishBookNow = ['UPWARD_BOOK_PRESSURE', 'STRONG_UPWARD_BOOK_PRESSURE'].includes(bookPressure?.classification);

  let classification = 'NO_ACCEPTANCE';

  if (brokeAbove && remainsAbove >= MIN_ACCEPTANCE_EVENTS && latest > referenceRange.high && !bearishBookNow) {
    classification = 'UPWARD_ACCEPTANCE';
  } else if (brokeBelow && remainsBelow >= MIN_ACCEPTANCE_EVENTS && latest < referenceRange.low && !bullishBookNow) {
    classification = 'DOWNWARD_ACCEPTANCE';
  } else if (brokeAbove && latest <= referenceRange.high && bearishBookNow) {
    classification = 'FAILED_BREAKOUT';
  } else if (brokeBelow && latest >= referenceRange.low && bullishBookNow) {
    classification = 'FAILED_BREAKDOWN';
  }

  return {
    status: 'DERIVED',
    referenceRange: { high: round(referenceRange.high), low: round(referenceRange.low) },
    latest: round(latest),
    classification
  };
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
