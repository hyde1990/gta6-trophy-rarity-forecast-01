// GTA VI trophy rarity forecaster (gta6-trophy-rarity-forecast-01).
//
// Idea: a trophy's earn rate is earners / players-tracked, and the two move for different
// reasons, so forecast them separately — but how depends on what the history shows.
//
// When the history shows real movement (several distinct page states), fit each trophy's
// logit rate as a straight line in log time since release over the recent states, shrunk
// toward its last rate. Logit-linear is deliberately tame: trophy curves saturate, so a
// power law in earner counts would overshoot the target by an order of magnitude.
//
// When the history is a single flat state (launch night: the page frozen for hours), no
// slope can be fit, so use the refresh inversion the brief publishes: Exophase refreshes
// on its own schedule, the page had already been flat for hours (a refresh is due), and
// the launch-night refresh multiplied the tracked count ~6x. At a refresh the new players
// arrive holding the starter trophy (the one at 100% stays there) and almost nothing else:
// of the 3,333 new trophy-earns that refresh brought, 3,230 were the starter trophy,
// leaving ~100 spread over the other 54. So most rates collapse by ~6x, a few next-story
// trophies gain a little, and the starter stays at 100%.
//
// Quantiles are logit-normal around that median, with a spread that grows with the horizon
// and with how much the forecast leans on the prior instead of observed movement.
// Only the standard library is used. No network, no randomness: two runs write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The scored levels, each paired with the standard normal's quantile at that level
// (one array, so the two can never drift out of alignment).
const QUANTILES = [
  { level: 0.05, z: -1.645 },
  { level: 0.25, z: -0.674 },
  { level: 0.5, z: 0 },
  { level: 0.75, z: 0.674 },
  { level: 0.95, z: 1.645 },
];

// Named model constants (chosen on the scenario backtests in validation/; see README).
const SIGMA_FLOOR = 0.25; // logit spread that is always present
const SIGMA_PER_DAY = 0.45; // extra logit spread per horizon day
const SIGMA_MIN = 0.3;
const SIGMA_MAX = 1.6;
const SLOPE_CLAMP = 1.5; // logit-per-log-hour slope clamp in the trend fit
const SHRINK_PRIOR = 4; // trend weight w = n / (n + 4) toward the last rate
const TREND_FALLBACK_VAR = 0.5; // extra variance when fewer than 3 points fit
const FLAT_EXTRA_VAR = 0.65; // extra variance: the other refresh branch is live
const REFRESH_BASE = 0.25; // prior refresh probability at zero flat hours
const REFRESH_PER_HOUR = 1 / 6; // +1/6 refresh probability per flat hour
const REFRESH_CAP = 0.9;
const REFRESH_THRESHOLD = 0.5; // at or above this, forecast the refresh branch
const N_GROWTH = 6; // the launch-night refresh multiplied tracked players ~6x
const FRONTIER_BONUS = 6; // extra earners for next-story trophies at a refresh
const OTHER_BONUS = 0.5; // extra earners for other trophies at a refresh
const NO_REFRESH_DRIFT = 0.1; // logit drift per log day when no refresh comes
const SATURATED_Q05 = 99.97; // lower quantile for a trophy everybody holds
const UNSEEN_RATE = 0.01; // a trophy never seen in any read sits at the print floor

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}
interface PageRead {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; platform: string; release_date: string; source: string };
  trophies: Trophy[];
  history: PageRead[];
}

// ---- small numeric helpers (all pure and deterministic) ----

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(clampPct(x) * 10_000) / 10_000;

// Logit spread for a forecast: a floor, growth with the horizon, plus the extra
// variance of whatever the forecast leans on. Clamped to [SIGMA_MIN, SIGMA_MAX].
const sigmaFor = (horizonDays: number, extraVar: number): number =>
  Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, Math.sqrt(SIGMA_FLOOR ** 2 + SIGMA_PER_DAY ** 2 * horizonDays + extraVar)));

// Least-squares line of ys on xs: returns [intercept, slope]; slope 0 when unidentified.
function linFit(xs: number[], ys: number[]): [number, number] {
  const n = xs.length;
  if (n < 2) return [n === 1 ? ys[0] : 0, 0];
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += xs[i];
    meanY += ys[i];
  }
  meanX /= n;
  meanY /= n;
  let sumCross = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sumCross += (xs[i] - meanX) * (ys[i] - meanY);
    sumSq += (xs[i] - meanX) * (xs[i] - meanX);
  }
  const slope = sumSq > 1e-12 ? sumCross / sumSq : 0;
  return [meanY - slope * meanX, slope];
}

// ---- the forecast ----

interface State {
  h: number; // hours since the release day began
  n: number; // players tracked
  rates: Array<number | null>;
}

// Distinct page states: consecutive reads with the same player count and the same
// rates are one frozen page, not new information.
function collapseStates(c: Case, hoursSinceRelease: (iso: string) => number): State[] {
  const states: State[] = [];
  for (const read of c.history) {
    const s: State = { h: hoursSinceRelease(read.at), n: read.players_tracked, rates: read.rates };
    const prev = states[states.length - 1];
    if (
      prev !== undefined &&
      prev.n === s.n &&
      prev.rates.length === s.rates.length &&
      prev.rates.every((r, i) => r === s.rates[i])
    ) {
      continue;
    }
    states.push(s);
  }
  return states;
}

// Last known rate per trophy (last non-null read). A trophy never seen in any read
// falls back to the smallest positive last rate among the others — in practice the
// print floor — rather than an invented 1%.
function lastRates(c: Case): number[] {
  const rates: Array<number | null> = c.trophies.map((_, i) => {
    for (let j = c.history.length - 1; j >= 0; j--) {
      const r = c.history[j].rates[i];
      if (r !== null && r !== undefined) return r;
    }
    return null;
  });
  const seen = rates.filter((r): r is number => r !== null && r > 0);
  const unseen = seen.length > 0 ? Math.min(...seen) : UNSEEN_RATE;
  return rates.map((r) => (r === null ? unseen : r));
}

// Logit-linear trend in log time, shrunk toward the last rate. With fewer than
// three fitted points there is no slope to trust, so the median stays at the
// last rate with a wider spread.
function trendForecast(
  xs: number[],
  ys: number[],
  logTarget: number,
  lastLogit: number,
  horizonDays: number,
): { medianLogit: number; sigma: number } {
  if (xs.length < 3) {
    return { medianLogit: lastLogit, sigma: sigmaFor(horizonDays, TREND_FALLBACK_VAR) };
  }
  const [intercept, slopeRaw] = linFit(xs, ys);
  const slope = Math.min(SLOPE_CLAMP, Math.max(-SLOPE_CLAMP, slopeRaw));
  const fitted = intercept + slope * logTarget;
  // Residual spread of the fit, in logit units.
  let residualSumSq = 0;
  for (let j = 0; j < xs.length; j++) residualSumSq += (ys[j] - (intercept + slope * xs[j])) ** 2;
  const residual = Math.sqrt(residualSumSq / Math.max(1, xs.length - 2));
  const shrinkWeight = xs.length / (xs.length + SHRINK_PRIOR);
  return {
    medianLogit: shrinkWeight * fitted + (1 - shrinkWeight) * lastLogit,
    sigma: sigmaFor(horizonDays, residual * residual),
  };
}

// The next-story trophies — list positions 3–10, ids 3–10 in id order — are the
// ones a refresh's new cohort is already close to earning; the rest gain almost
// nothing. Keyed by trophy id, not list index, so a reordered case still works.
const isFrontier = (id: number): boolean => id >= 3 && id <= 10;

// Flat history: refresh inversion. How long the page has already been flat
// tells how due a refresh is (refreshes arrive every few hours).
function flatForecast(
  lastPct: number,
  lastPlayers: number,
  flatHours: number,
  horizonDays: number,
  frontier: boolean,
): { medianLogit: number; sigma: number } {
  const pRefresh = Math.min(REFRESH_CAP, REFRESH_BASE + flatHours * REFRESH_PER_HOUR);
  const lastEarners = Math.max(0.5, (lastPct * lastPlayers) / 100);
  let medianLogit: number;
  if (pRefresh >= REFRESH_THRESHOLD) {
    // Refresh branch: the count jumps ~6x (the launch-night refresh's size);
    // new players bring almost no earns except on the next-story trophies,
    // which gain a few earners each from the cohort already playing.
    const nPred = lastPlayers * N_GROWTH;
    const ePred = lastEarners + (frontier ? FRONTIER_BONUS : OTHER_BONUS);
    medianLogit = logit((100 * ePred) / nPred);
  } else {
    // No-refresh branch: rates drift only by slow earning.
    medianLogit = logit(lastPct) + NO_REFRESH_DRIFT * Math.log(1 + horizonDays);
  }
  // Wide spread: the other branch is live, and the refresh's size is uncertain.
  return { medianLogit, sigma: sigmaFor(horizonDays, FLAT_EXTRA_VAR) };
}

// Five quantiles around a logit-normal median, rounded to 4dp and forced monotone.
function buildQuantiles(medianLogit: number, sigma: number): number[] {
  const q = QUANTILES.map(({ z }) => round4(invLogit(medianLogit + z * sigma)));
  for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
  return q;
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const releaseMs = Date.parse(`${c.game.release_date}T00:00:00Z`);
  const releaseStart = Number.isFinite(releaseMs) ? releaseMs : Date.parse(c.history[0]?.at ?? c.at);
  const hoursSinceRelease = (iso: string): number =>
    Math.max(0.05, (Date.parse(iso) - releaseStart) / 3_600_000);
  const hNow = hoursSinceRelease(c.at);
  const hTarget = hoursSinceRelease(c.target);
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);
  const logTime = (h: number): number => Math.log(1 + h);

  const states = collapseStates(c, hoursSinceRelease);

  const lastRate = lastRates(c);
  const lastPlayers = states.length > 0 ? states[states.length - 1].n : (c.history[c.history.length - 1]?.players_tracked ?? 1000);
  // How long the page has already been flat (for the refresh-due prior).
  const flatHours = states.length > 0 ? Math.max(0, hNow - states[0].h) : 0;

  // States to fit on: the last 24 hours when they hold enough points, else all states.
  const recent = states.filter((s) => hNow - s.h <= 24);
  const fitStates = recent.length >= 3 ? recent : states;
  const hasTrend = fitStates.length >= 3;

  const rows: Array<{ id: number; q: number[] }> = c.trophies.map((t, i) => {
    const lastPct = lastRate[i];
    if (lastPct >= 99.99) {
      // Saturated: everybody tracked holds it, and the next refresh kept it there.
      return { id: t.id, q: [SATURATED_Q05, 99.99, 99.99, 99.99, 99.99] };
    }

    let medianLogit: number;
    let sigma: number;

    if (hasTrend) {
      // Logit-linear trend in log time, shrunk toward the last rate.
      const xs: number[] = [];
      const ys: number[] = [];
      for (const s of fitStates) {
        const r = s.rates[i];
        if (r === null || r === undefined) continue;
        xs.push(logTime(s.h));
        ys.push(logit(r));
      }
      ({ medianLogit, sigma } = trendForecast(xs, ys, logTime(hTarget), logit(lastPct), horizonDays));
    } else {
      ({ medianLogit, sigma } = flatForecast(lastPct, lastPlayers, flatHours, horizonDays, isFrontier(t.id)));
    }

    return { id: t.id, q: buildQuantiles(medianLogit, sigma) };
  });
  return rows;
}

// ---- driver: every *.in in name order, one *.out each, same bytes every run ----

// A valid output for a case we cannot forecast properly: last rates held flat
// with the widest spread, so the case still scores instead of going invalid.
function fallbackRows(c: Case): Array<{ id: number; q: number[] }> {
  const rates = c.history && c.history.length > 0 ? lastRates(c) : c.trophies.map(() => 1);
  return c.trophies.map((t, i) => {
    if (rates[i] >= 99.99) return { id: t.id, q: [SATURATED_Q05, 99.99, 99.99, 99.99, 99.99] };
    return { id: t.id, q: buildQuantiles(logit(rates[i]), SIGMA_MAX) };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (!c.trophies || c.trophies.length === 0) {
    console.error(`${file}: no trophies listed, skipping`);
    continue;
  }
  // The spec fixes the five levels; if a case ever asked for others, warn and
  // still write the standard five quantiles rather than failing the case.
  if (c.levels.length !== QUANTILES.length || c.levels.some((t, j) => t !== QUANTILES[j].level)) {
    console.error(`${file} asks for levels ${JSON.stringify(c.levels)}, writing standard quantiles`);
  }
  let trophies: Array<{ id: number; q: number[] }>;
  try {
    trophies = forecastCase(c);
  } catch (err) {
    console.error(`${file}: forecast failed (${err instanceof Error ? err.message : err}), writing persistence fallback`);
    trophies = fallbackRows(c);
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
