import { assessDataQuality } from '../data/dataQualityEngine.js';
import { computeMicroprice } from '../microstructure/micropriceEngine.js';
import { computeDepthImbalance } from '../microstructure/depthImbalanceEngine.js';
import { computeLiquidityWithdrawal } from '../microstructure/liquidityWithdrawalEngine.js';
import { computeBookPressure } from '../microstructure/bookPressureEngine.js';
import { computeTradeFlowProxy } from '../microstructure/tradeFlowProxyEngine.js';
import { computeEstimatedCVD } from '../microstructure/estimatedCvdEngine.js';
import { computeAbsorptionProxy } from '../microstructure/absorptionProxyEngine.js';
import { computeRefillSuspicion } from '../microstructure/refillSuspicionEngine.js';
import { computeLiquidityVacuum } from '../microstructure/liquidityVacuumEngine.js';
import { computeVolatilityRegime } from '../microstructure/volatilityRegimeEngine.js';
import { computePriceAcceptance } from '../microstructure/priceAcceptanceEngine.js';
import { computeOptionsPositioning } from '../options/optionsPositioningEngine.js';
import { selectOptionContract } from '../options/optionContractSelector.js';
import { computePremiumConfirmation } from '../options/premiumConfirmationEngine.js';
import { computeMarketRegime } from './marketRegimeEngine.js';
import { computeContradictions } from './contradictionEngine.js';
import { computeConfluence } from './confluenceEngine.js';
import { runSignalStateMachine } from '../state/signalStateMachine.js';
import { computeWallPcrSignal, computeExitPlan } from '../strategies/wallPcrEngine.js';

/**
 * Runs the full 17-engine chain for one symbol using its current
 * rolling store state. Called on every broadcast tick; output is
 * exactly what's pushed to the frontend over Socket.IO.
 *
 * Pipeline order matches the spec:
 * ADAPTER -> NORMALIZER -> VALIDATOR -> ROLLING STORE -> [here] ->
 * MICROSTRUCTURE ENGINES -> OPTIONS ENGINE -> REGIME ENGINE ->
 * CONTRADICTION ENGINE -> SIGNAL STATE MACHINE -> SIGNAL OUTPUT ->
 * SOCKET.IO -> PWA
 *
 * SIGNAL-ONLY: nothing in this chain, or anything it calls, places,
 * modifies, or cancels an order.
 */
export function runEngineChain(symbolStore) {
  const dataQuality = assessDataQuality(symbolStore, { requiredDepthLevels: 5 });

  const depth = symbolStore.latestDepth();
  const microprice = computeMicroprice(depth);
  const depthImbalance = computeDepthImbalance(symbolStore);
  const liquidityWithdrawal = computeLiquidityWithdrawal(symbolStore);

  const priceResponse = recentPriceDelta(symbolStore);
  const bookPressure = computeBookPressure({ microprice, depthImbalance, liquidityWithdrawal, priceResponse });

  const tradeFlowProxy = computeTradeFlowProxy(symbolStore);
  const estimatedCVD = computeEstimatedCVD(symbolStore, tradeFlowProxy);

  const absorptionProxy = computeAbsorptionProxy(symbolStore, { tradeFlowProxy, liquidityWithdrawal });
  const refillSuspicion = computeRefillSuspicion(symbolStore);
  const liquidityVacuum = computeLiquidityVacuum({ liquidityWithdrawal, tradeFlowProxy, bookPressure, priceResponse });
  const volatilityRegime = computeVolatilityRegime(symbolStore);
  const priceAcceptance = computePriceAcceptance(symbolStore, { bookPressure });

  // Options engines run only once an option chain snapshot has been
  // pushed into the store. Absent that, they correctly report
  // UNAVAILABLE rather than fabricating context.
  const latestOptionSnapshot = symbolStore.optionSnapshots.last();
  const underlyingDirectionForOptions =
    bookPressure.status === 'DERIVED'
      ? ['UPWARD_BOOK_PRESSURE', 'STRONG_UPWARD_BOOK_PRESSURE'].includes(bookPressure.classification)
        ? 'BULLISH'
        : ['DOWNWARD_BOOK_PRESSURE', 'STRONG_DOWNWARD_BOOK_PRESSURE'].includes(bookPressure.classification)
          ? 'BEARISH'
          : null
      : null;

  const optionsPositioning = latestOptionSnapshot
    ? computeOptionsPositioning(latestOptionSnapshot, underlyingDirectionForOptions)
    : { status: 'UNAVAILABLE', reason: 'no option chain snapshot in store' };

  const optionContractSelector = latestOptionSnapshot && underlyingDirectionForOptions
    ? selectOptionContract(latestOptionSnapshot, underlyingDirectionForOptions)
    : { status: 'UNAVAILABLE', reason: 'no directional candidate or option snapshot yet' };

  const premiumConfirmation = optionContractSelector.status === 'INFORMATIONAL_ONLY'
    ? computePremiumConfirmation(symbolStore, optionContractSelector.recommendedContract, underlyingDirectionForOptions)
    : { status: 'UNAVAILABLE', reason: 'no recommended contract yet' };

  const marketRegime = computeMarketRegime({
    bookPressure,
    priceAcceptance,
    liquidityWithdrawal,
    liquidityVacuum,
    tradeFlowProxy,
    volatilityRegime,
    absorptionProxy
  });

  const candidateDirection = underlyingDirectionForOptions;
  const contradictions = computeContradictions({
    candidateDirection,
    microprice,
    depthImbalance,
    absorptionProxy,
    priceAcceptance,
    optionsPositioning,
    tradeFlowProxy
  });

  const engineOutputs = {
    dataQuality,
    bookPressure,
    marketRegime,
    contradictions,
    microprice,
    depthImbalance,
    optionsPositioning,
    optionContractSelector,
    premiumConfirmation
  };

  const signal = runSignalStateMachine(symbolStore, engineOutputs);

  // Attach an exit plan to the microstructure signal's recommended
  // contract too — previously this signal path gave a direction and
  // grade but no risk-management numbers, unlike the wall/PCR path.
  if (signal.status === 'SIGNAL_ACTIVE' && signal.recommendedContract?.ltp) {
    signal.exitPlan = computeExitPlan(signal.recommendedContract.ltp);
  }

  // Independent second signal path — OI wall + PCR, ported from
  // Wall Sniper. Deliberately separate from the microstructure chain
  // above; see confluenceEngine.js for how the two are compared.
  const wallPcrSignal = latestOptionSnapshot
    ? computeWallPcrSignal(symbolStore, latestOptionSnapshot)
    : { status: 'UNAVAILABLE', reason: 'no option chain snapshot in store' };

  const confluence = computeConfluence(signal, wallPcrSignal);

  const output = {
    symbol: symbolStore.symbol,
    timestamp: Date.now(),
    dataQuality,
    microprice,
    depthImbalance,
    liquidityWithdrawal,
    bookPressure,
    tradeFlowProxy,
    estimatedCVD,
    absorptionProxy,
    refillSuspicion,
    liquidityVacuum,
    volatilityRegime,
    priceAcceptance,
    optionsPositioning,
    optionContractSelector,
    premiumConfirmation,
    marketRegime,
    contradictions,
    signal,
    wallPcrSignal,
    confluence
  };

  symbolStore.pushDerived('pipelineOutput', output);
  return output;
}

function recentPriceDelta(symbolStore) {
  const quotes = symbolStore.quotesInWindow('5s');
  if (quotes.length < 2) return null;
  const first = quotes[0].ltp;
  const last = quotes[quotes.length - 1].ltp;
  if (first == null || last == null) return null;
  return last - first;
}
