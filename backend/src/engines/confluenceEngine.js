/**
 * CONFLUENCE ENGINE
 *
 * The microstructure signal (order-flow/depth based) and the
 * wall/PCR signal (OI-positioning based) are independent methods
 * using different data. When they agree, that's meaningfully
 * stronger evidence than either alone; when they conflict, that's
 * a reason for caution, not something to hide.
 *
 * This never overrides either signal — it's a read-only summary
 * layer on top of both.
 */
export function computeConfluence(microSignal, wallSignal) {
  const microDirection = microSignal?.status === 'SIGNAL_ACTIVE' ? microSignal.direction : null;
  const wallDirection =
    wallSignal?.status === 'PROXY' && wallSignal.verdict === 'BUY_CALL'
      ? 'BULLISH'
      : wallSignal?.status === 'PROXY' && wallSignal.verdict === 'BUY_PUT'
        ? 'BEARISH'
        : null;

  if (!microDirection && !wallDirection) {
    return { status: 'NO_ACTIVE_SIGNAL', agreement: 'NONE' };
  }

  if (microDirection && wallDirection) {
    if (microDirection === wallDirection) {
      return {
        status: 'BOTH_ACTIVE',
        agreement: 'DUAL_CONFIRMED',
        direction: microDirection,
        note: `Microstructure and Wall/PCR both point ${microDirection} — independent confirmation.`
      };
    }
    return {
      status: 'BOTH_ACTIVE',
      agreement: 'CONFLICTING',
      note: `Microstructure says ${microDirection}, Wall/PCR says ${wallDirection} — independent methods disagree. Treat with extra caution.`
    };
  }

  if (microDirection) {
    return {
      status: 'MICRO_ONLY',
      agreement: 'SINGLE_METHOD',
      direction: microDirection,
      note: 'Microstructure signal active; Wall/PCR has no matching setup right now.'
    };
  }

  return {
    status: 'WALL_ONLY',
    agreement: 'SINGLE_METHOD',
    direction: wallDirection,
    note: 'Wall/PCR signal active; microstructure has no matching setup right now.'
  };
}
