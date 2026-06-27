// ============================================================
// Group E — Political & Institutional Intelligence
// E1: Congress Momentum  E2: Pelosi Equity  E3: Pelosi Options
// E4: Buffett Bot  E5: ARK Bot  E6: Hedge Fund Consensus
//
// Data sources (all free / legally mandated public disclosures):
//   E1: Quiver Quantitative API (congress trades)
//       https://api.quiverquant.com/beta/live/congresstrading
//   E2/E3: Quiver Quant (same endpoint, filter by member name)
//   E4/E6: SEC EDGAR 13F filings
//          https://efts.sec.gov/LATEST/search-index?q=...&dateRange=custom
//   E5: ARK Invest public holdings CSV
//       https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv
//
// Data is cached in external_data_cache and refreshed by a separate
// daily fetch job (/api/cron/fetch-external-data).
// Bots read from the cache — they never call external APIs directly.
// ============================================================

import { BotContext, executeTrade, totalPortfolioValue } from "@/lib/botEngine";
import { SupabaseClient } from "@supabase/supabase-js";

// ── Cache readers ─────────────────────────────────────────────

async function readCache<T>(supabase: SupabaseClient, source: string, key: string): Promise<T | null> {
  const { data } = await supabase
    .from("external_data_cache")
    .select("payload")
    .eq("source", source)
    .eq("key", key)
    .single();
  return data?.payload ?? null;
}

// ── E1 — Congress Momentum Bot ────────────────────────────────
// Buy stocks bought by 3+ different Congress members in last 30 days.

interface CongressTrade {
  symbol: string;
  member: string;
  transaction: "Purchase" | "Sale";
  date: string;
  amount_range: string;
}

export async function runE1(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, holdings, prices, portfolio } = ctx;

  const trades = await readCache<CongressTrade[]>(supabase, "capitol_trades", "recent_30d");
  if (!trades || trades.length === 0) {
    return ["E1: no Capitol Trades data in cache — skipping"];
  }

  // Count unique buyers per symbol
  const buyerMap = new Map<string, Set<string>>();
  for (const t of trades) {
    if (t.transaction !== "Purchase") continue;
    if (!buyerMap.has(t.symbol)) buyerMap.set(t.symbol, new Set());
    buyerMap.get(t.symbol)!.add(t.member);
  }

  // Signals: 3+ unique buyers
  const signals = Array.from(buyerMap.entries())
    .filter(([, members]) => members.size >= 3)
    .sort((a, b) => b[1].size - a[1].size);

  if (signals.length === 0) {
    return ["E1: no stocks with 3+ Congress buyers this month"];
  }

  // Exit holdings no longer in signal set
  const signalSymbols = signals.map(([s]) => s);
  for (const holding of [...holdings]) {
    if (!signalSymbols.includes(holding.symbol)) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: "E1: no longer in Congress signal" });
      logs.push(`E1 exit ${holding.symbol}: ${result.message}`);
    }
  }

  // Buy top signals (up to 4 positions, 20% of cash each)
  for (const [symbol, members] of signals.slice(0, 4)) {
    if (holdings.find(h => h.symbol === symbol)) continue;
    if (!prices.has(symbol)) continue;
    const spend  = portfolio.cash_balance * 0.20;
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `${members.size} Congress members bought in last 30 days` });
    logs.push(`E1 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── E2 — Pelosi Equity Bot ────────────────────────────────────
// Mirror Nancy Pelosi's disclosed equity positions.

interface PelosiPosition {
  symbol: string;
  transaction: "Purchase" | "Sale" | "Exchange";
  member: "Nancy Pelosi" | "Paul Pelosi";
  asset_type: "Stock" | "Call Option" | "Put Option";
  date: string;
}

export async function runE2(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, holdings, prices, portfolio } = ctx;

  const positions = await readCache<PelosiPosition[]>(supabase, "capitol_trades", "pelosi_trades");
  if (!positions) return ["E2: no Pelosi trade data in cache — skipping"];

  // Only Nancy, only equity (not options)
  const nancyEquity = positions.filter(p =>
    p.member === "Nancy Pelosi" &&
    p.asset_type === "Stock"
  );

  const buys  = new Set(nancyEquity.filter(p => p.transaction === "Purchase").map(p => p.symbol));
  const sells = new Set(nancyEquity.filter(p => p.transaction === "Sale").map(p => p.symbol));

  // Sell anything she's sold
  for (const holding of [...holdings]) {
    if (sells.has(holding.symbol)) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: "E2: Pelosi sold this position" });
      logs.push(`E2 sell ${holding.symbol}: ${result.message}`);
    }
  }

  // Buy anything she's bought (equal weight across her portfolio)
  const targetSymbols = Array.from(buys).filter(s => prices.has(s));
  if (targetSymbols.length === 0) return [...logs, "E2: no new Pelosi buys in cache"];

  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const targetPerPos   = portfolioTotal / Math.max(targetSymbols.length, 5);

  for (const symbol of targetSymbols) {
    const holding    = holdings.find(h => h.symbol === symbol);
    const price      = prices.get(symbol)?.price ?? 0;
    const currentVal = (holding?.shares ?? 0) * price;
    const deficit    = targetPerPos - currentVal;
    if (deficit < 1) continue;
    const spend  = Math.min(deficit, portfolio.cash_balance * 0.25);
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: "E2: Nancy Pelosi disclosed purchase" });
    logs.push(`E2 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── E3 — Pelosi Options Bot ───────────────────────────────────
// Mirror Paul Pelosi's options trades, converted to shares.
// Calls = buy underlying. Puts = sell/skip.

export async function runE3(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, holdings, prices, portfolio } = ctx;

  const positions = await readCache<PelosiPosition[]>(supabase, "capitol_trades", "pelosi_trades");
  if (!positions) return ["E3: no Pelosi trade data in cache — skipping"];

  const paulOptions = positions.filter(p =>
    p.member === "Paul Pelosi" &&
    (p.asset_type === "Call Option" || p.asset_type === "Put Option")
  );

  for (const trade of paulOptions) {
    const { symbol, transaction, asset_type } = trade;
    if (!prices.has(symbol)) continue;

    if (asset_type === "Call Option" && transaction === "Purchase") {
      // Calls = bullish = buy underlying shares
      const spend  = portfolio.cash_balance * 0.30; // Paul bets big
      const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `E3: Paul Pelosi call option → buy underlying` });
      logs.push(`E3 buy ${symbol}: ${result.message}`);
    } else if (asset_type === "Put Option" || transaction === "Sale") {
      // Puts or sales = sell or skip
      const holding = holdings.find(h => h.symbol === symbol);
      if (holding) {
        const result = await executeTrade({ ctx, symbol, action: "sell", amount: "all", reason: `E3: Paul Pelosi put/sale → exit underlying` });
        logs.push(`E3 sell ${symbol}: ${result.message}`);
      }
    }
  }

  if (logs.length === 0) logs.push("E3: no new Paul Pelosi option trades in cache");
  return logs;
}

// ── E4 — Buffett Bot ──────────────────────────────────────────
// Equal weight across Berkshire's top 5 13F holdings.
// Rebalances quarterly (caller checks if 13F is new).

interface HedgeFundHolding {
  symbol: string;
  value_usd: number;
  shares: number;
  fund?: string;
}

export async function runE4(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, holdings, prices, portfolio } = ctx;

  const berkshireHoldings = await readCache<HedgeFundHolding[]>(supabase, "sec_13f", "berkshire");
  if (!berkshireHoldings || berkshireHoldings.length === 0) {
    return ["E4: no Berkshire 13F data in cache — skipping"];
  }

  // Top 5 by disclosed value
  const top5 = berkshireHoldings
    .sort((a, b) => b.value_usd - a.value_usd)
    .slice(0, 5)
    .map(h => h.symbol);

  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const targetPerPos   = portfolioTotal / 5;

  // Sell anything not in top 5
  for (const holding of [...holdings]) {
    if (!top5.includes(holding.symbol)) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: "E4: no longer in Berkshire top 5" });
      logs.push(`E4 exit ${holding.symbol}: ${result.message}`);
    }
  }

  // Rebalance top 5
  for (const symbol of top5) {
    if (!prices.has(symbol)) continue;
    const price      = prices.get(symbol)!.price;
    const holding    = holdings.find(h => h.symbol === symbol);
    const currentVal = (holding?.shares ?? 0) * price;
    const deficit    = targetPerPos - currentVal;
    if (deficit < 1) continue;
    const spend  = Math.min(deficit, portfolio.cash_balance * 0.40);
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `E4: Berkshire top-${top5.indexOf(symbol)+1} holding` });
    logs.push(`E4 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── E5 — ARK Bot ──────────────────────────────────────────────
// Top 5 from ARKK daily holdings. Rebalances weekly.

export async function runE5(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, holdings, prices, portfolio } = ctx;

  const arkHoldings = await readCache<HedgeFundHolding[]>(supabase, "ark_holdings", "ARKK");
  if (!arkHoldings || arkHoldings.length === 0) {
    return ["E5: no ARK holdings data in cache — skipping"];
  }

  const top5 = arkHoldings
    .sort((a, b) => b.value_usd - a.value_usd)
    .slice(0, 5)
    .map(h => h.symbol);

  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const targetPerPos   = portfolioTotal / 5;

  // Sell anything not in top 5
  for (const holding of [...holdings]) {
    if (!top5.includes(holding.symbol)) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: "E5: no longer in ARKK top 5" });
      logs.push(`E5 exit ${holding.symbol}: ${result.message}`);
    }
  }

  // Buy/rebalance top 5
  for (const symbol of top5) {
    if (!prices.has(symbol)) continue;
    const price      = prices.get(symbol)!.price;
    const holding    = holdings.find(h => h.symbol === symbol);
    const currentVal = (holding?.shares ?? 0) * price;
    const deficit    = targetPerPos - currentVal;
    if (deficit < 1) continue;
    const spend  = Math.min(deficit, portfolio.cash_balance * 0.40);
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `E5: ARKK top-${top5.indexOf(symbol)+1} holding` });
    logs.push(`E5 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── E6 — Hedge Fund Consensus Bot ────────────────────────────
// Buy stocks in the top 10 holdings of 5+ major hedge funds.

export async function runE6(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, holdings, prices, portfolio } = ctx;

  const consensus = await readCache<{ symbol: string; fund_count: number }[]>(supabase, "sec_13f", "consensus");
  if (!consensus || consensus.length === 0) {
    return ["E6: no 13F consensus data in cache — skipping"];
  }

  // Stocks in top 10 holdings of 5+ funds
  const signals = consensus
    .filter(c => c.fund_count >= 5)
    .sort((a, b) => b.fund_count - a.fund_count)
    .slice(0, 6); // max 6 positions

  const signalSymbols = signals.map(s => s.symbol);

  // Exit positions that fell out of consensus
  for (const holding of [...holdings]) {
    if (!signalSymbols.includes(holding.symbol)) {
      const result = await executeTrade({ ctx, symbol: holding.symbol, action: "sell", amount: "all", reason: "E6: no longer in hedge fund consensus" });
      logs.push(`E6 exit ${holding.symbol}: ${result.message}`);
    }
  }

  // Equal-weight buy
  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const targetPerPos   = portfolioTotal / signals.length;

  for (const { symbol, fund_count } of signals) {
    if (!prices.has(symbol)) continue;
    const price      = prices.get(symbol)!.price;
    const holding    = holdings.find(h => h.symbol === symbol);
    const currentVal = (holding?.shares ?? 0) * price;
    const deficit    = targetPerPos - currentVal;
    if (deficit < 1) continue;
    const spend  = Math.min(deficit, portfolio.cash_balance * 0.30);
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `E6: in top-10 of ${fund_count} hedge funds` });
    logs.push(`E6 buy ${symbol}: ${result.message}`);
  }

  return logs;
}
