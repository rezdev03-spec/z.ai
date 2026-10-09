# ZennNyx AI v9 — Workspace

Static HTML/CSS/JS client with Vercel serverless API. The UI uses crisp bordered panels, an editorial serif display font, a model picker, isolated project preview, KaTeX math rendering, real web sources, and a 20-message daily quota (WIB).

## Deploy
1. Replace project files with this ZIP's files, keeping the `api/` folder structure.
2. Keep your existing `GROQ_API_KEY`.
3. Optional: set `GEMINI_API_KEY` to enable Gemini choices.
4. Optional: set `OPENROUTER_API_KEY` to load currently listed free text models from OpenRouter. The server rejects OpenRouter IDs without the `:free` suffix to avoid selecting a paid route.
5. Keep/set `TAVILY_API_KEY` if you want live web search and source links.
6. Optional but recommended: set `RATE_LIMIT_SECRET` to a stable random secret in Vercel Environment Variables. If omitted, the backend signs the daily quota cookie using the first configured provider key.
7. Redeploy.

## Environment variables
- `GROQ_API_KEY` (required only when using Groq models)
- `GEMINI_API_KEY` (optional; enables Gemini 3.8 Flash and Gemini 3.5 Flash-Lite)
- `OPENROUTER_API_KEY` (optional; model selector dynamically lists free text models only)
- `TAVILY_API_KEY` (optional; live web search)
- `RATE_LIMIT_SECRET` (optional; stable cookie-signing secret)
- `GROQ_VISION_MODEL` (optional; defaults to `qwen/qwen3.8-27b`)
- `PUBLIC_APP_URL` (optional; OpenRouter app attribution)

The API keys stay on the server and are not sent to browser JavaScript.

## Quota notes
The server validates a signed cookie with the Jakarta-local calendar date and accepts at most 20 requests per day per browser cookie. A client-side guard mirrors the limit. Because the project has no database/login system, clearing site cookies/storage can reset the per-browser quota; a durable account-wide limit would need a persistent shared store or authentication.
