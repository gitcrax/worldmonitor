// Monte Carlo over what actually happened after past precedents. The
// simulator never invents a distribution: it resamples observed outcomes, so
// fat tails and skew in the history carry straight into the risk numbers.

import { createRng, mean, quantile, randomInt } from './_stats.mjs';

export const DEFAULT_PATHS = 10_000;

/** Risk summary of a sample of returns (losses are negative returns). */
export function summarizeDistribution(returns, { lossThreshold = 0, confidence = 0.95 } = {}) {
  if (!returns.length) throw new RangeError('summarizeDistribution needs at least one return');
  const tailQ = 1 - confidence;
  const cutoff = quantile(returns, tailQ);
  const tail = returns.filter((r) => r <= cutoff);
  return {
    paths: returns.length,
    mean: mean(returns),
    median: quantile(returns, 0.5),
    p05: quantile(returns, 0.05),
    p25: quantile(returns, 0.25),
    p75: quantile(returns, 0.75),
    p95: quantile(returns, 0.95),
    probUp: returns.filter((r) => r > 0).length / returns.length,
    probLossBeyond: returns.filter((r) => r < -Math.abs(lossThreshold)).length / returns.length,
    valueAtRisk: Math.max(0, -cutoff),
    conditionalValueAtRisk: Math.max(0, -mean(tail)),
  };
}

/**
 * Bootstrap one asset's outcome: draw `paths` returns with replacement from
 * the precedent sample. `direction: 'short'` flips the sign so the summary is
 * always the position's P&L.
 */
export function simulateAsset(precedentReturns, { paths = DEFAULT_PATHS, seed = 1, direction = 'long', lossThreshold = 0 } = {}) {
  if (!precedentReturns.length) throw new RangeError('simulateAsset needs precedent returns');
  const rng = createRng(seed);
  const sign = direction === 'short' ? -1 : 1;
  const out = new Array(paths);
  for (let i = 0; i < paths; i += 1) out[i] = sign * precedentReturns[randomInt(rng, precedentReturns.length)];
  return summarizeDistribution(out, { lossThreshold });
}

/**
 * Portfolio simulation. With `jointScenarios` (rows of { [symbol]: return }
 * observed on the same past date or event) whole rows are resampled, which
 * keeps the real co-movement between assets. Without them each asset is
 * drawn independently from its own precedents, which understates tail risk;
 * the result says which mode ran.
 *
 * @param {Array<{symbol: string, weight: number, direction?: 'long'|'short'}>} positions
 */
export function simulatePortfolio(positions, {
  precedentsBySymbol = {},
  jointScenarios = null,
  paths = DEFAULT_PATHS,
  seed = 1,
  lossThreshold = 0,
} = {}) {
  if (!positions.length) throw new RangeError('simulatePortfolio needs at least one position');
  const rng = createRng(seed);
  const signed = positions.map((p) => ({ ...p, sign: p.direction === 'short' ? -1 : 1 }));
  const joint = Array.isArray(jointScenarios)
    ? jointScenarios.filter((row) => signed.every((p) => Number.isFinite(row[p.symbol])))
    : null;
  const mode = joint && joint.length ? 'joint' : 'independent';
  if (mode === 'independent') {
    for (const p of signed) {
      if (!precedentsBySymbol[p.symbol]?.length) throw new RangeError(`no precedents for ${p.symbol}`);
    }
  }
  const out = new Array(paths);
  for (let i = 0; i < paths; i += 1) {
    let total = 0;
    if (mode === 'joint') {
      const row = joint[randomInt(rng, joint.length)];
      for (const p of signed) total += p.weight * p.sign * row[p.symbol];
    } else {
      for (const p of signed) {
        const sample = precedentsBySymbol[p.symbol];
        total += p.weight * p.sign * sample[randomInt(rng, sample.length)];
      }
    }
    out[i] = total;
  }
  return { mode, scenarios: mode === 'joint' ? joint.length : null, ...summarizeDistribution(out, { lossThreshold }) };
}

/**
 * What-if: apply a hypothetical event's measured per-asset precedents to the
 * current book. Positions with no precedent for that event are reported as
 * unexposed rather than assumed flat-and-safe.
 */
export function simulateWhatIf(positions, eventPrecedentsBySymbol, options = {}) {
  const exposed = positions.filter((p) => eventPrecedentsBySymbol[p.symbol]?.length);
  const unexposed = positions.filter((p) => !eventPrecedentsBySymbol[p.symbol]?.length).map((p) => p.symbol);
  if (!exposed.length) return { exposed: [], unexposed, result: null };
  const result = simulatePortfolio(exposed, { ...options, precedentsBySymbol: eventPrecedentsBySymbol, jointScenarios: options.jointScenarios ?? null });
  return { exposed: exposed.map((p) => p.symbol), unexposed, result };
}
