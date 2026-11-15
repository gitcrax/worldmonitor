# Market signal engine (private, paper only)

This engine measures how assets moved after past classes of world events, simulates the outcomes, sizes paper positions, and keeps a ledger. That ledger decides, against pre-registered criteria, whether the engine is reliable. **It never places real orders.**

## Modules

| Module | Role |
| --- | --- |
| `_stats.mjs` | t-test p-values, Benjamini-Hochberg, OLS, quantiles, seeded RNG |
| `_lookahead-guard.mjs` | Point-in-time views. Throws on any row dated after the as-of date |
| `_event-study.mjs` | Market-model abnormal returns, CAR at +1, +5 and +20 days, declustering, BH across all cells, out-of-sample validation |
| `_simulator.mjs` | Bootstrap Monte Carlo per asset and per portfolio (joint or independent), what-if events, VaR and CVaR |
| `_sizing.mjs` | Fractional Kelly with a per-position cap. Zero size when there is no edge |
| `_paper-ledger.mjs` | Immutable paper ledger: stops, horizon exits, costs, metrics, random-entry permutation test |
| `_viability.mjs` | Pre-registered go/no-go verdict: `viable`, `inconclusive` or `not_viable` |
| `_price-archive.mjs`, `archive-prices.mjs` | Free daily price archive: Yahoo bars into one JSON object per symbol in R2 or on local disk |

## Run locally (no credentials)

```bash
node scripts/signals/archive-prices.mjs --local ./.signals --symbols ^GSPC,XLE,CL=F
```

The R2 mode needs `SIGNALS_ENGINE_ENABLED=1` and the existing `CLOUDFLARE_R2_*` credentials. `SIGNALS_R2_BUCKET` and `SIGNALS_R2_PREFIX` are optional.

## Tests

```bash
node --test tests/signals-engine.test.mjs
```

The fixtures plant a known effect in a synthetic market. The study must find that effect and reject a null class. The ledger must match a hand-computed P&L.

## Next

1. Event archive and taxonomy.
2. Predictor, using precedents and calibration.
3. Recommender.
4. Walk-forward backtest (Stage 1).
5. Frozen forward paper trial (Stage 2).
6. MCP tools and panel.
