// Event study: how did each asset move, beyond what the market explains,
// after each class of event? This is the measurement layer under every
// market signal. Nothing here guesses; it only counts what history shows.
//
// Conventions
// - Bars are daily, sorted ascending: { date: 'YYYY-MM-DD', open, high, low, close, adjClose? }.
// - Returns are simple close-to-close on adjClose (falling back to close).
// - Day 0 is the first trading day on or after the event date.
// - CAR for horizon h sums abnormal returns over trading days 0..h-1.
// - The market model is fitted on an estimation window that ends well before
//   day 0, so the event itself never contaminates its own baseline.

import { assertIsoDate } from './_lookahead-guard.mjs';
import { benjaminiHochberg, mean, olsFit, sampleStd, studentTTwoSidedP } from './_stats.mjs';

export const DEFAULT_HORIZONS = Object.freeze([1, 5, 20]);
export const DEFAULT_ESTIMATION = Object.freeze({ start: -250, end: -30, minObservations: 120 });

function closeOf(bar) {
  const value = Number.isFinite(bar.adjClose) ? bar.adjClose : bar.close;
  return Number.isFinite(value) && value > 0 ? value : NaN;
}

/** Daily simple returns keyed by date (the first bar has no return). */
export function dailyReturns(bars) {
  const out = new Map();
  for (let i = 1; i < bars.length; i += 1) {
    const prev = closeOf(bars[i - 1]);
    const cur = closeOf(bars[i]);
    if (Number.isFinite(prev) && Number.isFinite(cur)) out.set(bars[i].date, cur / prev - 1);
  }
  return out;
}

/** Dates on which both series have a return, ascending, with paired values. */
export function alignReturns(assetReturns, marketReturns) {
  const dates = [];
  const asset = [];
  const market = [];
  for (const [date, r] of assetReturns) {
    const m = marketReturns.get(date);
    if (m === undefined) continue;
    dates.push(date);
    asset.push(r);
    market.push(m);
  }
  const order = dates.map((_, i) => i).sort((a, b) => (dates[a] < dates[b] ? -1 : dates[a] > dates[b] ? 1 : 0));
  return {
    dates: order.map((i) => dates[i]),
    asset: order.map((i) => asset[i]),
    market: order.map((i) => market[i]),
  };
}

function firstIndexOnOrAfter(dates, date) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Cumulative abnormal returns for one event on one asset.
 * `model: 'market'` fits alpha + beta on the market; `'mean'` (used when the
 * asset is the market itself) subtracts the estimation-window mean.
 * Returns null when there is not enough history. A horizon whose window ends
 * after `asOf` (or after the data) is reported as null, never extrapolated.
 */
export function computeEventCar(aligned, eventDate, {
  horizons = DEFAULT_HORIZONS,
  estimation = DEFAULT_ESTIMATION,
  model = 'market',
  asOf = null,
} = {}) {
  assertIsoDate(eventDate, 'eventDate');
  const t0 = firstIndexOnOrAfter(aligned.dates, eventDate);
  if (t0 >= aligned.dates.length) return null;
  const estStart = Math.max(0, t0 + estimation.start);
  const estEnd = t0 + estimation.end;
  if (estEnd - estStart < estimation.minObservations) return null;
  const estAsset = aligned.asset.slice(estStart, estEnd);
  const estMarket = aligned.market.slice(estStart, estEnd);
  let fit;
  if (model === 'mean') {
    const m = mean(estAsset);
    fit = { alpha: m, beta: 0, residualStd: sampleStd(estAsset), n: estAsset.length };
  } else {
    fit = olsFit(estMarket, estAsset);
  }
  if (!fit || !(fit.residualStd > 0)) return null;

  const cars = {};
  for (const h of horizons) {
    const last = t0 + h - 1;
    if (last >= aligned.dates.length || (asOf && aligned.dates[last] > asOf)) {
      cars[h] = null;
      continue;
    }
    let car = 0;
    for (let i = t0; i <= last; i += 1) car += aligned.asset[i] - (fit.alpha + fit.beta * aligned.market[i]);
    cars[h] = { car, scar: car / (fit.residualStd * Math.sqrt(h)), endDate: aligned.dates[last] };
  }
  return { eventDate, day0: aligned.dates[t0], beta: fit.beta, residualStd: fit.residualStd, cars };
}

function daysBetween(a, b) {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

/**
 * Drop events of the same class that fall within `minGapDays` calendar days
 * of the last kept one. Overlapping windows double-count one market move and
 * shrink standard errors that should not shrink.
 */
export function declusterEvents(events, { minGapDays = 30 } = {}) {
  const byClass = new Map();
  for (const event of events) {
    assertIsoDate(event.date, 'event.date');
    const list = byClass.get(event.eventClass) ?? [];
    list.push(event);
    byClass.set(event.eventClass, list);
  }
  const kept = [];
  for (const list of byClass.values()) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let lastDate = null;
    for (const event of list) {
      if (lastDate && daysBetween(lastDate, event.date) < minGapDays) continue;
      kept.push(event);
      lastDate = event.date;
    }
  }
  return kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Summary statistics of a sample of CARs, with a two-sided t-test of mean = 0. */
export function summarizeCars(values) {
  const n = values.length;
  const m = mean(values);
  const sd = sampleStd(values);
  const se = n > 1 ? sd / Math.sqrt(n) : NaN;
  const t = se > 0 ? m / se : NaN;
  const pValue = n > 1 ? studentTTwoSidedP(t, n - 1) : NaN;
  const positives = values.filter((v) => v > 0).length;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n,
    meanCar: m,
    medianCar: n ? sorted[Math.floor((n - 1) / 2)] : NaN,
    sdCar: sd,
    tStat: t,
    pValue,
    hitRateUp: n ? positives / n : NaN,
  };
}

/**
 * Run the full study: every (event class, symbol, horizon) cell, then
 * Benjamini-Hochberg across all cells together so testing hundreds of pairs
 * does not manufacture "discoveries".
 *
 * @param {object} input
 * @param {Array<{id?: string, date: string, eventClass: string}>} input.events
 * @param {Record<string, Array>} input.barsBySymbol
 * @param {string} input.marketSymbol  benchmark used by the market model
 * @param {string} [input.asOf]        windows ending after this date are excluded
 */
export function runEventStudy({
  events,
  barsBySymbol,
  marketSymbol,
  asOf = null,
  horizons = DEFAULT_HORIZONS,
  estimation = DEFAULT_ESTIMATION,
  minEvents = 8,
  fdrQ = 0.1,
  minGapDays = 30,
}) {
  const marketBars = barsBySymbol[marketSymbol];
  if (!marketBars?.length) throw new Error(`runEventStudy: no bars for market symbol ${marketSymbol}`);
  const marketReturns = dailyReturns(marketBars);
  const usable = declusterEvents(
    events.filter((e) => !asOf || e.date <= asOf),
    { minGapDays },
  );
  const classes = [...new Set(usable.map((e) => e.eventClass))].sort();

  const cells = [];
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    const aligned = alignReturns(dailyReturns(bars), marketReturns);
    const model = symbol === marketSymbol ? 'mean' : 'market';
    for (const eventClass of classes) {
      const perHorizon = new Map(horizons.map((h) => [h, []]));
      const eventIds = new Map(horizons.map((h) => [h, []]));
      for (const event of usable) {
        if (event.eventClass !== eventClass) continue;
        const result = computeEventCar(aligned, event.date, { horizons, estimation, model, asOf });
        if (!result) continue;
        for (const h of horizons) {
          const cell = result.cars[h];
          if (!cell) continue;
          perHorizon.get(h).push(cell.car);
          eventIds.get(h).push(event.id ?? event.date);
        }
      }
      for (const h of horizons) {
        const values = perHorizon.get(h);
        if (values.length < minEvents) continue;
        cells.push({ eventClass, symbol, horizon: h, eventIds: eventIds.get(h), ...summarizeCars(values) });
      }
    }
  }

  const { adjusted, rejected } = benjaminiHochberg(cells.map((c) => c.pValue), fdrQ);
  return cells.map((cell, i) => ({ ...cell, qValue: adjusted[i], significant: rejected[i] }));
}

/**
 * Out-of-sample validation. Fit on events before `splitDate`, test on events
 * from `splitDate` on. A cell survives only if it was significant in-sample
 * AND the out-of-sample mean has the same sign with p below `testAlpha`.
 * Survivors are the only cells allowed to generate live signals.
 */
export function validateOutOfSample({ events, splitDate, testAlpha = 0.1, ...options }) {
  assertIsoDate(splitDate, 'splitDate');
  const dayBefore = new Date(Date.parse(`${splitDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const train = runEventStudy({ ...options, events: events.filter((e) => e.date < splitDate), asOf: dayBefore });
  const test = runEventStudy({ ...options, events: events.filter((e) => e.date >= splitDate), minEvents: Math.min(options.minEvents ?? 8, 5) });
  const testByKey = new Map(test.map((c) => [`${c.eventClass}|${c.symbol}|${c.horizon}`, c]));
  return train
    .filter((cell) => cell.significant)
    .map((cell) => {
      const oos = testByKey.get(`${cell.eventClass}|${cell.symbol}|${cell.horizon}`) ?? null;
      const survives = Boolean(oos)
        && Math.sign(oos.meanCar) === Math.sign(cell.meanCar)
        && oos.pValue < testAlpha;
      return { ...cell, outOfSample: oos, survives };
    });
}
