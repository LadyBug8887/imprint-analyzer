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

/* ---------------- Helpers ---------------- */

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

function ensureEndsWithQuestion(text) {
  if (!text) return "I’m here.\n\nWhat set this off today?";
  if (text.includes("?")) return text;
  return (text.trim() + "\n\nWhat set this off today?").trim();
}

function warmFallback() {
  // No tech talk, stays in character
  return "I’m here.\n\nSay that again for me?";
}

function tryParseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

// If the model ignored JSON mode and returned plain text,
// we treat the whole thing as assistant_message.
function normalizeModelOutput(raw) {
  const parsed = tryParseJson(raw);
  if (parsed && typeof parsed === "object") return parsed;

  // Plain text fallback (still a real response)
  return {
    assistant_message: String(raw || "").trim()
  };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function withRetry(fn, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const retryable =
        status === 429 ||
        (status >= 500 && status <= 599) ||
        err?.name === "AbortError";

      if (!retryable || i === tries - 1) throw err;
      await sleep(700 + i * 900);
    }
  }
  throw lastErr;
}

/* ---------------- Chat ---------------- */

app.post("/chat", async (req, res) => {
  const started = Date.now();

  try {
    const session_id = String(req.body.session_id || "").trim();
    const user_text = String(req.body.user_text || "").trim();
    const history = sanitizeHistory(req.body.history);

    if (!session_id) return res.status(400).json({ error: "session_id is required" });
    if (!user_text) return res.status(400).json({ error: "user_text is required" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000,
      maxRetries: 0
    });

    const userTurns = history.filter(m => m.role === "user").length;

    const SYSTEM = `
You are Lauren inside WITHIN.

Tone: a hybrid of (A) precise psychological strategist and (B) emotionally intelligent best friend.
Warm, confident, clear. No therapy-speak. No long lectures.

CRITICAL FLOW:
Early stage (first 3–4 user turns): extract context only.
- Ask ONE diagnostic question.
- No advice yet. No reframes yet. No reflective questions yet.
- Focus on: what happened, what triggered it, when it started, how often, what stakes.

Later: gently name the pattern + simple psychology in plain language.
Example: "When the brain senses uncertainty, it tries to regain control..."

Rules:
- End with exactly ONE question.
- Only ONE question mark total.
- If user switches topics, respond only to the newest message.
- No body-location questions.
- No breathing prompts.

Length:
- 3–5 sentences max.
- 2 short paragraphs max.

Return JSON if possible with:
assistant_message
follow_up_questions
chakra_map
map
show_assessment_button
profile_update
But if you cannot, return plain text. Keep it short.
`;

    const completion = await withRetry(async () => {
      return await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.35,
        max_tokens: 260,
        // If supported by your installed OpenAI SDK, this helps.
        // If not supported, normalizeModelOutput handles plain text.
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          ...history,
          { role: "user", content: user_text }
        ]
      });
    }, 2);

    const raw = completion.choices?.[0]?.message?.content || "";
    const out = normalizeModelOutput(raw);

    let assistant_message = typeof out.assistant_message === "string" ? out.assistant_message : "";
    assistant_message = enforceSpacing(clampSentences(assistant_message, 5));
    assistant_message = enforceOneQuestionMark(assistant_message);
    assistant_message = ensureEndsWithQuestion(assistant_message);

    const ms = Date.now() - started;
    console.log("[WITHIN] OK", { ms, session_id, userTurns });

    // Always return the structure your frontend expects
    return res.json({
      assistant_message,
      follow_up_questions: [ "What set this off today?" ],
      chakra_map: ["", "", ""],
      map: {
        sabotage_archetype: "None",
        sabotage_confidence: 0,
        perceived_threat: [],
        limiting_belief: "",
        identity_belief: "I am someone who is learning to understand myself",
        protection_intent: "",
        recommended_protocol: "Relief"
      },
      show_assessment_button: false,
      profile_update: {}
    });

  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    console.error("[WITHIN] ERROR", {
      status,
      message: String(err?.message || err).slice(0, 400)
    });

    // IMPORTANT: return 200 so your frontend still renders a message
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

app.post("/analyze", (req, res) => {
  return res.status(410).json({ error: "Use POST /chat instead." });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Running on port", PORT));
