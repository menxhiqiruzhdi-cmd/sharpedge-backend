require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(cors({ origin: "*", methods: ["POST", "GET", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: "Too many requests." } });
app.use("/api/", limiter);

// ─── Odds cache ───────────────────────────────────────────────
let oddsCache = { data: null, lastFetched: 0 };
const CACHE_TTL = 5 * 60 * 1000;

const SPORTS = [
  "americanfootball_nfl", "basketball_nba", "baseball_mlb",
  "icehockey_nhl", "soccer_usa_mls", "mma_mixed_martial_arts",
];

const SPORT_LABELS = {
  americanfootball_nfl: "NFL", basketball_nba: "NBA", baseball_mlb: "MLB",
  icehockey_nhl: "NHL", soccer_usa_mls: "MLS", mma_mixed_martial_arts: "UFC",
};

async function fetchLiveOdds() {
  const now = Date.now();
  if (oddsCache.data && now - oddsCache.lastFetched < CACHE_TTL) return oddsCache.data;
  if (!process.env.ODDS_API_KEY) throw new Error("ODDS_API_KEY not configured");

  const allGames = [];
  for (const sport of SPORTS) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const games = await res.json();

      games.forEach(game => {
        const book = game.bookmakers?.find(b => b.key === "draftkings" || b.key === "fanduel") || game.bookmakers?.[0];
        if (!book) return;

        const h2h = book.markets?.find(m => m.key === "h2h");
        const spread = book.markets?.find(m => m.key === "spreads");
        const total = book.markets?.find(m => m.key === "totals");

        const homeML = h2h?.outcomes?.find(o => o.name === game.home_team)?.price;
        const awayML = h2h?.outcomes?.find(o => o.name === game.away_team)?.price;
        const homeSpread = spread?.outcomes?.find(o => o.name === game.home_team);
        const overTotal = total?.outcomes?.find(o => o.name === "Over");

        const gameTime = new Date(game.commence_time);
        const isLive = gameTime < new Date();

        allGames.push({
          id: game.id,
          sport: SPORT_LABELS[sport] || sport,
          status: isLive ? "LIVE" : "UPCOMING",
          time: isLive ? "LIVE" : gameTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
          home: game.home_team,
          away: game.away_team,
          homeML: homeML ? (homeML > 0 ? `+${homeML}` : `${homeML}`) : "N/A",
          awayML: awayML ? (awayML > 0 ? `+${awayML}` : `${awayML}`) : "N/A",
          spread: homeSpread ? `${game.home_team.split(" ").pop()} ${homeSpread.point > 0 ? "+" : ""}${homeSpread.point}` : "N/A",
          total: overTotal ? `O/U ${overTotal.point}` : "N/A",
        });
      });
    } catch (e) {
      console.error(`Error fetching ${sport}:`, e.message);
    }
  }

  oddsCache = { data: allGames, lastFetched: Date.now() };
  return allGames;
}

// ─── Routes ──────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ name: "SharpEdge AI Backend", status: "live", version: "2.0.0" }));
app.get("/health", (req, res) => res.json({ status: "ok", service: "SharpEdge AI Backend" }));

app.get("/api/odds", async (req, res) => {
  try {
    const games = await fetchLiveOdds();
    res.json({ games, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { messages, system } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages array is required" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not configured" });

  let liveOddsContext = "";
  try {
    const games = await fetchLiveOdds();
    if (games.length > 0) {
      liveOddsContext = "\n\nLIVE ODDS DATA (real-time — use this for all analysis):\n";
      games.slice(0, 20).forEach(g => {
        liveOddsContext += `${g.sport}: ${g.away} (${g.awayML}) vs ${g.home} (${g.homeML}) | Spread: ${g.spread} | ${g.total} | ${g.status} ${g.time}\n`;
      });
      liveOddsContext += "\nAlways reference these real lines and teams in your analysis.";
    }
  } catch (e) {
    console.error("Odds fetch failed:", e.message);
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 600,
        system: (system || defaultSystem) + liveOddsContext,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || "Anthropic API error" });
    }

    const data = await response.json();
    res.json({ reply: data.content?.[0]?.text || "" });
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).json({ error: "Server error. Try again." });
  }
});

const defaultSystem = `You are SharpEdge AI, an elite sports betting intelligence assistant covering NFL, NBA, MLB, NHL, Soccer/MLS, and UFC/MMA. Sharp, data-driven, concise. Think like a professional sports bettor.

You have access to real-time live odds injected into your context. Always reference actual games, teams, and lines from this data.

Style: Direct. No fluff. Use betting terms naturally (juice, ATS, ML, spread, total, hook, CLV, EV, steam, reverse line movement). Always mention risk. Never guarantee wins.

Response format:
1. Recommendation (bet or pass — specific team and line)
2. 2-3 sharp reasons
3. Confidence/EV note
4. Bankroll sizing (units)

Keep under 220 words.`;

app.listen(PORT, () => console.log(`SharpEdge backend v2.0 running on port ${PORT}`));
