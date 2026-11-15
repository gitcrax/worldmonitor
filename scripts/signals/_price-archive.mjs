// Daily price archive: the engine's long memory for prices. One JSON object
// per symbol in R2 (free tier), merged forward every day. Pure helpers live
// here; scripts/signals/archive-prices.mjs does the I/O.

import { loadSharedConfig } from '../_seed-utils.mjs';
import { loadYahooCountryStockIndexes } from '../_country-stock-index-registry.mjs';

export const PRICE_ARCHIVE_SCHEMA_VERSION = 1;
export const PRICE_ARCHIVE_PREFIX = 'signals/prices/daily/v1';

/** R2 object key for a symbol. Yahoo symbols carry ^ = . which stay readable once encoded. */
export function priceArchiveKey(symbol, prefix = '') {
  const base = [prefix.replace(/^\/+|\/+$/g, ''), PRICE_ARCHIVE_PREFIX].filter(Boolean).join('/');
  return `${base}/${encodeURIComponent(symbol)}.json`;
}

function isoDateInZone(epochSeconds, gmtOffsetSeconds) {
  return new Date((epochSeconds + (gmtOffsetSeconds || 0)) * 1000).toISOString().slice(0, 10);
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse a Yahoo v8 chart response (interval=1d) into daily bars dated in the
 * exchange's own calendar. Bars missing open or close are dropped, not
 * zero-filled: a fake zero is a -100% return.
 */
export function parseYahooDailyBars(chart) {
  const result = chart?.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const offset = result.meta?.gmtoffset ?? 0;
  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = finite(quote.open?.[i]);
    const close = finite(quote.close?.[i]);
    if (!(open > 0) || !(close > 0)) continue;
    const date = isoDateInZone(timestamps[i], offset);
    byDate.set(date, {
      date,
      open,
      high: finite(quote.high?.[i]) ?? Math.max(open, close),
      low: finite(quote.low?.[i]) ?? Math.min(open, close),
      close,
      adjClose: finite(adj[i]) ?? close,
      volume: finite(quote.volume?.[i]),
    });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Merge freshly fetched bars over the archive. Incoming bars win on the same
 * date (Yahoo revises adjusted closes after splits and dividends).
 */
export function mergeBars(existing = [], incoming = []) {
  const byDate = new Map(existing.map((bar) => [bar.date, bar]));
  for (const bar of incoming) byDate.set(bar.date, bar);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Throws on a structurally broken series; returns it unchanged otherwise. */
export function validateBars(symbol, bars) {
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date)) throw new Error(`${symbol}: bad date ${bar.date}`);
    if (i && bars[i - 1].date >= bar.date) throw new Error(`${symbol}: dates not strictly ascending at ${bar.date}`);
    if (!(bar.open > 0 && bar.close > 0)) throw new Error(`${symbol}: non-positive price on ${bar.date}`);
  }
  return bars;
}

export function buildArchiveDocument(symbol, bars, nowMs = Date.now()) {
  return {
    schemaVersion: PRICE_ARCHIVE_SCHEMA_VERSION,
    symbol,
    source: 'yahoo',
    interval: '1d',
    updatedAt: new Date(nowMs).toISOString(),
    firstDate: bars[0]?.date ?? null,
    lastDate: bars.at(-1)?.date ?? null,
    bars,
  };
}

/**
 * The archived universe: the dashboard's stocks, sector ETFs, commodities,
 * spot ETFs and Yahoo-served country indices, de-duplicated. ^GSPC is the
 * market-model benchmark and is always first.
 */
export function loadArchiveUniverse() {
  const symbols = ['^GSPC', 'SPY'];
  const add = (list) => {
    for (const item of list ?? []) {
      const symbol = item?.symbol ?? item?.ticker;
      if (symbol) symbols.push(symbol);
    }
  };
  add(loadSharedConfig('stocks.json').symbols);
  add(loadSharedConfig('sectors.json').sectors);
  add(loadSharedConfig('commodities.json').commodities);
  for (const list of Object.values(loadSharedConfig('etfs.json'))) {
    if (Array.isArray(list)) add(list);
  }
  add(loadYahooCountryStockIndexes());
  return [...new Set(symbols)];
}
