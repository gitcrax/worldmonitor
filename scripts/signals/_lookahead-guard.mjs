// Point-in-time discipline for every backtest and live run. A model fitted
// "as of" a date may only see rows dated on or before it. Anything later is a
// look-ahead leak, and a leak silently inflates every backtest metric, so the
// guard throws instead of filtering when a caller hands it future data.

export class LookaheadError extends Error {
  constructor(label, offendingDate, asOf) {
    super(`${label}: row dated ${offendingDate} is after as-of ${asOf} (look-ahead leak)`);
    this.name = 'LookaheadError';
    this.offendingDate = offendingDate;
    this.asOf = asOf;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(value, label = 'date') {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new TypeError(`${label} must be an ISO YYYY-MM-DD string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Throw if any row's date (via `getDate`) is after `asOf`. */
export function assertNoLookahead(rows, asOf, { label = 'rows', getDate = (row) => row.date } = {}) {
  assertIsoDate(asOf, 'asOf');
  for (const row of rows) {
    const date = getDate(row);
    if (date > asOf) throw new LookaheadError(label, date, asOf);
  }
  return rows;
}

/**
 * Point-in-time view of a dataset: bars and events trimmed to `asOf`.
 * Events are visible by `knownAt` when present (the moment the system
 * learned of them), else by their occurrence date.
 */
export function asOfView({ barsBySymbol = {}, events = [] }, asOf) {
  assertIsoDate(asOf, 'asOf');
  const bars = {};
  for (const [symbol, series] of Object.entries(barsBySymbol)) {
    bars[symbol] = series.filter((bar) => bar.date <= asOf);
  }
  const visibleEvents = events.filter((event) => (event.knownAt ?? event.date) <= asOf);
  return { barsBySymbol: bars, events: visibleEvents, asOf };
}
