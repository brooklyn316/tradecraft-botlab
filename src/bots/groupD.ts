// ============================================================
// Group D — Adaptive / Shadow Bot
// D1: Copies the current leaderboard leader.
//     Checks every 7 days, switches within 24h.
// ============================================================

import { BotContext, executeTrade, totalPortfolioValue, getBotLabClient } from "@/lib/botEngine";
import { runA1, runA2, runA3, runA4, runA5 } from "./groupA";
import { runB1, runB2, runB3 } from "./groupB";
import { runC1, runC2, runC3 } from "./groupC";
import { SupabaseClient } from "@supabase/supabase-js";

// ── Leaderboard query ─────────────────────────────────────────

export interface LeaderEntry {
  bot_id: string;
  bot_code: string;
  total_value: number;
  cumulative_return: number;
}

/** Returns the current leaderboard ranked by total_value (latest snapshot per bot) */
async function getLeaderboard(supabase: SupabaseClient): Promise<LeaderEntry[]> {
  // Get the most recent snapshot date
  const { data: latest } = await supabase
    .from("bot_daily_snapshots")
    .select("snapshot_date")
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .single();

  if (!latest) return [];

  const { data, error } = await supabase
    .from("bot_daily_snapshots")
    .select("bot_id, total_value, cumulative_return, bots!inner(code)")
    .eq("snapshot_date", latest.snapshot_date)
    .order("total_value", { ascending: false });

  if (error || !data) return [];

  return data.map((row: any) => ({
    bot_id: row.bot_id,
    bot_code: row.bots.code,
    total_value: row.total_value,
    cumulative_return: row.cumulative_return,
  }));
}

// ── Strategy dispatcher ───────────────────────────────────────
// Given a bot code, run that bot's strategy on D1's context.

async function runStrategy(code: string, ctx: BotContext): Promise<string[]> {
  switch (code) {
    case "A1": return runA1(ctx);
    case "A2": return runA2(ctx);
    case "A3": return runA3(ctx);
    case "A4": return runA4(ctx);
    case "A5": return runA5(ctx);
    case "B1": return runB1(ctx);
    case "B2": return runB2(ctx);
    case "B3": return runB3(ctx);
    case "C1": return runC1(ctx);
    case "C2": return runC2(ctx);
    case "C3": return runC3(ctx);
    default:   return [`D1: unknown strategy to mirror — ${code}`];
  }
}

// ── D1 — Shadow Bot ───────────────────────────────────────────

/** Stored in external_data_cache: { current_leader: "A2", last_checked: ISO string } */
const SHADOW_CACHE_KEY = "D1_shadow_state";

export async function runD1(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, bot } = ctx;

  // Load current shadow state
  const { data: cacheRow } = await supabase
    .from("external_data_cache")
    .select("payload, fetched_at")
    .eq("source", "shadow_bot")
    .eq("key", SHADOW_CACHE_KEY)
    .single();

  const state: { current_leader: string; last_checked: string } = cacheRow?.payload ?? {
    current_leader: "A1", // default: start by copying A1
    last_checked: new Date(0).toISOString(),
  };

  const now        = new Date();
  const lastCheck  = new Date(state.last_checked);
  const daysSince  = (now.getTime() - lastCheck.getTime()) / (1000 * 60 * 60 * 24);

  // Check leaderboard every 7 days
  if (daysSince >= 7) {
    const board   = await getLeaderboard(supabase);
    const leaders = board.filter(e => e.bot_code !== "D1"); // exclude self

    if (leaders.length > 0) {
      const topValue  = leaders[0].total_value;
      const contender = leaders[0].bot_code;

      // Stay with current if tied
      if (contender !== state.current_leader) {
        const currentEntry = leaders.find(e => e.bot_code === state.current_leader);
        const currentValue = currentEntry?.total_value ?? 0;

        if (topValue > currentValue) {
          logs.push(`D1: switching from ${state.current_leader} → ${contender} ($${topValue.toFixed(2)} vs $${currentValue.toFixed(2)})`);
          state.current_leader = contender;
        } else {
          logs.push(`D1: tied — staying with ${state.current_leader}`);
        }
      } else {
        logs.push(`D1: ${state.current_leader} still leads — no switch`);
      }
    }

    state.last_checked = now.toISOString();

    // Persist updated state
    await supabase.from("external_data_cache").upsert({
      source: "shadow_bot",
      key: SHADOW_CACHE_KEY,
      payload: state,
      fetched_at: now.toISOString(),
    }, { onConflict: "source,key" });
  }

  logs.push(`D1: mirroring ${state.current_leader}`);

  const stratLogs = await runStrategy(state.current_leader, ctx);
  return [...logs, ...stratLogs.map(l => `D1→${state.current_leader}: ${l}`)];
}

// ── D2 — Anti-Shadow ──────────────────────────────────────────
// Contrarian: copies the WORST-performing bot's strategy.
// Thesis: worst performers may be oversold / due for reversal.

const ANTI_SHADOW_CACHE_KEY = "D2_antishadow_state";

export async function runD2(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase } = ctx;

  const { data: cacheRow } = await supabase
    .from("external_data_cache")
    .select("payload, fetched_at")
    .eq("source", "shadow_bot")
    .eq("key", ANTI_SHADOW_CACHE_KEY)
    .single();

  const state: { current_target: string; last_checked: string } = cacheRow?.payload ?? {
    current_target: "A5",
    last_checked: new Date(0).toISOString(),
  };

  const now       = new Date();
  const daysSince = (now.getTime() - new Date(state.last_checked).getTime()) / (1000 * 60 * 60 * 24);

  if (daysSince >= 7) {
    const board = await getLeaderboard(supabase);
    const sorted = board.filter(e => !["D1","D2","D3","D4","S1"].includes(e.bot_code));
    if (sorted.length > 0) {
      const worst = sorted[sorted.length - 1].bot_code;
      if (worst !== state.current_target) {
        logs.push(`D2: contrarian switch — now copying worst bot: ${worst}`);
        state.current_target = worst;
      } else {
        logs.push(`D2: ${worst} still worst — staying contrarian`);
      }
    }
    state.last_checked = now.toISOString();
    await supabase.from("external_data_cache").upsert({
      source: "shadow_bot", key: ANTI_SHADOW_CACHE_KEY,
      payload: state, fetched_at: now.toISOString(),
    }, { onConflict: "source,key" });
  }

  logs.push(`D2: contrarian — mirroring ${state.current_target}`);
  const stratLogs = await runStrategy(state.current_target, ctx);
  return [...logs, ...stratLogs.map(l => `D2→${state.current_target}: ${l}`)];
}

// ── D3 — Sector Leader ────────────────────────────────────────
// Finds which GROUP (A–F) has the best average cumulative return.
// Buys equal-weight the top symbols from that group.

export async function runD3(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, holdings, prices, portfolio } = ctx;

  // Get latest snapshots
  const { data: latest } = await supabase
    .from("bot_daily_snapshots")
    .select("snapshot_date")
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .single();

  if (!latest) return ["D3: no snapshot data yet"];

  const { data: snaps } = await supabase
    .from("bot_daily_snapshots")
    .select("cumulative_return, bots!inner(group_id, code)")
    .eq("snapshot_date", latest.snapshot_date);

  if (!snaps || snaps.length === 0) return ["D3: no snapshot data"];

  // Average return per group
  const groupReturns: Record<string, number[]> = {};
  for (const row of snaps as any[]) {
    const g = row.bots.group_id;
    if (!["A","B","C","F"].includes(g)) continue; // only concrete strategy groups
    if (!groupReturns[g]) groupReturns[g] = [];
    groupReturns[g].push(row.cumulative_return);
  }

  const groupAvg = Object.entries(groupReturns).map(([g, returns]) => ({
    group: g,
    avg: returns.reduce((a, b) => a + b, 0) / returns.length,
  })).sort((a, b) => b.avg - a.avg);

  if (groupAvg.length === 0) return ["D3: no group data"];

  const bestGroup = groupAvg[0].group;
  logs.push(`D3: best group is ${bestGroup} (avg ${groupAvg[0].avg.toFixed(2)}%)`);

  // Buy top-performing symbols from best group based on recent price gains
  const { GROUP_A_ALL_SYMBOLS } = await import("./groupA");
  const { B_SYMBOLS, SECTOR_ETFS } = await import("./groupB");

  const groupSymbols: Record<string, string[]> = {
    A: GROUP_A_ALL_SYMBOLS,
    B: B_SYMBOLS,
    C: [...GROUP_A_ALL_SYMBOLS, "SPY", "QQQ"],
    F: ["AAPL","MSFT","NVDA","TSLA","GOOGL","META","AMD","JPM","XOM","JNJ","SPY","QQQ",...SECTOR_ETFS],
  };

  const symbols = groupSymbols[bestGroup] ?? GROUP_A_ALL_SYMBOLS;
  const rankedSymbols = symbols
    .map(s => ({ symbol: s, changePct: prices.get(s)?.change_percent ?? 0 }))
    .filter(x => prices.has(x.symbol))
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 3);

  // Sell holdings not in top 3
  for (const h of [...holdings]) {
    if (!rankedSymbols.find(r => r.symbol === h.symbol)) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `D3: rotating to Group ${bestGroup} leaders` });
      logs.push(`D3 exit ${h.symbol}: ${result.message}`);
    }
  }

  // Buy top symbols equally
  const perSymbol = portfolio.cash_balance / rankedSymbols.length;
  for (const { symbol, changePct } of rankedSymbols) {
    if (holdings.find(h => h.symbol === symbol)) continue;
    const spend = Math.min(perSymbol, portfolio.cash_balance * 0.40);
    if (spend < 1) break;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `D3: Group ${bestGroup} leader — change ${changePct.toFixed(2)}%` });
    logs.push(`D3 buy ${symbol}: ${result.message}`);
  }

  return logs;
}

// ── D4 — Blend Bot ────────────────────────────────────────────
// Reads the top 3 bots' current holdings and buys the same stocks equally.

export async function runD4(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];
  const { supabase, holdings, prices, portfolio } = ctx;

  // Get top 3 bots from leaderboard (excluding D bots and S1)
  const board = await getLeaderboard(supabase);
  const top3  = board
    .filter(e => !["D1","D2","D3","D4","S1"].includes(e.bot_code))
    .slice(0, 3);

  if (top3.length === 0) return ["D4: no leaderboard data yet"];

  // Fetch their holdings
  const topBotIds  = top3.map(e => e.bot_id);
  const { data: topHoldings } = await supabase
    .from("bot_holdings")
    .select("symbol, shares, bot_id")
    .in("bot_id", topBotIds);

  if (!topHoldings || topHoldings.length === 0) return ["D4: top bots have no holdings yet"];

  // Count how many top bots hold each symbol
  const symbolCount: Record<string, number> = {};
  for (const h of topHoldings) {
    symbolCount[h.symbol] = (symbolCount[h.symbol] ?? 0) + 1;
  }

  // Symbols held by at least 2 of the top 3
  const blendSymbols = Object.entries(symbolCount)
    .filter(([, count]) => count >= 2)
    .map(([symbol]) => symbol);

  if (blendSymbols.length === 0) {
    // Fall back: just take all unique symbols from top 3
    blendSymbols.push(...Array.from(new Set(topHoldings.map(h => h.symbol))).slice(0, 4));
  }

  const topCodes = top3.map(e => e.bot_code).join(", ");
  logs.push(`D4: blending with ${topCodes}`);

  // Sell holdings not in blend
  for (const h of [...holdings]) {
    if (!blendSymbols.includes(h.symbol)) {
      const result = await executeTrade({ ctx, symbol: h.symbol, action: "sell", amount: "all", reason: `D4: not in top-3 blend (leaders: ${topCodes})` });
      logs.push(`D4 exit ${h.symbol}: ${result.message}`);
    }
  }

  // Buy blend symbols equally
  const perSymbol = blendSymbols.length > 0 ? portfolio.cash_balance / blendSymbols.length : 0;
  for (const symbol of blendSymbols) {
    if (!prices.has(symbol)) continue;
    const holding    = holdings.find(h => h.symbol === symbol);
    const currentVal = (holding?.shares ?? 0) * (prices.get(symbol)?.price ?? 0);
    const portfolioTotal = (holdings.reduce((s, h) => s + h.shares * (prices.get(h.symbol)?.price ?? 0), 0)) + portfolio.cash_balance;
    const targetVal  = portfolioTotal / blendSymbols.length;
    const deficit    = targetVal - currentVal;
    if (deficit < 1) continue;
    const spend = Math.min(deficit, portfolio.cash_balance * 0.40, perSymbol);
    if (spend < 1) break;
    const holdCount = symbolCount[symbol] ?? 1;
    const result = await executeTrade({ ctx, symbol, action: "buy", amount: spend, reason: `D4: held by ${holdCount}/3 top bots (${topCodes})` });
    logs.push(`D4 buy ${symbol}: ${result.message}`);
  }

  return logs;
}
