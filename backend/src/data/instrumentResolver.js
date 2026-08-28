/**
 * InstrumentResolver
 *
 * Central mapping from underlying -> exchange/segment/securityId.
 * Security IDs on Dhan change per expiry and get reassigned by
 * the exchange, so this is intentionally a configurable lookup, not
 * a hardcoded permanent map. In LIVE mode, populate this from each
 * provider's instrument master file (Dhan publishes a daily CSV;
 * Dhan publishes a scrip master CSV/JSON) rather than editing by hand.
 */

// Placeholder spot/index security IDs — replace with current values
// from the provider instrument master before going LIVE.
const UNDERLYINGS = {
  NIFTY: {
    symbol: 'NIFTY',
    spotReference: { exchangeSegment: 'IDX_I', securityId: '13', exchange: 'NSE' },
    nearestLiquidFuture: { exchangeSegment: 'NSE_FNO', securityId: null, exchange: 'NSE' },
    strikeStep: 50
  },
  BANKNIFTY: {
    symbol: 'BANKNIFTY',
    spotReference: { exchangeSegment: 'IDX_I', securityId: '25', exchange: 'NSE' },
    nearestLiquidFuture: { exchangeSegment: 'NSE_FNO', securityId: null, exchange: 'NSE' },
    strikeStep: 100
  },
  SENSEX: {
    symbol: 'SENSEX',
    spotReference: { exchangeSegment: 'IDX_I', securityId: '51', exchange: 'BSE' },
    nearestLiquidFuture: { exchangeSegment: 'BSE_FNO', securityId: null, exchange: 'BSE' },
    strikeStep: 100
  }
};

export function getUnderlyingConfig(symbol) {
  const cfg = UNDERLYINGS[symbol];
  if (!cfg) throw new Error(`InstrumentResolver: unknown underlying ${symbol}`);
  return cfg;
}

export function listUnderlyings() {
  return Object.keys(UNDERLYINGS);
}

/**
 * Resolves the instrument set used for microstructure analysis.
 * Per spec: prefer the nearest liquid future's depth over raw index
 * cash when deeper market depth is required, and fall back to the
 * spot/index reference when a future isn't configured yet (e.g. mock
 * mode, or before the future's securityId has been populated for the
 * current expiry).
 */
export function resolveMicrostructureInstrument(symbol) {
  const cfg = getUnderlyingConfig(symbol);
  if (cfg.nearestLiquidFuture.securityId) {
    return { ...cfg.nearestLiquidFuture, symbol: `${symbol}-FUT` };
  }
  return { ...cfg.spotReference, symbol };
}

export function resolveAtmStrike(symbol, spotPrice) {
  const cfg = getUnderlyingConfig(symbol);
  return Math.round(spotPrice / cfg.strikeStep) * cfg.strikeStep;
}
