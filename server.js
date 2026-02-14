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

  // If no paragraph break, add one after ~2 sentences (optional)
  if (!s.includes("\n\n")) {
    const sentences = s.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length >= 3) {
      s = `${sentences.slice(0, 2).join(" ")}\n\n${sentences.slice(2).join(" ")}`.trim();
    }
  }
  return s;
}

function clampSentences(msg, max = 4) {
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
    .slice(-8) // fewer messages = faster + less “essay”
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

function isIDK(text) {
  const s = (text || "").toLowerCase().trim();
  return s === "idk" || s === "i don't know" || s === "i dont know" || s === "not sure" || s === "i'm not sure" || s === "im not sure";
}

function classifyUserMessage(text) {
  const t = (text || "").trim();
  const s = t.toLowerCase();

  const lowInfo =
    s.length < 40 ||
    isIDK(t) ||
    ["tired", "confused", "overwhelmed", "stressed", "anxious", "sad", "upset", "help"].some(p => s === p);

  const hasConcreteSignals =
    /\b(today|yesterday|this morning|tonight|this week|at work|with my|my boss|my mom|my dad|my partner|my boyfriend|my girlfriend|my husband|my wife)\b/i.test(t) ||
    /\b(because|after|when|then)\b/i.test(t) ||
    /\b(decide|decision|choose|picked|said|texted|called|met|argued|fight)\b/i.test(t);

  if (lowInfo && !hasConcreteSignals) return "gentle";
  if (hasConcreteSignals && !lowInfo) return "direct";
  return lowInfo ? "gentle" : "direct";
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

    const isAssessmentRequest = user_text.toLowerCase() === "/assessment";
    const userTurns = countUserTurns(history);
    const assessmentReady = userTurns >= 5 && !isAssessmentRequest;

    const toneMode = classifyUserMessage(user_text);
    const userSaidIDK = isIDK(user_text);

    // Clarify-first on early turns OR when vague/IDK (Trigger-first)
    const clarifyFirst = !isAssessmentRequest && !isContinueRequest && (userTurns < 2 || toneMode === "gentle" || userSaidIDK);

    const SYSTEM = `
You are Lauren inside WITHIN.

Main goal:
Extract the key details (starting with the trigger) so you can gently reveal blind spots the user may not be conscious of.

Voice:
- Human, intelligent, emotionally mature.
- Warm and calm; direct when the user gives specifics.
- Not clinical. No therapy-speak. No overwhelm.

Hard rules:
- Never ask the user to identify the root. You infer it later.
- No body-location questions. No breathing prompts.
- End assistant_message with exactly ONE question (and that same question must be follow_up_questions[0]).

Response length (very important):
- Keep assistant_message SHORT: 2–4 sentences max.
- 1–2 short paragraphs max with a blank line.
- No bullet lists.
- Do NOT “force feed” knowledge. Only one small insight per turn.

Trigger-first behavior:
- When the user is vague, tired, confused, overwhelmed, or says “I don’t know,” your FIRST job is to find the trigger:
  what happened right before they felt this shift.

“I don’t know” handling:
- If user says “I don’t know,” do NOT push.
- Offer 2–3 tiny options that make it easy to answer (examples like: “a text,” “a thought,” “a moment at work,” “waking up like this”).
- Then ask ONE gentle trigger question.

Clarify-first rule:
- If clarifyFirst=true: do NOT give action steps, plans, prioritizing, or “do this today.”
  You may reflect briefly + make a light hypothesis, then ask ONE clarifying question.

Pattern naming:
- First 3–4 user turns: keep pattern language light (“What this looks like is…”).
- Over time: gently point out blind spots as you gather info.

Assessment:
- When assessmentReady=true, include this exact line as its own paragraph at the end:
  “Do you want an Assessment (clear breakdown + plan), or keep chatting to go deeper?”
- If /assessment: short labeled sections, 1–2 sentences each, separated by blank lines.

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

    const MODE_SYS = `toneMode=${toneMode}, clarifyFirst=${clarifyFirst}, userSaidIDK=${userSaidIDK}`;

    const CLARIFY_SYS = clarifyFirst
      ? (userSaidIDK
          ? "User said they don't know. Be reassuring. Give 2–3 tiny options, then ask ONE gentle trigger question. No advice."
          : (toneMode === "gentle"
              ? "User is low-detail. Be warm. Ask ONE gentle trigger-first clarifying question. No advice."
              : "User has detail. Be direct. Ask ONE precise trigger clarifying question. No advice."))
      : "";

    const CONTINUE_SYS = isContinueRequest
      ? "Continue seamlessly from the existing conversation. Do NOT ask the user to recap. Keep it short and end with one thoughtful question."
      : "";

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.42,
      presence_penalty: 0.12,
      frequency_penalty: 0.10,
      max_tokens: 160, // shorter responses
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "system", content: `Existing profile: ${JSON.stringify(profile).slice(0, 1000)}` },
        { role: "system", content: MODE_SYS },
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

    parsed.follow_up_questions = parsed.follow_up_questions.slice(0, 1);
    if (parsed.follow_up_questions.length === 0) {
      parsed.follow_up_questions = [
        userSaidIDK
          ? "Was there a moment right before this—like a text, a thought, or something at work—that set it off?"
          : "What happened right before you started feeling this way?"
      ];
    }

    // Clamp/spacing shorter
    if (!isAssessmentRequest) {
      parsed.assistant_message = enforceBreathableSpacing(
        clampSentences(parsed.assistant_message, 4)
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
