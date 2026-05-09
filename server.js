require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3001;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(express.json());
app.use(cors({ origin: "*", methods: ["POST", "GET", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: "Too many requests." } });
app.use("/api/", limiter);

// Cache 30 minutes to save API credits
let oddsCache = { data: null, lastFetched: 0 };
const CACHE_TTL = 30 * 60 * 1000;

const SPORTS = [
  "americanfootball_nfl", "basketball_nba", "baseball_mlb", "icehockey_nhl",
  "soccer_epl", "soccer_spain_la_liga", "soccer_germany_bundesliga",
  "soccer_italy_serie_a", "soccer_france_ligue_one", "soccer_usa_mls",
  "soccer_uefa_champs_league", "mma_mixed_martial_arts",
];

const SPORT_LABELS = {
  americanfootball_nfl:"NFL", basketball_nba:"NBA", baseball_mlb:"MLB",
  icehockey_nhl:"NHL", soccer_epl:"EPL", soccer_spain_la_liga:"La Liga",
  soccer_germany_bundesliga:"Bundesliga", soccer_italy_serie_a:"Serie A",
  soccer_france_ligue_one:"Ligue 1", soccer_usa_mls:"MLS",
  soccer_uefa_champs_league:"Champions League", mma_mixed_martial_arts:"UFC",
};

async function fetchLiveOdds() {
  const now = Date.now();
  if (oddsCache.data && now - oddsCache.lastFetched < CACHE_TTL) {
    console.log("Returning cached odds");
    return oddsCache.data;
  }
  if (!process.env.ODDS_API_KEY) throw new Error("ODDS_API_KEY not configured");

  const allGames = [];
  for (const sport of SPORTS) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        console.error(`Error fetching ${sport}:`, text);
        continue;
      }
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
          id: game.id, sport: SPORT_LABELS[sport] || sport,
          status: isLive ? "LIVE" : "UPCOMING",
          time: isLive ? "LIVE" : gameTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
          home: game.home_team, away: game.away_team,
          homeML: homeML ? (homeML > 0 ? `+${homeML}` : `${homeML}`) : "N/A",
          awayML: awayML ? (awayML > 0 ? `+${awayML}` : `${awayML}`) : "N/A",
          spread: homeSpread ? `${game.home_team.split(" ").pop()} ${homeSpread.point > 0 ? "+" : ""}${homeSpread.point}` : "N/A",
          total: overTotal ? `O/U ${overTotal.point}` : "N/A",
        });
      });
    } catch (e) { console.error(`Error fetching ${sport}:`, e.message); }
  }

  oddsCache = { data: allGames, lastFetched: Date.now() };
  console.log(`Fetched ${allGames.length} games, cached for 30 minutes`);
  return allGames;
}

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });
    req.user = user;
    next();
  } catch (e) { return res.status(401).json({ error: "Auth failed" }); }
}

app.get("/", (req, res) => res.json({ name: "SharpEdge AI Backend", status: "live", version: "3.0.0" }));
app.get("/health", (req, res) => res.json({ status: "ok", service: "SharpEdge AI Backend" }));

app.post("/api/auth/signup", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email, password,
      user_metadata: { name: name || "", tier: "free" },
      email_confirm: true,
    });
    if (error) return res.status(400).json({ error: error.message });
    const { data: session, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) return res.status(400).json({ error: signInError.message });
    res.json({
      user: { id: data.user.id, email: data.user.email, name: data.user.user_metadata?.name || "", tier: "free" },
      token: session.session.access_token,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    res.json({
      user: { id: data.user.id, email: data.user.email, name: data.user.user_metadata?.name || "", tier: data.user.user_metadata?.tier || "free" },
      token: data.session.access_token,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.user_metadata?.name || "", tier: req.user.user_metadata?.tier || "free" } });
});

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  await supabase.auth.admin.signOut(req.headers.authorization?.replace("Bearer ", ""));
  res.json({ success: true });
});

app.get("/api/odds", async (req, res) => {
  try { res.json({ games: await fetchLiveOdds(), updatedAt: new Date().toISOString() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/chat", async (req, res) => {
  const { messages, system } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages array required" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not configured" });

  let userTier = "free";
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token) {
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) userTier = user.user_metadata?.tier || "free";
    } catch (e) {}
  }

  let liveOddsContext = "";
  try {
    const games = await fetchLiveOdds();
    if (games.length > 0) {
      liveOddsContext = "\n\nLIVE ODDS DATA (real-time):\n";
      games.slice(0, 20).forEach(g => {
        liveOddsContext += `${g.sport}: ${g.away} (${g.awayML}) vs ${g.home} (${g.homeML}) | Spread: ${g.spread} | ${g.total} | ${g.status} ${g.time}\n`;
      });
      liveOddsContext += "\nAlways reference these real lines in your analysis.";
    }
  } catch (e) {}

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: userTier === "free" ? 300 : 600, system: (system || defaultSystem) + liveOddsContext, messages }),
    });
    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || "AI error" });
    }
    const data = await response.json();
    res.json({ reply: data.content?.[0]?.text || "", tier: userTier });
  } catch (err) { res.status(500).json({ error: "Server error." }); }
});

const defaultSystem = `You are SharpEdge AI, an elite sports betting intelligence assistant covering NFL, NBA, MLB, NHL, EPL, La Liga, Bundesliga, Serie A, Ligue 1, Champions League, MLS, and UFC/MMA. Sharp, data-driven, concise. Think like a professional sports bettor. You have access to real-time live odds. Always reference actual games, teams, and lines. Style: Direct. No fluff. Use betting terms (juice, ATS, ML, spread, total, hook, CLV, EV, steam, reverse line movement). Always mention risk. Never guarantee wins. Format: 1) Recommendation 2) 2-3 sharp reasons 3) Confidence/EV note 4) Bankroll sizing. Keep under 220 words.`;

app.listen(PORT, () => console.log(`SharpEdge backend v3.0 running on port ${PORT}`));
