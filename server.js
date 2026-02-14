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

/* -----------------------------
   Helper Utilities
----------------------------- */

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

  // Ensure short paragraphing (2 paragraphs max)
  if (!s.includes("\n\n")) {
    const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (parts.length >= 3) {
      s = `${parts.slice(0, 2).join(" ")}\n\n${parts.slice(2).join(" ")}`.trim();
    }
  } else {
    // If too many paragraphs, compress
    const paras = s.split(/\n\n+/).filter(Boolean);
    s = paras.slice(0, 2).join("\n\n").trim();
  }
  return s;
}

function clampSentences(msg, max = 5) {
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
    .filter(m => m.content.trim() && m.content.trim() !== "…")
    .slice(-10) // smaller = faster + less overwhelming
    .map(m => ({ role: m.role, content: m.content.trim() }));
}

function ensureEndsWithQuestion(text, fallbackQ) {
  const s = (text || "").trim();
  if (!s) return `${fallbackQ}`;
  if (/[?]\s*$/.test(s)) return s;
  return `${s}\n\n${fallbackQ}`;
}

function extractLastQuestion(text) {
  const m = (text || "").match(/([^\n\r?]*\?)\s*$/);
  return m && m[1] ? m[1].trim() : null;
}

function safeString(x) {
  return (typeof x === "string" ? x : "").trim();
}

/* -----------------------------
   Main Chat Endpoint
----------------------------- */

app.post("/chat", async (req, res) => {
  try {
    const session_id = String(req.body.session_id || "").trim();
    const user_text = String(req.body.user_text || "").trim();
    const history = sanitizeHistory(req.body.history);
    const profile = (req.body.profile && typeof req.body.profile === "object") ? req.body.profile : {};

    const isContinueRequest = user_text === "__CONTINUE__";

    if (!session_id) return res.status(400).json({ error: "session_id is required" });
    if (!user_text) return res.status(400).json({ error: "user_text is required" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing in Render env vars" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const isAssessmentRequest = user_text.trim().toLowerCase() === "/assessment";
    const userTurns = countUserTurns(history);
    const assessmentReady = userTurns >= 5 && !isAssessmentRequest;

    const SYSTEM = `
You are Lauren inside WITHIN.

Vibe:
- Human, intelligent, warm, emotionally mature. Confident and simple.
- Not clinical. No therapy-speak. No lectures. No overwhelm.

Hard rules:
- Never ask the user to identify the root. You infer it gently.
- No body-location questions. No breathing prompts.
- Give ONE insight + ONE small next step.
- End assistant_message with exactly ONE thoughtful question.

Chat mode format:
- 2 short paragraphs max (blank line between).
- 3–5 sentences total.
- First: reflect one concrete detail so the user feels seen.
- Then: name the likely pattern underneath in plain language (not absolute).
- Then: ONE simple reframe OR ONE tiny action.
- End with ONE selective question that’s easy to answer.

Keep it light in the first 3–4 user turns. You can name patterns, but gently.

Assessment:
- When assessmentReady=true, include this exact line as its own paragraph at the very end:
  “Do you want an Assessment (clear breakdown + plan), or keep chatting to go deeper?”
- If user sends /assessment: use short labeled sections, 1–2 sentences each, separated by blank lines.

Output:
Return ONLY valid JSON with EXACT keys:
assistant_message
follow_up_questions
chakra_map
map
show_assessment_button
profile_update

follow_up_questions:
- Exactly 1 question.
- Must match the final question in assistant_message.

No extra keys. JSON only.
`;

    const CONTINUE_SYS = isContinueRequest
      ? "Continue seamlessly from the existing conversation. Do NOT ask the user to recap. Keep your reply short and end with one thoughtful question."
      : "";

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.45,
      presence_penalty: 0.15,
      frequency_penalty: 0.10,
      // keep responses shorter/faster
      max_tokens: 220,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "system", content: `Existing profile: ${JSON.stringify(profile).slice(0, 1200)}` },
        { role: "system", content: `assessmentReady=${assessmentReady}, isAssessmentRequest=${isAssessmentRequest}` },
        ...(CONTINUE_SYS ? [{ role: "system", content: CONTINUE_SYS }] : []),
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

    if (typeof parsed.assistant_message !== "string") parsed.assistant_message = "";
    if (!Array.isArray(parsed.follow_up_questions)) parsed.follow_up_questions = [];
    if (!parsed.map || typeof parsed.map !== "object") parsed.map = {};

    // Enforce exactly 1 follow-up question
    parsed.follow_up_questions = parsed.follow_up_questions.slice(0, 1);
    if (parsed.follow_up_questions.length === 0) {
      parsed.follow_up_questions = ["Is this a pattern for you, or more of a one-time spike?"];
    }

    // Clamp/spacing (shorter)
    if (!isAssessmentRequest) {
      parsed.assistant_message = enforceBreathableSpacing(
        clampSentences(parsed.assistant_message, 5)
      );
    } else {
      parsed.assistant_message = enforceBreathableSpacing(parsed.assistant_message).slice(0, 2200);
    }

    // Force assistant_message to end with the same question
    const q = safeString(parsed.follow_up_questions[0]) || "Is this a pattern for you, or more of a one-time spike?";
    parsed.assistant_message = ensureEndsWithQuestion(parsed.assistant_message, q);

    // Ensure follow_up_questions matches the last question
    const lastQ = extractLastQuestion(parsed.assistant_message);
    if (lastQ) parsed.follow_up_questions[0] = lastQ;

    // Assessment button visibility
    parsed.show_assessment_button = isAssessmentRequest ? false : assessmentReady;

    // Profile update fallback
    if (!parsed.profile_update || typeof parsed.profile_update !== "object") {
      parsed.profile_update = profile || {};
    }

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

