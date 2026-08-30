/**
 * ENGINE — OI / VOLUME CHANGE TRACKER
 *
 * Dhan's option chain already includes previous_oi/previous_volume
 * per leg — but Angel's doesn't give you anything to diff against.
 * Rather than have two different code paths (one broker computes
 * change itself, one trusts the broker), this module keeps its own
 * rolling snapshot per (underlying, expiry, strike, legType) and
 * computes change the same way for both — so OI-buildup signals
 * behave identically regardless of which broker is active.
 *
 * "Change" here means since the LAST snapshot this engine saw, not
 * since previous trading day's close — that's what actually matters
 * for an intraday retail trader watching OI build in real time.
 */

const previousSnapshots = new Map(); // key: `${underlying}:${expiry}` -> Map(strike:legType -> {oi, volume, at})

function key(underlying, expiry) {
  return `${underlying}:${expiry}`;
}

/**
 * Call once per fresh option-chain fetch. Mutates nothing — returns
 * a NEW chain object with oiChange/volumeChange/oiChangePct added to
 * every leg, and updates the internal previous-snapshot cache for
 * next time.
 */
export function withOiVolumeChange(chainSnapshot) {
  if (!chainSnapshot) return chainSnapshot;
  const k = key(chainSnapshot.underlying, chainSnapshot.expiry);
  const prev = previousSnapshots.get(k) || new Map();
  const next = new Map();

  const strikes = chainSnapshot.strikes.map((row) => {
    const withChange = { strike: row.strike };
    for (const legType of ['CE', 'PE']) {
      const leg = row[legType];
      if (!leg) {
        withChange[legType] = null;
        continue;
      }
      const prevLeg = prev.get(`${row.strike}:${legType}`);
      const oiChange = prevLeg ? leg.oi - prevLeg.oi : 0;
      const volumeChange = prevLeg ? leg.volume - prevLeg.volume : 0;
      const oiChangePct = prevLeg && prevLeg.oi ? round((oiChange / prevLeg.oi) * 100, 2) : 0;

      withChange[legType] = { ...leg, oiChange, volumeChange, oiChangePct };
      next.set(`${row.strike}:${legType}`, { oi: leg.oi, volume: leg.volume });
    }
    return withChange;
  });

  previousSnapshots.set(k, next);
  return { ...chainSnapshot, strikes };
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
