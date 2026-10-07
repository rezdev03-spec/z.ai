# ZennNyx AI

Minimal black/white AI chat for Vercel + Groq.

## Environment variables

Set these in Vercel:

- `GROQ_API_KEY` = your Groq API key
- `GROQ_MODEL` = `openai/gpt-oss-20b` (optional; this is already the default)

No Gemini key, DeepSeek key, OpenRouter key, or client-side API key is used.

## Deploy

Import this folder into Vercel. Add the environment variable, redeploy, then open the deployment.

The frontend automatically follows the device/browser system theme via `prefers-color-scheme`.
