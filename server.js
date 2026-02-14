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

// Extract the first JSON object found in a string (fallback safety)
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function shortenToMaxSentences(msg, max = 3) {
  if (!msg || typeof msg !== "string") return "";
  const parts = msg.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, max).join(" ").trim();
}

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

WITHIN is a compassionate conversational coach that reveals underlying patterns by asking excellent questions.

Absolute rule: Keep replies SHORT to gather info.
You must respond in 1–3 sentences total, then ask exactly ONE question.

Return ONLY JSON that matches the required schema.

Required keys:
assistant_message
follow_up_questions
chakra_map
map

assistant_message:
- 1 to 3 sentences total.
- No lists. No long explanations. No advice.
- Gentle reflection + small hint at an underlying driver.

follow_up_questions:
- Array of exactly 1 question.
- Make it easy to answer.

chakra_map:
- Array of exactly 3 items.
- Each: chakra (Root/Sacral/Solar Plexus/Heart/Throat/Third Eye/Crown), state (blocked/overactive), why (one short grounded sentence).
- Use grounded language (no mystical claims).

map:
- sabotage_archetype: one of ["Avoider","Perfectionist","Overdriver","Collapser","Pre-Rejector","None"]
- sabotage_confidence: 0..1
- perceived_threat: 0..5 keywords
- limiting_belief: short
- identity_belief: MUST start with exactly "I am someone who"
- protection_intent: short
- recommended_protocol: one of ["Relief","Agency","Identity-Install","Behavior-Proof","Regulation"]

Hard rules:
- Do NOT output activation_level.
- Do NOT output readiness.
- Do NOT invent new archetypes.
- Output must be valid JSON only.
`;

    const trimmedHistory = history
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.25,
      response_format: { type: "json_object" }, // ✅ forces JSON output
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
      // Fallback: try extracting the JSON object from raw text
      parsed = extractFirstJsonObject(raw);
      if (!parsed) {
        return res.status(500).json({ error: "Model did not return valid JSON", raw });
      }
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

    // Enforce short assistant message
    parsed.assistant_message = shortenToMaxSentences(parsed.assistant_message, 3);

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
