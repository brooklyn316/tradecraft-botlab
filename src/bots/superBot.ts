// ============================================================
// Super Bot — S1
// AI-driven meta-strategy using Claude Haiku.
// Every 30 min: reads all bot performance + market data,
// calls Claude to reason about trades, executes recommendations.
// ============================================================

import { BotContext, executeTrade, totalPortfolioValue, loadPrices } from "@/lib/botEngine";

interface ClaudeTrade {
  action: "buy" | "sell";
  symbol: string;
  amount: number | "all";
  reason: string;
}

interface ClaudeResponse {
  reasoning: string;
  trades: ClaudeTrade[];
}

// ── Build context prompt ──────────────────────────────────────

async function buildPrompt(ctx: BotContext): Promise<string> {
  const { supabase, holdings, prices, portfolio } = ctx;

  // 1. Get leaderboard (latest snapshots for all bots)
  const { data: latest } = await supabase
    .from("bot_daily_snapshots")
    .select("snapshot_date")
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .single();

  let leaderboardText = "No leaderboard data yet.";
  if (latest) {
    const { data: snaps } = await supabase
      .from("bot_daily_snapshots")
      .select("cumulative_return, total_value, bots!inner(code, name, group_id, description)")
      .eq("snapshot_date", latest.snapshot_date)
      .order("cumulative_return", { ascending: false })
      .limit(20);

    if (snaps && snaps.length > 0) {
      leaderboardText = (snaps as any[]).map((s, i) =>
        `${i+1}. ${s.bots.code} (${s.bots.name}, Group ${s.bots.group_id}): ${s.cumulative_return >= 0 ? "+" : ""}${s.cumulative_return.toFixed(2)}% return, $${s.total_value.toFixed(2)} value`
      ).join("\n");
    }
  }

  // 2. Recent market data — top movers
  const allPrices = Array.from(prices.values())
    .filter(p => p.change_percent !== null)
    .sort((a, b) => (b.change_percent ?? 0) - (a.change_percent ?? 0));

  const topGainers = allPrices.slice(0, 5)
    .map(p => `${p.symbol}: ${(p.change_percent ?? 0) >= 0 ? "+" : ""}${(p.change_percent ?? 0).toFixed(2)}% ($${p.price.toFixed(2)})`)
    .join(", ");

  const topLosers = allPrices.slice(-5).reverse()
    .map(p => `${p.symbol}: ${(p.change_percent ?? 0).toFixed(2)}% ($${p.price.toFixed(2)})`)
    .join(", ");

  // 3. S1 current portfolio
  const portfolioTotal = totalPortfolioValue(holdings, prices, portfolio.cash_balance);
  const holdingsText   = holdings.length > 0
    ? holdings.map(h => {
        const price  = prices.get(h.symbol)?.price ?? h.avg_cost;
        const pnlPct = (price - h.avg_cost) / h.avg_cost * 100;
        return `  ${h.symbol}: ${h.shares.toFixed(4)} shares @ $${price.toFixed(2)} (entry $${h.avg_cost.toFixed(2)}, P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`;
      }).join("\n")
    : "  (no holdings — fully in cash)";

  return `You are S1, an AI trading bot competing against 50 other algorithmic bots in a 12-month experiment. Each bot started with $1,000. Your goal is to maximise total return.

TODAY'S DATE: ${new Date().toISOString().split("T")[0]}

=== LEADERBOARD (top 20 bots by cumulative return) ===
${leaderboardText}

=== TODAY'S MARKET (key movers) ===
Top gainers: ${topGainers}
Top losers:  ${topLosers}

=== YOUR CURRENT PORTFOLIO (S1) ===
Total value: $${portfolioTotal.toFixed(2)} | Cash: $${portfolio.cash_balance.toFixed(2)}
Holdings:
${holdingsText}

=== YOUR TASK ===
Analyse the leaderboard to identify which strategies are winning and why. Consider market conditions today. Then decide what trades S1 should make this 30-minute cycle.

Rules you must follow:
- Max 40% of portfolio value in a single stock
- You have a 30-minute cooldown between trades (enforced by system)
- Available symbols: AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA, META, AMD, NFLX, COIN, DIS, BAC, GS, V, MA, PFE, ABBV, UNH, CVX, LMT, KO, JNJ, JPM, WMT, XOM, SPY, QQQ, PLTR, PG, MCD, MRK, SLB, OXY, XLK, XLF, XLE, XLV, XLI, TLT, GLD
- For buys: amount is dollars to spend (e.g. 150 means spend $150)
- For sells: amount is shares to sell, or "all" to close position

Respond ONLY with valid JSON in exactly this format:
{
  "reasoning": "2-3 sentence explanation of your analysis and strategy",
  "trades": [
    {"action": "buy", "symbol": "AAPL", "amount": 200, "reason": "brief reason"},
    {"action": "sell", "symbol": "TSLA", "amount": "all", "reason": "brief reason"}
  ]
}

If no trades are warranted, return an empty trades array. Do not include any text outside the JSON.`;
}

// ── Call Claude API ───────────────────────────────────────────

async function callClaude(prompt: string): Promise<ClaudeResponse | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("S1: ANTHROPIC_API_KEY not set");
    return null;
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`S1: Claude API error ${res.status}: ${err}`);
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text ?? "";

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("S1: no JSON found in Claude response:", text.slice(0, 200));
      return null;
    }

    return JSON.parse(jsonMatch[0]) as ClaudeResponse;
  } catch (err) {
    console.error("S1: Claude call failed:", err);
    return null;
  }
}

// ── Main runner ───────────────────────────────────────────────

export async function runS1(ctx: BotContext): Promise<string[]> {
  const logs: string[] = [];

  try {
    const prompt   = await buildPrompt(ctx);
    const response = await callClaude(prompt);

    if (!response) {
      return ["S1: Claude API call failed — skipping this cycle"];
    }

    logs.push(`S1 reasoning: ${response.reasoning}`);

    if (!response.trades || response.trades.length === 0) {
      logs.push("S1: no trades recommended this cycle");
      return logs;
    }

    // Load fresh prices for any symbols in the trade list not already in context
    const tradeSymbols = response.trades.map(t => t.symbol);
    const missingSymbols = tradeSymbols.filter(s => !ctx.prices.has(s));
    if (missingSymbols.length > 0) {
      const extra = await loadPrices(ctx.supabase, missingSymbols);
      extra.forEach((v, k) => ctx.prices.set(k, v));
    }

    for (const trade of response.trades) {
      const { action, symbol, amount, reason } = trade;
      const fullReason = `S1 AI: ${reason} | Analysis: ${response.reasoning.slice(0, 100)}`;

      const result = await executeTrade({
        ctx,
        symbol,
        action,
        amount,
        reason: fullReason,
      });

      logs.push(`S1 ${action} ${symbol}: ${result.message}`);
    }

  } catch (err) {
    logs.push(`S1 error: ${(err as Error).message}`);
  }

  return logs;
}
