/**
 * ENGINE 15 — MARKET REGIME
 * Single dominant regime classification from the engines already
 * computed. Deliberately does not use RSI as core logic per spec.
 */
export function computeMarketRegime({
  bookPressure,
  priceAcceptance,
  liquidityWithdrawal,
  liquidityVacuum,
  tradeFlowProxy,
  volatilityRegime,
  absorptionProxy
}) {
  if (bookPressure?.status !== 'DERIVED' || volatilityRegime?.status !== 'DERIVED') {
    return { status: 'UNAVAILABLE', reason: 'requires book pressure + volatility regime' };
  }

  const bullishBook = ['UPWARD_BOOK_PRESSURE', 'STRONG_UPWARD_BOOK_PRESSURE'].includes(bookPressure.classification);
  const bearishBook = ['DOWNWARD_BOOK_PRESSURE', 'STRONG_DOWNWARD_BOOK_PRESSURE'].includes(bookPressure.classification);
  const strongBullishBook = bookPressure.classification === 'STRONG_UPWARD_BOOK_PRESSURE';
  const strongBearishBook = bookPressure.classification === 'STRONG_DOWNWARD_BOOK_PRESSURE';

  const bullishFlow = tradeFlowProxy?.tradeFlowState === 'ESTIMATED_BUY_PRESSURE';
  const bearishFlow = tradeFlowProxy?.tradeFlowState === 'ESTIMATED_SELL_PRESSURE';

  const upwardAcceptance = priceAcceptance?.classification === 'UPWARD_ACCEPTANCE';
  const downwardAcceptance = priceAcceptance?.classification === 'DOWNWARD_ACCEPTANCE';

  const upwardVacuum = liquidityVacuum?.upwardVacuum?.classification && liquidityVacuum.upwardVacuum.classification !== 'NONE';
  const downwardVacuum = liquidityVacuum?.downwardVacuum?.classification && liquidityVacuum.downwardVacuum.classification !== 'NONE';

  const askAbsorption = absorptionProxy?.askAbsorptionProxy?.classification;
  const bidAbsorption = absorptionProxy?.bidAbsorptionProxy?.classification;
  const strongAskAbsorption = ['MODERATE', 'STRONG'].includes(askAbsorption);
  const strongBidAbsorption = ['MODERATE', 'STRONG'].includes(bidAbsorption);

  let regime = 'BALANCED';

  if (volatilityRegime.classification === 'COMPRESSION') {
    regime = 'COMPRESSION';
  } else if (upwardAcceptance && upwardVacuum && bullishBook) {
    regime = 'BREAKOUT_UP';
  } else if (downwardAcceptance && downwardVacuum && bearishBook) {
    regime = 'BREAKOUT_DOWN';
  } else if (bullishFlow && strongAskAbsorption && !upwardAcceptance) {
    regime = 'EXHAUSTION_UP';
  } else if (bearishFlow && strongBidAbsorption && !downwardAcceptance) {
    regime = 'EXHAUSTION_DOWN';
  } else if (volatilityRegime.classification === 'EXTREME_VOLATILITY') {
    regime = 'HIGH_RISK';
  } else if (priceAcceptance?.classification === 'FAILED_BREAKOUT' || priceAcceptance?.classification === 'FAILED_BREAKDOWN') {
    regime = 'ROTATION';
  } else if (strongBullishBook && bullishFlow) {
    regime = 'UPWARD_PRESSURE';
  } else if (strongBearishBook && bearishFlow) {
    regime = 'DOWNWARD_PRESSURE';
  } else if (bullishBook || bearishBook) {
    regime = bullishBook ? 'UPWARD_PRESSURE' : 'DOWNWARD_PRESSURE';
  }

  return { status: 'DERIVED', regime };
}
