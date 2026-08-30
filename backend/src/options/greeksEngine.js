/**
 * ENGINE — GREEKS (Black-Scholes-Merton, European options)
 *
 * WHY THIS EXISTS: Dhan's option chain gives delta/gamma/theta/vega
 * + IV directly (their Data API subscription). Angel gives NONE of
 * this — no IV, no Greeks. And even Dhan doesn't give the "hidden"
 * second/third-order Greeks (vanna, charm, vomma, speed, color,
 * zomma) that give real edge on how an option's risk profile shifts
 * as spot/vol/time move — nobody's broker API gives you those. So
 * this module is what makes Greeks-based edge possible AT ALL, on
 * either broker, for every Greek beyond the basic four.
 *
 * Model: standard Black-Scholes-Merton on the SPOT price (not
 * Black-76 on a forward) — reasonable for index options on a short
 * holding horizon where the spot/forward drift over your intraday
 * timeframe is small relative to spread/slippage. If deep-ITM/OTM
 * edge cases ever look wrong, that assumption is the first thing to
 * revisit.
 *
 * Every function here is pure math — no network calls, no broker
 * dependency. `computeFullGreeks()` is the one entry point most
 * callers need.
 */

const DAYS_PER_YEAR = 365;
const DEFAULT_RISK_FREE_RATE = 0.065; // ~India 91-day T-bill ballpark; override if you have a live rate source

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Abramowitz-Stegun approximation of the standard normal CDF —
// accurate to ~1e-7, plenty for option pricing at retail stakes.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const y =
    1 -
    normPdf(x) *
      t *
      (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? y : 1 - y;
}

function d1d2(spot, strike, tYears, vol, r) {
  const sqrtT = Math.sqrt(Math.max(tYears, 1e-6));
  const d1 = (Math.log(spot / strike) + (r + (vol * vol) / 2) * tYears) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  return { d1, d2, sqrtT };
}

export function blackScholesPrice(optionType, spot, strike, tYears, vol, r = DEFAULT_RISK_FREE_RATE) {
  if (tYears <= 0 || vol <= 0) return Math.max(0, optionType === 'CE' ? spot - strike : strike - spot);
  const { d1, d2 } = d1d2(spot, strike, tYears, vol, r);
  if (optionType === 'CE') {
    return spot * normCdf(d1) - strike * Math.exp(-r * tYears) * normCdf(d2);
  }
  return strike * Math.exp(-r * tYears) * normCdf(-d2) - spot * normCdf(-d1);
}

/**
 * Backs out implied volatility from an observed LTP via
 * Newton-Raphson (falls back to bisection if Newton's step
 * misbehaves near-expiry / deep ITM, where vega ≈ 0 and Newton can
 * diverge). This is REQUIRED for Angel (no IV supplied at all) and
 * used as a cross-check/fallback if Dhan's IV field is ever missing.
 */
export function solveImpliedVolatility(optionType, ltp, spot, strike, tYears) {
  if (tYears <= 0 || ltp <= 0) return null;

  let vol = 0.25; // reasonable starting guess for index options
  for (let i = 0; i < 50; i++) {
    const price = blackScholesPrice(optionType, spot, strike, tYears, vol);
    const { vega } = firstOrderGreeks(optionType, spot, strike, tYears, vol);
    const vegaPerUnit = vega * 100; // firstOrderGreeks returns vega per 1% vol move; Newton needs it per unit vol
    if (Math.abs(vegaPerUnit) < 1e-8) break; // vega too flat — bail to bisection below
    const diff = price - ltp;
    if (Math.abs(diff) < 1e-4) return round(vol * 100, 3); // converged, return as a percentage like brokers report it
    vol = vol - diff / vegaPerUnit;
    if (vol <= 0.001 || vol > 5) break; // stepped somewhere unreasonable — bail to bisection
  }

  // Bisection fallback — slower but always converges for a valid
  // price within [0.1%, 500%] vol, which covers every real market.
  let lo = 0.001;
  let hi = 5;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const price = blackScholesPrice(optionType, spot, strike, tYears, mid);
    if (price > ltp) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-5) break;
  }
  return round(((lo + hi) / 2) * 100, 3);
}

function firstOrderGreeks(optionType, spot, strike, tYears, vol, r = DEFAULT_RISK_FREE_RATE) {
  if (tYears <= 0 || vol <= 0) {
    return { delta: optionType === 'CE' ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const { d1, d2, sqrtT } = d1d2(spot, strike, tYears, vol, r);
  const nd1 = normPdf(d1);
  const isCall = optionType === 'CE';

  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = nd1 / (spot * vol * sqrtT);
  const vega = (spot * nd1 * sqrtT) / 100; // per 1% vol move — matches how brokers report it
  const rho =
    (isCall
      ? strike * tYears * Math.exp(-r * tYears) * normCdf(d2)
      : -strike * tYears * Math.exp(-r * tYears) * normCdf(-d2)) / 100; // per 1% rate move
  const thetaAnnual = isCall
    ? -((spot * nd1 * vol) / (2 * sqrtT)) - r * strike * Math.exp(-r * tYears) * normCdf(d2)
    : -((spot * nd1 * vol) / (2 * sqrtT)) + r * strike * Math.exp(-r * tYears) * normCdf(-d2);
  const theta = thetaAnnual / DAYS_PER_YEAR; // per calendar day — matches how brokers report it

  return { delta, gamma, theta, vega, rho };
}

/**
 * "Hidden" Greeks — second/third-order sensitivities. No Indian
 * broker API exposes these; this is the actual edge this module
 * adds beyond what Dhan already gives you for free.
 *
 *   vanna  = ∂delta/∂vol  = ∂vega/∂spot   — how much your delta
 *            hedge breaks as IV moves; big vanna = your directional
 *            exposure is secretly a volatility bet too.
 *   charm  = ∂delta/∂time — "delta decay". How much delta erodes
 *            just from time passing, holding spot/vol fixed. Big
 *            near expiry — explains why an ATM position's directional
 *            exposure can quietly vanish overnight with no price move.
 *   vomma  = ∂vega/∂vol   ("volga"). Convexity of vega — how much
 *            your vega itself changes as IV moves. Matters most for
 *            OTM strikes around IV spikes (e.g. into an event).
 *   speed  = ∂gamma/∂spot — rate of change of gamma. Tells you if
 *            your gamma exposure is about to accelerate as price
 *            approaches the strike.
 *   color  = ∂gamma/∂time — gamma decay. Like charm but for gamma:
 *            explains why near-expiry gamma scalping positions
 *            behave differently hour to hour even with flat price.
 *   zomma  = ∂gamma/∂vol  — how gamma shifts as IV moves.
 */
function hiddenGreeks(optionType, spot, strike, tYears, vol, r = DEFAULT_RISK_FREE_RATE) {
  if (tYears <= 0 || vol <= 0) {
    return { vanna: 0, charm: 0, vomma: 0, speed: 0, color: 0, zomma: 0 };
  }
  const { d1, d2, sqrtT } = d1d2(spot, strike, tYears, vol, r);
  const nd1 = normPdf(d1);
  const isCall = optionType === 'CE';

  const vanna = (-nd1 * d2) / vol;
  const vomma = ((nd1 * spot * sqrtT) / 100) * ((d1 * d2) / vol); // scaled to match vega's per-1% convention

  const charmAnnual = isCall
    ? -nd1 * ((2 * r * tYears - d2 * vol * sqrtT) / (2 * tYears * vol * sqrtT))
    : nd1 * ((2 * r * tYears - d2 * vol * sqrtT) / (2 * tYears * vol * sqrtT)) * -1;
  const charm = charmAnnual / DAYS_PER_YEAR; // per calendar day, matching theta's convention

  const speed = (-nd1 / (spot * spot * vol * sqrtT)) * (d1 / (vol * sqrtT) + 1);
  const colorAnnual =
    (-nd1 / (2 * spot * tYears * vol * sqrtT)) *
    (2 * r * tYears + 1 + ((2 * r * tYears - d2 * vol * sqrtT) / (vol * sqrtT)) * d1);
  const color = colorAnnual / DAYS_PER_YEAR;
  const zomma = (nd1 * (d1 * d2 - 1)) / (spot * vol * vol * sqrtT);

  return {
    vanna: round(vanna, 6),
    charm: round(charm, 6),
    vomma: round(vomma, 6),
    speed: round(speed, 10),
    color: round(color, 8),
    zomma: round(zomma, 8)
  };
}

/**
 * Main entry point. Prefers the broker's own delta/gamma/theta/vega
 * + IV when supplied (Dhan) for consistency with what a human sees
 * on Dhan's own screens, but ALWAYS computes rho + every hidden
 * Greek itself (no broker supplies those). Computes everything
 * itself, including IV via solveImpliedVolatility, when the broker
 * gives nothing (Angel).
 */
export function computeFullGreeks({ optionType, spot, strike, expiryDate, ltp, brokerGreeks, brokerIV }) {
  const tYears = daysToExpiry(expiryDate) / DAYS_PER_YEAR;
  const iv = brokerIV ?? solveImpliedVolatility(optionType, ltp, spot, strike, tYears);
  if (iv == null) return null;
  const vol = iv / 100;

  const first = brokerGreeks?.delta != null
    ? { delta: brokerGreeks.delta, gamma: brokerGreeks.gamma, theta: brokerGreeks.theta, vega: brokerGreeks.vega, rho: firstOrderGreeks(optionType, spot, strike, tYears, vol).rho }
    : firstOrderGreeks(optionType, spot, strike, tYears, vol);

  const hidden = hiddenGreeks(optionType, spot, strike, tYears, vol);

  return {
    iv: round(iv, 3),
    ivSource: brokerIV != null ? 'BROKER' : 'COMPUTED',
    daysToExpiry: round(daysToExpiry(expiryDate), 2),
    ...roundGreeks(first),
    ...hidden,
    greeksSource: brokerGreeks?.delta != null ? 'BROKER+COMPUTED_HIDDEN' : 'FULLY_COMPUTED'
  };
}

function roundGreeks(g) {
  return {
    delta: round(g.delta, 5),
    gamma: round(g.gamma, 6),
    theta: round(g.theta, 4),
    vega: round(g.vega, 4),
    rho: round(g.rho, 4)
  };
}

function daysToExpiry(expiryDate) {
  // Accepts "YYYY-MM-DD" (Dhan) or "28OCT2025" (Angel) — normalize both.
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(expiryDate)
    ? new Date(expiryDate + 'T15:30:00+05:30').getTime() // NSE close time on expiry day
    : parseAngelDateToExpiryMs(expiryDate);
  return Math.max((ms - Date.now()) / (1000 * 60 * 60 * 24), 0);
}

function parseAngelDateToExpiryMs(str) {
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const day = parseInt(str.slice(0, 2), 10);
  const mon = months[str.slice(2, 5).toUpperCase()];
  const year = parseInt(str.slice(5, 9), 10);
  return new Date(year, mon, day, 15, 30).getTime();
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
