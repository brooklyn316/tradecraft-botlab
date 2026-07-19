// ============================================================
// Vercel Cron: /api/cron/run-bots
// Runs every 30 minutes during US market hours (9:30–16:00 ET weekdays).
// Covers all 51 bots across groups A–F + Super Bot S1.
//
// Also handles external data refresh (formerly a separate cron).
// External data is refreshed once per day when stale (>20 hours old).
// This keeps the entire Bot Lab on a SINGLE cron-job.org entry.
// ============================================================

import { NextResponse } from "next/server";
import {
  getBotLabClient,
  loadBotContext,
  writeDailySnapshot,
  refreshPrices,
  isMarketOpen,
} from "@/lib/botEngine";
import { SupabaseClient } from "@supabase/supabase-js";

// ── External data helpers (merged from fetch-external-data) ───

async function isExternalDataStale(supabase: SupabaseClient): Promise<boolean> {
  const { data } = await supabase
    .from("external_data_cache")
    .select("fetched_at")
    .eq("source", "capitol_trades")
    .eq("key", "recent_30d")
    .single();
  if (!data?.fetched_at) return true;
  const ageHours = (Date.now() - new Date(data.fetched_at).getTime()) / 3_600_000;
  return ageHours > 20;
}

async function fetchCapitolTrades(supabase: SupabaseClient) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const norm = (t: string) => ((t ?? "").toLowerCase().includes("purchase") || t === "buy") ? "Purchase" : "Sale";

  let houseTrades: any[] = [];
  try {
    const r = await fetch("https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json", { headers: { "User-Agent": "TradecraftBotLab/1.0" } });
    if (r.ok) {
      houseTrades = (await r.json() as any[])
        .filter(t => new Date(t.transaction_date ?? t.disclosure_date ?? "") >= cutoff && t.ticker && t.ticker !== "--")
        .map(t => ({ symbol: (t.ticker ?? "").toUpperCase(), member: t.representative ?? "", transaction: norm(t.type ?? ""), date: t.transaction_date ?? t.disclosure_date ?? "", amount_range: t.amount ?? "", asset_type: "Stock" }));
    }
  } catch { /* continue */ }

  let senateTrades: any[] = [];
  try {
    const r = await fetch("https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json", { headers: { "User-Agent": "TradecraftBotLab/1.0" } });
    if (r.ok) {
      senateTrades = (await r.json() as any[])
        .filter(t => new Date(t.transaction_date ?? t.disclosure_date ?? "") >= cutoff && t.ticker && t.ticker !== "--")
        .map(t => ({ symbol: (t.ticker ?? "").toUpperCase(), member: t.senator ?? "", transaction: norm(t.type ?? ""), date: t.transaction_date ?? t.disclosure_date ?? "", amount_range: t.amount ?? "", asset_type: t.asset_type ?? "Stock" }));
    }
  } catch { /* continue */ }

  const trades = [...houseTrades, ...senateTrades];
  if (trades.length === 0) return;

  await supabase.from("external_data_cache").upsert({ source: "capitol_trades", key: "recent_30d", payload: trades, fetched_at: new Date().toISOString() }, { onConflict: "source,key" });
  const pelosi = trades.filter(t => t.member?.toLowerCase().includes("pelosi"));
  await supabase.from("external_data_cache").upsert({ source: "capitol_trades", key: "pelosi_trades", payload: pelosi, fetched_at: new Date().toISOString() }, { onConflict: "source,key" });
}

async function fetchBerkshire(supabase: SupabaseClient) {
  try {
    const r = await fetch("https://data.sec.gov/submissions/CIK0001067983.json", { headers: { "User-Agent": "TradecraftBotLab research@botlab.dev" } });
    if (!r.ok) return;
    const data = await r.json();
    const idx  = data.filings?.recent?.form?.findIndex((f: string) => f === "13F-HR");
    if (idx === undefined || idx === -1) return;
    const acc  = data.filings.recent.accessionNumber[idx].replace(/-/g, "");
    const doc  = data.filings.recent.primaryDocument[idx];
    const docR = await fetch(`https://www.sec.gov/Archives/edgar/data/1067983/${acc}/${doc}`, { headers: { "User-Agent": "TradecraftBotLab research@botlab.dev" } });
    if (!docR.ok) return;
    const xml  = await docR.text();
    const CUSIP: Record<string, string> = { "037833100": "AAPL", "670346105": "OXY", "531229441": "KO", "713448108": "CVX", "929042109": "WFC" };
    const re   = /<nameOfIssuer>(.*?)<\/nameOfIssuer>[\s\S]*?<cusip>(.*?)<\/cusip>[\s\S]*?<value>(\d+)<\/value>[\s\S]*?<sshPrnamt>(\d+)<\/sshPrnamt>/g;
    const holdings: any[] = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
      const [, name, cusip, val, shr] = m;
      holdings.push({ symbol: CUSIP[cusip] ?? name.split(" ")[0].slice(0, 5).toUpperCase(), name, value_usd: parseInt(val) * 1000, shares: parseInt(shr) });
    }
    const top20 = holdings.sort((a, b) => b.value_usd - a.value_usd).slice(0, 20);
    await supabase.from("external_data_cache").upsert({ source: "sec_13f", key: "berkshire", payload: top20, fetched_at: new Date().toISOString() }, { onConflict: "source,key" });
  } catch { /* non-fatal */ }
}

async function fetchArkHoldings(supabase: SupabaseClient) {
  try {
    const r = await fetch("https://ark-funds.com/wp-content/uploads/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv", { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return;
    const lines = (await r.text()).trim().split("\n").slice(1);
    const holdings = lines.map(l => {
      const c = l.split(",").map(x => x.replace(/"/g, "").trim());
      return { symbol: c[3]?.toUpperCase(), name: c[2], shares: parseFloat(c[5]?.replace(/,/g, "") ?? "0"), value_usd: parseFloat(c[6]?.replace(/[$,]/g, "") ?? "0"), weight_pct: parseFloat(c[7]?.replace(/%/g, "") ?? "0") };
    }).filter(h => h.symbol && h.value_usd > 0);
    await supabase.from("external_data_cache").upsert({ source: "ark_holdings", key: "ARKK", payload: holdings, fetched_at: new Date().toISOString() }, { onConflict: "source,key" });
  } catch { /* non-fatal */ }
}

async function maybeRefreshExternalData(supabase: SupabaseClient): Promise<string> {
  const stale = await isExternalDataStale(supabase);
  if (!stale) return "external data fresh — skipped";
  // Run fetches in parallel, all non-fatal
  await Promise.allSettled([
    fetchCapitolTrades(supabase),
    fetchBerkshire(supabase),
    fetchArkHoldings(supabase),
  ]);
  return "external data refreshed";
}

// Group A
import { GROUP_A_ALL_SYMBOLS, runA1, runA2, runA3, runA4, runA5, runA2B, runA3B, runA6 } from "@/bots/groupA";
// Group B
import { B_SYMBOLS, SECTOR_ETFS, DEFENSIVE_ETFS, runB1, runB2, runB3, runB2B, runB4, runB5 } from "@/bots/groupB";
// Group C
import { runC1, runC2, runC3, runC1B, runC1C, runC2B, runC3B, runC4, runC5, runC6 } from "@/bots/groupC";
// Group D
import { runD1, runD2, runD3, runD4 } from "@/bots/groupD";
// Group E
import { runE1, runE2, runE3, runE4, runE5, runE6 } from "@/bots/groupE";
// Group F
import { F_UNIVERSE, runF1, runF2, runF3, runF4, runF5, runF6, runF7, runF8, runF9, runF10, runF11, runF12, runF13, runF14, runF15 } from "@/bots/groupF";
// Super Bot
import { runS1 } from "@/bots/superBot";

function verifyCronSecret(req: Request): boolean {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}

// ── Shared symbol sets ────────────────────────────────────────

const C_SYMBOLS   = [...GROUP_A_ALL_SYMBOLS, "SPY", "QQQ"];
const D_SYMBOLS   = [...GROUP_A_ALL_SYMBOLS, ...B_SYMBOLS, ...SECTOR_ETFS];
const ALL_SYMBOLS = Array.from(new Set([...F_UNIVERSE, ...B_SYMBOLS, ...SECTOR_ETFS, ...DEFENSIVE_ETFS, "TLT", "GLD"]));

// ── Bot registry ──────────────────────────────────────────────

const BOT_RUNNERS: Record<string, {
  symbols: string[];
  run: (ctx: Awaited<ReturnType<typeof loadBotContext>>) => Promise<string[]>;
  weeklyOnly?: boolean;
}> = {
  // Group A
  A1:  { symbols: ["AAPL","MSFT","GOOGL","AMZN","NVDA"], run: runA1 },
  A2:  { symbols: GROUP_A_ALL_SYMBOLS, run: runA2 },
  A2B: { symbols: GROUP_A_ALL_SYMBOLS, run: runA2B },
  A3:  { symbols: GROUP_A_ALL_SYMBOLS, run: runA3 },
  A3B: { symbols: GROUP_A_ALL_SYMBOLS, run: runA3B },
  A4:  { symbols: ["KO","JNJ","JPM","WMT","XOM"], run: runA4 },
  A5:  { symbols: GROUP_A_ALL_SYMBOLS, run: runA5 },
  A6:  { symbols: GROUP_A_ALL_SYMBOLS, run: runA6 },

  // Group B
  B1:  { symbols: B_SYMBOLS, run: runB1 },
  B2:  { symbols: ["SPY"], run: runB2 },
  B2B: { symbols: ["SPY"], run: runB2B },
  B3:  { symbols: ["ENZL","EWA","EWJ"], run: runB3, weeklyOnly: true },
  B4:  { symbols: SECTOR_ETFS, run: runB4, weeklyOnly: true },
  B5:  { symbols: DEFENSIVE_ETFS, run: runB5 },

  // Group C
  C1:  { symbols: C_SYMBOLS, run: runC1 },
  C1B: { symbols: C_SYMBOLS, run: runC1B },
  C1C: { symbols: C_SYMBOLS, run: runC1C },
  C2:  { symbols: C_SYMBOLS, run: runC2 },
  C2B: { symbols: C_SYMBOLS, run: runC2B },
  C3:  { symbols: C_SYMBOLS, run: runC3 },
  C3B: { symbols: C_SYMBOLS, run: runC3B },
  C4:  { symbols: C_SYMBOLS, run: runC4 },
  C5:  { symbols: C_SYMBOLS, run: runC5 },
  C6:  { symbols: C_SYMBOLS, run: runC6 },

  // Group D
  D1:  { symbols: D_SYMBOLS, run: runD1 },
  D2:  { symbols: D_SYMBOLS, run: runD2 },
  D3:  { symbols: ALL_SYMBOLS, run: runD3 },
  D4:  { symbols: ALL_SYMBOLS, run: runD4 },

  // Group E (symbols loaded from cache)
  E1:  { symbols: [], run: runE1 },
  E2:  { symbols: [], run: runE2 },
  E3:  { symbols: [], run: runE3 },
  E4:  { symbols: [], run: runE4 },
  E5:  { symbols: [], run: runE5 },
  E6:  { symbols: [], run: runE6 },

  // Group F
  F1:  { symbols: F_UNIVERSE, run: runF1 },
  F2:  { symbols: F_UNIVERSE, run: runF2 },
  F3:  { symbols: ["JNJ","PG","KO","MCD","WMT"], run: runF3 },
  F4:  { symbols: ["TSLA","NVDA","AMD","COIN","PLTR"], run: runF4 },
  F5:  { symbols: ["AAPL","MSFT","NVDA","AMD","GOOGL","META"], run: runF5 },
  F6:  { symbols: ["JNJ","UNH","PFE","ABBV","MRK"], run: runF6 },
  F7:  { symbols: ["JPM","BAC","GS","V","MA"], run: runF7 },
  F8:  { symbols: ["XOM","CVX","OXY","SLB"], run: runF8 },
  F9:  { symbols: F_UNIVERSE, run: runF9 },
  F10: { symbols: F_UNIVERSE, run: runF10 },
  F11: { symbols: F_UNIVERSE, run: runF11 },
  F12: { symbols: GROUP_A_ALL_SYMBOLS, run: runF12 },
  F13: { symbols: F_UNIVERSE, run: runF13 },
  F14: { symbols: F_UNIVERSE, run: runF14 },
  F15: { symbols: SECTOR_ETFS, run: runF15 },

  // Super Bot
  S1:  { symbols: ALL_SYMBOLS, run: runS1 },
};

// ── Snapshot timing ───────────────────────────────────────────

function isNearMarketClose(): boolean {
  const et  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const min = et.getHours() * 60 + et.getMinutes();
  return min >= 930 && min < 990; // 15:30–16:30 ET
}

// ── Main handler ──────────────────────────────────────────────

export async function GET(req: Request) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const marketOpen = isMarketOpen();
  console.log(`[run-bots] market open: ${marketOpen}, utc: ${new Date().toISOString()}`);
  if (!marketOpen) {
    return NextResponse.json({ skipped: true, reason: "Market closed", utc: new Date().toISOString() });
  }

  const supabase    = getBotLabClient();
  const isMonday    = new Date().getDay() === 1;
  const isCloseTime = isNearMarketClose();
  const results: Record<string, { logs: string[]; error?: string }> = {};

  // Refresh external data if stale (once per day, non-blocking on failure)
  const externalStatus = await maybeRefreshExternalData(supabase);
  console.log("External data:", externalStatus);

  // Collect all symbols for batch price refresh
  const allSymbols = Array.from(new Set(
    Object.values(BOT_RUNNERS).flatMap(b => b.symbols)
  ));

  try {
    await refreshPrices(allSymbols);
  } catch (err) {
    console.error("Price refresh failed:", err);
  }

  // Run each bot
  for (const [code, config] of Object.entries(BOT_RUNNERS)) {
    if (config.weeklyOnly && !isMonday) continue;

    try {
      const ctx = await loadBotContext(supabase, code, config.symbols);
      if (ctx.portfolio.is_dormant) {
        results[code] = { logs: [`${code}: dormant — skipped`] };
        continue;
      }

      const logs = await config.run(ctx);

      if (isCloseTime) {
        await writeDailySnapshot(ctx);
        logs.push(`${code}: daily snapshot written`);
      }

      results[code] = { logs };
    } catch (err) {
      console.error(`Bot ${code} error:`, err);
      results[code] = { logs: [], error: (err as Error).message };
    }
  }

  return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), results });
}
