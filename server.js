require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.send("WITHIN is live ✅"));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------- Helpers ---------- */

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.trim() }))
    .filter(m => m.content && m.content !== "…")
    .slice(-12);
}

function enforceSpacing(text) {
  if (!text || typeof text !== "string") return "";
  let t = text.trim().replace(/\n{3,}/g, "\n\n");
  if (!t.includes("\n\n")) {
    const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (parts.length >= 3) t = `${parts.slice(0, 2).join(" ")}\n\n${parts.slice(2).join(" ")}`.trim();
  }
  return t;
}

function clampSentences(text, max = 5) {
  if (!text || typeof text !== "string") return "";
  const parts = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, max).join(" ").trim();
}

function enforceOneQuestionMark(text) {
  if (!text || typeof text !== "string") return "";
  const q = (text.match(/\?/g) || []).length;
  if (q <= 1) return text.trim();
  const first = text.indexOf("?");
  return text.slice(0, first + 1).trim();
}

function ensureEndsWithQuestion(text, userTurns = 0) {
  // Turn counting: userTurns = number of user messages already in history
  // After receiving a message:
  // - if this is their first message (userTurns === 1), ask their name
  // - otherwise ask what's going on / how they're feeling

  const firstTurnAskName =
    "Hi, I’m Lauren.\n\nWhat should I call you?";

  const laterTurnQuestion =
    "What’s going on for you today?";

  if (!text || typeof text !== "string") {
    return userTurns <= 1 ? firstTurnAskName : laterTurnQuestion;
  }

  const t = text.trim();
  if (t.includes("?")) return t;

  return (t + "\n\n" + (userTurns <= 1 ? "What should I call you?" : "What’s going on for you today?")).trim();
}


function warmFallback() {
  return "I’m here.\n\nSay that again for me?";
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status <= 599) || err?.name === "AbortError";
      if (!retryable || i === tries - 1) throw err;
      await sleep(700 + i * 900);
    }
  }
  throw lastErr;
}

/* ---------- Chat ---------- */

app.post("/chat", async (req, res) => {
  const started = Date.now();

  try {
   const session_id = String(req.body.session_id || "").trim();
const user_text = String(req.body.user_text || "").trim();
const history = sanitizeHistory(req.body.history);

let processed_text = user_text;

// Only interpret number selections at the very beginning
const userTurnCount = history.filter(m => m.role === "user").length;
const isBeginning = userTurnCount === 0;

if (isBeginning) {
  if (user_text === "1") {
    processed_text = "I want to work on uncovering a limiting belief shaping my behavior.";
  } else if (user_text === "2") {
    processed_text = "I want to explore what is really holding me back right now.";
  } else if (user_text === "3") {
    processed_text = "I want to work through a relationship dynamic that keeps repeating.";
  } else if (user_text === "4") {
    processed_text = "I want to strengthen my self-confidence and self-image.";
  } else if (user_text === "5") {
    processed_text = "I want to understand my emotional patterns better.";
  } else if (user_text === "6") {
    processed_text = "I want to talk about what is going on in my life right now.";
  }
}


    if (!session_id) return res.status(400).json({ error: "session_id is required" });
    if (!user_text) return res.status(400).json({ error: "user_text is required" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000, maxRetries: 0 });

    const userTurns = history.filter(m => m.role === "user").length;

    const SYSTEM = `
You are Lauren inside WITHIN.

Voice:
Warm, confident, precise. Emotionally intelligent bestie + psychological strategist.
No therapy-speak. No lectures. No filler. No “tell me more” chains.

Core Experience Goal:
The user should feel understood quickly AND get something useful quickly.
Do not interrogate. Do not stack questions. Alternate between:
Validate → clarify → micro-insight/tool → clarify → deeper insight/tool.

Conversation Flow Rules:
- Never ask more than ONE question per message (ONE question mark total).
- Do NOT ask questions back-to-back more than once. If you asked a question last turn, your next turn must include an insight/tool BEFORE the next question.
- By the user’s 2nd message at the latest, provide at least ONE of:
  (a) a pattern hypothesis, (b) a reframing statement, or (c) a simple tool.
- Every message must contain at least ONE “value unit”:
  - a crisp observation about what’s happening,
  - a simple psychological explanation in plain language,
  - a micro-tool (2 steps max),
  - or a clean reframe.
- If you don’t have enough context, give a provisional hypothesis (“My guess is…”) and confirm with one question.

Tools (allowed, light-touch):
- “Name it to tame it” style labeling: identify the likely driver (uncertainty, rejection sensitivity, control, guilt, comparison, people-pleasing, perfectionism).
- One micro-tool max per message, 2 steps max (example: “Do X. Then do Y.”).
- No breathing prompts. No body-location questions.

Early Stage (first 1–3 user turns):
- Goal: stabilize + orient + get context.
- Ask ONE clarifying question, but also give a small helpful insight or micro-shift in the SAME message.
- Focus on: trigger, meaning, stakes, pattern (“Does this happen elsewhere?”), not long history.

Later Stage (after turn 3):
- Gently deepen: name the loop, identify belief/protection, offer a practical experiment.
- Keep it actionable and grounded.

Output Constraints:
- 2–4 sentences max. (If greeting/first contact: 1–2 short sentences.)
- 2 short paragraphs max.
- No bullet points.
- End with exactly ONE thoughtful question.
- Only ONE question mark total.
- If user changes topics, respond only to the newest message.

Return ONLY a JSON object with these keys:
assistant_message, follow_up_questions, chakra_map, map, show_assessment_button, profile_update

JSON Requirements:
- assistant_message: string
- follow_up_questions: array (0–2 items, but frontend will use the first)
- chakra_map: array of 3 strings (can be empty strings)
- map: object (can be empty object if unsure)
- show_assessment_button: boolean
- profile_update: object (can be empty object)
`;

    const completion = await withRetry(async () => {
      return await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.35,
        max_tokens: 260,
        messages: [
          // extra guard so the word json is always present in messages:
          { role: "system", content: "Return valid json only. json." },
          { role: "system", content: SYSTEM },
          ...history,
          { role: "user", content: processed_text }

        ]
      });
    }, 2);

    const raw = completion.choices?.[0]?.message?.content || "";

    let parsed;
try { parsed = JSON.parse(raw); }
catch { parsed = extractFirstJsonObject(raw); }

// If the model returns plain text, wrap it instead of failing
if (!parsed || typeof parsed !== "object") {
  parsed = {
    assistant_message: String(raw || "").trim(),
    follow_up_questions: [],
    chakra_map: ["", "", ""],
    map: {},
    show_assessment_button: false,
    profile_update: {}
  };
}


    let assistant_message = typeof parsed.assistant_message === "string" ? parsed.assistant_message : "";
    assistant_message = enforceSpacing(clampSentences(assistant_message, 5));
    assistant_message = enforceOneQuestionMark(assistant_message);
    assistant_message = ensureEndsWithQuestion(assistant_message, userTurns);

    const ms = Date.now() - started;
    console.log("[WITHIN] OK", { ms, session_id, userTurns });

    return res.status(200).json({
      assistant_message,
      follow_up_questions: Array.isArray(parsed.follow_up_questions) && parsed.follow_up_questions.length
        ? [String(parsed.follow_up_questions[0])]
        : ["What set this off today?"],
      chakra_map: Array.isArray(parsed.chakra_map) && parsed.chakra_map.length === 3 ? parsed.chakra_map : ["", "", ""],
      map: (parsed.map && typeof parsed.map === "object") ? parsed.map : {
        sabotage_archetype: "None",
        sabotage_confidence: 0,
        perceived_threat: [],
        limiting_belief: "",
        identity_belief: "I am someone who is learning to understand myself",
        protection_intent: "",
        recommended_protocol: "Relief"
      },
      show_assessment_button: false,
      profile_update: (parsed.profile_update && typeof parsed.profile_update === "object") ? parsed.profile_update : {}
    });

  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    console.error("[WITHIN] ERROR", { status, message: String(err?.message || err).slice(0, 400) });

    return res.status(200).json({
      assistant_message: warmFallback(),
      follow_up_questions: ["What set this off today?"],
      chakra_map: ["", "", ""],
      map: {
        sabotage_archetype: "None",
        sabotage_confidence: 0,
        perceived_threat: [],
        limiting_belief: "",
        identity_belief: "I am someone who is figuring this out",
        protection_intent: "",
        recommended_protocol: "Relief"
      },
      show_assessment_button: false,
      profile_update: {}
    });
  }
});

app.post("/analyze", (req, res) => res.status(410).json({ error: "Use POST /chat instead." }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Running on port", PORT));
