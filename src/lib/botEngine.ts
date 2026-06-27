// ============================================================
// Bot Engine — Core trading runtime
// Handles: price fetching, trade execution, guards, snapshots.
// All bot strategies call these shared functions.
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ── Types ─────────────────────────────────────────────────────

export interface Bot {
  id: string;
  code: string;
  name: string;
  group_id: string;
  is_active: boolean;
}

export interface BotPortfolio {
  bot_id: string;
  cash_balance: number;
  is_dormant: boolean;
  last_traded_at: string | null;
}

export interface BotHolding {
  bot_id: string;
  symbol: string;
  shares: number;
  avg_cost: number;
  updated_at: string;
}

export interface StockPrice {
  symbol: string;
  company_name: string | null;
  price: number;
  open: number | null;
  high: number | null;
  low: number | null;
  prev_close: number | null;
  change_amount: number | null;
  change_percent: number | null;
  week_52_high: number | null;
  week_52_low: number | null;
  updated_at: string;
}

export interface PriceHistory {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface BotContext {
  supabase: SupabaseClient;
  bot: Bot;
  portfolio: BotPortfolio;
  holdings: BotHolding[];
  prices: Map<string, StockPrice>;
  history: Map<string, PriceHistory[]>; // symbol → last N days sorted asc
}

// ── Constants ─────────────────────────────────────────────────

export const STARTING_CASH      = 1000.00;
export const DORMANCY_THRESHOLD = 50.00;       // cash below this → dormant
export const MAX_POSITION_PCT   = 0.40;         // 40% of portfolio value max
export const COOLDOWN_MINUTES   = 30;

// ── Supabase client (service role) ────────────────────────────

export function getBotLabClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// ── Price helpers ─────────────────────────────────────────────

/** Fetch current prices from DB cache for a set of symbols */
export async function loadPrices(
  supabase: SupabaseClient,
  symbols: string[]
): Promise<Map<string, StockPrice>> {
  const { data, error } = await supabase
    .from("stock_prices")
    .select("*")
    .in("symbol", symbols);
  if (error) throw error;
  const map = new Map<string, StockPrice>();
  for (const row of data ?? []) map.set(row.symbol, row);
  return map;
}

/** Fetch last N days of daily history for a set of symbols */
export async function loadHistory(
  supabase: SupabaseClient,
  symbols: string[],
  days = 30
): Promise<Map<string, PriceHistory[]>> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { data, error } = await supabase
    .from("stock_price_history")
    .select("*")
    .in("symbol", symbols)
    .gte("date", cutoff.toISOString().split("T")[0])
    .order("date", { ascending: true });
  if (error) throw error;

  const map = new Map<string, PriceHistory[]>();
  for (const row of data ?? []) {
    const arr = map.get(row.symbol) ?? [];
    arr.push(row);
    map.set(row.symbol, arr);
  }
  return map;
}

/** Trigger the price-fetch edge function to refresh a batch of symbols */
export async function refreshPrices(symbols: string[]): Promise<void> {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/fetch-prices`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ symbols }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fetch-prices edge function error: ${res.status} ${body}`);
  }
}

// ── Portfolio helpers ─────────────────────────────────────────

/** Total portfolio value (holdings at current prices + cash) */
export function totalPortfolioValue(
  holdings: BotHolding[],
  prices: Map<string, StockPrice>,
  cashBalance: number
): number {
  const holdingsValue = holdings.reduce((sum, h) => {
    const price = prices.get(h.symbol)?.price ?? h.avg_cost;
    return sum + h.shares * price;
  }, 0);
  return holdingsValue + cashBalance;
}

/** Holdings-only market value */
export function holdingsValue(
  holdings: BotHolding[],
  prices: Map<string, StockPrice>
): number {
  return holdings.reduce((sum, h) => {
    const price = prices.get(h.symbol)?.price ?? h.avg_cost;
    return sum + h.shares * price;
  }, 0);
}

/** Max $ amount that can be spent on a single position given portfolio value */
export function maxPositionValue(portfolioTotal: number): number {
  return portfolioTotal * MAX_POSITION_PCT;
}

// ── Guard checks ──────────────────────────────────────────────

/** Returns true if the bot is on cooldown (last trade < 30 min ago) */
export function isOnCooldown(portfolio: BotPortfolio): boolean {
  if (!portfolio.last_traded_at) return false;
  const elapsed = (Date.now() - new Date(portfolio.last_traded_at).getTime()) / 60000;
  return elapsed < COOLDOWN_MINUTES;
}

/** Check if bot should be marked dormant */
export function shouldBeDormant(cashBalance: number, holdings: BotHolding[], prices: Map<string, StockPrice>): boolean {
  const total = totalPortfolioValue(holdings, prices, cashBalance);
  return total < DORMANCY_THRESHOLD;
}

// ── Trade execution ───────────────────────────────────────────

export interface TradeParams {
  ctx: BotContext;
  symbol: string;
  action: "buy" | "sell";
  /** For buys: dollar amount to spend. For sells: shares to sell (or 'all'). */
  amount: number | "all";
  reason?: string;
}

export interface TradeResult {
  success: boolean;
  message: string;
  shares?: number;
  price?: number;
  total?: number;
}

export async function executeTrade(params: TradeParams): Promise<TradeResult> {
  const { ctx, symbol, action, reason } = params;
  const { supabase, bot, portfolio, holdings, prices } = ctx;

  // Guard: cooldown
  if (isOnCooldown(portfolio)) {
    return { success: false, message: "Cooldown active" };
  }

  // Guard: dormant
  if (portfolio.is_dormant) {
    return { success: false, message: "Bot is dormant" };
  }

  const priceRow = prices.get(symbol);
  if (!priceRow) {
    return { success: false, message: `No price data for ${symbol}` };
  }
  const price = priceRow.price;
  if (!price || price <= 0) {
    return { success: false, message: `Invalid price for ${symbol}: ${price}` };
  }

  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const currentHolding = holdings.find(h => h.symbol === symbol);
  const currentShares  = currentHolding?.shares ?? 0;
  const currentAvgCost = currentHolding?.avg_cost ?? 0;

  let sharesToTrade: number;
  let totalCost: number;

  if (action === "buy") {
    const dollarAmount = params.amount as number;

    // Guard: position limit
    const currentPositionValue = currentShares * price;
    const maxAllowed = maxPositionValue(portfolioTotal);
    const headroom = Math.max(0, maxAllowed - currentPositionValue);
    const spendable = Math.min(dollarAmount, headroom, portfolio.cash_balance);

    if (spendable < 1) {
      return { success: false, message: `Buy blocked: position limit or insufficient cash (headroom=$${headroom.toFixed(2)})` };
    }

    sharesToTrade = spendable / price;
    totalCost     = spendable;

    if (totalCost > portfolio.cash_balance) {
      return { success: false, message: "Insufficient cash" };
    }

  } else {
    // sell
    if (currentShares <= 0) {
      return { success: false, message: `No shares of ${symbol} to sell` };
    }
    sharesToTrade = params.amount === "all" ? currentShares : Math.min(params.amount as number, currentShares);
    totalCost     = sharesToTrade * price;
  }

  // Round to 6 decimal places (fractional shares OK)
  sharesToTrade = Math.round(sharesToTrade * 1e6) / 1e6;
  totalCost     = Math.round(totalCost * 100) / 100;

  // ── Apply trade ──────────────────────────────────────────────

  if (action === "buy") {
    const newCash   = portfolio.cash_balance - totalCost;
    const newShares = currentShares + sharesToTrade;
    const newAvgCost = currentShares === 0
      ? price
      : (currentShares * currentAvgCost + totalCost) / newShares;

    const { error: cashErr } = await supabase
      .from("bot_portfolios")
      .update({ cash_balance: newCash, last_traded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("bot_id", bot.id);
    if (cashErr) throw cashErr;

    const { error: holdingErr } = await supabase
      .from("bot_holdings")
      .upsert({ bot_id: bot.id, symbol, shares: newShares, avg_cost: newAvgCost, updated_at: new Date().toISOString() },
               { onConflict: "bot_id,symbol" });
    if (holdingErr) throw holdingErr;

    // Update context in-memory
    portfolio.cash_balance = newCash;
    portfolio.last_traded_at = new Date().toISOString();
    const existing = holdings.find(h => h.symbol === symbol);
    if (existing) { existing.shares = newShares; existing.avg_cost = newAvgCost; }
    else holdings.push({ bot_id: bot.id, symbol, shares: newShares, avg_cost: newAvgCost, updated_at: new Date().toISOString() });

  } else {
    const newCash   = portfolio.cash_balance + totalCost;
    const newShares = currentShares - sharesToTrade;

    const { error: cashErr } = await supabase
      .from("bot_portfolios")
      .update({ cash_balance: newCash, last_traded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("bot_id", bot.id);
    if (cashErr) throw cashErr;

    if (newShares < 0.000001) {
      // Close position entirely
      const { error } = await supabase
        .from("bot_holdings")
        .delete()
        .eq("bot_id", bot.id)
        .eq("symbol", symbol);
      if (error) throw error;
      const idx = holdings.findIndex(h => h.symbol === symbol);
      if (idx !== -1) holdings.splice(idx, 1);
    } else {
      const { error } = await supabase
        .from("bot_holdings")
        .update({ shares: newShares, updated_at: new Date().toISOString() })
        .eq("bot_id", bot.id)
        .eq("symbol", symbol);
      if (error) throw error;
      const existing = holdings.find(h => h.symbol === symbol);
      if (existing) existing.shares = newShares;
    }

    portfolio.cash_balance = newCash;
    portfolio.last_traded_at = new Date().toISOString();
  }

  // ── Log trade ─────────────────────────────────────────────
  await supabase.from("bot_trades").insert({
    bot_id: bot.id,
    symbol,
    company_name: priceRow.company_name,
    action,
    shares: sharesToTrade,
    price,
    total: totalCost,
    reason: reason ?? null,
    executed_at: new Date().toISOString(),
  });

  // ── Dormancy check ────────────────────────────────────────
  const newTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  if (newTotal < DORMANCY_THRESHOLD) {
    await supabase.from("bot_portfolios").update({ is_dormant: true }).eq("bot_id", bot.id);
    portfolio.is_dormant = true;
  }

  return { success: true, message: `${action} ${sharesToTrade.toFixed(4)} ${symbol} @ $${price}`, shares: sharesToTrade, price, total: totalCost };
}

// ── Daily snapshot ────────────────────────────────────────────

export async function writeDailySnapshot(ctx: BotContext): Promise<void> {
  const { supabase, bot, portfolio, holdings, prices } = ctx;

  const portfolioVal = holdingsValue(holdings, prices);
  const totalVal     = portfolioVal + portfolio.cash_balance;
  const cumReturn    = ((totalVal / STARTING_CASH) - 1) * 100;

  // Day P&L: compare to yesterday's snapshot
  const today = new Date().toISOString().split("T")[0];
  const { data: yesterday } = await supabase
    .from("bot_daily_snapshots")
    .select("total_value")
    .eq("bot_id", bot.id)
    .lt("snapshot_date", today)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .single();

  const prevTotal = yesterday?.total_value ?? STARTING_CASH;
  const dayPnl    = totalVal - prevTotal;

  const holdingsJson = holdings.map(h => ({
    symbol: h.symbol,
    shares: h.shares,
    price: prices.get(h.symbol)?.price ?? h.avg_cost,
    value: h.shares * (prices.get(h.symbol)?.price ?? h.avg_cost),
  }));

  await supabase.from("bot_daily_snapshots").upsert({
    bot_id: bot.id,
    snapshot_date: today,
    portfolio_value: Math.round(portfolioVal * 100) / 100,
    cash_balance: Math.round(portfolio.cash_balance * 100) / 100,
    total_value: Math.round(totalVal * 100) / 100,
    day_pnl: Math.round(dayPnl * 100) / 100,
    cumulative_return: Math.round(cumReturn * 10000) / 10000,
    holdings_json: holdingsJson,
    created_at: new Date().toISOString(),
  }, { onConflict: "bot_id,snapshot_date" });
}

// ── Context loader ────────────────────────────────────────────

export async function loadBotContext(
  supabase: SupabaseClient,
  botCode: string,
  symbols: string[],
  historyDays = 30
): Promise<BotContext> {
  const { data: bot, error: botErr } = await supabase
    .from("bots")
    .select("*")
    .eq("code", botCode)
    .single();
  if (botErr) throw botErr;

  const { data: portfolio, error: portErr } = await supabase
    .from("bot_portfolios")
    .select("*")
    .eq("bot_id", bot.id)
    .single();
  if (portErr) throw portErr;

  const { data: holdings, error: holdErr } = await supabase
    .from("bot_holdings")
    .select("*")
    .eq("bot_id", bot.id);
  if (holdErr) throw holdErr;

  // Include any symbols currently held (even if not in the strategy's default list)
  const allSymbols = Array.from(new Set(Array.from(symbols).concat((holdings ?? []).map((h: BotHolding) => h.symbol))));

  const prices  = await loadPrices(supabase, allSymbols);
  const history = await loadHistory(supabase, allSymbols, historyDays);

  return {
    supabase,
    bot,
    portfolio,
    holdings: holdings ?? [],
    prices,
    history,
  };
}

// ── Market hours check ────────────────────────────────────────

export function isMarketOpen(): boolean {
  const now = new Date();
  // Convert to US Eastern Time
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etString);

  const day  = et.getDay();
  const hour = et.getHours();
  const min  = et.getMinutes();

  // Weekdays only
  if (day === 0 || day === 6) return false;

  // 9:30 AM – 4:00 PM ET
  const minutesFromMidnight = hour * 60 + min;
  return minutesFromMidnight >= 570 && minutesFromMidnight < 960; // 9:30=570, 16:00=960
}
