const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.send("Imprint Analyzer is live ✅");
});

app.post("/analyze", async (req, res) => {
  try {
    const user_text = (req.body.user_text || "").trim();
    if (!user_text) return res.status(400).json({ error: "user_text is required" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing in Render env vars" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const system = `
const system = `
You are a STRICT JSON extraction engine for an identity/self-sabotage coaching app.
Return ONLY valid JSON. No markdown. No extra keys. No advice.

You MUST return exactly these keys:
sabotage_archetype
sabotage_confidence
perceived_threat
limiting_belief
identity_belief
protection_intent
recommended_protocol
one_sentence_reflection

Allowed values:
- sabotage_archetype: one of ["Avoider","Perfectionist","Overdriver","Collapser","Pre-Rejector","None"]
- sabotage_confidence: number 0 to 1
- perceived_threat: array of 0 to 5 short keywords (examples: "judgment","visibility","abandonment","control","failure","success","safety","rejection")
- limiting_belief: short sentence
- identity_belief: MUST start with exactly "I am someone who"
- protection_intent: short sentence describing what the pattern is trying to prevent
- recommended_protocol: one of ["Relief","Agency","Identity-Install","Behavior-Proof","Regulation"]
- one_sentence_reflection: empathetic mirror only; NO instructions; no therapy suggestions.

Rules:
- Do not invent new archetypes.
- If no sabotage pattern is detectable, set sabotage_archetype="None" and sabotage_confidence < 0.35.
- Output must be valid JSON that can be parsed with JSON.parse.
`;

`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user_text }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: "Model did not return JSON", raw });
    }

    return res.json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Running on port", PORT));


