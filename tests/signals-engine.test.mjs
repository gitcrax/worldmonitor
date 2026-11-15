import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  alignReturns,
  computeEventCar,
  dailyReturns,
  declusterEvents,
  runEventStudy,
  validateOutOfSample,
} from '../scripts/signals/_event-study.mjs';
import { LookaheadError, asOfView, assertNoLookahead } from '../scripts/signals/_lookahead-guard.mjs';
import {
  createLedger,
  maxDrawdown,
  openPosition,
  processDay,
  randomEntryPermutationTest,
  tradeMetrics,
} from '../scripts/signals/_paper-ledger.mjs';
import { mergeBars, parseYahooDailyBars, priceArchiveKey, validateBars } from '../scripts/signals/_price-archive.mjs';
import { simulateAsset, simulatePortfolio, simulateWhatIf } from '../scripts/signals/_simulator.mjs';
import { edgeFromOutcomes, kellyFraction, sizePosition } from '../scripts/signals/_sizing.mjs';
import {
  benjaminiHochberg,
  createRng,
  normalDraw,
  quantile,
  studentTTwoSidedP,
} from '../scripts/signals/_stats.mjs';
import { brierScore, evaluateViability, reliabilityError, trialFingerprint } from '../scripts/signals/_viability.mjs';

// ── Synthetic market ────────────────────────────────────────────────────────
// Business days from 2015, a random-walk market, and assets that load on it.
// `plantedEffect` adds a fixed abnormal return on the 5 trading days after each
// event of that class, so the study has a known answer to find.

function businessDays(start, count) {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function buildMarket({ days = 2600, seed = 42, events = [], effects = {} } = {}) {
  const rng = createRng(seed);
  const dates = businessDays('2015-01-05', days);
  const marketR = dates.map(() => 0.0003 + 0.01 * normalDraw(rng));
  const bump = { PLANTED: new Array(days).fill(0), NULL: new Array(days).fill(0) };
  for (const event of events) {
    const t0 = dates.findIndex((d) => d >= event.date);
    const effect = effects[event.eventClass];
    if (t0 < 0 || !effect) continue;
    for (let k = 0; k < 5 && t0 + k < days; k += 1) bump[effect.symbol][t0 + k] += effect.perDay;
  }
  const series = (rets) => {
    let price = 100;
    return dates.map((date, i) => {
      const open = price;
      price *= 1 + rets[i];
      return { date, open, high: Math.max(open, price) * 1.002, low: Math.min(open, price) * 0.998, close: price, adjClose: price };
    });
  };
  const planted = marketR.map((m, i) => 1.2 * m + 0.008 * normalDraw(rng) + bump.PLANTED[i]);
  const nul = marketR.map((m, i) => 0.8 * m + 0.008 * normalDraw(rng) + bump.NULL[i]);
  return { dates, barsBySymbol: { MKT: series(marketR), PLANTED: series(planted), NULL: series(nul) } };
}

function eventsEvery(dates, eventClass, everyDays, startIndex) {
  const out = [];
  for (let i = startIndex; i < dates.length - 30; i += everyDays) out.push({ id: `${eventClass}-${i}`, date: dates[i], eventClass });
  return out;
}

describe('signals stats', () => {
  it('t-distribution p-values match reference values', () => {
    assert.ok(Math.abs(studentTTwoSidedP(2.0, 10) - 0.0734) < 1e-3);
    assert.ok(Math.abs(studentTTwoSidedP(1.96, 1e6) - 0.05) < 1e-3);
    assert.ok(Math.abs(studentTTwoSidedP(0, 5) - 1) < 1e-12);
  });

  it('Benjamini-Hochberg adjusts and rejects like the textbook example', () => {
    const p = [0.01, 0.04, 0.03, 0.005, 0.5];
    const { adjusted, rejected } = benjaminiHochberg(p, 0.05);
    assert.deepEqual(rejected, [true, true, true, true, false]);
    assert.ok(Math.abs(adjusted[3] - 0.025) < 1e-12);
    assert.ok(Math.abs(adjusted[4] - 0.5) < 1e-12);
  });

  it('BH holds false discoveries near q on pure noise', () => {
    const rng = createRng(3);
    let falseRejections = 0;
    for (let trial = 0; trial < 200; trial += 1) {
      const p = Array.from({ length: 50 }, () => rng());
      falseRejections += benjaminiHochberg(p, 0.1).rejected.some(Boolean) ? 1 : 0;
    }
    assert.ok(falseRejections / 200 <= 0.15, `family-wise rejections ${falseRejections}/200`);
  });

  it('seeded generator is deterministic', () => {
    const a = createRng(9);
    const b = createRng(9);
    for (let i = 0; i < 5; i += 1) assert.equal(a(), b());
  });
});

describe('signals event study', () => {
  const base = buildMarket();
  const plantedEvents = eventsEvery(base.dates, 'opec_cut', 60, 300);
  const nullEvents = eventsEvery(base.dates, 'quiet_news', 60, 330);
  const { barsBySymbol } = buildMarket({
    events: plantedEvents,
    effects: { opec_cut: { symbol: 'PLANTED', perDay: 0.006 } },
  });
  const events = [...plantedEvents, ...nullEvents];

  it('detects a planted +3% five-day effect and flags it after BH', () => {
    const cells = runEventStudy({ events, barsBySymbol, marketSymbol: 'MKT' });
    const hit = cells.find((c) => c.eventClass === 'opec_cut' && c.symbol === 'PLANTED' && c.horizon === 5);
    assert.ok(hit, 'planted cell computed');
    assert.ok(hit.significant, `planted effect significant (q=${hit.qValue})`);
    assert.ok(Math.abs(hit.meanCar - 0.03) < 0.01, `mean CAR ${hit.meanCar} near 0.03`);
    assert.ok(hit.hitRateUp > 0.8);
  });

  it('finds nothing in the null class', () => {
    const cells = runEventStudy({ events, barsBySymbol, marketSymbol: 'MKT' });
    const nullHits = cells.filter((c) => c.eventClass === 'quiet_news' && c.significant);
    assert.equal(nullHits.length, 0, JSON.stringify(nullHits.map((c) => [c.symbol, c.horizon, c.qValue])));
  });

  it('planted effect survives out-of-sample; noise does not', () => {
    const rows = validateOutOfSample({ events, barsBySymbol, marketSymbol: 'MKT', splitDate: '2020-06-01' });
    const survivor = rows.find((c) => c.eventClass === 'opec_cut' && c.symbol === 'PLANTED' && c.horizon === 5);
    assert.ok(survivor?.survives, 'planted cell survives OOS');
    assert.ok(rows.every((c) => c.eventClass !== 'quiet_news' || !c.survives));
  });

  it('a CAR window ending after asOf is excluded, never extrapolated', () => {
    const aligned = alignReturns(dailyReturns(barsBySymbol.PLANTED), dailyReturns(barsBySymbol.MKT));
    const eventDate = base.dates[1000];
    const result = computeEventCar(aligned, eventDate, { asOf: base.dates[1002] });
    assert.ok(result.cars[1]);
    assert.equal(result.cars[5], null);
    assert.equal(result.cars[20], null);
  });

  it('declustering drops same-class events inside the gap', () => {
    const kept = declusterEvents([
      { date: '2020-01-01', eventClass: 'a' },
      { date: '2020-01-10', eventClass: 'a' },
      { date: '2020-02-15', eventClass: 'a' },
      { date: '2020-01-05', eventClass: 'b' },
    ], { minGapDays: 30 });
    assert.deepEqual(kept.map((e) => `${e.eventClass}:${e.date}`), ['a:2020-01-01', 'b:2020-01-05', 'a:2020-02-15']);
  });
});

describe('signals look-ahead guard', () => {
  it('throws on a future row', () => {
    assert.throws(() => assertNoLookahead([{ date: '2024-01-02' }], '2024-01-01'), LookaheadError);
    assert.doesNotThrow(() => assertNoLookahead([{ date: '2024-01-01' }], '2024-01-01'));
  });

  it('asOfView hides future bars and events not yet known', () => {
    const view = asOfView({
      barsBySymbol: { X: [{ date: '2024-01-01' }, { date: '2024-01-03' }] },
      events: [{ date: '2024-01-01', knownAt: '2024-01-04' }, { date: '2024-01-02' }],
    }, '2024-01-02');
    assert.equal(view.barsBySymbol.X.length, 1);
    assert.deepEqual(view.events.map((e) => e.date), ['2024-01-02']);
  });
});

describe('signals simulator', () => {
  it('bootstrap converges on the known distribution', () => {
    const rng = createRng(11);
    const sample = Array.from({ length: 5000 }, () => 0.01 + 0.02 * normalDraw(rng));
    const sim = simulateAsset(sample, { paths: 20000, seed: 5 });
    assert.ok(Math.abs(sim.mean - 0.01) < 0.002);
    assert.ok(Math.abs(sim.p05 - (0.01 - 1.645 * 0.02)) < 0.003);
    assert.ok(sim.conditionalValueAtRisk >= sim.valueAtRisk);
  });

  it('short positions flip the sign and runs are reproducible', () => {
    const sample = [0.05, 0.05, 0.05, -0.01];
    const long = simulateAsset(sample, { seed: 2, paths: 2000 });
    const short = simulateAsset(sample, { seed: 2, paths: 2000, direction: 'short' });
    assert.ok(Math.abs(long.mean + short.mean) < 1e-12);
    assert.deepEqual(simulateAsset(sample, { seed: 2, paths: 2000 }), long);
  });

  it('joint scenarios keep a hedge hedged', () => {
    const joint = Array.from({ length: 200 }, (_, i) => {
      const r = (i % 2 ? 1 : -1) * 0.03;
      return { A: r, B: r };
    });
    const hedged = simulatePortfolio(
      [{ symbol: 'A', weight: 0.5 }, { symbol: 'B', weight: 0.5, direction: 'short' }],
      { jointScenarios: joint, paths: 2000, seed: 1 },
    );
    assert.equal(hedged.mode, 'joint');
    assert.ok(Math.abs(hedged.valueAtRisk) < 1e-12);
  });

  it('what-if reports positions with no precedent as unexposed', () => {
    const out = simulateWhatIf(
      [{ symbol: 'XLE', weight: 0.05 }, { symbol: 'XLK', weight: 0.05 }],
      { XLE: [0.04, 0.02, 0.05] },
      { paths: 500, seed: 3 },
    );
    assert.deepEqual(out.exposed, ['XLE']);
    assert.deepEqual(out.unexposed, ['XLK']);
    assert.ok(out.result.mean > 0);
  });
});

describe('signals sizing', () => {
  it('Kelly matches the closed form and caps hold', () => {
    assert.ok(Math.abs(kellyFraction({ pWin: 0.6, avgWin: 1, avgLoss: 1 }) - 0.2) < 1e-12);
    assert.equal(sizePosition({ pWin: 0.4, avgWin: 1, avgLoss: 1 }), 0);
    assert.equal(sizePosition({ pWin: 0.9, avgWin: 3, avgLoss: 1 }), 0.05);
    assert.ok(Math.abs(sizePosition({ pWin: 0.55, avgWin: 1, avgLoss: 1 }) - 0.025) < 1e-12);
  });

  it('edge from outcomes respects direction', () => {
    const edge = edgeFromOutcomes([-0.02, -0.01, 0.01], 'short');
    assert.ok(Math.abs(edge.pWin - 2 / 3) < 1e-12);
    assert.ok(Math.abs(edge.avgWin - 0.015) < 1e-12);
  });
});

describe('signals paper ledger', () => {
  const bars = {
    XLE: [
      { date: '2024-01-02', open: 100, high: 101, low: 99, close: 100 },
      { date: '2024-01-03', open: 100, high: 103, low: 99.5, close: 102 },
      { date: '2024-01-04', open: 102, high: 105, low: 101, close: 104 },
      { date: '2024-01-05', open: 104, high: 106, low: 103, close: 105 },
    ],
  };

  it('P&L and costs match a hand calculation', () => {
    let ledger = createLedger({ startingEquity: 100_000, costBps: 10 });
    ledger = openPosition(ledger, { id: 't1', symbol: 'XLE', direction: 'long', weight: 0.05, entryDate: '2024-01-02', entryPrice: 100, horizonDays: 3, eventClass: 'opec_cut', strategy: 'stat' });
    for (const bar of bars.XLE) ledger = processDay(ledger, bar.date, bars);
    const [trade] = ledger.closed;
    // 5,000 notional × +4% = 200, minus 10 bps of notional (5) on each side = 190.
    assert.equal(trade.exitReason, 'horizon');
    assert.equal(trade.exitDate, '2024-01-04');
    assert.ok(Math.abs(trade.pnl - 190) < 1e-9);
    assert.ok(Math.abs(ledger.realizedEquity - 100_190) < 1e-9);
    assert.equal(tradeMetrics(ledger).hitRate, 1);
  });

  it('stops fill at the stop, or at the open on a gap', () => {
    let ledger = createLedger();
    ledger = openPosition(ledger, { id: 's1', symbol: 'XLE', direction: 'short', weight: 0.05, entryDate: '2024-01-02', entryPrice: 100, horizonDays: 10, stopPct: 0.02 });
    ledger = processDay(ledger, '2024-01-03', bars);
    assert.equal(ledger.closed[0].exitReason, 'stop');
    assert.equal(ledger.closed[0].exitPrice, 102);
  });

  it('refuses oversize and duplicate positions', () => {
    const ledger = createLedger();
    assert.throws(() => openPosition(ledger, { id: 'x', symbol: 'XLE', direction: 'long', weight: 0.2, entryDate: '2024-01-02', entryPrice: 100, horizonDays: 1 }));
    const once = openPosition(ledger, { id: 'x', symbol: 'XLE', direction: 'long', weight: 0.05, entryDate: '2024-01-02', entryPrice: 100, horizonDays: 1 });
    assert.throws(() => openPosition(once, { id: 'x', symbol: 'XLE', direction: 'long', weight: 0.05, entryDate: '2024-01-02', entryPrice: 100, horizonDays: 1 }));
  });

  it('max drawdown of a known curve', () => {
    assert.ok(Math.abs(maxDrawdown([100, 120, 90, 130, 117]) - 0.25) < 1e-12);
  });

  it('random-entry test does not credit a no-skill strategy', () => {
    const { barsBySymbol } = buildMarket({ seed: 8 });
    const rng = createRng(4);
    const series = barsBySymbol.NULL;
    const trades = Array.from({ length: 60 }, (_, k) => {
      const i = 50 + randomIndex(rng, series.length - 80);
      const entry = series[i].open;
      const exit = series[i + 4].close;
      return { symbol: 'NULL', direction: 'long', horizonDays: 5, netReturn: exit / entry - 1 - 0.002, id: k };
    });
    const test = randomEntryPermutationTest(trades, barsBySymbol, { iterations: 300, seed: 1 });
    assert.ok(test.pValue > 0.05, `p=${test.pValue}`);
  });
});

function randomIndex(rng, n) {
  return Math.floor(rng() * n);
}

describe('signals viability verdict', () => {
  const good = {
    closedTrades: 200,
    trialDays: 150,
    netSharpe: 1.1,
    benchmarkSharpe: 0.6,
    randomEntryPValue: 0.01,
    predictions: Array.from({ length: 100 }, (_, i) => ({ p: 0.7, outcome: i < 70 })),
    pnlByClass: { a: 400, b: 350, c: 300 },
    subPeriodReturns: [0.02, 0.01, -0.005],
  };

  it('all criteria passing is viable', () => {
    assert.equal(evaluateViability(good).verdict, 'viable');
  });

  it('too little evidence is inconclusive, regardless of performance', () => {
    assert.equal(evaluateViability({ ...good, closedTrades: 40 }).verdict, 'inconclusive');
  });

  it('enough evidence and a failed check is not viable, and says which', () => {
    const out = evaluateViability({ ...good, randomEntryPValue: 0.3, pnlByClass: { a: 900, b: 10 } });
    assert.equal(out.verdict, 'not_viable');
    assert.match(out.summary, /random_entry_p/);
    assert.match(out.summary, /class_concentration/);
  });

  it('Brier and reliability behave at the extremes', () => {
    assert.equal(brierScore([{ p: 1, outcome: true }, { p: 0, outcome: false }]), 0);
    assert.equal(brierScore([{ p: 0.5, outcome: true }]), 0.25);
    assert.ok(reliabilityError(good.predictions) < 1e-9);
  });

  it('trial fingerprints are stable and change with the frozen config', () => {
    const a = trialFingerprint({ model: 'v1', horizons: [1, 5], q: 0.1 });
    assert.equal(a, trialFingerprint({ q: 0.1, horizons: [1, 5], model: 'v1' }));
    assert.notEqual(a, trialFingerprint({ model: 'v2', horizons: [1, 5], q: 0.1 }));
  });
});

describe('signals price archive', () => {
  const chart = {
    chart: {
      result: [{
        meta: { gmtoffset: -18000 },
        timestamp: [1704205800, 1704292200, 1704378600],
        indicators: {
          quote: [{ open: [100, null, 102], high: [101, 1, 103], low: [99, 1, 101], close: [100.5, 2, 102.5], volume: [10, 0, 12] }],
          adjclose: [{ adjclose: [99.5, 2, 101.5] }],
        },
      }],
    },
  };

  it('parses bars in the exchange calendar and drops incomplete ones', () => {
    const bars = parseYahooDailyBars(chart);
    assert.deepEqual(bars.map((b) => b.date), ['2024-01-02', '2024-01-04']);
    assert.equal(bars[0].adjClose, 99.5);
  });

  it('merge lets revised bars win and keeps order', () => {
    const merged = mergeBars(
      [{ date: '2024-01-02', open: 1, close: 1 }, { date: '2024-01-03', open: 1, close: 1 }],
      [{ date: '2024-01-03', open: 2, close: 2 }, { date: '2024-01-04', open: 3, close: 3 }],
    );
    assert.deepEqual(merged.map((b) => b.close), [1, 2, 3]);
    assert.doesNotThrow(() => validateBars('X', merged));
    assert.throws(() => validateBars('X', [...merged].reverse()));
  });

  it('keys are encoded and prefixed', () => {
    assert.equal(priceArchiveKey('^GSPC'), 'signals/prices/daily/v1/%5EGSPC.json');
    assert.equal(priceArchiveKey('CL=F', '/private/'), 'private/signals/prices/daily/v1/CL%3DF.json');
  });

  it('quantile helper agrees with type-7 definition', () => {
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  });
});
