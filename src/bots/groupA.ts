// ============================================================
// Group A — US Stocks, Rule-Based
// A1: Index Bot   A2: Momentum Bot  A3: Value Bot
// A4: Dividend Bot  A5: Chaos Bot
// ============================================================

import {
  BotContext,
  executeTrade,
  totalPortfolioValue,
  holdingsValue,
  maxPositionValue,
} from "@/lib/botEngine";

// ── Symbols ────────────────────────────────────────────────────

const A1_SYMBOLS  = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA"];
const A4_SYMBOLS  = ["KO", "JNJ", "JPM", "WMT", "XOM"];

// Broad candidate pool for A2 (momentum) and A3 (value)
// Bots scan daily movers from this watchlist
export const GROUP_A_ALL_SYMBOLS = [
  ...A1_SYMBOLS, ...A4_SYMBOLS,
  "TSLA", "META", "AMD", "NFLX", "COIN",
  "DIS", "BAC", "GS", "V", "MA",
  "PFE", "ABBV", "UNH", "CVX", "LMT",
];

// ── A1 — Index Bot ────────────────────────────────────────────
// Equal-weight across 5 blue chips. Trades only on >10% drift.

export async function runA1(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const targetPct      = 1 / A1_SYMBOLS.length;         // 0.20 each
  const targetValue    = portfolioTotal * targetPct;

  // Check each symbol for drift
  for (const symbol of A1_SYMBOLS) {
    const price = prices.get(symbol)?.price;
    if (!price) { logs.push(`A1: no price for ${symbol}`); continue; }

    const holding     = holdings.find(h => h.symbol === symbol);
    const currentVal  = (holding?.shares ?? 0) * price;
    const driftPct    = portfolioTotal > 0 ? Math.abs(currentVal - targetValue) / portfolioTotal : 1;

    if (driftPct < 0.10) continue; // within tolerance

    if (currentVal > targetValue) {
      // Overweight — sell excess
      const excessValue  = currentVal - targetValue;
      const sharesToSell = excessValue / price;
      if (sharesToSell < 0.0001) continue;
      const result = await executeTrade({ ctx, symbol, action: "sell", amount: sharesToSell, reason: `Overweight by ${(driftPct*100).toFixed(1)}%` });
      logs.push(`A1 sell ${symbol}: ${result.message}`);
    } else {
      // Underweight — buy up to target (limited by cash and position cap)
      const deficitValue = targetValue - currentVal;
      const result = await executeTrade({ ctx, symbol, action: "buy", amount: deficitValue, reason: `Underweight by ${(driftPct*100).toFixed(1)}%` });
      logs.push(`A1 buy ${symbol}: ${result.message}`);
    }
  }

  return logs;
}

// ── A2 — Momentum Bot ─────────────────────────────────────────
// Buy top 2 stocks up >1% today (35% of cash per buy).
// Sell any holding that drops >2% in a single day.

export async function runA2(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  // Step 1: cut losing positions
  for (const holding of [...holdings]) {
    const priceRow = prices.get(holding.symbol);
    if (!priceRow?.change_percent) continue;
    if (priceRow.change_percent < -2) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `Down ${priceRow.change_percent.toFixed(2)}% today` });
      logs.push(`A2 cut ${holding.symbol}: ${result.message}`);
    }
  }

  // Step 2: find today's gainers (>1% up)
  const gainers = GROUP_A_ALL_SYMBOLS
    .map(s => ({ symbol: s, changePct: prices.get(s)?.change_percent ?? 0 }))
    .filter(x => x.changePct > 1)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 2);

  for (const { symbol, changePct } of gainers) {
    const spendAmount = portfolio.cash_balance * 0.35;
    if (spendAmount < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spendAmount, reason: `Up ${changePct.toFixed(2)}% today` });
    logs.push(`A2 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── A3 — Value Bot ────────────────────────────────────────────
// Buy stocks near 52-week low. Sell when +15% from avg cost.

export async function runA3(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  // Step 1: take profit on any +15% position
  for (const holding of [...holdings]) {
    const price = prices.get(holding.symbol)?.price;
    if (!price) continue;
    const gain = (price - holding.avg_cost) / holding.avg_cost * 100;
    if (gain >= 15) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `+${gain.toFixed(1)}% profit target hit` });
      logs.push(`A3 sell ${holding.symbol}: ${result.message}`);
    }
  }

  // Step 2: look for value buys (price within 10% of 52-week low)
  const candidates = GROUP_A_ALL_SYMBOLS.filter(s => {
    const p = prices.get(s);
    if (!p?.week_52_low || !p.price) return false;
    const pctAboveLow = (p.price - p.week_52_low) / p.week_52_low * 100;
    return pctAboveLow <= 10; // within 10% of 52-week low
  });

  if (candidates.length === 0) return logs;

  // Buy up to 2 candidates, spend 25% of cash each
  for (const symbol of candidates.slice(0, 2)) {
    const spendAmount = portfolio.cash_balance * 0.25;
    if (spendAmount < 1) break;
    const p = prices.get(symbol)!;
    const pctAboveLow = ((p.price - p.week_52_low!) / p.week_52_low! * 100).toFixed(1);
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spendAmount, reason: `${pctAboveLow}% above 52-week low` });
    logs.push(`A3 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── A4 — Dividend Bot ─────────────────────────────────────────
// Hold KO, JNJ, JPM, WMT, XOM. Never sells unless forced (dormancy).
// On each run: buy any missing position with available cash.

export async function runA4(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const targetPct      = 1 / A4_SYMBOLS.length;
  const targetValue    = portfolioTotal * targetPct;

  for (const symbol of A4_SYMBOLS) {
    const price   = prices.get(symbol)?.price;
    if (!price) continue;

    const holding    = holdings.find(h => h.symbol === symbol);
    const currentVal = (holding?.shares ?? 0) * price;

    if (currentVal >= targetValue * 0.9) continue; // close enough

    const deficit = targetValue - currentVal;
    const spend   = Math.min(deficit, portfolio.cash_balance * 0.30); // buy in chunks
    if (spend < 1) continue;

    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: "Dividend Bot initial/rebalance buy" });
    logs.push(`A4 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── A5 — Chaos Bot ────────────────────────────────────────────
// 35% chance: do nothing. Otherwise: random buy or sell.

export async function runA5(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  // 35% chance of doing nothing
  if (Math.random() < 0.35) {
    return ["A5: idle (random)"];
  }

  const action = Math.random() < 0.5 ? "buy" : "sell";

  if (action === "sell" && holdings.length > 0) {
    const holding = holdings[Math.floor(Math.random() * holdings.length)];
    const sellFraction = 0.2 + Math.random() * 0.8;
    const sharesToSell = holding.shares * sellFraction;
    const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: sharesToSell, reason: "Chaos Bot random sell" });
    logs.push(`A5 random sell: ${result.message}`);
  } else if (action === "buy" && portfolio.cash_balance > 10) {
    const symbol    = GROUP_A_ALL_SYMBOLS[Math.floor(Math.random() * GROUP_A_ALL_SYMBOLS.length)];
    const spendFrac = 0.05 + Math.random() * 0.15;
    const spend     = portfolio.cash_balance * spendFrac;
    const result    = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: "Chaos Bot random buy" });
    logs.push(`A5 random buy: ${result.message}`);
  } else {
    logs.push("A5: no valid action (no holdings or no cash)");
  }

  return logs;
}

// ── A2B — Momentum Aggressive ─────────────────────────────────
// Same as A2 but triggers on >0.5% moves. More frequent trading.

export async function runA2B(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  for (const holding of [...holdings]) {
    const priceRow = prices.get(holding.symbol);
    if (!priceRow?.change_percent) continue;
    if (priceRow.change_percent < -1) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `A2B cut: down ${priceRow.change_percent.toFixed(2)}% today` });
      logs.push(`A2B cut ${holding.symbol}: ${result.message}`);
    }
  }

  const gainers = GROUP_A_ALL_SYMBOLS
    .map(s => ({ symbol: s, changePct: prices.get(s)?.change_percent ?? 0 }))
    .filter(x => x.changePct > 0.5)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 3);

  for (const { symbol, changePct } of gainers) {
    const spend = portfolio.cash_balance * 0.30;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `A2B: up ${changePct.toFixed(2)}% (>0.5% threshold)` });
    logs.push(`A2B buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── A3B — Value Conservative ──────────────────────────────────
// Like A3 but requires within 5% of 52-week low. Sells at +20%.

export async function runA3B(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  for (const holding of [...holdings]) {
    const price = prices.get(holding.symbol)?.price;
    if (!price) continue;
    const gain = (price - holding.avg_cost) / holding.avg_cost * 100;
    if (gain >= 20) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `A3B profit: +${gain.toFixed(1)}% target hit` });
      logs.push(`A3B sell ${holding.symbol}: ${result.message}`);
    }
  }

  const candidates = GROUP_A_ALL_SYMBOLS.filter(s => {
    const p = prices.get(s);
    if (!p?.week_52_low || !p.price) return false;
    return (p.price - p.week_52_low) / p.week_52_low * 100 <= 5;
  });

  for (const symbol of candidates.slice(0, 2)) {
    const spend = portfolio.cash_balance * 0.25;
    if (spend < 1) break;
    const p = prices.get(symbol)!;
    const pctAboveLow = ((p.price - p.week_52_low!) / p.week_52_low! * 100).toFixed(1);
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `A3B: ${pctAboveLow}% above 52-week low (strict ≤5% threshold)` });
    logs.push(`A3B buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── A6 — Growth Chaser ────────────────────────────────────────
// Buys stocks within 5% of their 52-week HIGH.
// Thesis: stocks near highs are in strong uptrends — ride the momentum.
// Sells if they fall >8% from avg cost (trend break).

export async function runA6(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio } = ctx;

  for (const holding of [...holdings]) {
    const price = prices.get(holding.symbol)?.price;
    if (!price) continue;
    const pnlPct = (price - holding.avg_cost) / holding.avg_cost * 100;
    if (pnlPct <= -8) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: `A6 trend break: ${pnlPct.toFixed(1)}% from entry` });
      logs.push(`A6 stop ${holding.symbol}: ${result.message}`);
    }
  }

  const nearHighs = GROUP_A_ALL_SYMBOLS.filter(s => {
    const p = prices.get(s);
    if (!p?.week_52_high || !p.price) return false;
    return (p.week_52_high - p.price) / p.week_52_high * 100 <= 5;
  });

  for (const symbol of nearHighs.slice(0, 2)) {
    if (holdings.find(h => h.symbol === symbol)) continue;
    const spend = portfolio.cash_balance * 0.30;
    if (spend < 1) break;
    const p = prices.get(symbol)!;
    const pctFromHigh = ((p.week_52_high! - p.price) / p.week_52_high! * 100).toFixed(1);
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `A6: ${pctFromHigh}% below 52-week high — momentum extension` });
    logs.push(`A6 buy ${symbol}: ${result.message}`);
  }

  return logs;
}
