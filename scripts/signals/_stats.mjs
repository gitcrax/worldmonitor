// Pure statistics shared by the market signal engine. No I/O, no globals:
// every random draw comes from a caller-seeded generator so replays are
// deterministic.

export function mean(values) {
  if (!values.length) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample standard deviation (n - 1). NaN below two observations. */
export function sampleStd(values) {
  if (values.length < 2) return NaN;
  const m = mean(values);
  let ss = 0;
  for (const v of values) ss += (v - m) ** 2;
  return Math.sqrt(ss / (values.length - 1));
}

/** Linear-interpolated quantile (type 7, the R and NumPy default). */
export function quantile(values, q) {
  if (!values.length) return NaN;
  if (!(q >= 0 && q <= 1)) throw new RangeError(`quantile q must be in [0,1], got ${q}`);
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Lanczos approximation (g = 7, n = 9); accurate to ~1e-15 for x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Continued fraction for the incomplete beta function (modified Lentz).
function betaContinuedFraction(a, b, x) {
  const MAX_ITER = 300;
  const EPS = 3e-14;
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Two-sided p-value of a Student-t statistic with `df` degrees of freedom. */
export function studentTTwoSidedP(t, df) {
  if (!Number.isFinite(t) || !(df > 0)) return NaN;
  return regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/**
 * Benjamini-Hochberg false-discovery control. Returns, in input order, the
 * BH-adjusted p-value and whether each hypothesis is rejected at level `q`.
 * Non-finite p-values are never rejected and do not count toward m.
 */
export function benjaminiHochberg(pValues, q = 0.1) {
  const indexed = pValues
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => Number.isFinite(p));
  const m = indexed.length;
  const adjusted = new Array(pValues.length).fill(NaN);
  const rejected = new Array(pValues.length).fill(false);
  if (!m) return { adjusted, rejected };
  indexed.sort((a, b) => a.p - b.p);
  let running = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const { p, i } = indexed[rank - 1];
    running = Math.min(running, (p * m) / rank);
    adjusted[i] = Math.min(1, running);
  }
  for (const { i } of indexed) rejected[i] = adjusted[i] <= q;
  return { adjusted, rejected };
}

/** Mulberry32: tiny, fast, deterministic PRNG returning floats in [0, 1). */
export function createRng(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng, maxExclusive) {
  return Math.floor(rng() * maxExclusive);
}

/** Standard normal draw (Box-Muller) from a seeded generator. */
export function normalDraw(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Ordinary least squares of y on x: { alpha, beta, residualStd, n }. */
export function olsFit(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  let ss = 0;
  for (let i = 0; i < n; i += 1) ss += (y[i] - alpha - beta * x[i]) ** 2;
  return { alpha, beta, residualStd: Math.sqrt(ss / (n - 2)), n };
}
