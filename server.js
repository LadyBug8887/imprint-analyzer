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
Return ONLY valid JSON with keys:
activation_level (0-10), sabotage_archetype, sabotage_confidence (0-1),
perceived_threat (array max 5), limiting_belief, identity_belief (starts with "I am someone who"),
protection_intent, readiness, recommended_protocol, one_sentence_reflection
No markdown. No extra keys.
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


