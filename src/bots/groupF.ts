// ============================================================
// Group F — Pure Technical / Thematic Strategies (15 bots)
// F1–F15: sector focus, technical signals, position styles
// ============================================================

import { BotContext, executeTrade, totalPortfolioValue } from "@/lib/botEngine";
import { GROUP_A_ALL_SYMBOLS } from "./groupA";
import { SECTOR_ETFS } from "./groupB";

// ── Symbol universes ────────────────────────────────────────────

export const F_UNIVERSE = [
  ...GROUP_A_ALL_SYMBOLS,
  "SPY", "QQQ", "PG", "MCD", "MRK", "ABBV", "UNH", "SLB", "OXY", "PLTR", "COIN",
  ...SECTOR_ETFS,
];

const F3_SYMBOLS  = ["JNJ", "PG", "KO", "MCD", "WMT"];
const F4_SYMBOLS  = ["TSLA", "NVDA", "AMD", "COIN", "PLTR"];
const F5_SYMBOLS  = ["AAPL", "MSFT", "NVDA", "AMD", "GOOGL", "META"];
const F6_SYMBOLS  = ["JNJ", "UNH", "PFE", "ABBV", "MRK"];
const F7_SYMBOLS  = ["JPM", "BAC", "GS", "V", "MA"];
const F8_SYMBOLS  = ["XOM", "CVX", "OXY", "SLB"];

// ── Equal-weight helper ────────────────────────────────────────

async function equalWeightRebalance(
  ctx: BotContext,
  symbols: string[],
  botCode: string
): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;
  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const target         = portfolioTotal / symbols.length;

  // Sell overweight / out-of-universe first
  for (const h of [...holdings]) {
    if (!symbols.includes(h.symbol)) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `${botCode}: not in target universe` });
      logs.push(`${botCode} exit ${h.symbol}: ${result.message}`);
      continue;
    }
    const price      = prices.get(h.symbol)?.price ?? 0;
    const currentVal = h.shares * price;
    const drift      = currentVal - target;
    const driftPct   = Math.abs(drift) / portfolioTotal;
    if (drift > 0 && driftPct > 0.07) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: drift / price, reason: `${botCode}: rebalance — overweight ${(driftPct*100).toFixed(1)}%` });
      logs.push(`${botCode} trim ${h.symbol}: ${result.message}`);
    }
  }

  // Buy underweight
  for (const symbol of symbols) {
    const price      = prices.get(symbol)?.price;
    if (!price) continue;
    const h          = holdings.find(x => x.symbol === symbol);
    const currentVal = (h?.shares ?? 0) * price;
    const deficit    = target - currentVal;
    if (deficit < 1 || portfolio.cash_balance < 1) continue;
    const spend      = Math.min(deficit, portfolio.cash_balance * 0.35);
    if (spend < 1) continue;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `${botCode}: equal-weight rebalance — underweight ${((deficit/portfolioTotal)*100).toFixed(1)}%` });
    logs.push(`${botCode} buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── F1 — 52-Week High Momentum ────────────────────────────────
// Buys stocks within 5% of their 52-week high. Sells on >8% drawdown.

export async function runF1(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  for (const h of [...holdings]) {
    const price  = prices.get(h.symbol)?.price;
    if (!price) continue;
    const pnlPct = (price - h.avg_cost) / h.avg_cost * 100;
    if (pnlPct <= -8) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `F1: momentum stopped — ${pnlPct.toFixed(1)}% from entry` });
      logs.push(`F1 stop ${h.symbol}: ${result.message}`);
    }
  }

  const nearHighs = F_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .filter(s => {
      const p = prices.get(s);
      if (!p?.week_52_high || !p.price) return false;
      return (p.week_52_high - p.price) / p.week_52_high * 100 <= 5;
    })
    .slice(0, 2);

  for (const symbol of nearHighs) {
    const spend = portfolio.cash_balance * 0.30;
    if (spend < 1) break;
    const p         = prices.get(symbol)!;
    const pctFromHi = ((p.week_52_high! - p.price) / p.week_52_high! * 100).toFixed(1);
    const result    = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `F1: ${pctFromHi}% below 52-week high — strong momentum` });
    logs.push(`F1 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── F2 — 52-Week Low Hunter ───────────────────────────────────
// Aggressively buys within 3% of 52-week low. Sells at +25%.

export async function runF2(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  for (const h of [...holdings]) {
    const price  = prices.get(h.symbol)?.price;
    if (!price) continue;
    const pnlPct = (price - h.avg_cost) / h.avg_cost * 100;
    if (pnlPct >= 25) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `F2: +${pnlPct.toFixed(1)}% profit target` });
      logs.push(`F2 sell ${h.symbol}: ${result.message}`);
    }
  }

  const nearLows = F_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .filter(s => {
      const p = prices.get(s);
      if (!p?.week_52_low || !p.price || p.week_52_low <= 0) return false;
      return (p.price - p.week_52_low) / p.week_52_low * 100 <= 3;
    })
    .slice(0, 2);

  for (const symbol of nearLows) {
    const spend = portfolio.cash_balance * 0.30;
    if (spend < 1) break;
    const p         = prices.get(symbol)!;
    const pctAbove  = ((p.price - p.week_52_low!) / p.week_52_low! * 100).toFixed(1);
    const result    = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `F2: only ${pctAbove}% above 52-week low — deep value` });
    logs.push(`F2 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── F3–F8: Sector Focus Bots ──────────────────────────────────

export async function runF3(ctx: BotContext): Promise<string[]> {
  return equalWeightRebalance(ctx, F3_SYMBOLS, "F3");
}

export async function runF4(ctx: BotContext): Promise<string[]> {
  return equalWeightRebalance(ctx, F4_SYMBOLS, "F4");
}

export async function runF5(ctx: BotContext): Promise<string[]> {
  return equalWeightRebalance(ctx, F5_SYMBOLS, "F5");
}

export async function runF6(ctx: BotContext): Promise<string[]> {
  return equalWeightRebalance(ctx, F6_SYMBOLS, "F6");
}

export async function runF7(ctx: BotContext): Promise<string[]> {
  return equalWeightRebalance(ctx, F7_SYMBOLS, "F7");
}

export async function runF8(ctx: BotContext): Promise<string[]> {
  return equalWeightRebalance(ctx, F8_SYMBOLS, "F8");
}

// ── F9 — Tight Stop-Loss ──────────────────────────────────────
// Sells any holding down >1% immediately. Buys top daily gainer.

export async function runF9(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  for (const h of [...holdings]) {
    const priceRow = prices.get(h.symbol);
    if (!priceRow?.change_percent) continue;
    if (priceRow.change_percent < -1) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `F9: tight stop — down ${priceRow.change_percent.toFixed(2)}% today` });
      logs.push(`F9 stop ${h.symbol}: ${result.message}`);
    }
  }

  const gainers = F_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .map(s => ({ symbol: s, changePct: prices.get(s)?.change_percent ?? 0 }))
    .filter(x => x.changePct > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 1);

  for (const { symbol, changePct } of gainers) {
    const spend = portfolio.cash_balance * 0.80;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `F9: top daily gainer at +${changePct.toFixed(2)}%` });
    logs.push(`F9 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── F10 — Winner Hold ─────────────────────────────────────────
// Finds the 7-day top performer and holds it. Switches when new leader emerges.

export async function runF10(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  const ranked = F_UNIVERSE
    .map(symbol => {
      const hist = history.get(symbol) ?? [];
      if (hist.length < 2) return { symbol, return7d: 0 };
      const old  = hist[Math.max(0, hist.length - 8)].close;
      const curr = hist[hist.length - 1].close;
      return { symbol, return7d: (curr - old) / old * 100 };
    })
    .sort((a, b) => b.return7d - a.return7d);

  if (ranked.length === 0) return ["F10: no history data"];
  const winner = ranked[0];
  const currentSymbols = holdings.map(h => h.symbol);

  for (const symbol of currentSymbols) {
    if (symbol !== winner.symbol) {
      const result = await executeTrade({ ctx, symbol, action: "sell", amount: "all", reason: `F10: new 7-day winner is ${winner.symbol} (${winner.return7d.toFixed(2)}%)` });
      logs.push(`F10 exit ${symbol}: ${result.message}`);
    }
  }

  if (!holdings.find(h => h.symbol === winner.symbol) && portfolio.cash_balance > 1) {
    const result = await executeTrade({ ctx, symbol: winner.symbol, action: "buy", amount: portfolio.cash_balance * 0.99, reason: `F10: 7-day leader +${winner.return7d.toFixed(2)}% — hold until dethroned` });
    logs.push(`F10 buy ${winner.symbol}: ${result.message}`);
  }

  return logs;
}

// ── F11 — Contrarian Weekly ───────────────────────────────────
// Buys the worst weekly performer expecting a bounce.

export async function runF11(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  const ranked = F_UNIVERSE
    .map(symbol => {
      const hist = history.get(symbol) ?? [];
      if (hist.length < 2) return { symbol, return7d: 0 };
      const old  = hist[Math.max(0, hist.length - 8)].close;
      const curr = hist[hist.length - 1].close;
      return { symbol, return7d: (curr - old) / old * 100 };
    })
    .sort((a, b) => a.return7d - b.return7d); // ascending — worst first

  if (ranked.length === 0) return ["F11: no history"];
  const loser = ranked[0];

  // Sell holdings that are no longer the loser
  for (const h of [...holdings]) {
    const pnlPct = (prices.get(h.symbol)?.price ?? h.avg_cost) / h.avg_cost * 100 - 100;
    if (h.symbol !== loser.symbol || pnlPct >= 5 || pnlPct <= -8) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `F11: contrarian exit — P&L ${pnlPct.toFixed(1)}%` });
      logs.push(`F11 exit ${h.symbol}: ${result.message}`);
    }
  }

  if (!holdings.find(h => h.symbol === loser.symbol) && portfolio.cash_balance > 1) {
    const result = await executeTrade({ ctx, symbol: loser.symbol, action: "buy", amount: portfolio.cash_balance * 0.80, reason: `F11: contrarian — worst 7-day performer (${loser.return7d.toFixed(2)}%) — bounce play` });
    logs.push(`F11 buy ${loser.symbol}: ${result.message}`);
  }

  return logs;
}

// ── F12 — Equal Weight All ────────────────────────────────────
// Equal-weights across entire watchlist. Max diversification.

const F12_SYMBOLS = GROUP_A_ALL_SYMBOLS.slice(0, 15); // top 15 from universe

export async function runF12(ctx: BotContext): Promise<string[]> {
  return equalWeightRebalance(ctx, F12_SYMBOLS, "F12");
}

// ── F13 — Cash Preference ─────────────────────────────────────
// Stays 70% cash. Only deploys when a stock drops >5% in one day.

export async function runF13(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  // Recover: sell anything up >5% from avg cost
  for (const h of [...holdings]) {
    const price  = prices.get(h.symbol)?.price;
    if (!price) continue;
    const pnlPct = (price - h.avg_cost) / h.avg_cost * 100;
    if (pnlPct >= 5) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `F13: recovery +${pnlPct.toFixed(1)}% — returning to cash` });
      logs.push(`F13 sell ${h.symbol}: ${result.message}`);
    }
  }

  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const maxDeploy      = portfolioTotal * 0.30; // only deploy 30%

  const extremeDips = F_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .map(s => ({ symbol: s, changePct: prices.get(s)?.change_percent ?? 0 }))
    .filter(x => x.changePct < -5)
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 1);

  for (const { symbol, changePct } of extremeDips) {
    const deployable = Math.min(maxDeploy, portfolio.cash_balance * 0.25);
    if (deployable < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: deployable, reason: `F13: extreme dip ${changePct.toFixed(2)}% — deploying limited capital` });
    logs.push(`F13 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── F14 — Multi-Day Momentum ──────────────────────────────────
// Buys stocks up 3+ consecutive days. Sells on first down day.

function consecutiveUpDays(closes: number[]): number {
  let count = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    if (closes[i] > closes[i - 1]) count++;
    else break;
  }
  return count;
}

export async function runF14(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  // Exit on any down day
  for (const h of [...holdings]) {
    const priceRow = prices.get(h.symbol);
    if (!priceRow?.change_percent) continue;
    if (priceRow.change_percent < 0) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `F14: streak broken — down ${priceRow.change_percent.toFixed(2)}% today` });
      logs.push(`F14 exit ${h.symbol}: ${result.message}`);
    }
  }

  // Buy 3+ consecutive up days
  const streakers = F_UNIVERSE
    .filter(s => !holdings.find(h => h.symbol === s))
    .map(s => {
      const hist   = history.get(s) ?? [];
      const closes = hist.map(h => h.close);
      return { symbol: s, streak: consecutiveUpDays(closes) };
    })
    .filter(x => x.streak >= 3)
    .sort((a, b) => b.streak - a.streak)
    .slice(0, 2);

  for (const { symbol, streak } of streakers) {
    const spend = portfolio.cash_balance * 0.30;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `F14: ${streak} consecutive up days — momentum streak` });
    logs.push(`F14 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── F15 — Sector Pairs ────────────────────────────────────────
// Holds the best-performing sector ETF. Exits the worst.

export async function runF15(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  const ranked = SECTOR_ETFS
    .map(symbol => {
      const hist = history.get(symbol) ?? [];
      if (hist.length < 2) return { symbol, return5d: 0 };
      const old  = hist[Math.max(0, hist.length - 6)].close;
      const curr = hist[hist.length - 1].close;
      return { symbol, return5d: (curr - old) / old * 100 };
    })
    .sort((a, b) => b.return5d - a.return5d);

  if (ranked.length === 0) return ["F15: no sector data"];
  const best  = ranked[0];
  const worst = ranked[ranked.length - 1];

  // Sell worst sector and anything not the best
  for (const h of [...holdings]) {
    if (h.symbol !== best.symbol) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `F15: rotating — ${best.symbol} leads with ${best.return5d.toFixed(2)}% 5d return` });
      logs.push(`F15 exit ${h.symbol}: ${result.message}`);
    }
  }

  logs.push(`F15: avoiding ${worst.symbol} (worst at ${worst.return5d.toFixed(2)}%)`);

  if (!holdings.find(h => h.symbol === best.symbol) && portfolio.cash_balance > 1) {
    const result = await executeTrade({ ctx, symbol: best.symbol, action: "buy", amount: portfolio.cash_balance * 0.99, reason: `F15: sector leader ${best.symbol} +${best.return5d.toFixed(2)}% 5-day` });
    logs.push(`F15 buy ${best.symbol}: ${result.message}`);
  }

  return logs;
}
