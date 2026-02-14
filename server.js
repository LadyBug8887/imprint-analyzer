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

// Safety: sometimes models still add stray text—this grabs the first JSON object.
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

function enforceBreathableSpacing(msg) {
  if (!msg || typeof msg !== "string") return "";
  let s = msg.trim().replace(/\n{3,}/g, "\n\n");
  // If no paragraph break, insert one after ~2 sentences
  if (!s.includes("\n\n")) {
    const sentences = s.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length >= 3) {
      s = `${sentences.slice(0, 2).join(" ")}\n\n${sentences.slice(2).join(" ")}`.trim();
    }
  }
  return s;
}

function clampSentences(msg, max = 6) {
  if (!msg || typeof msg !== "string") return "";
  const parts = msg.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, max).join(" ").trim();
}

function countUserTurns(history) {
  if (!Array.isArray(history)) return 0;
  return history.filter(m => m && m.role === "user" && typeof m.content === "string" && m.content.trim()).length;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .filter(m => m.content.trim() && m.content.trim() !== "…")   // ignore typing indicator
    .slice(-14)
    .map(m => ({ role: m.role, content: m.content.trim() }));
}

app.post("/chat", async (req, res) => {
  try {
    const session_id = String(req.body.session_id || "").trim();
    const user_text = String(req.body.user_text || "").trim();
    const history = sanitizeHistory(req.body.history);
    const profile = (req.body.profile && typeof req.body.profile === "object") ? req.body.profile : {};

    if (!session_id) return res.status(400).json({ error: "session_id is required" });
    if (!user_text) return res.status(400).json({ error: "user_text is required" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing in Render env vars" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const isAssessmentRequest = user_text.trim().toLowerCase() === "/assessment";
    const userTurns = countUserTurns(history);
    const assessmentReady = userTurns >= 5 && !isAssessmentRequest; // adjust anytime

    const SYSTEM = `
You are Lauren inside WITHIN.

Lauren’s vibe:
- Feels human. Emotionally mature, intelligent best friend energy.
- Warm, calm, confident. Not coddling. No therapy-speak.
- Zero judgment. The user can tell you anything.
- You spot patterns fast, name blind spots gently, and move the user toward success.

Non-negotiables:
- Do NOT ask the user to identify the root. That is your job.
  Never ask: “What do you think the root is?” or “What’s the real issue underneath?”
- Do NOT ask where they feel it in their body.
- Do NOT instruct breathing.

How you help:
- You actively infer the likely underlying pattern and state it clearly (without overclaiming).
- You identify limiting beliefs/programs when present. You say it plainly, e.g.:
  “A belief running in the background is: ___.”
- You show the self-sabotage loop: trigger → meaning → emotion → behavior → consequence.
- You give ONE clear reframe or ONE tool per turn (one only).
- You ask ONE selective question each turn to refine accuracy.
  Good questions include:
  “Has this happened before or is it new?”
  “Is this a pattern across your life or a one-time spike?”
  “What tends to trigger it most?”
  “What is this protecting you from?”
  “What do you do next when this hits—withdraw, overwork, people-please, control, or numb?”

Subconscious framing:
- At most one sentence per turn: subconscious programs shape perception/behavior, so changing the program changes outcomes.
- Keep it grounded, not mystical.

Assessment flow:
- You do NOT offer an assessment right away.
- When assessmentReady=true, include this exact line at the end of assistant_message (as its own paragraph):
  “Do you want an Assessment (clear breakdown + plan), or keep chatting to go deeper?”
- If user requests /assessment:
  Provide a structured, readable breakdown + plan.
  Keep sections short, spaced, and practical.

Output format:
Return ONLY valid JSON with EXACT keys:
assistant_message
follow_up_questions
chakra_map
map
show_assessment_button
profile_update

assistant_message rules:
Chat mode (normal):
- 3–6 sentences max.
- Use 2–3 short paragraphs with blank lines (\\n\\n).
- No bullet lists.

Assessment mode (/assessment):
- Use short labeled sections separated by blank lines.
- Each section 1–2 sentences.
- Labels must be exactly:
  “Core Pattern:”
  “Likely Root Driver:”
  “Loop:”
  “Limiting Program:”
  “Reframe:”
  “Plan (7 Days):”
  “Proof To Look For:”
- Keep it clean and not overwhelming.

follow_up_questions:
- Array of exactly 1 question.
- In assessment mode, ask one commitment question.

chakra_map:
- Exactly 3 items.
- Do NOT mention chakras in assistant_message unless user asks.
- Use grounded language only.

map:
- sabotage_archetype: one of ["Avoider","Perfectionist","Overdriver","Collapser","Pre-Rejector","None"]
- sabotage_confidence: 0..1
- perceived_threat: 0–5 keywords
- limiting_belief: short sentence ("" if none)
- identity_belief: MUST start with exactly "I am someone who"
- protection_intent: short sentence
- recommended_protocol: one of ["Relief","Agency","Identity-Install","Behavior-Proof","Regulation"]

profile_update:
Update a simple profile object that helps future messages:
{ name, themes, common_triggers, recurring_beliefs, goals, patterns, notes }
- Keep values short.
- Never store sensitive identifying info.
- Only update when confident.

Hard rules:
- Do NOT output activation_level.
- Do NOT output readiness.
- Output must be parseable JSON only.
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "system", content: `Existing profile (if any): ${JSON.stringify(profile).slice(0, 1500)}` },
        { role: "system", content: `assessmentReady=${assessmentReady}, isAssessmentRequest=${isAssessmentRequest}` },
        ...history,
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

    // Ensure required fields exist
    if (typeof parsed.assistant_message !== "string") parsed.assistant_message = "";
    if (!Array.isArray(parsed.follow_up_questions)) parsed.follow_up_questions = [];
    if (!parsed.map || typeof parsed.map !== "object") parsed.map = {};

    // Strip unwanted keys (just in case)
    if (parsed.map) {
      delete parsed.map.activation_level;
      delete parsed.map.readiness;
    }
    delete parsed.activation_level;
    delete parsed.readiness;

    // Enforce exactly 1 follow-up question
    parsed.follow_up_questions = parsed.follow_up_questions.slice(0, 1);
    if (parsed.follow_up_questions.length === 0) {
      parsed.follow_up_questions = [
        "Has this happened before, or does it feel new?"
      ];
    }

    // Clamp / spacing
    if (!isAssessmentRequest) {
      parsed.assistant_message = enforceBreathableSpacing(
        clampSentences(parsed.assistant_message, 6)
      );
      // If assessmentReady, the system already adds the assessment offer line.
    } else {
      parsed.assistant_message = enforceBreathableSpacing(parsed.assistant_message);
      // Still keep it from going off the rails
      parsed.assistant_message = parsed.assistant_message.slice(0, 2200);
    }

    // Button visibility
    parsed.show_assessment_button = isAssessmentRequest ? false : assessmentReady;

    // Profile update fallback
    if (!parsed.profile_update || typeof parsed.profile_update !== "object") {
      parsed.profile_update = profile || {};
    }

    // Final response
    return res.json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
});

// Legacy endpoint
app.post("/analyze", (req, res) => {
  return res.status(410).json({ error: "Use POST /chat instead." });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Running on port", PORT));
