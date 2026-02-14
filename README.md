# IMPRINT-ANALYZER

Starter Express server for the IMPRINT-ANALYZER project.

Quick start:

```bash
cp .env.example .env
# set OPENAI_API_KEY in .env if you want to call the API
npm start
```

API:
- `GET /` health
- `POST /api/analyze` JSON { "text": "..." }
