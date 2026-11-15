#!/usr/bin/env node
// Daily price archive worker for the private market signal engine.
//
// First run backfills from SIGNALS_BACKFILL_START (default 2010-01-01); later
// runs refetch the last ~2 weeks and merge, so Yahoo's revisions to adjusted
// closes are picked up. Storage is one JSON object per symbol in R2.
//
//   node scripts/signals/archive-prices.mjs                     # R2 (needs SIGNALS_ENGINE_ENABLED=1)
//   node scripts/signals/archive-prices.mjs --local ./.signals  # local files, no credentials
//   node scripts/signals/archive-prices.mjs --local ./.signals --symbols ^GSPC,XLE

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getR2JsonObject, putR2JsonObject, resolveR2StorageConfig } from '../_r2-storage.mjs';
import { loadEnvFile, writeSeedMeta } from '../_seed-utils.mjs';
import { fetchYahooJson } from '../_yahoo-fetch.mjs';
import { isMainModule } from '../lib/main-module.mjs';
import {
  buildArchiveDocument,
  loadArchiveUniverse,
  mergeBars,
  parseYahooDailyBars,
  priceArchiveKey,
  validateBars,
} from './_price-archive.mjs';

export const PRICE_ARCHIVE_SEED_KEY = 'signals:price-archive:v1';
const YAHOO_STAGGER_MS = 150;
const REFRESH_LOOKBACK_DAYS = 14;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { local: null, symbols: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--local') args.local = argv[++i];
    else if (argv[i] === '--symbols') args.symbols = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

function createStore({ local, env }) {
  if (local) {
    const pathFor = (symbol) => join(local, priceArchiveKey(symbol));
    return {
      label: `local:${local}`,
      async get(symbol) {
        try { return JSON.parse(await readFile(pathFor(symbol), 'utf8')); } catch { return null; }
      },
      async put(symbol, doc) {
        await mkdir(join(local, priceArchiveKey(symbol), '..'), { recursive: true });
        await writeFile(pathFor(symbol), JSON.stringify(doc));
      },
      async putIndex(index) {
        await writeFile(join(local, priceArchiveKey('_index'), '..', '_index.json'), JSON.stringify(index, null, 2));
      },
    };
  }
  const config = resolveR2StorageConfig(env, { bucketEnv: 'SIGNALS_R2_BUCKET', prefixEnv: 'SIGNALS_R2_PREFIX' });
  if (!config) throw new Error('R2 is not configured; pass --local <dir> to archive to disk instead');
  const prefix = env.SIGNALS_R2_PREFIX ?? '';
  return {
    label: `r2:${config.bucket}`,
    get: (symbol) => getR2JsonObject(config, priceArchiveKey(symbol, prefix)),
    put: (symbol, doc) => putR2JsonObject(config, priceArchiveKey(symbol, prefix), doc),
    putIndex: (index) => putR2JsonObject(config, priceArchiveKey('_index', prefix), index),
  };
}

function period1For(existing, backfillStart) {
  if (existing?.lastDate) {
    return Math.floor(Date.parse(`${existing.lastDate}T00:00:00Z`) / 1000) - REFRESH_LOOKBACK_DAYS * 86_400;
  }
  return Math.floor(Date.parse(`${backfillStart}T00:00:00Z`) / 1000);
}

export async function archiveSymbol(symbol, { store, backfillStart, nowMs = Date.now(), fetchJson = fetchYahooJson }) {
  const existing = await store.get(symbol);
  const period1 = period1For(existing, backfillStart);
  const period2 = Math.floor(nowMs / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
  const incoming = parseYahooDailyBars(await fetchJson(url, { label: symbol }));
  if (!incoming.length && !existing) return { symbol, status: 'empty', bars: 0 };
  const bars = validateBars(symbol, mergeBars(existing?.bars ?? [], incoming));
  const doc = buildArchiveDocument(symbol, bars, nowMs);
  await store.put(symbol, doc);
  return { symbol, status: 'ok', bars: bars.length, firstDate: doc.firstDate, lastDate: doc.lastDate, added: bars.length - (existing?.bars?.length ?? 0) };
}

export async function runPriceArchive({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  if (!args.local && env.SIGNALS_ENGINE_ENABLED !== '1') {
    console.log('[signals] SIGNALS_ENGINE_ENABLED is not 1; price archive skipped');
    return { skipped: true };
  }
  const store = createStore({ local: args.local, env });
  const backfillStart = env.SIGNALS_BACKFILL_START || '2010-01-01';
  const symbols = args.symbols ?? loadArchiveUniverse();
  console.log(`[signals] archiving ${symbols.length} symbols to ${store.label} (backfill from ${backfillStart})`);

  const results = [];
  for (const symbol of symbols) {
    try {
      const result = await archiveSymbol(symbol, { store, backfillStart });
      results.push(result);
      console.log(`  ${symbol}: ${result.status} ${result.bars} bars (${result.firstDate ?? '-'} → ${result.lastDate ?? '-'}, +${result.added ?? 0})`);
    } catch (err) {
      results.push({ symbol, status: 'error', error: String(err?.message ?? err) });
      console.warn(`  ${symbol}: error ${err?.message ?? err}`);
    }
    await sleep(YAHOO_STAGGER_MS);
  }

  const ok = results.filter((r) => r.status === 'ok');
  const index = { updatedAt: new Date().toISOString(), symbols: results };
  await store.putIndex(index);
  if (!args.local) await writeSeedMeta(PRICE_ARCHIVE_SEED_KEY, ok.length);
  console.log(`[signals] done: ${ok.length}/${symbols.length} archived, ${results.length - ok.length} failed or empty`);
  if (!ok.length) process.exitCode = 1;
  return { results };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  loadEnvFile(import.meta.url);
  await runPriceArchive();
}
