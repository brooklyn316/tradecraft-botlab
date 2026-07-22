// ============================================================
// Group F — Pure Technical / Thematic Strategies (18 bots)
// F1–F15: sector focus, technical signals, position styles
// F16: news sentiment  F17/F18: 3-5-7 sizing / profit-taking rules
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

// ── F16 — News Sentiment Bot ────────────────────────────────────
// Buys the name with the clearest positive recent news tone, exits any
// holding whose tone has turned clearly negative. Sentiment comes from
// GDELT's free Average Tone score (roughly -10..+10 in practice; real
// headline coverage, no API key required) — fetched and cached in
// external_data_cache by /api/cron/run-bots (~once/day, see
// fetchNewsSentiment there), never called directly from here.

export const NEWS_SYMBOL_NAMES: Record<string, string> = {
  AAPL:  "Apple Inc",
  MSFT:  "Microsoft Corp",
  GOOGL: "Google",
  AMZN:  "Amazon.com",
  TSLA:  "Tesla Inc",
  NVDA:  "Nvidia Corp",
  META:  "Meta Platforms",
  JPM:   "JPMorgan Chase",
  XOM:   "ExxonMobil",
  DIS:   "Walt Disney Company",
};

interface NewsSentiment {
  symbol: string;
  avg_tone: number;
  coverage_buckets: number;
}

export async function runF16(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, holdings, prices, portfolio } = ctx;
  const symbols = Object.keys(NEWS_SYMBOL_NAMES);

  const { data: rows } = await supabase
    .from("external_data_cache")
    .select("key, payload")
    .eq("source", "news_sentiment")
    .in("key", symbols);
  const sentimentMap = new Map<string, NewsSentiment>(
    (rows ?? []).map((r: { key: string; payload: NewsSentiment }) => [r.key, r.payload])
  );

  if (sentimentMap.size === 0) {
    return ["F16: no news sentiment data in cache yet — skipping"];
  }

  // Exit anything whose news has turned clearly negative
  for (const h of [...holdings]) {
    const sentiment = sentimentMap.get(h.symbol);
    if (sentiment && sentiment.coverage_buckets >= 2 && sentiment.avg_tone <= -2) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `F16: news tone turned negative (${sentiment.avg_tone.toFixed(2)}) — exiting` });
      logs.push(`F16 exit ${h.symbol}: ${result.message}`);
    }
  }

  let best: { symbol: string; sentiment: NewsSentiment } | null = null;
  for (const symbol of symbols) {
    if (holdings.some(h => h.symbol === symbol)) continue;
    const sentiment = sentimentMap.get(symbol);
    if (!sentiment || sentiment.coverage_buckets < 2) continue;
    if (sentiment.avg_tone >= 2 && (!best || sentiment.avg_tone > best.sentiment.avg_tone)) {
      best = { symbol, sentiment };
    }
  }

  if (!best) {
    logs.push("F16: no symbol with clearly positive news tone right now");
    return logs;
  }
  if (!prices.get(best.symbol)?.price) {
    logs.push(`F16: ${best.symbol} has positive tone but no live price — skipping`);
    return logs;
  }
  const spend = portfolio.cash_balance * 0.3;
  if (spend < 1) { logs.push("F16: insufficient cash"); return logs; }
  const result = await executeTrade({ ctx, symbol: best.symbol, action: "buy", amount: spend, reason: `F16: positive news tone (${best.sentiment.avg_tone.toFixed(2)}) — ${best.sentiment.coverage_buckets} recent mentions` });
  logs.push(`F16 buy ${best.symbol}: ${result.message}`);
  return logs;
}

// ── F17 — 3-5-7 Position Scaling ────────────────────────────────
// Classic position-sizing discipline: a first entry risks 3% of portfolio;
// a second tranche brings it to 5% if the trade is working; a third brings
// it to a hard-capped 7% if it's still working. Never adds to a loser —
// only pyramids into strength. This bot is about SIZING discipline, not
// signal generation, so the entry/add filter is kept minimal: price above
// its own 10-day average.

const F17_TIERS = [0.03, 0.05, 0.07]; // cumulative % of portfolio

export async function runF17(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { holdings, prices, portfolio, history } = ctx;

  // Safety stop — the 3-5-7 rule is about sizing into winners, not about
  // holding a loser indefinitely.
  for (const h of [...holdings]) {
    const priceRow = prices.get(h.symbol);
    if (!priceRow?.price) continue;
    const change = (priceRow.price - h.avg_cost) / h.avg_cost;
    if (change <= -0.05) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `F17: stop-loss at -5% — the trade stopped working, exit and reset` });
      logs.push(`F17 stop ${h.symbol}: ${result.message}`);
    }
  }

  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);

  for (const symbol of F_UNIVERSE) {
    const hist     = history.get(symbol);
    const priceRow = prices.get(symbol);
    if (!hist || hist.length < 10 || !priceRow?.price) continue;
    const avg10     = hist.slice(-10).reduce((s, d) => s + d.close, 0) / 10;
    const inUptrend = priceRow.price > avg10;

    const holding      = holdings.find(h => h.symbol === symbol);
    const currentValue = (holding?.shares ?? 0) * priceRow.price;
    const currentPct   = portfolioTotal > 0 ? currentValue / portfolioTotal : 0;
    const unrealizedGain = holding ? (priceRow.price - holding.avg_cost) / holding.avg_cost : 0;

    if (holding && unrealizedGain < 0) continue; // never pyramid into a loser
    if (!inUptrend) continue;

    const nextTier = F17_TIERS.find(t => t > currentPct + 0.001);
    if (!nextTier) continue; // already at or above the 7% cap

    const targetValue = portfolioTotal * nextTier;
    const spend = Math.min(targetValue - currentValue, portfolio.cash_balance);
    if (spend < 1) continue;

    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `F17: ${holding ? "adding to" : "opening"} position — scaling to ${(nextTier * 100).toFixed(0)}% tier (10-day uptrend)` });
    logs.push(`F17 ${holding ? "add" : "open"} ${symbol}: ${result.message}`);
    break; // one tranche action per tick
  }

  if (logs.length === 0) logs.push("F17: no qualifying uptrend entries this check");
  return logs;
}

// ── F18 — 3-5-7 Profit Taking ───────────────────────────────────
// Classic scale-out discipline: sell a third of the position at +3% gain,
// half of what's left (≈another third of the original) at +5%, and the
// remainder at +7% — banking profit in stages instead of all-or-nothing.
// Needs to remember which tiers have already been taken per holding
// (bot_holdings.profit_tier), since price sitting above +3% on every
// subsequent tick would otherwise re-trigger the same partial sell forever.

const F18_TIERS = [
  { pct: 0.03, tier: 1, fraction: 1 / 3 },
  { pct: 0.05, tier: 2, fraction: 0.5 },
  { pct: 0.07, tier: 3, fraction: 1 },
];

export async function runF18(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, bot, holdings, prices, portfolio } = ctx;

  for (const h of [...holdings]) {
    const priceRow = prices.get(h.symbol);
    if (!priceRow?.price) continue;
    const gain = (priceRow.price - h.avg_cost) / h.avg_cost;
    const next = F18_TIERS.find(t => t.tier > h.profit_tier && gain >= t.pct);
    if (!next) continue;

    const amount = next.fraction === 1 ? "all" : h.shares * next.fraction;
    const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount, reason: `F18: +${(next.pct * 100).toFixed(0)}% tier reached — banking ${next.fraction === 1 ? "the rest" : `${(next.fraction * 100).toFixed(0)}% of the position`}` });
    logs.push(`F18 tier${next.tier} ${h.symbol}: ${result.message}`);

    if (result.success && next.fraction !== 1) {
      await supabase.from("bot_holdings").update({ profit_tier: next.tier }).eq("bot_id", bot.id).eq("symbol", h.symbol);
    }
  }

  for (const symbol of F_UNIVERSE) {
    if (holdings.some(h => h.symbol === symbol)) continue;
    const priceRow = prices.get(symbol);
    if (!priceRow?.price || (priceRow.change_percent ?? 0) < 2) continue;
    const spend = portfolio.cash_balance * 0.25;
    if (spend < 1) continue;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `F18: entering on today's +${(priceRow.change_percent ?? 0).toFixed(1)}% move — will scale out at +3/+5/+7%` });
    logs.push(`F18 buy ${symbol}: ${result.message}`);
    break;
  }

  if (logs.length === 0) logs.push("F18: no tier exits or new entries this check");
  return logs;
}
