require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.send("WITHIN is live ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

/* ------------------------- Helpers ------------------------- */

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant"))
    .filter(m => typeof m.content === "string" && m.content.trim())
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.trim() }));
}

function clampSentences(text, max = 5) {
  if (!text) return "";
  const parts = text.trim().split(/(?<=[.!?])\s+/);
  return parts.slice(0, max).join(" ").trim();
}

function enforceOneQuestion(text) {
  if (!text) return "";
  const matches = text.match(/\?/g);
  if (!matches || matches.length <= 1) return text;

  const firstIndex = text.indexOf("?");
  return text.slice(0, firstIndex + 1).trim();
}

function enforceSpacing(text) {
  if (!text) return "";
  let t = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!t.includes("\n\n")) {
    const parts = t.split(/(?<=[.!?])\s+/);
    if (parts.length >= 3) {
      t = parts.slice(0, 2).join(" ") + "\n\n" + parts.slice(2).join(" ");
    }
  }
  return t.trim();
}

function warmFallback() {
  return enforceOneQuestion(
    "I’m still here. I didn’t get a clean response on my side, but I’ve got you.\n\nTell me again what’s happening right now?"
  );
}

/* ------------------------- Main Chat ------------------------- */

app.post("/chat", async (req, res) => {
  try {
    const session_id = String(req.body.session_id || "").trim();
    const user_text = String(req.body.user_text || "").trim();
    const history = sanitizeHistory(req.body.history);
    const profile = req.body.profile && typeof req.body.profile === "object"
      ? req.body.profile
      : {};

    if (!session_id || !user_text) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000,
      maxRetries: 0
    });

    const userTurns = history.filter(m => m.role === "user").length;

    const SYSTEM = `
You are Lauren inside WITHIN.

Lauren is a hybrid of:
- A precise psychological strategist
- An emotionally intelligent best friend

She is sharp, warm, grounded, and calm.
She does not ramble.
She does not overwhelm.
She does not over-teach.
She does not sound clinical.

She uses psychology that is simple and easy to understand.
She explains concepts in plain language.
She introduces insight gradually instead of dumping knowledge.

Conversation structure:

EARLY STAGE (first 3–4 user turns):
- Extract context.
- Ask one diagnostic question only.
- Focus on trigger, situation, frequency, stakes.
- No solutions yet.
- No reframes yet.
- No deep reflection yet.
- Keep responses short.

MIDDLE STAGE:
- Gently name patterns.
- Example: "A pattern I’m noticing is..."
- Briefly explain the psychology behind it in simple terms.
- Example: "When the brain feels uncertainty, it tries to regain control..."

SHIFT STAGE:
- Offer one small shift.
- Only one tool.
- Keep it practical.

ALWAYS:
- End with exactly one thoughtful question.
- Never ask more than one question.
- Never ask the user to identify the root.
- Do not ask where they feel it in their body.
- Do not instruct breathing.
- If the user switches topics, drop the previous thread immediately and respond only to the newest message.

Response rules:
- 3–5 sentences maximum.
- 2 short paragraphs maximum.
- Exactly one question mark.
- No bullet points.
- Clear, grounded, psychologically intelligent.
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.35,
      max_tokens: 260,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        ...history,
        { role: "user", content: user_text }
      ]
    });

    let raw = completion.choices?.[0]?.message?.content || "";
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.json({
        assistant_message: warmFallback(),
        follow_up_questions: ["What just triggered this today?"],
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
        profile_update: profile
      });
    }

    if (!parsed.assistant_message) parsed.assistant_message = "";
    if (!Array.isArray(parsed.follow_up_questions)) parsed.follow_up_questions = [];

    parsed.assistant_message = clampSentences(parsed.assistant_message, 5);
    parsed.assistant_message = enforceSpacing(parsed.assistant_message);
    parsed.assistant_message = enforceOneQuestion(parsed.assistant_message);

    if (!parsed.assistant_message.includes("?")) {
      parsed.assistant_message += "\n\nWhat set this off today?";
    }

    parsed.follow_up_questions = [parsed.follow_up_questions[0] || "What set this off today?"];
    parsed.chakra_map = ["", "", ""];
    parsed.show_assessment_button = false;
    parsed.profile_update = profile;

    return res.json(parsed);

  } catch (err) {
    console.error("Server error:", err.message);
    return res.status(200).json({
      assistant_message: warmFallback(),
      follow_up_questions: ["What just happened?"],
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Running on port", PORT));
