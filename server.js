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

// Detect if theta reset has already been used this session (based on history content)
function thetaAlreadyUsed(history) {
  if (!Array.isArray(history)) return false;
  return history.some(m =>
    m &&
    m.role === "assistant" &&
    typeof m.content === "string" &&
    m.content.toLowerCase().includes("[theta-reset]")
  );
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

    const isThetaRequest =
      user_text === "__THETA_RESET__" ||
      /^\/theta\b/i.test(user_text) ||
      user_text.toLowerCase().includes("theta reset");

    const thetaUsed = thetaAlreadyUsed(history);

    const SYSTEM = `
You are WITHIN.

WITHIN feels like chatting with a super intelligent, warm, emotionally mature friend.
Your job: help the user uncover blind spots, name the root pattern, and offer a practical reframe + tool to get unstuck.

Voice:
- Warm, grounded, direct
- No coddling, no over-validating
- No therapy-speak, no diagnosis
- No “if you’re willing”
- No mentioning you are an AI

Conversation style:
- Keep it short and easy to read.
- Always move the conversation forward with ONE great question.
- When you spot a limiting belief/program, name it clearly.
- Explain briefly: subconscious programs drive perception, emotion, and behavior—so changing the program changes the results.
- Offer ONE small tool or reframe the user can apply now (no big lists).

Very important restrictions:
- Do NOT ask “where do you feel it in your body.”
- Do NOT prompt breathing except inside the Theta Reset flow.
- Theta Reset can be offered as an option, but only run it when the user explicitly requests it.

Theta Reset rules:
- Only provide ONE Theta Reset per session.
- If the user requests another Theta Reset in the same session, acknowledge and offer a non-breath alternative (a cognitive reframe question).
- Mark Theta Reset responses by including the tag [THETA-RESET] at the start of assistant_message.

Output:
Return ONLY valid JSON with EXACT keys:
assistant_message
follow_up_questions
chakra_map
map

assistant_message formatting:
- Normal turns: 2–4 sentences max.
- Use 1–2 short paragraphs with a blank line between (use \\n\\n).
- No bullet lists.

follow_up_questions:
- Array of exactly 1 question.
- The question should deepen root discovery (origin, trigger, protection, cost/benefit, or “what would change if…”).

chakra_map:
- Keep it, but do NOT mention chakras in assistant_message unless user asks.
- Exactly 3 items:
  chakra: one of ["Root","Sacral","Solar Plexus","Heart","Throat","Third Eye","Crown"]
  state: "blocked" or "overactive"
  why: one grounded sentence (psychological, not mystical).

map:
- sabotage_archetype: one of ["Avoider","Perfectionist","Overdriver","Collapser","Pre-Rejector","None"]
- sabotage_confidence: 0..1
- perceived_threat: 0–5 keywords
- limiting_belief: short sentence ("" if none)
- identity_belief: MUST start with exactly "I am someone who"
- protection_intent: short sentence
- recommended_protocol: one of ["Relief","Agency","Identity-Install","Behavior-Proof","Regulation"]

Hard rules:
- Do NOT output activation_level.
- Do NOT output readiness.
- Do NOT invent new archetypes.
- Output must be valid JSON only.
`;

    const trimmedHistory = history
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));

    // If theta requested and already used, we steer away from breath and give a short alternative.
    if (isThetaRequest && thetaUsed) {
      const data = {
        assistant_message:
          "You already did a Theta Reset this session, so let’s use a faster, non-breath lever.\n\nWhat’s the exact sentence your mind keeps repeating right before you spiral or shut down?",
        follow_up_questions: [
          "What’s the exact sentence your mind repeats right before you spiral or shut down?"
        ],
        chakra_map: [
          { chakra: "Third Eye", state: "overactive", why: "Your mind is looping on interpretation and meaning-making." },
          { chakra: "Heart", state: "blocked", why: "Self-acceptance feels gated by a condition being met." },
          { chakra: "Solar Plexus", state: "blocked", why: "Confidence drops when the inner narrative turns critical." }
        ],
        map: {
          sabotage_archetype: "None",
          sabotage_confidence: 0.25,
          perceived_threat: ["judgment", "rejection"],
          limiting_belief: "",
          identity_belief: "I am someone who wants clarity before moving forward.",
          protection_intent: "To prevent making a move that could lead to regret or judgment.",
          recommended_protocol: "Agency"
        }
      };
      return res.json(data);
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },

        // Provide the model one extra instruction based on theta request
        ...(isThetaRequest
          ? [{
              role: "system",
              content: `
Theta Reset requested.
Create a short guided reset (about 60–90 seconds).
Include ONE breath instruction max.
No body-scanning.
End by asking ONE question.
Remember to start assistant_message with [THETA-RESET].
`
            }]
          : []),

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

    // Strip unwanted keys just in case
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
      parsed.follow_up_questions = ["What feels like the real problem underneath this?"];
    }

    // Enforce short + spaced
    const isThetaResponse = typeof parsed.assistant_message === "string" &&
      parsed.assistant_message.toUpperCase().includes("[THETA-RESET]");

    // Normal turns must be very short; theta can be longer, but still readable
    if (!isThetaResponse) {
      parsed.assistant_message = enforceBreathableSpacing(
        shortenToMaxSentences(parsed.assistant_message, 4)
      );
    } else {
      // For theta: keep readable spacing, but allow a bit more length
      parsed.assistant_message = enforceBreathableSpacing(parsed.assistant_message);
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
