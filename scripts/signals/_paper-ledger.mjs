// Paper-trading ledger. Pure and immutable: every operation returns a new
// ledger, so a replay from the same inputs always lands on the same equity.
// No order ever leaves this module; it only records what a trade would have
// done at prices that existed at the time.

import { createRng, mean, randomInt, sampleStd } from './_stats.mjs';

export const DEFAULT_LEDGER_CONFIG = Object.freeze({
  startingEquity: 100_000,
  costBps: 10, // per side: commission + slippage
  maxPositionWeight: 0.05,
  maxGrossExposure: 1,
});

export function createLedger(config = {}) {
  const cfg = { ...DEFAULT_LEDGER_CONFIG, ...config };
  return Object.freeze({
    config: Object.freeze(cfg),
    realizedEquity: cfg.startingEquity,
    open: Object.freeze([]),
    closed: Object.freeze([]),
  });
}

function grossExposure(ledger) {
  return ledger.open.reduce((sum, p) => sum + p.notional, 0) / ledger.realizedEquity;
}

/**
 * Open a position at `entryPrice` (the next open after the signal; never the
 * signal bar's own close). Throws on a cap breach or duplicate id rather than
 * silently resizing, so a strategy cannot hide oversizing.
 */
export function openPosition(ledger, order) {
  const { id, symbol, direction, weight, entryDate, entryPrice, horizonDays, stopPct = null } = order;
  if (!id || ledger.open.some((p) => p.id === id) || ledger.closed.some((t) => t.id === id)) {
    throw new Error(`openPosition: missing or duplicate id ${id}`);
  }
  if (direction !== 'long' && direction !== 'short') throw new Error(`openPosition: bad direction ${direction}`);
  if (!(entryPrice > 0)) throw new Error(`openPosition: bad entry price ${entryPrice}`);
  if (!(weight > 0) || weight > ledger.config.maxPositionWeight + 1e-12) {
    throw new Error(`openPosition: weight ${weight} outside (0, ${ledger.config.maxPositionWeight}]`);
  }
  if (!(Number.isInteger(horizonDays) && horizonDays > 0)) throw new Error(`openPosition: bad horizon ${horizonDays}`);
  const notional = weight * ledger.realizedEquity;
  if (grossExposure(ledger) + weight > ledger.config.maxGrossExposure + 1e-12) {
    throw new Error('openPosition: gross exposure cap exceeded');
  }
  const entryCost = notional * (ledger.config.costBps / 10_000);
  const position = Object.freeze({
    ...order,
    stopPct,
    notional,
    entryCost,
    stopPrice: stopPct == null ? null
      : direction === 'long' ? entryPrice * (1 - stopPct) : entryPrice * (1 + stopPct),
  });
  return Object.freeze({ ...ledger, open: Object.freeze([...ledger.open, position]) });
}

export function closePosition(ledger, id, { exitDate, exitPrice, reason }) {
  const position = ledger.open.find((p) => p.id === id);
  if (!position) throw new Error(`closePosition: no open position ${id}`);
  if (!(exitPrice > 0)) throw new Error(`closePosition: bad exit price ${exitPrice}`);
  if (exitDate < position.entryDate) throw new Error('closePosition: exit before entry');
  const sign = position.direction === 'long' ? 1 : -1;
  const grossReturn = sign * (exitPrice / position.entryPrice - 1);
  const exitCost = position.notional * (ledger.config.costBps / 10_000);
  const pnl = position.notional * grossReturn - position.entryCost - exitCost;
  const trade = Object.freeze({
    ...position,
    exitDate,
    exitPrice,
    exitReason: reason,
    exitCost,
    grossReturn,
    netReturn: pnl / position.notional,
    pnl,
  });
  const realizedEquity = ledger.realizedEquity + pnl;
  return Object.freeze({
    ...ledger,
    realizedEquity,
    open: Object.freeze(ledger.open.filter((p) => p.id !== id)),
    closed: Object.freeze([...ledger.closed, Object.freeze({ ...trade, equityAfter: realizedEquity })]),
  });
}

/**
 * Advance the ledger through one trading day's bar for each open symbol.
 * Stops fill at the stop price (or the open, if it gapped through). Horizon
 * exits fill at the close on the horizon-th trading day after entry.
 */
export function processDay(ledger, date, barsBySymbol) {
  let next = ledger;
  for (const position of ledger.open) {
    const bars = barsBySymbol[position.symbol] ?? [];
    const bar = bars.find((b) => b.date === date);
    if (!bar || date <= position.entryDate) continue;
    if (position.stopPrice != null) {
      const hitLong = position.direction === 'long' && bar.low <= position.stopPrice;
      const hitShort = position.direction === 'short' && bar.high >= position.stopPrice;
      if (hitLong || hitShort) {
        const gapped = position.direction === 'long' ? bar.open < position.stopPrice : bar.open > position.stopPrice;
        next = closePosition(next, position.id, { exitDate: date, exitPrice: gapped ? bar.open : position.stopPrice, reason: 'stop' });
        continue;
      }
    }
    const heldDays = bars.filter((b) => b.date >= position.entryDate && b.date <= date).length;
    if (heldDays >= position.horizonDays) {
      next = closePosition(next, position.id, { exitDate: date, exitPrice: bar.close, reason: 'horizon' });
    }
  }
  return next;
}

/** Largest peak-to-trough fall of an equity series, as a positive fraction. */
export function maxDrawdown(equitySeries) {
  let peak = -Infinity;
  let worst = 0;
  for (const value of equitySeries) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.max(worst, (peak - value) / peak);
  }
  return worst;
}

/** Annualized Sharpe of daily returns (risk-free rate assumed 0). */
export function annualizedSharpe(dailyReturns, periodsPerYear = 252) {
  const sd = sampleStd(dailyReturns);
  if (!(sd > 0)) return NaN;
  return (mean(dailyReturns) / sd) * Math.sqrt(periodsPerYear);
}

export function tradeMetrics(ledger) {
  const trades = ledger.closed;
  const returns = trades.map((t) => t.netReturn);
  const equity = [ledger.config.startingEquity, ...trades.map((t) => t.equityAfter)];
  return {
    trades: trades.length,
    hitRate: trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : NaN,
    meanNetReturn: mean(returns),
    sdNetReturn: sampleStd(returns),
    totalReturn: ledger.realizedEquity / ledger.config.startingEquity - 1,
    maxDrawdown: maxDrawdown(equity),
    pnlByClass: groupPnl(trades, (t) => t.eventClass ?? 'unknown'),
    pnlByStrategy: groupPnl(trades, (t) => t.strategy ?? 'unknown'),
  };
}

function groupPnl(trades, keyOf) {
  const out = {};
  for (const t of trades) {
    const key = keyOf(t);
    out[key] = (out[key] ?? 0) + t.pnl;
  }
  return out;
}

/**
 * Random-entry baseline: replay each closed trade on the same symbol, with
 * the same direction and holding period, from a random entry date. The
 * p-value is the share of random runs whose mean net return is at least the
 * real one. A strategy that cannot beat this has no timing skill.
 */
export function randomEntryPermutationTest(trades, barsBySymbol, { iterations = 1000, seed = 7, costBps = DEFAULT_LEDGER_CONFIG.costBps } = {}) {
  if (!trades.length) return { iterations: 0, actualMean: NaN, pValue: NaN, randomMeans: [] };
  const rng = createRng(seed);
  const actualMean = mean(trades.map((t) => t.netReturn));
  const cost = (2 * costBps) / 10_000;
  const randomMeans = [];
  let atLeast = 0;
  for (let k = 0; k < iterations; k += 1) {
    const sims = [];
    for (const t of trades) {
      const bars = barsBySymbol[t.symbol];
      const hold = t.horizonDays;
      if (!bars || bars.length <= hold + 1) continue;
      const i = randomInt(rng, bars.length - hold - 1) + 1;
      const entry = bars[i].open;
      const exit = bars[i + hold - 1].close;
      if (!(entry > 0 && exit > 0)) continue;
      const sign = t.direction === 'long' ? 1 : -1;
      sims.push(sign * (exit / entry - 1) - cost);
    }
    if (!sims.length) continue;
    const m = mean(sims);
    randomMeans.push(m);
    if (m >= actualMean) atLeast += 1;
  }
  return {
    iterations: randomMeans.length,
    actualMean,
    pValue: (atLeast + 1) / (randomMeans.length + 1),
    randomMeans,
  };
}
