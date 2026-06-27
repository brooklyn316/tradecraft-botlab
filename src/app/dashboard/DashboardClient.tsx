"use client";

// ============================================================
// Tradecraft Bot Lab — Dashboard v2
// 51 bots, 7 groups, AI super bot, trade log with reasoning.
// ============================================================

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────

interface BotRow {
  id: string;
  code: string;
  name: string;
  group_id: string;
  description: string;
  is_active: boolean;
}

interface SnapshotRow {
  bot_id: string;
  snapshot_date: string;
  total_value: number;
  cash_balance: number;
  portfolio_value: number;
  day_pnl: number;
  cumulative_return: number;
  holdings_json: any[];
}

interface TradeRow {
  id: string;
  bot_id: string;
  symbol: string;
  company_name: string | null;
  action: "buy" | "sell";
  shares: number;
  price: number;
  total: number;
  reason: string | null;
  executed_at: string;
}

interface HoldingRow {
  bot_id: string;
  symbol: string;
  shares: number;
  avg_cost: number;
}

// ── Colours ───────────────────────────────────────────────────

const GROUP_COLOURS: Record<string, string> = {
  A: "#3b82f6",
  B: "#10b981",
  C: "#f59e0b",
  D: "#8b5cf6",
  E: "#ef4444",
  F: "#06b6d4",
  S: "#f97316",
};

const GROUP_LABELS: Record<string, string> = {
  A: "US Rules",
  B: "Global ETF",
  C: "Technical",
  D: "Adaptive",
  E: "Smart Money",
  F: "Thematic",
  S: "Super Bot",
};

// ── Helpers ───────────────────────────────────────────────────

function pnlColour(v: number) {
  return v >= 0 ? "text-emerald-400" : "text-red-400";
}

function fmt(v: number, d = 2) {
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function GroupBadge({ groupId }: { groupId: string }) {
  return (
    <span
      style={{ backgroundColor: GROUP_COLOURS[groupId] ?? "#6b7280" }}
      className="text-white text-xs font-bold px-2 py-0.5 rounded-full"
    >
      {groupId}
    </span>
  );
}

// ── Sparkline ─────────────────────────────────────────────────

function Sparkline({ points, colour }: { points: number[]; colour: string }) {
  if (points.length < 2) return <span className="text-gray-700 text-xs">–</span>;
  const min = Math.min(...points), max = Math.max(...points);
  const range = max - min || 1;
  const W = 80, H = 28;
  const coords = points.map((v, i) => ({
    x: (i / (points.length - 1)) * W,
    y: H - ((v - min) / range) * (H - 4) - 2,
  }));
  const d = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <path d={d} fill="none" stroke={colour} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ── Full equity chart ─────────────────────────────────────────

function EquityChart({ botId, snapshots, colour }: { botId: string; snapshots: SnapshotRow[]; colour: string }) {
  const data = snapshots.filter(s => s.bot_id === botId);
  if (data.length < 2) return (
    <div className="flex items-center justify-center h-40 text-gray-600 text-sm">No snapshot data yet — runs after market close.</div>
  );
  const values = data.map(s => s.total_value);
  const min = Math.min(...values) * 0.998, max = Math.max(...values) * 1.002;
  const range = max - min || 1;
  const W = 900, H = 200;
  const coords = values.map((v, i) => ({
    x: (i / (values.length - 1)) * W,
    y: H - ((v - min) / range) * (H - 10) - 5,
  }));
  const d = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const baseline = H - ((1000 - min) / range) * (H - 10) - 5;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1="0" y1={baseline} x2={W} y2={baseline} stroke="#374151" strokeWidth="1" strokeDasharray="4,4" />
        <path d={d} fill="none" stroke={colour} strokeWidth="2.5" strokeLinejoin="round" />
        <circle cx={coords[0].x} cy={coords[0].y} r="3" fill={colour} />
        <circle cx={coords[coords.length - 1].x} cy={coords[coords.length - 1].y} r="4" fill={colour} />
      </svg>
      <div className="flex justify-between text-xs text-gray-600 mt-1">
        <span>{data[0].snapshot_date}</span>
        <span className="text-gray-500">─── $1,000 baseline ───</span>
        <span>{data[data.length - 1].snapshot_date}</span>
      </div>
    </div>
  );
}

// ── Market Clock ─────────────────────────────────────────────

function MarketClock() {
  const [now, setNow] = useState(new Date());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => setNow(new Date()), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");
  const fmtTime = (d: Date, tz: string) =>
    d.toLocaleTimeString("en-NZ", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const fmtDay = (d: Date, tz: string) =>
    d.toLocaleDateString("en-NZ", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });

  const nzTime  = fmtTime(now, "Pacific/Auckland");
  const nzDay   = fmtDay(now, "Pacific/Auckland");
  const utcTime = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  const utcDay  = fmtDay(now, "UTC");
  const etTime  = fmtTime(now, "America/New_York");
  const etDay   = fmtDay(now, "America/New_York");

  // ── Pure UTC math — no new Date(localeString) parsing ────────
  // Get ET date/time components via Intl (avoids local-timezone parse bugs)
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const gp = (t: string) => parseInt(etParts.find(p => p.type === t)?.value ?? "0");
  const etY   = gp("year");
  const etMo  = gp("month") - 1; // 0-indexed for Date.UTC
  const etD   = gp("day");
  const etH   = gp("hour");
  const etMin = gp("minute");
  const etSec = gp("second");

  // ET UTC offset in ms: how far behind UTC is ET right now (e.g. 4*3600*1000 for EDT)
  // Derived by comparing "ET components read as if UTC" vs actual UTC ms
  const etAsIfUtcMs = Date.UTC(etY, etMo, etD, etH, etMin, etSec);
  const etOffsetMs  = now.getTime() - etAsIfUtcMs; // positive = ET behind UTC

  // Day of week in ET (0=Sun…6=Sat) — safe because we use ET date components
  const etDow      = new Date(etY, etMo, etD).getDay();
  const etTotalMin = etH * 60 + etMin;
  const OPEN_MIN   = 9 * 60 + 30;
  const CLOSE_MIN  = 16 * 60;
  const isWeekday  = etDow >= 1 && etDow <= 5;
  const isOpen     = isWeekday && etTotalMin >= OPEN_MIN && etTotalMin < CLOSE_MIN;

  let statusLabel = "";

  if (isOpen) {
    // UTC ms when market closes today
    const closeUtcMs = Date.UTC(etY, etMo, etD, 16, 0, 0) + etOffsetMs;
    const diffS = Math.max(0, Math.floor((closeUtcMs - now.getTime()) / 1000));
    const h = Math.floor(diffS / 3600), m = Math.floor((diffS % 3600) / 60), s = diffS % 60;
    statusLabel = `Closes in ${h}h ${pad(m)}m ${pad(s)}s`;
  } else {
    // Find how many days until next weekday open
    let daysAhead: number;
    if (isWeekday && etTotalMin < OPEN_MIN) {
      daysAhead = 0; // today, pre-market
    } else {
      daysAhead = 0;
      for (let i = 1; i <= 7; i++) {
        if (((etDow + i) % 7) >= 1 && ((etDow + i) % 7) <= 5) { daysAhead = i; break; }
      }
    }

    // UTC ms when the next open occurs: "etD+daysAhead at 09:30 ET" expressed in UTC
    const nextOpenUtcMs = Date.UTC(etY, etMo, etD + daysAhead, 9, 30, 0) + etOffsetMs;
    const diffS = Math.max(0, Math.floor((nextOpenUtcMs - now.getTime()) / 1000));
    const h = Math.floor(diffS / 3600), m = Math.floor((diffS % 3600) / 60), s = diffS % 60;
    const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const prefix = daysAhead === 0 ? "Opens in" : daysAhead === 1 ? "Opens tomorrow —" : `Opens ${dayNames[(etDow + daysAhead) % 7]} —`;
    statusLabel = `${prefix} ${h}h ${pad(m)}m ${pad(s)}s`;
  }

  return (
    <div className="px-6 py-3 border-b border-gray-800 flex flex-wrap gap-3">
      <div className="flex-1 min-w-[140px] bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
        <p className="text-gray-500 text-xs uppercase tracking-wider mb-0.5">🇳🇿 New Zealand</p>
        <p className="text-white font-mono text-xl font-bold leading-none">{nzTime}</p>
        <p className="text-gray-600 text-xs mt-0.5">{nzDay}</p>
      </div>
      <div className="flex-1 min-w-[140px] bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
        <p className="text-gray-500 text-xs uppercase tracking-wider mb-0.5">🌐 UTC</p>
        <p className="text-white font-mono text-xl font-bold leading-none">{utcTime}</p>
        <p className="text-gray-600 text-xs mt-0.5">{utcDay}</p>
      </div>
      <div className="flex-1 min-w-[140px] bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
        <p className="text-gray-500 text-xs uppercase tracking-wider mb-0.5">🗽 New York (ET)</p>
        <p className="text-white font-mono text-xl font-bold leading-none">{etTime}</p>
        <p className="text-gray-600 text-xs mt-0.5">{etDay}</p>
      </div>
      <div className={`flex-1 min-w-[200px] rounded-lg px-4 py-2.5 border ${isOpen ? "bg-emerald-950 border-emerald-700" : "bg-gray-900 border-gray-700"}`}>
        <p className="text-gray-500 text-xs uppercase tracking-wider mb-0.5">Market Status</p>
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${isOpen ? "bg-emerald-400 animate-pulse" : "bg-gray-600"}`} />
          <p className={`font-bold text-lg leading-none ${isOpen ? "text-emerald-400" : "text-gray-400"}`}>
            {isOpen ? "OPEN" : "CLOSED"}
          </p>
        </div>
        <p className={`text-xs mt-1 font-mono ${isOpen ? "text-emerald-600" : "text-gray-400"}`}>{statusLabel}</p>
      </div>
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────

type Tab = "leaderboard" | "groups" | "equity" | "trades" | "superbot";

export default function DashboardPage() {
  const supabase = useMemo(() => createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  ), []);

  const [bots, setBots]           = useState<BotRow[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [trades, setTrades]       = useState<TradeRow[]>([]);
  const [holdings, setHoldings]   = useState<HoldingRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [tab, setTab]             = useState<Tab>("leaderboard");
  const [selectedBot, setSelectedBot] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<string>("ALL");
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    const [
      { data: botData },
      { data: snapData },
      { data: tradeData },
      { data: holdData },
    ] = await Promise.all([
      supabase.from("bots").select("*").order("code"),
      supabase.from("bot_daily_snapshots").select("*").order("snapshot_date", { ascending: true }),
      supabase.from("bot_trades").select("*").order("executed_at", { ascending: false }).limit(200),
      supabase.from("bot_holdings").select("*"),
    ]);
    setBots(botData ?? []);
    setSnapshots(snapData ?? []);
    setTrades(tradeData ?? []);
    setHoldings(holdData ?? []);
    setLastRefresh(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Build leaderboard
  const leaderboard = bots
    .map(bot => {
      const botSnaps  = snapshots.filter(s => s.bot_id === bot.id);
      const latest    = botSnaps.length > 0 ? botSnaps[botSnaps.length - 1] : null;
      const sparkData = botSnaps.slice(-14).map(s => s.total_value);
      return { bot, latest, sparkData };
    })
    .sort((a, b) => {
      const av = a.latest?.total_value ?? 1000;
      const bv = b.latest?.total_value ?? 1000;
      return bv - av;
    })
    .map((e, i) => ({ ...e, rank: i + 1 }));

  const filteredLeaderboard = groupFilter === "ALL"
    ? leaderboard
    : leaderboard.filter(e => e.bot.group_id === groupFilter);

  // Group stats
  const groups = ["A","B","C","D","E","F","S"];
  const groupStats = groups.map(g => {
    const entries = leaderboard.filter(e => e.bot.group_id === g && e.latest);
    const count   = entries.length;
    const avg     = count > 0 ? entries.reduce((s, e) => s + (e.latest!.cumulative_return), 0) / count : 0;
    const best    = entries.reduce((best, e) => (e.latest!.cumulative_return > (best?.latest?.cumulative_return ?? -Infinity)) ? e : best, entries[0]);
    return { g, count, avg, best };
  });

  // Bot map
  const botMap = new Map(bots.map(b => [b.id, b]));

  // Super bot data
  const superBot      = bots.find(b => b.code === "S1");
  const superHoldings = superBot ? holdings.filter(h => h.bot_id === superBot.id) : [];
  const superTrades   = superBot ? trades.filter(t => t.bot_id === superBot.id) : [];
  const superSnap     = superBot ? snapshots.filter(s => s.bot_id === superBot.id) : [];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-mono">

      {/* Top bar */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">🤖 Tradecraft Bot Lab</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            {bots.length} bots · {loading ? "loading…" : `refreshed ${timeAgo(lastRefresh.toISOString())}`}
          </p>
        </div>
        <button onClick={load} className="text-xs text-gray-400 hover:text-white border border-gray-700 px-3 py-1.5 rounded-lg">
          ↺ Refresh
        </button>
      </div>

      <MarketClock />

      {/* Group summary strip */}
      <div className="px-6 py-3 border-b border-gray-800 grid grid-cols-7 gap-2">
        {groupStats.map(({ g, count, avg, best }) => (
          <button
            key={g}
            onClick={() => { setGroupFilter(g); setTab("leaderboard"); }}
            className={`rounded-lg p-2 text-left border transition-colors ${
              groupFilter === g ? "border-gray-500 bg-gray-800" : "border-gray-800 hover:border-gray-700"
            }`}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span style={{ backgroundColor: GROUP_COLOURS[g] }} className="w-2 h-2 rounded-full" />
              <span className="text-xs font-bold">{g}</span>
              <span className="text-gray-600 text-xs">{count}</span>
            </div>
            <p className={`text-sm font-bold leading-none ${pnlColour(avg)}`}>
              {avg >= 0 ? "+" : ""}{fmt(avg, 1)}%
            </p>
            <p className="text-gray-600 text-xs truncate">{GROUP_LABELS[g]}</p>
          </button>
        ))}
      </div>

      {/* Main tabs */}
      <div className="px-6 pt-4 flex gap-2 mb-4">
        {(["leaderboard","groups","equity","trades","superbot"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wide transition-colors ${
              tab === t ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            {t === "superbot" ? "🧠 Super Bot" : t}
          </button>
        ))}
        {groupFilter !== "ALL" && (
          <button onClick={() => setGroupFilter("ALL")} className="ml-auto text-xs text-gray-500 hover:text-white px-2">
            ✕ Clear filter
          </button>
        )}
      </div>

      <div className="px-6 pb-10">

        {/* ── LEADERBOARD ── */}
        {tab === "leaderboard" && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wide">
                  <th className="text-left px-3 py-3 w-8">#</th>
                  <th className="text-left px-3 py-3">Bot</th>
                  <th className="text-right px-3 py-3">Value</th>
                  <th className="text-right px-3 py-3">Return</th>
                  <th className="text-right px-3 py-3">Today</th>
                  <th className="text-right px-3 py-3">Cash</th>
                  <th className="text-left px-3 py-3">Holdings</th>
                  <th className="text-center px-3 py-3">14d Trend</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeaderboard.map(({ bot, latest, sparkData, rank }) => {
                  const colour       = GROUP_COLOURS[bot.group_id] ?? "#6b7280";
                  const botHoldings  = holdings.filter(h => h.bot_id === bot.id);
                  const holdingStr   = botHoldings.length > 0
                    ? botHoldings.map(h => h.symbol).slice(0, 3).join(", ") + (botHoldings.length > 3 ? ` +${botHoldings.length - 3}` : "")
                    : "cash";

                  return (
                    <tr
                      key={bot.id}
                      onClick={() => { setSelectedBot(bot.id); setTab("equity"); }}
                      className="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer transition-colors"
                    >
                      <td className="px-3 py-2.5 text-gray-500 text-xs">{rank}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <GroupBadge groupId={bot.group_id} />
                          <div>
                            <p className="font-semibold text-sm">{bot.code} <span className="text-gray-400 font-normal">— {bot.name}</span></p>
                            <p className="text-gray-600 text-xs truncate max-w-xs">{bot.description?.slice(0, 55)}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        ${fmt(latest?.total_value ?? 1000)}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-mono text-sm font-bold ${pnlColour(latest?.cumulative_return ?? 0)}`}>
                        {latest ? `${(latest.cumulative_return >= 0 ? "+" : "")}${fmt(latest.cumulative_return)}%` : "—"}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-mono text-xs ${pnlColour(latest?.day_pnl ?? 0)}`}>
                        {latest ? `${latest.day_pnl >= 0 ? "+" : ""}$${fmt(latest.day_pnl)}` : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-500 text-xs">
                        ${fmt(latest?.cash_balance ?? 1000)}
                      </td>
                      <td className="px-3 py-2.5 text-gray-400 text-xs font-mono">
                        {holdingStr}
                      </td>
                      <td className="px-3 py-2.5 flex justify-center">
                        <Sparkline points={sparkData} colour={colour} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── GROUPS ── */}
        {tab === "groups" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {groupStats.map(({ g, count, avg, best }) => {
              const groupBots = leaderboard.filter(e => e.bot.group_id === g);
              return (
                <div key={g} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span style={{ backgroundColor: GROUP_COLOURS[g] }} className="w-3 h-3 rounded-full" />
                    <h3 className="font-bold">Group {g} — {GROUP_LABELS[g]}</h3>
                    <span className="text-gray-600 text-xs ml-auto">{count} bots</span>
                  </div>
                  <p className={`text-2xl font-bold mb-1 ${pnlColour(avg)}`}>
                    {avg >= 0 ? "+" : ""}{fmt(avg)}% avg
                  </p>
                  {best && (
                    <p className="text-gray-500 text-xs mb-3">
                      Best: {best.bot.code} {best.latest ? `(+${fmt(best.latest.cumulative_return)}%)` : ""}
                    </p>
                  )}
                  <div className="space-y-1">
                    {groupBots.map(({ bot, latest, rank }) => (
                      <div
                        key={bot.id}
                        onClick={() => { setSelectedBot(bot.id); setTab("equity"); }}
                        className="flex items-center justify-between text-xs py-1 hover:bg-gray-800 rounded px-1 cursor-pointer"
                      >
                        <span className="text-gray-400">#{rank} {bot.code}</span>
                        <span className="text-gray-500 truncate mx-2 flex-1">{bot.name}</span>
                        <span className={`font-mono font-bold ${pnlColour(latest?.cumulative_return ?? 0)}`}>
                          {latest ? `${latest.cumulative_return >= 0 ? "+" : ""}${fmt(latest.cumulative_return)}%` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── EQUITY CHART ── */}
        {tab === "equity" && (
          <div className="space-y-4">
            {/* Bot picker */}
            <div className="flex flex-wrap gap-1.5">
              {bots.map(b => (
                <button
                  key={b.id}
                  onClick={() => setSelectedBot(b.id)}
                  style={selectedBot === b.id ? { backgroundColor: GROUP_COLOURS[b.group_id] } : {}}
                  className={`px-2 py-1 rounded text-xs font-mono transition-colors ${
                    selectedBot === b.id ? "text-white" : "bg-gray-800 text-gray-400 hover:text-white"
                  }`}
                >
                  {b.code}
                </button>
              ))}
            </div>

            {selectedBot ? (() => {
              const bot     = botMap.get(selectedBot)!;
              const colour  = GROUP_COLOURS[bot?.group_id] ?? "#6b7280";
              const botSnap = snapshots.filter(s => s.bot_id === selectedBot);
              const latest  = botSnap[botSnap.length - 1];
              const botHold = holdings.filter(h => h.bot_id === selectedBot);

              return (
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <GroupBadge groupId={bot?.group_id} />
                      <div>
                        <h2 className="font-bold">{bot?.code} — {bot?.name}</h2>
                        <p className="text-gray-500 text-xs">{bot?.description}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold">${fmt(latest?.total_value ?? 1000)}</p>
                      <p className={`text-sm ${pnlColour((latest?.total_value ?? 1000) - 1000)}`}>
                        {latest ? `${latest.cumulative_return >= 0 ? "+" : ""}${fmt(latest.cumulative_return)}% total return` : "No data yet"}
                      </p>
                    </div>
                  </div>

                  <EquityChart botId={selectedBot} snapshots={snapshots} colour={colour} />

                  {/* Current holdings */}
                  {botHold.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-800">
                      <p className="text-gray-500 text-xs mb-2 uppercase tracking-wide">Current Holdings</p>
                      <div className="flex flex-wrap gap-2">
                        {botHold.map(h => (
                          <span key={h.symbol} className="bg-gray-800 text-xs px-2 py-1 rounded font-mono">
                            {h.symbol} · {h.shares.toFixed(3)} @ ${fmt(h.avg_cost)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recent trades for this bot */}
                  <div className="mt-4 pt-4 border-t border-gray-800">
                    <p className="text-gray-500 text-xs mb-2 uppercase tracking-wide">Recent Trades</p>
                    <div className="space-y-1">
                      {trades.filter(t => t.bot_id === selectedBot).slice(0, 10).map(t => (
                        <div key={t.id} className="text-xs flex items-start gap-2">
                          <span className={`font-bold w-8 ${t.action === "buy" ? "text-emerald-400" : "text-red-400"}`}>
                            {t.action.toUpperCase()}
                          </span>
                          <span className="font-mono text-gray-300 w-12">{t.symbol}</span>
                          <span className="text-gray-500">${fmt(t.total)}</span>
                          <span className="text-gray-600 flex-1">{t.reason ?? "—"}</span>
                          <span className="text-gray-700 shrink-0">{timeAgo(t.executed_at)}</span>
                        </div>
                      ))}
                      {trades.filter(t => t.bot_id === selectedBot).length === 0 && (
                        <p className="text-gray-700 text-xs">No trades yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })() : (
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-12 text-center text-gray-600">
                Select a bot above to view its equity curve and trade history.
              </div>
            )}
          </div>
        )}

        {/* ── TRADE LOG ── */}
        {tab === "trades" && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-x-auto">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="font-bold text-sm">Trade Log — Last 200 trades</h2>
              <span className="text-gray-600 text-xs">{trades.length} trades loaded</span>
            </div>
            <table className="w-full text-xs min-w-[800px]">
              <thead>
                <tr className="border-b border-gray-800 text-gray-600 uppercase tracking-wide">
                  <th className="text-left px-3 py-2">Time</th>
                  <th className="text-left px-3 py-2">Bot</th>
                  <th className="text-left px-3 py-2">Action</th>
                  <th className="text-left px-3 py-2">Symbol</th>
                  <th className="text-right px-3 py-2">Shares</th>
                  <th className="text-right px-3 py-2">Price</th>
                  <th className="text-right px-3 py-2">Total</th>
                  <th className="text-left px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => {
                  const bot    = botMap.get(t.bot_id);
                  const colour = GROUP_COLOURS[bot?.group_id ?? ""] ?? "#6b7280";
                  return (
                    <tr key={t.id} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{timeAgo(t.executed_at)}</td>
                      <td className="px-3 py-2">
                        <span style={{ color: colour }} className="font-bold">{bot?.code ?? "?"}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`font-bold ${t.action === "buy" ? "text-emerald-400" : "text-red-400"}`}>
                          {t.action.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono font-bold">{t.symbol}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{t.shares.toFixed(4)}</td>
                      <td className="px-3 py-2 text-right font-mono">${fmt(t.price)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-300">${fmt(t.total)}</td>
                      <td className="px-3 py-2 text-gray-500 max-w-xs truncate">{t.reason ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── SUPER BOT PANEL ── */}
        {tab === "superbot" && (
          <div className="space-y-4">
            {/* Header card */}
            <div className="bg-gray-900 rounded-xl border border-orange-500/30 p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">🧠</span>
                  <div>
                    <h2 className="font-bold text-lg">S1 — Super Bot</h2>
                    <p className="text-gray-500 text-xs">AI-driven · Powered by Claude Haiku · Learns from all 50 training bots</p>
                  </div>
                </div>
                {superSnap.length > 0 && (() => {
                  const latest = superSnap[superSnap.length - 1];
                  return (
                    <div className="text-right">
                      <p className="text-2xl font-bold">${fmt(latest.total_value)}</p>
                      <p className={`text-sm ${pnlColour(latest.cumulative_return)}`}>
                        {latest.cumulative_return >= 0 ? "+" : ""}{fmt(latest.cumulative_return)}%
                      </p>
                    </div>
                  );
                })()}
              </div>
              <EquityChart botId={superBot?.id ?? ""} snapshots={snapshots} colour="#f97316" />
            </div>

            {/* Holdings */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h3 className="font-bold text-sm mb-3 text-orange-400">Current Holdings</h3>
              {superHoldings.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {superHoldings.map(h => (
                    <div key={h.symbol} className="bg-gray-800 rounded p-2">
                      <p className="font-bold font-mono">{h.symbol}</p>
                      <p className="text-gray-400 text-xs">{h.shares.toFixed(4)} shares</p>
                      <p className="text-gray-500 text-xs">avg ${fmt(h.avg_cost)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-600 text-sm">No holdings — fully in cash.</p>
              )}
            </div>

            {/* AI trade log with full reasoning */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h3 className="font-bold text-sm mb-3 text-orange-400">AI Trade Decisions</h3>
              {superTrades.length > 0 ? (
                <div className="space-y-3">
                  {superTrades.slice(0, 20).map(t => (
                    <div key={t.id} className="border-b border-gray-800 pb-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`font-bold text-xs ${t.action === "buy" ? "text-emerald-400" : "text-red-400"}`}>
                          {t.action.toUpperCase()}
                        </span>
                        <span className="font-mono font-bold">{t.symbol}</span>
                        <span className="text-gray-500 text-xs">${fmt(t.total)}</span>
                        <span className="text-gray-700 text-xs ml-auto">{timeAgo(t.executed_at)}</span>
                      </div>
                      {t.reason && (
                        <p className="text-gray-400 text-xs leading-relaxed">{t.reason}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-600 text-sm">No AI trades yet. S1 will make its first trade on the next market open.</p>
              )}
            </div>

            {/* How it works */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h3 className="font-bold text-sm mb-2 text-gray-400">How the Super Bot Works</h3>
              <ol className="text-gray-500 text-xs space-y-1.5 list-decimal list-inside">
                <li>Every 30 minutes during market hours, S1 reads the full leaderboard of all 50 training bots.</li>
                <li>It also reads today's market data — top gainers, top losers, key prices.</li>
                <li>This data is sent to Claude (Haiku model) with S1's current portfolio.</li>
                <li>Claude analyses which strategies are winning, why, and what trades S1 should make.</li>
                <li>S1 executes Claude's recommendations subject to the same 40% position cap and $50 dormancy rules as all other bots.</li>
                <li>All reasoning is logged — you can read Claude's full analysis in each trade's reason field above.</li>
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
