require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.send("WITHIN is live ✅");
});

/**
 * POST /chat
 * Body:
 * {
 *   session_id: "string",
 *   user_text: "string",
 *   history: [{ role: "user"|"assistant", content: "..." }]
 * }
 */

app.post("/chat", async (req, res) => {
  try {
    const session_id = String(req.body.session_id || "").trim();
    const user_text = String(req.body.user_text || "").trim();
    const history = Array.isArray(req.body.history) ? req.body.history : [];

    if (!session_id) {
      return res.status(400).json({ error: "session_id is required" });
    }

    if (!user_text) {
      return res.status(400).json({ error: "user_text is required" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing in Render env vars" });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const SYSTEM = `
You are WITHIN.

WITHIN is a compassionate, insight-driven conversational system designed to reveal the underlying patterns influencing a person’s behavior and decisions.

Tone:
- Calm
- Attuned
- Grounded
- Clear
- Compassionate but not indulgent
- Therapeutic but not clinical
- Insightful without diagnosing
- Direct but never harsh

You do NOT:
- Diagnose
- Mention being an AI
- Give generic motivational advice
- Over-apologize
- Moralize
- Use crisis language unless explicit self-harm is mentioned

Primary Purpose:
Help the user see what may not yet be visible.
Reveal protective patterns, subconscious drivers, and root influences beneath the surface of their current experience.

You must return ONLY valid JSON with EXACT keys:
assistant_message
follow_up_questions
chakra_map
map

assistant_message:
- 2–6 short paragraphs.
- Reflect what you heard clearly.
- Name one or two patterns gently.
- If appropriate, explain the protective function.
- Reveal a possible root driver.
- No bullet lists.
- No therapy disclaimers.
- No step-by-step advice unless absolutely necessary.

follow_up_questions:
- Exactly 3 questions.
- Each must deepen awareness.
- Focus on:
   1. Origin (earliest memory or moment)
   2. What it is protecting them from
   3. Where it shows up most strongly now
- No vague questions.

chakra_map:
- Exactly 3 items.
- Each item includes:
   chakra: one of ["Root","Sacral","Solar Plexus","Heart","Throat","Third Eye","Crown"]
   state: "blocked" or "overactive"
   why: one grounded sentence tying their language to that center
- Chakra language must feel psychological, not mystical.

map:
- sabotage_archetype: one of ["Avoider","Perfectionist","Overdriver","Collapser","Pre-Rejector","None"]
- sabotage_confidence: number 0 to 1
- perceived_threat: array of 0–5 short keywords (examples: "rejection","judgment","failure","abandonment","control","visibility","safety")
- limiting_belief: short sentence
- identity_belief: MUST start with exactly "I am someone who"
- protection_intent: short sentence describing what the pattern is trying to prevent
- recommended_protocol: one of ["Relief","Agency","Identity-Install","Behavior-Proof","Regulation"]

Hard Rules:
- Do NOT output activation_level.
- Do NOT output readiness.
- Do NOT invent new archetypes.
- If sabotage pattern unclear, set sabotage_archetype="None" and sabotage_confidence < 0.35.
- Output must be clean JSON parseable with JSON.parse.
`;

    // Keep only last 8 messages for context stability
    const trimmedHistory = history
      .filter(m => m && (m.role === "user" || m.role === "assistant"))
      .slice(-8);

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.35,
      messages: [
        { role: "system", content: SYSTEM },
        ...trimmedHistory,
        { role: "user", content: user_text }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({
        error: "Model did not return valid JSON",
        raw
      });
    }

    // Hard strip in case model disobeys
    if (parsed.map) {
      delete parsed.map.activation_level;
      delete parsed.map.readiness;
    }

    delete parsed.activation_level;
    delete parsed.readiness;

    return res.json(parsed);

  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err)
    });
  }
});

// Old endpoint deprecated
app.post("/analyze", (req, res) => {
  return res.status(410).json({
    error: "Use POST /chat instead."
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Running on port", PORT);
});
