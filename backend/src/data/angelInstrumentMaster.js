import axios from 'axios';

const SCRIP_MASTER_URL = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';

// Angel republishes this once daily (~8:30 AM IST per their own
// forum posts) — refresh once a day, not on every request. It's a
// large file (~30-50MB, tens of thousands of instruments), so this
// is also a bandwidth/latency concern, not just a rate-limit one.
const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000;

let cache = null; // full parsed array from Angel
let cachedAt = 0;
let refreshPromise = null;

// Angel's known fixed index tokens (NSE exchange segment). These
// don't roll over with expiry the way option/future tokens do, so
// they're safe to keep as constants rather than looking them up —
// but if Angel ever changes them, the master-driven functions below
// are still the source of truth for everything else.
const INDEX_TOKENS = {
  NIFTY: { token: '26000', exchange: 'NSE' },
  BANKNIFTY: { token: '26009', exchange: 'NSE' },
  SENSEX: { token: '1', exchange: 'BSE' } // BSE SENSEX — verify against current master if this ever looks wrong
};

async function loadMaster() {
  if (cache && Date.now() - cachedAt < REFRESH_INTERVAL_MS) return cache;
  if (refreshPromise) return refreshPromise; // de-dupe concurrent callers during a refresh

  refreshPromise = axios
    .get(SCRIP_MASTER_URL, { timeout: 30000 })
    .then((res) => {
      cache = res.data;
      cachedAt = Date.now();
      console.log('[AngelInstrumentMaster] Loaded', { count: cache.length, at: new Date(cachedAt).toISOString() });
      return cache;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

export function getIndexToken(underlyingName) {
  return INDEX_TOKENS[underlyingName] || null;
}

/**
 * Returns every option-chain expiry date string (Angel's own format,
 * e.g. "28OCT2025") available for this underlying, sorted soonest
 * first, so callers can pick "nearest weekly" without hardcoding a
 * date that will silently go stale after the next expiry.
 */
export async function listExpiries(underlyingName) {
  const master = await loadMaster();
  const dates = new Set();
  for (const row of master) {
    if (row.name === underlyingName && row.instrumenttype === 'OPTIDX' && row.expiry) {
      dates.add(row.expiry);
    }
  }
  return [...dates].sort((a, b) => parseAngelDate(a) - parseAngelDate(b));
}

export async function getNearestExpiry(underlyingName) {
  const expiries = await listExpiries(underlyingName);
  return expiries[0] || null;
}

/**
 * Returns { strike, CE: {token, symbol} | null, PE: {...} | null }[]
 * for one underlying + one expiry — everything AngelAdapter needs to
 * compose an option chain snapshot via the quote API.
 */
export async function getOptionChainTokens(underlyingName, expiry) {
  const master = await loadMaster();
  const byStrike = new Map();

  for (const row of master) {
    if (row.name !== underlyingName || row.instrumenttype !== 'OPTIDX' || row.expiry !== expiry) continue;
    const strike = Number(row.strike) / 100; // Angel stores strike * 100
    const isCE = row.symbol.endsWith('CE');
    const isPE = row.symbol.endsWith('PE');
    if (!isCE && !isPE) continue;

    if (!byStrike.has(strike)) byStrike.set(strike, { strike, CE: null, PE: null });
    byStrike.get(strike)[isCE ? 'CE' : 'PE'] = { token: row.token, symbol: row.symbol, exchange: row.exch_seg };
  }

  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

/**
 * Nearest-liquid-future token for the given underlying + expiry
 * month — used to fix InstrumentResolver's previously-null
 * `nearestLiquidFuture.securityId` for Angel's side.
 */
export async function getNearestFutureToken(underlyingName) {
  const master = await loadMaster();
  const futures = master
    .filter((row) => row.name === underlyingName && row.instrumenttype === 'FUTIDX' && row.expiry)
    .sort((a, b) => parseAngelDate(a.expiry) - parseAngelDate(b.expiry));
  const nearest = futures[0];
  return nearest ? { token: nearest.token, symbol: nearest.symbol, exchange: nearest.exch_seg } : null;
}

function parseAngelDate(str) {
  // "28OCT2025" -> Date. Angel's format is fixed, so a small manual
  // parser is more reliable here than trusting Date() to guess it.
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const day = parseInt(str.slice(0, 2), 10);
  const mon = months[str.slice(2, 5).toUpperCase()];
  const year = parseInt(str.slice(5, 9), 10);
  return new Date(year, mon, day).getTime();
}
