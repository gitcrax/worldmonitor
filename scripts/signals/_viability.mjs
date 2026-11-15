// Pre-registered viability verdict. The criteria are fixed before a trial
// starts and hashed with it; changing them mid-trial is a new trial. The
// engine says "not viable" as readily as "viable": that is the point.

import { createHash } from 'node:crypto';

export const DEFAULT_VIABILITY_CRITERIA = Object.freeze({
  minClosedTrades: 150,
  minTrialDays: 120,
  minNetSharpe: 0.7,
  mustBeatBenchmarkSharpe: true,
  maxRandomEntryPValue: 0.05,
  maxReliabilityError: 0.05,
  maxSingleClassPnlShare: 0.5,
  minPositiveSubPeriods: 2,
});

/** Mean squared error of probability forecasts against 0/1 outcomes. */
export function brierScore(predictions) {
  if (!predictions.length) return NaN;
  let sum = 0;
  for (const { p, outcome } of predictions) sum += (p - (outcome ? 1 : 0)) ** 2;
  return sum / predictions.length;
}

/**
 * Expected calibration error: across equal-width probability bins, the
 * count-weighted gap between mean forecast and observed frequency.
 */
export function reliabilityError(predictions, bins = 10) {
  if (!predictions.length) return NaN;
  const cells = Array.from({ length: bins }, () => ({ n: 0, p: 0, hits: 0 }));
  for (const { p, outcome } of predictions) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    cells[b].n += 1;
    cells[b].p += p;
    cells[b].hits += outcome ? 1 : 0;
  }
  let error = 0;
  for (const c of cells) {
    if (c.n) error += (c.n / predictions.length) * Math.abs(c.p / c.n - c.hits / c.n);
  }
  return error;
}

/** Stable fingerprint of a trial's frozen configuration. */
export function trialFingerprint(frozen) {
  const canonical = JSON.stringify(frozen, Object.keys(flattenKeys(frozen)).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function flattenKeys(value, out = {}) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out[k] = true;
      flattenKeys(v, out);
    }
  }
  return out;
}

/**
 * @param {object} evidence
 * @param {number} evidence.closedTrades
 * @param {number} evidence.trialDays
 * @param {number} evidence.netSharpe
 * @param {number} evidence.benchmarkSharpe
 * @param {number} evidence.randomEntryPValue
 * @param {Array<{p:number,outcome:boolean}>} evidence.predictions
 * @param {Record<string, number>} evidence.pnlByClass
 * @param {number[]} evidence.subPeriodReturns
 */
export function evaluateViability(evidence, criteria = DEFAULT_VIABILITY_CRITERIA) {
  const c = { ...DEFAULT_VIABILITY_CRITERIA, ...criteria };
  const brier = brierScore(evidence.predictions ?? []);
  const reliability = reliabilityError(evidence.predictions ?? []);
  const pnl = Object.values(evidence.pnlByClass ?? {});
  const totalPositivePnl = pnl.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const maxClassShare = totalPositivePnl > 0 ? Math.max(...pnl) / totalPositivePnl : 1;
  const positiveSubPeriods = (evidence.subPeriodReturns ?? []).filter((r) => r > 0).length;

  const sample = [
    { id: 'closed_trades', value: evidence.closedTrades, threshold: `>= ${c.minClosedTrades}`, pass: evidence.closedTrades >= c.minClosedTrades },
    { id: 'trial_days', value: evidence.trialDays, threshold: `>= ${c.minTrialDays}`, pass: evidence.trialDays >= c.minTrialDays },
  ];
  const performance = [
    { id: 'net_sharpe', value: evidence.netSharpe, threshold: `>= ${c.minNetSharpe}`, pass: evidence.netSharpe >= c.minNetSharpe },
    {
      id: 'beats_benchmark',
      value: evidence.netSharpe - evidence.benchmarkSharpe,
      threshold: '> 0',
      pass: !c.mustBeatBenchmarkSharpe || evidence.netSharpe > evidence.benchmarkSharpe,
    },
    { id: 'random_entry_p', value: evidence.randomEntryPValue, threshold: `< ${c.maxRandomEntryPValue}`, pass: evidence.randomEntryPValue < c.maxRandomEntryPValue },
    { id: 'brier_vs_coin', value: brier, threshold: '< 0.25', pass: brier < 0.25 },
    { id: 'reliability_error', value: reliability, threshold: `< ${c.maxReliabilityError}`, pass: reliability < c.maxReliabilityError },
    { id: 'class_concentration', value: maxClassShare, threshold: `<= ${c.maxSingleClassPnlShare}`, pass: maxClassShare <= c.maxSingleClassPnlShare },
    { id: 'positive_sub_periods', value: positiveSubPeriods, threshold: `>= ${c.minPositiveSubPeriods}`, pass: positiveSubPeriods >= c.minPositiveSubPeriods },
  ];

  const sampleReady = sample.every((x) => x.pass);
  const performancePass = performance.every((x) => x.pass);
  const verdict = !sampleReady ? 'inconclusive' : performancePass ? 'viable' : 'not_viable';
  return {
    verdict,
    checks: [...sample, ...performance],
    summary: verdict === 'viable'
      ? 'Every pre-registered criterion passed.'
      : verdict === 'inconclusive'
        ? 'Not enough trades or time yet; keep the trial running unchanged.'
        : `Failed: ${performance.filter((x) => !x.pass).map((x) => x.id).join(', ')}.`,
  };
}
