// ============================================================
// Group C — Technical Analysis
// C1: RSI Reversal  C2: Breakout  C3: Mean Reversion
// ============================================================

import { BotContext, executeTrade, totalPortfolioValue } from "@/lib/botEngine";
import { GROUP_A_ALL_SYMBOLS } from "./groupA";

// Candidate universe shared with group A + B ETFs
const C_UNIVERSE = [...GROUP_A_ALL_SYMBOLS, "SPY", "QQQ"];

// ── Helpers ────────────────────────────────────────────────────

/** Returns the number of consecutive down days ending on the most recent day */
function consecutiveDownDays(closes: number[]): number {
  let count = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    if (closes[i] < closes[i - 1]) count++;
    else break;
  }
  return count;
}

/** Returns today's % change vs yesterday from price history */
function dayChangePct(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const prev = closes[closes.length - 2];
  const curr = closes[closes.length - 1];
  return prev > 0 ? (curr - prev) / prev * 100 : null;
}

// ── C1 — RSI Reversal Bot ─────────────────────────────────────
// Buy after 3 consecutive down days.
// Sell when +5% gain OR -3% loss from avg entry price.

export async function runC1(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  // Step 1: exit positions at target or stop-loss
  for (const holding of [...holdings]) {
    const price = prices.get(holding.symbol)?.price;
    if (!price) continue;
    const pnlPct = (price - holding.avg_cost) / holding.avg_cost * 100;
    if (pnlPct >= 5) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C1 take profit: +${pnlPct.toFixed(2)}%` });
      logs.push(`C1 sell ${holding.symbol}: ${result.message}`);
    } else if (pnlPct <= -3) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C1 stop-loss: ${pnlPct.toFixed(2)}%` });
      logs.push(`C1 stop ${holding.symbol}: ${result.message}`);
    }
  }

  // Step 2: scan for 3 consecutive down days
  for (const symbol of C_UNIVERSE) {
    if (holdings.find(h => h.symbol === symbol)) continue; // already holding

    const hist   = history.get(symbol) ?? [];
    const closes = hist.map(h => h.close);
    const downs  = consecutiveDownDays(closes);

    if (downs >= 3) {
      const spend  = Math.min(portfolio.cash_balance * 0.25, portfolio.cash_balance);
      if (spend < 1) break;
      const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `${downs} consecutive down days` });
      logs.push(`C1 buy ${symbol}: ${result.message}`);
    }
  }

  return logs;
}

// ── C2 — Breakout Bot ─────────────────────────────────────────
// Buy stocks up >2% today.
// Re-evaluate after 24 hours; sell if move has reversed (back below entry).

export async function runC2(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  // Step 1: exit reversed breakouts (price back below avg cost entry)
  for (const holding of [...holdings]) {
    const price = prices.get(holding.symbol)?.price;
    if (!price) continue;
    // Sell if below entry (reversal) or after being flat for a day
    if (price < holding.avg_cost) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C2: breakout reversed — price below entry` });
      logs.push(`C2 exit ${holding.symbol}: ${result.message}`);
    }
  }

  // Step 2: buy new breakouts (up >2% today)
  const breakouts = C_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .map(s => ({ symbol: s, changePct: prices.get(s)?.change_percent ?? 0 }))
    .filter(x => x.changePct > 2)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 3); // top 3 breakouts max

  for (const { symbol, changePct } of breakouts) {
    const spend  = portfolio.cash_balance * 0.25;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `Breakout: up ${changePct.toFixed(2)}% today` });
    logs.push(`C2 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── C3 — Mean Reversion Bot ───────────────────────────────────
// Buy stocks down >2% today, expecting a bounce.
// Sell at +3% recovery or cut at -5%.

export async function runC3(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  // Step 1: exit positions at recovery target or stop
  for (const holding of [...holdings]) {
    const price  = prices.get(holding.symbol)?.price;
    if (!price) continue;
    const pnlPct = (price - holding.avg_cost) / holding.avg_cost * 100;
    if (pnlPct >= 3) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C3 recovery: +${pnlPct.toFixed(2)}%` });
      logs.push(`C3 take profit ${holding.symbol}: ${result.message}`);
    } else if (pnlPct <= -5) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C3 cut: ${pnlPct.toFixed(2)}%` });
      logs.push(`C3 stop ${holding.symbol}: ${result.message}`);
    }
  }

  // Step 2: buy dips (down >2% today)
  const dips = C_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .map(s => ({ symbol: s, changePct: prices.get(s)?.change_percent ?? 0 }))
    .filter(x => x.changePct < -2)
    .sort((a, b) => a.changePct - b.changePct) // most down first
    .slice(0, 3);

  for (const { symbol, changePct } of dips) {
    const spend  = portfolio.cash_balance * 0.25;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `Dip buy: down ${changePct.toFixed(2)}% today` });
    logs.push(`C3 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── C1B — RSI Aggressive ──────────────────────────────────────
// Like C1 but triggers after only 2 consecutive down days.

export async function runC1B(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  for (const holding of [...holdings]) {
    const price = prices.get(holding.symbol)?.price;
    if (!price) continue;
    const pnlPct = (price - holding.avg_cost) / holding.avg_cost * 100;
    if (pnlPct >= 5) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C1B take profit: +${pnlPct.toFixed(2)}%` });
      logs.push(`C1B sell ${holding.symbol}: ${result.message}`);
    } else if (pnlPct <= -3) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C1B stop-loss: ${pnlPct.toFixed(2)}%` });
      logs.push(`C1B stop ${holding.symbol}: ${result.message}`);
    }
  }

  for (const symbol of C_UNIVERSE) {
    if (holdings.find(h => h.symbol === symbol)) continue;
    const hist   = history.get(symbol) ?? [];
    const closes = hist.map(h => h.close);
    const downs  = consecutiveDownDays(closes);
    if (downs >= 2) {
      const spend = Math.min(portfolio.cash_balance * 0.20, portfolio.cash_balance);
      if (spend < 1) break;
      const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `C1B: ${downs} consecutive down days (aggressive 2-day trigger)` });
      logs.push(`C1B buy ${symbol}: ${result.message}`);
    }
  }

  return logs;
}

// ── C1C — RSI Conservative ────────────────────────────────────
// Like C1 but requires 5 consecutive down days. Very patient.

export async function runC1C(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  for (const holding of [...holdings]) {
    const price = prices.get(holding.symbol)?.price;
    if (!price) continue;
    const pnlPct = (price - holding.avg_cost) / holding.avg_cost * 100;
    if (pnlPct >= 8) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C1C take profit: +${pnlPct.toFixed(2)}%` });
      logs.push(`C1C sell ${holding.symbol}: ${result.message}`);
    } else if (pnlPct <= -3) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C1C stop-loss: ${pnlPct.toFixed(2)}%` });
      logs.push(`C1C stop ${holding.symbol}: ${result.message}`);
    }
  }

  for (const symbol of C_UNIVERSE) {
    if (holdings.find(h => h.symbol === symbol)) continue;
    const hist   = history.get(symbol) ?? [];
    const closes = hist.map(h => h.close);
    const downs  = consecutiveDownDays(closes);
    if (downs >= 5) {
      const spend = Math.min(portfolio.cash_balance * 0.30, portfolio.cash_balance);
      if (spend < 1) break;
      const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `C1C: ${downs} consecutive down days (conservative 5-day trigger)` });
      logs.push(`C1C buy ${symbol}: ${result.message}`);
    }
  }

  return logs;
}

// ── C2B — Breakout Aggressive ─────────────────────────────────
// Like C2 but triggers on >1.5% moves instead of >2%.

export async function runC2B(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  for (const holding of [...holdings]) {
    const price = prices.get(holding.symbol)?.price;
    if (!price) continue;
    if (price < holding.avg_cost) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C2B: breakout reversed below entry` });
      logs.push(`C2B exit ${holding.symbol}: ${result.message}`);
    }
  }

  const breakouts = C_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .map(s => ({ symbol: s, changePct: prices.get(s)?.change_percent ?? 0 }))
    .filter(x => x.changePct > 1.5)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 3);

  for (const { symbol, changePct } of breakouts) {
    const spend = portfolio.cash_balance * 0.25;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `C2B breakout: up ${changePct.toFixed(2)}% (>1.5% trigger)` });
    logs.push(`C2B buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── C3B — Mean Reversion Aggressive ──────────────────────────
// Like C3 but catches dips on >1.5% down moves.

export async function runC3B(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  for (const holding of [...holdings]) {
    const price  = prices.get(holding.symbol)?.price;
    if (!price) continue;
    const pnlPct = (price - holding.avg_cost) / holding.avg_cost * 100;
    if (pnlPct >= 3) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C3B recovery: +${pnlPct.toFixed(2)}%` });
      logs.push(`C3B profit ${holding.symbol}: ${result.message}`);
    } else if (pnlPct <= -5) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C3B stop: ${pnlPct.toFixed(2)}%` });
      logs.push(`C3B stop ${holding.symbol}: ${result.message}`);
    }
  }

  const dips = C_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .map(s => ({ symbol: s, changePct: prices.get(s)?.change_percent ?? 0 }))
    .filter(x => x.changePct < -1.5)
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 3);

  for (const { symbol, changePct } of dips) {
    const spend = portfolio.cash_balance * 0.25;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `C3B dip: down ${changePct.toFixed(2)}% (>1.5% trigger)` });
    logs.push(`C3B buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── C4 — Trend Follower ───────────────────────────────────────
// Buys stocks trading above their 20-day MA. Sells when they fall below.

function movingAverage(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export async function runC4(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  for (const holding of [...holdings]) {
    const hist   = history.get(holding.symbol) ?? [];
    const closes = hist.map(h => h.close);
    const ma20   = movingAverage(closes, 20);
    const price  = prices.get(holding.symbol)?.price;
    if (!ma20 || !price) continue;
    if (price < ma20) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C4: price $${price.toFixed(2)} fell below 20-day MA $${ma20.toFixed(2)}` });
      logs.push(`C4 exit ${holding.symbol}: ${result.message}`);
    }
  }

  const aboveMA = C_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .filter(s => {
      const hist   = history.get(s) ?? [];
      const closes = hist.map(h => h.close);
      const ma20   = movingAverage(closes, 20);
      const price  = prices.get(s)?.price;
      return ma20 && price && price > ma20;
    })
    .slice(0, 2);

  for (const symbol of aboveMA) {
    const spend = portfolio.cash_balance * 0.25;
    if (spend < 1) break;
    const hist   = history.get(symbol) ?? [];
    const closes = hist.map(h => h.close);
    const ma20   = movingAverage(closes, 20)!;
    const price  = prices.get(symbol)!.price;
    const pctAbove = ((price - ma20) / ma20 * 100).toFixed(1);
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `C4: ${pctAbove}% above 20-day MA — uptrend confirmed` });
    logs.push(`C4 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── C5 — Counter-Trend ───────────────────────────────────────
// Buys stocks below 20-day MA expecting mean reversion. Exits when price recovers above MA.

export async function runC5(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  for (const holding of [...holdings]) {
    const hist   = history.get(holding.symbol) ?? [];
    const closes = hist.map(h => h.close);
    const ma20   = movingAverage(closes, 20);
    const price  = prices.get(holding.symbol)?.price;
    if (!ma20 || !price) continue;
    const pnlPct = (price - holding.avg_cost) / holding.avg_cost * 100;
    if (price > ma20) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C5: price recovered above 20-day MA — target hit (+${pnlPct.toFixed(1)}%)` });
      logs.push(`C5 exit ${holding.symbol}: ${result.message}`);
    } else if (pnlPct <= -7) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C5 stop: ${pnlPct.toFixed(2)}% — no reversion` });
      logs.push(`C5 stop ${holding.symbol}: ${result.message}`);
    }
  }

  const belowMA = C_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .filter(s => {
      const hist   = history.get(s) ?? [];
      const closes = hist.map(h => h.close);
      const ma20   = movingAverage(closes, 20);
      const price  = prices.get(s)?.price;
      return ma20 && price && price < ma20;
    })
    .slice(0, 2);

  for (const symbol of belowMA) {
    const spend = portfolio.cash_balance * 0.20;
    if (spend < 1) break;
    const hist     = history.get(symbol) ?? [];
    const closes   = hist.map(h => h.close);
    const ma20     = movingAverage(closes, 20)!;
    const price    = prices.get(symbol)!.price;
    const pctBelow = ((ma20 - price) / ma20 * 100).toFixed(1);
    const result   = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `C5: ${pctBelow}% below 20-day MA — counter-trend reversion play` });
    logs.push(`C5 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── C6 — Volatility Seeker ────────────────────────────────────
// Buys stocks with a large intraday range (high-low > 2% of price).
// Exits on low-volatility days (range < 0.5%).

export async function runC6(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  for (const holding of [...holdings]) {
    const p = prices.get(holding.symbol);
    if (!p?.high || !p.low || !p.price) continue;
    const rangePct = (p.high - p.low) / p.price * 100;
    if (rangePct < 0.5) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `C6: low volatility day (range ${rangePct.toFixed(2)}%) — exiting` });
      logs.push(`C6 exit ${holding.symbol}: ${result.message}`);
    }
  }

  const volatile = C_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .map(s => {
      const p = prices.get(s);
      if (!p?.high || !p.low || !p.price) return null;
      const rangePct = (p.high - p.low) / p.price * 100;
      return { symbol: s, rangePct };
    })
    .filter((x): x is { symbol: string; rangePct: number } => x !== null && x.rangePct > 2)
    .sort((a, b) => b.rangePct - a.rangePct)
    .slice(0, 2);

  for (const { symbol, rangePct } of volatile) {
    const spend = portfolio.cash_balance * 0.25;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `C6: high volatility — intraday range ${rangePct.toFixed(2)}%` });
    logs.push(`C6 buy ${symbol}: ${result.message}`);
  }

  return logs;
}
