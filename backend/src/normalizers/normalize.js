/**
 * Shared normalization helpers. Adapters call these so that every
 * downstream engine receives one consistent shape regardless of
 * provider-specific field names.
 */

export function normalizeQuote({
  provider,
  symbol,
  exchange,
  segment,
  securityId,
  timestamp,
  ltp,
  ltq,
  ltt,
  open,
  high,
  low,
  close,
  volume,
  totalBuyQuantity,
  totalSellQuantity,
  oi,
  oiDayHigh,
  oiDayLow,
  dataQuality
}) {
  return {
    provider,
    symbol,
    exchange,
    segment,
    securityId,
    timestamp: timestamp ?? Date.now(),

    ltp: numOrNull(ltp),
    ltq: numOrNull(ltq),
    ltt: ltt ?? null,

    open: numOrNull(open),
    high: numOrNull(high),
    low: numOrNull(low),
    close: numOrNull(close),

    volume: numOrNull(volume),

    totalBuyQuantity: numOrNull(totalBuyQuantity),
    totalSellQuantity: numOrNull(totalSellQuantity),

    oi: numOrNull(oi),
    oiDayHigh: numOrNull(oiDayHigh),
    oiDayLow: numOrNull(oiDayLow),

    dataQuality: dataQuality || 'UNKNOWN'
  };
}

export function normalizeDepth({
  provider,
  symbol,
  securityId,
  timestamp,
  levelsAvailable,
  bids,
  asks,
  dataQuality
}) {
  return {
    provider,
    symbol,
    securityId,
    timestamp: timestamp ?? Date.now(),
    levelsAvailable: levelsAvailable ?? (bids ? bids.length : 0),
    bids: (bids || []).map((b, i) => ({
      price: numOrNull(b.price),
      quantity: numOrNull(b.quantity),
      orderCount: numOrNull(b.orderCount) ?? null,
      level: b.level ?? i + 1
    })),
    asks: (asks || []).map((a, i) => ({
      price: numOrNull(a.price),
      quantity: numOrNull(a.quantity),
      orderCount: numOrNull(a.orderCount) ?? null,
      level: a.level ?? i + 1
    })),
    dataQuality: dataQuality || 'UNKNOWN'
  };
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
