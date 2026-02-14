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

  // Keep to 2 short paragraphs max
  const paras = s.split(/\n\n+/).filter(Boolean);
  if (paras.length > 2) s = paras.slice(0, 2).join("\n\n").trim();

  // If no paragraph break, add one after ~2 sentences
  if (!s.includes("\n\n")) {
    const sentences = s.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length >= 3) {
      s = `${sentences.slice(0, 2).join(" ")}\n\n${sentences.slice(2).join(" ")}`.trim();
    }
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
    .slice(-10)
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

function isVagueUserMessage(t) {
  const s = (t || "").toLowerCase().trim();
  if (!s) return true;
  // Very short or generic states should trigger clarification first
  if (s.length < 28) return true;
  const vaguePhrases = [
    "i don't know", "idk", "tired", "confused", "overwhelmed", "stressed",
    "anxious", "sad", "upset", "i feel off", "i feel weird", "help"
  ];
  return vaguePhrases.some(p => s === p || s.includes(p));
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

    const shouldClarifyFirst = !isAssessmentRequest && !isContinueRequest && isVagueUserMessage(user_text);

    const SYSTEM = `
You are Lauren inside WITHIN.

Vibe:
- Human, intelligent, emotionally mature. Warm, direct, calm.
- Not clinical. No therapy-speak. No overwhelm.

Hard rules:
- Never ask the user to identify the root. You infer it gently later.
- No body-location questions. No breathing prompts.
- End assistant_message with exactly ONE thoughtful question.
- Keep it light for the first 3–4 user turns.

Critical behavior:
- DO NOT give advice or action steps until you understand context.
- If the user is vague (e.g., “I’m tired and confused”, “I don’t know”), you must:
  1) reflect briefly (1–2 sentences)
  2) ask ONE clarifying question to gather the missing detail
  3) do NOT recommend tasks, plans, or prioritizing yet

Chat format:
- 2 short paragraphs max (blank line between).
- 3–5 sentences total.
- Ask ONE high-quality clarifying question that makes it easy to answer.
Examples:
- “Is the tiredness more physical, emotional, or mental today?”
- “What happened right before you started feeling this way?”
- “What’s the main thing your mind keeps circling around?”

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

    const CLARIFY_SYS = shouldClarifyFirst
      ? "User is vague. You MUST ask a clarifying question first. Do NOT give advice or suggest actions in this turn."
      : "";

    const CONTINUE_SYS = isContinueRequest
      ? "Continue seamlessly from the existing conversation. Do NOT ask the user to recap. Keep your reply short and end with one thoughtful question."
      : "";

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.45,
      presence_penalty: 0.15,
      frequency_penalty: 0.10,
      max_tokens: 210,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "system", content: `Existing profile: ${JSON.stringify(profile).slice(0, 1200)}` },
        { role: "system", content: `assessmentReady=${assessmentReady}, isAssessmentRequest=${isAssessmentRequest}` },
        ...(CLARIFY_SYS ? [{ role: "system", content: CLARIFY_SYS }] : []),
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
    parsed.follow_up_questions = Array.isArray(parsed.follow_up_questions)
      ? parsed.follow_up_questions.slice(0, 1)
      : [];

    if (parsed.follow_up_questions.length === 0) {
      parsed.follow_up_questions = ["What happened right before you started feeling this way?"];
    }

    // Clamp/spacing
    if (!isAssessmentRequest) {
      parsed.assistant_message = enforceBreathableSpacing(
        clampSentences(parsed.assistant_message, 5)
      );
    } else {
      parsed.assistant_message = enforceBreathableSpacing(parsed.assistant_message).slice(0, 2200);
    }

    // Force assistant_message to end with the same question
    const q = safeString(parsed.follow_up_questions[0]) || "What happened right before you started feeling this way?";
    parsed.assistant_message = ensureEndsWithQuestion(parsed.assistant_message, q);

    // Ensure follow_up_questions matches the last question
    const lastQ = extractLastQuestion(parsed.assistant_message);
    if (lastQ) parsed.follow_up_questions[0] = lastQ;

    parsed.show_assessment_button = isAssessmentRequest ? false : assessmentReady;

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
