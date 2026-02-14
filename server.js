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

// Fallback extractor (rarely needed if response_format works, but keeps you safe)
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

function shortenToMaxSentences(msg, max = 4) {
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

WITHIN is a warm, therapeutic, compassionate conversation that helps people uncover what’s really driving their experience and change it at the root—without overwhelming them.

Non-negotiable behavior:
- Keep responses SHORT so you can gather information over turns.
- Always keep the conversation moving by asking ONE excellent next question every turn.
- Give the user meaningful feedback when you identify a limiting belief or a useful insight.

Safety + boundaries:
- Do not diagnose.
- Do not claim EMDR or perform therapy modalities.
- You may offer gentle grounding prompts (optional language) like breath + noticing the body.
- Do not mention being an AI.
- Do not mention hotlines unless the user expresses intent to self-harm.

Output:
Return ONLY valid JSON with EXACT keys:
assistant_message
follow_up_questions
chakra_map
map

assistant_message rules (warm + short):
- 2 to 4 sentences total (max 4).
- Sound human and compassionate.
- Reflect what you heard in a grounded way.
- If you see a limiting belief, name it gently (e.g., “A belief showing up here is…”).
- If you see a pattern, name it softly (e.g., “A protective pattern I’m noticing is…”).
- No lists. No long explanations. No advice.

follow_up_questions rules:
- Array of exactly 1 question.
- The question must be the best next question to clarify the root.
- Rotate the focus across turns: origin, trigger, protection, meaning, or body.
- Somatic rule: If strong emotion/shame/fear/grief/anger is present or implied, prefer a body-based question.
  Use wording like:
  “If you’re willing, take a slow breath and notice: where do you feel that in your body right now?”
  Keep it one question only.

chakra_map rules:
- Exactly 3 items.
- Each item:
  chakra: one of ["Root","Sacral","Solar Plexus","Heart","Throat","Third Eye","Crown"]
  state: "blocked" or "overactive"
  why: one short grounded sentence (psychological language, not mystical claims).

map rules:
- sabotage_archetype: one of ["Avoider","Perfectionist","Overdriver","Collapser","Pre-Rejector","None"]
- sabotage_confidence: number 0 to 1
- perceived_threat: array of 0–5 short keywords (examples: "rejection","judgment","failure","abandonment","control","visibility","safety","shame")
- limiting_belief: short sentence (empty string if none)
- identity_belief: MUST start with exactly "I am someone who"
- protection_intent: short sentence
- recommended_protocol: one of ["Relief","Agency","Identity-Install","Behavior-Proof","Regulation"]

Hard rules:
- Do NOT output activation_level.
- Do NOT output readiness.
- Do NOT invent new archetypes.
- If unclear, sabotage_archetype="None" and sabotage_confidence < 0.35.
- Output must be valid JSON only (no preface text).
`;

    const trimmedHistory = history
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.35,
      response_format: { type: "json_object" },
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
      parsed = extractFirstJsonObject(raw);
      if (!parsed) return res.status(500).json({ error: "Model did not return valid JSON", raw });
    }

    // Strip unwanted keys (just in case)
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
      parsed.follow_up_questions = [
        "If you’re willing, take a slow breath and notice: where do you feel that in your body right now?"
      ];
    }

    // Enforce short warm message
    parsed.assistant_message = shortenToMaxSentences(parsed.assistant_message, 4);

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
