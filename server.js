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
  if (!s.includes("\n\n")) {
    const sentences = s.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length >= 3) {
      s = `${sentences.slice(0, 2).join(" ")}\n\n${sentences.slice(2).join(" ")}`.trim();
    }
  }
  return s;
}

function clampSentences(msg, max = 8) {
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
    .slice(-14)
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

Voice:
- Smart, emotionally mature, warm, confident. Human. Not clinical.
- No therapy-speak, no lectures, no disclaimers, no coddling.
- You lead the conversation.

Non-negotiables:
- Never ask the user to identify the root. You infer it.
- Never ask body-location questions.
- Never instruct breathing.
- Always end assistant_message with exactly ONE thoughtful question.

Chat Mode:
- 2–3 short paragraphs separated by blank lines.
- 4–8 sentences max.
- First line: reflect one concrete detail.
- Then: name the likely pattern underneath (confident but not absolute).
- Then: give ONE reframe or ONE tool only.
- Include ONE micro-prediction if helpful.
- End with ONE selective forward-moving question.

Assessment Flow:
- Do NOT offer assessment immediately.
- When assessmentReady=true, include:
  “Do you want an Assessment (clear breakdown + plan), or keep chatting to go deeper?”
- If user sends /assessment, use structured labeled sections.

Output format:
Return ONLY valid JSON with keys:
assistant_message
follow_up_questions
chakra_map
map
show_assessment_button
profile_update

follow_up_questions:
- Exactly 1 question.
- Must match the final question in assistant_message.

Hard rules:
- Output must be parseable JSON only.
`;

    const CONTINUE_SYS = isContinueRequest
      ? "User asked you to continue seamlessly from the existing conversation. Do NOT ask them to recap. Continue your previous reasoning and end with one thoughtful question."
      : "";

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.55,
      presence_penalty: 0.25,
      frequency_penalty: 0.15,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "system", content: `Existing profile: ${JSON.stringify(profile).slice(0, 1500)}` },
        { role: "system", content: `assessmentReady=${assessmentReady}, isAssessmentRequest=${isAssessmentRequest}` },
        { role: "system", content: CONTINUE_SYS },
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

    parsed.follow_up_questions = parsed.follow_up_questions.slice(0, 1);
    if (parsed.follow_up_questions.length === 0) {
      parsed.follow_up_questions = ["Has this happened before, or does it feel new?"];
    }

    const q = safeString(parsed.follow_up_questions[0]) || "Has this happened before, or does it feel new?";
    parsed.assistant_message = ensureEndsWithQuestion(parsed.assistant_message, q);

    const lastQ = extractLastQuestion(parsed.assistant_message);
    if (lastQ) parsed.follow_up_questions[0] = lastQ;

    parsed.assistant_message = enforceBreathableSpacing(
      clampSentences(parsed.assistant_message, 8)
    );

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
