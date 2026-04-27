require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json());

// Allow your frontend domain in production — update FRONTEND_URL in .env
app.use(cors({
  origin: "*",
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.options("*", cors());

app.get("/", (req, res) => {
  res.json({ name: "SharpEdge AI Backend", status: "live", version: "1.0.0" });
});

// Rate limiting — 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests. Slow down." },
});
app.use("/api/", limiter);

// ─── Health check ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "SharpEdge AI Backend" });
});

// ─── AI Proxy Route ───────────────────────────────────────────
// Your frontend calls POST /api/chat
// This server forwards it to Anthropic — the API key never leaves this server
app.post("/api/chat", async (req, res) => {
  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array is required" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "API key not configured on server" });
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
        max_tokens: 500,
        system: system || defaultSystem,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || "Anthropic API error" });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || "";
    res.json({ reply });

  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).json({ error: "Server error. Try again." });
  }
});

// ─── Default SharpEdge system prompt ─────────────────────────
const defaultSystem = `You are SharpEdge AI, an elite sports betting intelligence assistant covering NFL, NBA, MLB, NHL, Soccer/MLS, and UFC/MMA. Sharp, data-driven, concise. Think like a professional sports bettor.

Capabilities: Line analysis, +EV bets, player props, bankroll management (Kelly Criterion), parlay construction, sharp vs public money analysis, live betting across all 6 sports.

Style: Direct and confident. No fluff. Clear recommendation with sharp reasoning. Use betting terminology naturally (juice, ATS, ML, spread, total, hook, CLV, EV, steam, reverse line movement). Always mention risk. Never guarantee wins.

Response format:
1. Recommendation (bet or pass — be specific)
2. 2-3 sharp reasons
3. Confidence level or EV note
4. Bankroll sizing (units to risk)

Keep under 200 words. Be the sharp friend who actually knows what they are talking about.`;

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SharpEdge backend running on port ${PORT}`);
});
