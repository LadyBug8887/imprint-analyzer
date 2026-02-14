require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { z } = require('zod');

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'IMPRINT-ANALYZER API' });
});

const AnalyzeSchema = z.object({
  text: z.string().min(1),
});

app.post('/api/analyze', (req, res) => {
  const parse = AnalyzeSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.errors });

  const { text } = parse.data;

  // Placeholder analysis — replace with OpenAI call when you set OPENAI_API_KEY
  const analysis = {
    length: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    summary: text.slice(0, 200),
  };

  res.json({ input: text, analysis });
});

app.listen(port, () => {
  console.log(`IMPRINT-ANALYZER listening on port ${port}`);
});
