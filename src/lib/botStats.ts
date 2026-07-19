// Pure, DB-agnostic performance metrics computed over a single bot's
// bot_daily_snapshots history — no writes, no side effects. Used by the
// dashboard's Compare tab to rank bots on more than raw return.

export interface DailySnapshot {
  bot_id: string;
  snapshot_date: string;
  total_value: number;
  day_pnl: number;
  cumulative_return: number;
}

export interface BotStats {
  totalReturn: number;       // % — from the latest snapshot's cumulative_return
  sharpe: number | null;     // annualized Sharpe-style ratio; null if too little data or zero variance
  winDayRate: number | null; // % of days with day_pnl > 0; null with no days
  volatility: number | null; // stdev of daily returns, as %; null with fewer than 2 return samples
  days: number;
}

// Below this many snapshot days, a Sharpe-style ratio is more noise than
// signal — shown as "—" in the UI rather than a misleadingly precise number.
const MIN_DAYS_FOR_SHARPE = 5;
const TRADING_DAYS_PER_YEAR = 252;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// `snapshots` must already belong to one bot and be sorted ascending by snapshot_date.
export function computeBotStats(snapshots: DailySnapshot[]): BotStats {
  const days = snapshots.length;
  if (days === 0) {
    return { totalReturn: 0, sharpe: null, winDayRate: null, volatility: null, days: 0 };
  }

  const totalReturn = snapshots[days - 1].cumulative_return;
  const winDayRate = (snapshots.filter(s => s.day_pnl > 0).length / days) * 100;

  const dailyReturns: number[] = [];
  for (let i = 1; i < days; i++) {
    const prev = snapshots[i - 1].total_value;
    const cur = snapshots[i].total_value;
    if (prev > 0) dailyReturns.push((cur - prev) / prev);
  }

  let volatility: number | null = null;
  let sharpe: number | null = null;
  if (dailyReturns.length >= 2) {
    const sd = stdev(dailyReturns);
    volatility = sd * 100;
    if (days >= MIN_DAYS_FOR_SHARPE && sd > 0) {
      sharpe = (mean(dailyReturns) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    }
  }

  return { totalReturn, sharpe, winDayRate, volatility, days };
}
