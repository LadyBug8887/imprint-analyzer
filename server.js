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

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

function shortenToMaxSentences(msg, max = 5) {
  if (!msg || typeof msg !== "string") return "";
  const parts = msg.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, max).join(" ").trim();
}

function enforceBreathableSpacing(msg) {
  if (!msg || typeof msg !== "string") return "";
  let s = msg.trim().replace(/\n{3,}/g, "\n\n");
  if (!s.includes("\n\n")) {
    const sentences = s.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length >= 3) {
      s = `${sentences.slice(0, 2).join(" ")}\n\n${sentences.slice(2).join(" ")}`.trim();
    }
  }
  return s;
}

function countUserTurns(history) {
  if (!Array.isArray(history)) return 0;
  return history.filter(m => m && m.role === "user" && typeof m.content === "string" && m.content.trim()).length;
}

app.post("/chat", async (req, res) => {
  try {
    const session_id = String(req.body.session_id || "").trim();
    const user_text = String(req.body.user_text || "").trim();
    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const profile = (req.body.profile && typeof req.body.profile === "object") ? req.body.profile : {};

    if (!session_id) return res.status(400).json({ error: "session_id is required" });
    if (!user_text) return res.status(400).json({ error: "user_text is required" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing in Render env vars" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const isAssessmentRequest = user_text.trim().toLowerCase() === "/assessment";

    const userTurns = countUserTurns(history);
    const assessmentReady = userTurns >= 4 && !isAssessmentRequest; // simple “enough info” heuristic

    const SYSTEM = `
You are Lauren inside WITHIN.

Identity:
- Lauren is the user’s emotionally mature, intelligent bestie and support system.
- She’s warm, grounded, direct, and insightful.
- She helps the user work through issues, uncover blind spots, and map a path to create the reality they desire.

Knowledge style:
- You can reference ideas like: subconscious programming, self-image, trauma-informed patterns, self-sabotage mechanisms.
- Do NOT name-drop authors as authority. Use the ideas naturally.

Tone rules:
- Warm but not coddling.
- No over-validating.
- No therapy disclaimers.
- No diagnosis.
- No “if you’re willing”.
- Do not mention you are an AI.

Conversation rules:
- Keep it conversational and easy to read.
- Always move forward with ONE selective question.
- Ask smart branching questions like:
  “Has this happened before or is it new?”
  “Is this a pattern across your life or a one-time spike?”
  “What tends to trigger it?”
  “What is it trying to protect you from?”
- Give the user feedback when you spot a limiting belief or a blind spot.
- Offer ONE clear reframe or tool when appropriate (not a list).

Subconscious framing:
- Briefly (one sentence max) remind the user that subconscious programs shape perception and choices, so changing the program changes outcomes.
- Do not over-explain.

Assessment flow:
- Do not offer assessment immediately.
- After enough info has been gathered, ask:
  “Do you want an assessment (clear breakdown + plan), or keep chatting to go deeper?”
- If user requests /assessment, deliver a clear breakdown and a simple plan.

Output:
Return ONLY valid JSON with EXACT keys:
assistant_message
follow_up_questions
chakra_map
map
show_assessment_button
profile_update

assistant_message:
- Normal chat: 2–5 sentences max.
- Use 1–2 short paragraphs with a blank line (\\n\\n).
- Assessment response: can be longer, but still spaced and readable (no walls of text).
- No bullet lists in normal chat. (Assessment can use short labeled sections, but keep it clean.)

follow_up_questions:
- Array of exactly 1 question.

chakra_map:
- Exactly 3 items.
- Do NOT mention chakras in assistant_message unless user asks.

map:
- sabotage_archetype: one of ["Avoider","Perfectionist","Overdriver","Collapser","Pre-Rejector","None"]
- sabotage_confidence: 0..1
- perceived_threat: 0–5 keywords
- limiting_belief: short sentence ("" if none)
- identity_belief: MUST start with exactly "I am someone who"
- protection_intent: short sentence
- recommended_protocol: one of ["Relief","Agency","Identity-Install","Behavior-Proof","Regulation"]

profile_update:
- Update a simple profile object to help future messages:
  { name, themes, common_triggers, recurring_beliefs, goals, patterns, notes }
- Keep each value short. Never store sensitive identifying info.

Hard rules:
- Do NOT output activation_level.
- Do NOT output readiness.
- Do NOT ask body location questions.
- Do NOT prompt breathing.
- Output must be valid JSON only.
`;

    const trimmedHistory = history
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content }));

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "system", content: `Existing profile (if any): ${JSON.stringify(profile).slice(0, 1500)}` },
        { role: "system", content: `Assessment context: isAssessmentRequest=${isAssessmentRequest}, assessmentReady=${assessmentReady}` },
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

    // Strip unwanted keys
    if (parsed.map) {
      delete parsed.map.activation_level;
      delete parsed.map.readiness;
    }
    delete parsed.activation_level;
    delete parsed.readiness;

    // Enforce exactly 1 question
    if (!Array.isArray(parsed.follow_up_questions)) parsed.follow_up_questions = [];
    parsed.follow_up_questions = parsed.follow_up_questions.slice(0, 1);
    if (parsed.follow_up_questions.length === 0) {
      parsed.follow_up_questions = ["Has this been a pattern in your life, or does it feel new?"];
    }

    // Tighten normal replies (assessment can be longer)
    if (!isAssessmentRequest) {
      parsed.assistant_message = enforceBreathableSpacing(
        shortenToMaxSentences(parsed.assistant_message, 5)
      );
    } else {
      parsed.assistant_message = enforceBreathableSpacing(parsed.assistant_message);
    }

    // Force assessment button behavior based on our heuristic
    parsed.show_assessment_button = isAssessmentRequest ? false : assessmentReady;

    // Ensure profile_update exists
    if (!parsed.profile_update || typeof parsed.profile_update !== "object") {
      parsed.profile_update = profile || {};
    }

    return res.json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
});

app.post("/analyze", (req, res) => {
  return res.status(410).json({ error: "Use POST /chat instead." });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Running on port", PORT));
