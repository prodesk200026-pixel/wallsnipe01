/**
 * ENGINE 9 — LIQUIDITY VACUUM
 * Upward vacuum: ask-side withdrawal + upward price response +
 * confirming trade flow or book pressure. Downward is the mirror.
 */
export function computeLiquidityVacuum({ liquidityWithdrawal, tradeFlowProxy, bookPressure, priceResponse }) {
  if (liquidityWithdrawal?.status !== 'EXACT_DEPTH_OBSERVATION') {
    return { status: 'UNAVAILABLE', reason: 'liquidity withdrawal unavailable' };
  }

  const askW = liquidityWithdrawal.askLiquidityWithdrawal;
  const bidW = liquidityWithdrawal.bidLiquidityWithdrawal;

  const flowState = tradeFlowProxy?.tradeFlowState;
  const bullishFlow = flowState === 'ESTIMATED_BUY_PRESSURE';
  const bearishFlow = flowState === 'ESTIMATED_SELL_PRESSURE';

  const bullishBook = ['UPWARD_BOOK_PRESSURE', 'STRONG_UPWARD_BOOK_PRESSURE'].includes(bookPressure?.classification);
  const bearishBook = ['DOWNWARD_BOOK_PRESSURE', 'STRONG_DOWNWARD_BOOK_PRESSURE'].includes(bookPressure?.classification);

  const upwardPriceResponse = typeof priceResponse === 'number' && priceResponse > 0;
  const downwardPriceResponse = typeof priceResponse === 'number' && priceResponse < 0;

  let upward = { classification: 'NONE' };
  let downward = { classification: 'NONE' };

  if (['MODERATE', 'STRONG'].includes(askW.classification) && upwardPriceResponse && (bullishFlow || bullishBook)) {
    upward = {
      classification: strength(askW.classification, bullishFlow && bullishBook),
      liquidityRemoved: askW.quantityRemoved,
      removalVelocity: askW.percentRemoved,
      affectedLevels: askW.affectedLevels,
      priceResponse,
      flowConfirmation: bullishFlow
    };
  }

  if (['MODERATE', 'STRONG'].includes(bidW.classification) && downwardPriceResponse && (bearishFlow || bearishBook)) {
    downward = {
      classification: strength(bidW.classification, bearishFlow && bearishBook),
      liquidityRemoved: bidW.quantityRemoved,
      removalVelocity: bidW.percentRemoved,
      affectedLevels: bidW.affectedLevels,
      priceResponse,
      flowConfirmation: bearishFlow
    };
  }

  return { status: 'DERIVED', upwardVacuum: upward, downwardVacuum: downward };
}

function strength(withdrawalClass, doubleConfirmed) {
  if (withdrawalClass === 'STRONG' && doubleConfirmed) return 'STRONG';
  if (withdrawalClass === 'STRONG' || doubleConfirmed) return 'MODERATE';
  return 'WEAK';
}
