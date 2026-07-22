// ============================================================
// Group G — YouTube-trader-inspired, rule-based
// G1: Ross Cameron (Warrior Trading) — Gap & Go
// G2: Rayner Teo — Price Action Swing
// G3: Alex Gonzalez (FxAlexG) — Set & Forget
// G4: Tori Trades (Victoria Duke) — Trendline Swing
//
// Each bot adapts a publicly-taught strategy to Botlab's actual data: large/
// mid-cap US stocks with daily OHLCV history, no small-cap/low-float scanner,
// no premarket data, no forex/futures. See bots.description (DB) for the
// per-bot caveats on what's a faithful adaptation vs. what had to change.
// ============================================================

import { BotContext, PriceHistory, executeTrade } from "@/lib/botEngine";
import { GROUP_A_ALL_SYMBOLS } from "./groupA";

// ── G1 — Ross Cameron — Gap & Go ────────────────────────────────
// Buy the strongest opening gap that's still pushing higher, cut losers fast,
// bank winners fast. Real edge window is the first ~90 minutes of the session.

function isEarlySession(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? "0");
  const totalMin = get("hour") * 60 + get("minute");
  return totalMin >= 570 && totalMin < 660; // 9:30–11:00 ET
}

export async function runG1(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  // Risk management is always on, regardless of session window.
  for (const holding of [...holdings]) {
    const priceRow = prices.get(holding.symbol);
    if (!priceRow?.price) continue;
    const changeFromCost = (priceRow.price - holding.avg_cost) / holding.avg_cost;
    if (changeFromCost <= -0.03) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `Stop-loss: down ${(changeFromCost * 100).toFixed(1)}% from entry — cut it fast` });
      logs.push(`G1 stop-out ${holding.symbol}: ${result.message}`);
    } else if (changeFromCost >= 0.08) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `Take-profit: up ${(changeFromCost * 100).toFixed(1)}% — ride it, then bank it` });
      logs.push(`G1 profit-take ${holding.symbol}: ${result.message}`);
    }
  }

  if (!isEarlySession()) {
    logs.push("G1: outside the 9:30–11:00 ET gap window — no new entries");
    return logs;
  }

  // stock_prices only ever holds the latest snapshot (overwritten every
  // tick), so there's no retained record of "what was the price relative to
  // open at each historical check." Logging every candidate ≥2% gap here —
  // qualifying or already-faded — is the only way to tell, after the fact,
  // whether the window genuinely had no opportunity or one appeared and
  // faded before a tick caught it still climbing.
  const candidates = GROUP_A_ALL_SYMBOLS
    .map(s => prices.get(s))
    .filter((p): p is NonNullable<typeof p> => !!p?.open && !!p?.prev_close && p.prev_close > 0 && !!p.price)
    .map(p => ({ p, gapPct: (p.open! - p.prev_close!) / p.prev_close! }))
    .filter(({ gapPct }) => gapPct >= 0.02); // any real gap, regardless of whether it's still climbing

  for (const { p, gapPct } of candidates) {
    const stillClimbing = p.price > p.open!;
    logs.push(`G1 candidate ${p.symbol}: gapped ${(gapPct * 100).toFixed(1)}%, ${stillClimbing ? "still above open" : `faded back to $${p.price} vs open $${p.open}`}`);
  }
  if (candidates.length === 0) {
    logs.push("G1: no symbol gapped ≥2% this check — no candidates");
  }

  const gappers = candidates
    .filter(({ p }) => p.price > p.open!) // real gap, still climbing above open
    .sort((a, b) => b.gapPct - a.gapPct)
    .slice(0, 1); // one concentrated bet at a time

  for (const { p, gapPct } of gappers) {
    if (holdings.some(h => h.symbol === p.symbol)) continue;
    const spend = portfolio.cash_balance * 0.4;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol: p.symbol, action: "buy", amount: spend, reason: `Gap & Go: opened ${(gapPct * 100).toFixed(1)}% above prior close, still pushing higher` });
    logs.push(`G1 buy ${p.symbol}: ${result.message}`);
  }

  return logs;
}

// ── G2 — Rayner Teo — Price Action Swing ────────────────────────
// No indicators: buy a bounce off recent support in an uptrend, sell at
// recent resistance, stop out below support. One swing per trade.

const G2_LOOKBACK = 15;

function supportResistance(hist: PriceHistory[]): { support: number; resistance: number; trendUp: boolean } | null {
  if (hist.length < G2_LOOKBACK) return null;
  const window = hist.slice(-G2_LOOKBACK);
  return {
    support: Math.min(...window.map(d => d.low)),
    resistance: Math.max(...window.map(d => d.high)),
    trendUp: window[window.length - 1].close > window[0].close,
  };
}

export async function runG2(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  for (const holding of [...holdings]) {
    const hist = history.get(holding.symbol);
    const priceRow = prices.get(holding.symbol);
    if (!hist || !priceRow?.price) continue;
    const sr = supportResistance(hist);
    if (!sr) continue;
    if (priceRow.price >= sr.resistance * 0.98) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `Reached ${G2_LOOKBACK}-day resistance ($${sr.resistance.toFixed(2)}) — captured the swing` });
      logs.push(`G2 sell ${holding.symbol}: ${result.message}`);
    } else if (priceRow.price < sr.support * 0.97) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `Broke below ${G2_LOOKBACK}-day support ($${sr.support.toFixed(2)}) — swing invalidated` });
      logs.push(`G2 stop ${holding.symbol}: ${result.message}`);
    }
  }

  for (const symbol of GROUP_A_ALL_SYMBOLS) {
    if (holdings.some(h => h.symbol === symbol)) continue;
    const hist = history.get(symbol);
    const priceRow = prices.get(symbol);
    if (!hist || !priceRow?.price) continue;
    const sr = supportResistance(hist);
    if (!sr || !sr.trendUp) continue;
    if (priceRow.price <= sr.support * 1.02) {
      const spend = portfolio.cash_balance * 0.3;
      if (spend < 1) break;
      const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `Bounce off ${G2_LOOKBACK}-day support ($${sr.support.toFixed(2)}) in an uptrend` });
      logs.push(`G2 buy ${symbol}: ${result.message}`);
      break; // one new swing at a time
    }
  }

  return logs;
}

// ── G3 — Alex Gonzalez (FxAlexG) — Set & Forget ─────────────────
// A held position is only ever checked against its fixed stop/target —
// deliberately not re-evaluated any other way once entered.

export async function runG3(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  for (const holding of [...holdings]) {
    const priceRow = prices.get(holding.symbol);
    if (!priceRow?.price) continue;
    const change = (priceRow.price - holding.avg_cost) / holding.avg_cost;
    if (change <= -0.03) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `Stop-loss hit (-3%, set at entry) — no second-guessing` });
      logs.push(`G3 stop ${holding.symbol}: ${result.message}`);
    } else if (change >= 0.06) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `Take-profit hit (+6%, set at entry) — no second-guessing` });
      logs.push(`G3 target ${holding.symbol}: ${result.message}`);
    }
  }

  for (const symbol of GROUP_A_ALL_SYMBOLS) {
    if (holdings.some(h => h.symbol === symbol)) continue;
    const hist = history.get(symbol);
    const priceRow = prices.get(symbol);
    if (!hist || hist.length < 10 || !priceRow?.price) continue;
    const priorHigh = Math.max(...hist.slice(-10, -1).map(d => d.high));
    if (priceRow.price > priorHigh && (priceRow.change_percent ?? 0) > 0) {
      const spend = portfolio.cash_balance * 0.3;
      if (spend < 1) break;
      const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `Breakout above the prior 10-day high ($${priorHigh.toFixed(2)}) — entering with a fixed +6%/-3% target set now` });
      logs.push(`G3 buy ${symbol}: ${result.message}`);
      break;
    }
  }

  return logs;
}

// ── G4 — Tori Trades — Trendline Swing ──────────────────────────
// A rising trendline (least-squares fit over the lookback, standing in for a
// manually-drawn one) acts as both entry and stop: buy at the line, exit the
// moment price closes below its current projected value.

const G4_LOOKBACK = 20;

function trendlineToday(hist: PriceHistory[]): { slope: number; today: number } | null {
  if (hist.length < G4_LOOKBACK) return null;
  const window = hist.slice(-G4_LOOKBACK);
  const xs = window.map((_, i) => i);
  const ys = window.map(d => d.close);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const sumXX = xs.reduce((s, x) => s + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, today: intercept + slope * (n - 1) };
}

export async function runG4(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  for (const holding of [...holdings]) {
    const hist = history.get(holding.symbol);
    const priceRow = prices.get(holding.symbol);
    if (!hist || !priceRow?.price) continue;
    const tl = trendlineToday(hist);
    if (tl && priceRow.price < tl.today) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `Closed below the ${G4_LOOKBACK}-day trendline ($${tl.today.toFixed(2)}) — exit immediately` });
      logs.push(`G4 exit ${holding.symbol}: ${result.message}`);
    }
  }

  for (const symbol of GROUP_A_ALL_SYMBOLS) {
    if (holdings.some(h => h.symbol === symbol)) continue;
    const hist = history.get(symbol);
    const priceRow = prices.get(symbol);
    if (!hist || !priceRow?.price) continue;
    const tl = trendlineToday(hist);
    if (tl && tl.slope > 0 && priceRow.price >= tl.today && priceRow.price <= tl.today * 1.02) {
      const spend = portfolio.cash_balance * 0.3;
      if (spend < 1) break;
      const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `Price at rising ${G4_LOOKBACK}-day trendline ($${tl.today.toFixed(2)}) — entry, exits if it closes below` });
      logs.push(`G4 buy ${symbol}: ${result.message}`);
      break;
    }
  }

  return logs;
}
