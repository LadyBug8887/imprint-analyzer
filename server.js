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

app.post("/chat", async (req, res) => {
  try {
    const session_id = String(req.body.session_id || "").trim();
    const user_text = String(req.body.user_text || "").trim();
    const history = Array.isArray(req.body.history) ? req.body.history : [];

    if (!session_id) return res.status(400).json({ error: "session_id is required" });
    if (!user_text) return res.status(400).json({ error: "user_text is required" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing in Render env vars" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const SYSTEM = `
You are WITHIN.

WITHIN is a compassionate conversational coach that helps people identify what’s really driving their experience (often beneath awareness) by asking excellent questions.

Absolute rule: Keep replies SHORT so you can gather information.
You must respond in 1–3 sentences total, then ask exactly ONE question.

Return ONLY valid JSON with EXACT keys:
assistant_message
follow_up_questions
chakra_map
map

assistant_message rules:
- 1 to 3 sentences total.
- No lists. No long explanations. No advice.
- Gently reflect what you heard and hint at a possible underlying driver in plain language.
- Do not mention being an AI.

follow_up_questions rules:
- Array of exactly 1 question.
- The question must be the best next question to clarify the root:
  pick ONE focus per turn: origin, protection, trigger, or meaning.
- Make it easy to answer.

chakra_map rules:
- Array of exactly 3 items.
- Each item:
  chakra: one of ["Root","Sacral","Solar Plexus","Heart","Throat","Third Eye","Crown"]
  state: "blocked" or "overactive"
  why: one short grounded sentence (no mystical language).

map rules:
- sabotage_archetype: one of ["Avoider","Perfectionist","Overdriver","Collapser","Pre-Rejector","None"]
- sabotage_confidence: number 0 to 1
- perceived_threat: array of 0–5 short keywords
- limiting_belief: short sentence
- identity_belief: MUST start with exactly "I am someone who"
- protection_intent: short sentence
- recommended_protocol: one of ["Relief","Agency","Identity-Install","Behavior-Proof","Regulation"]

Hard rules:
- Do NOT output activation_level.
- Do NOT output readiness.
- Do NOT invent new archetypes.
- If unclear, sabotage_archetype="None" and sabotage_confidence < 0.35.
- Output must be parseable JSON only.
`;

    const trimmedHistory = history
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-10);

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.25,
      messages: [
        { role: "system", content: SYSTEM },
        ...trimmedHistory.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: user_text }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: "Model did not return valid JSON", raw });
    }

    // Hard strip unwanted keys
    if (parsed.map) {
      delete parsed.map.activation_level;
      delete parsed.map.readiness;
    }
    delete parsed.activation_level;
    delete parsed.readiness;

    // Enforce exactly 1 follow-up question
    if (!Array.isArray(parsed.follow_up_questions)) parsed.follow_up_questions = [];
    parsed.follow_up_questions = parsed.follow_up_questions.slice(0, 1);
    if (parsed.follow_up_questions.length === 0) {
      parsed.follow_up_questions = ["When did you first start believing that?"];
    }

    // Last-resort shortening if the model rambles
    if (typeof parsed.assistant_message === "string") {
      const s = parsed.assistant_message.trim();
      // Keep only first 3 sentences max
      const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
      parsed.assistant_message = parts.slice(0, 3).join(" ").trim();
    }

    return res.json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
});

// Deprecated
app.post("/analyze", (req, res) => {
  return res.status(410).json({ error: "Use POST /chat instead." });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Running on port", PORT));
