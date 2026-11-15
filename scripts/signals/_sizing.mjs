// Position sizing. Full Kelly is optimal only when the edge estimate is
// exact, and ours never is, so the engine bets a fraction of Kelly and caps
// every position. A non-positive edge always sizes to zero.

export const DEFAULT_SIZING = Object.freeze({
  kellyMultiplier: 0.25,
  maxPositionWeight: 0.05,
  minPositionWeight: 0.0025,
});

/**
 * Kelly fraction for a bet that wins `avgWin` with probability `pWin` and
 * loses `avgLoss` otherwise (both positive magnitudes): f* = p - (1 - p) / b.
 */
export function kellyFraction({ pWin, avgWin, avgLoss }) {
  if (!(pWin >= 0 && pWin <= 1) || !(avgWin > 0) || !(avgLoss > 0)) return 0;
  const b = avgWin / avgLoss;
  return pWin - (1 - pWin) / b;
}

/** Portfolio weight for one recommendation, or 0 when there is no edge. */
export function sizePosition(edge, options = {}) {
  const { kellyMultiplier, maxPositionWeight, minPositionWeight } = { ...DEFAULT_SIZING, ...options };
  const full = kellyFraction(edge);
  if (!(full > 0)) return 0;
  const weight = Math.min(maxPositionWeight, full * kellyMultiplier);
  return weight < minPositionWeight ? 0 : weight;
}

/** Win probability and average win/loss magnitudes from directional outcomes. */
export function edgeFromOutcomes(returns, direction = 'long') {
  const sign = direction === 'short' ? -1 : 1;
  const signed = returns.map((r) => sign * r);
  const wins = signed.filter((r) => r > 0);
  const losses = signed.filter((r) => r < 0).map((r) => -r);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    pWin: signed.length ? wins.length / signed.length : 0,
    avgWin: avg(wins),
    avgLoss: avg(losses),
  };
}
