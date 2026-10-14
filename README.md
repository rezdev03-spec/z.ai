# ZennNyx AI v10.0 — Claude-style UI, Effort levels, streaming

Static HTML/CSS/JS client + Vercel serverless API. Providers: **NVIDIA NIM, Groq, Gemini, OpenRouter (free)**. Mistral is removed.

## What changed in v10
- **UI**: rebuilt to be minimal like the Claude app: centered greeting, round composer (`+`, effort chip, mic/send/stop), bottom sheets for *Add to chat* (Camera, Photos, Files, Web search switch) and *Effort*, slide-in menu with **Recents** (chat history saved in the browser, delete per chat). Dark by default, warm light theme follows the system. UI text is English.
- **Effort** replaces the model picker: **Fast / Low / Medium (recommended) / High**. Each level has its own model ladder, timeouts and token budget (`lib/models.js`, `TIERS`). The answering model is shown quietly under the reply.
- **Usage**: the "20 messages" counter is gone. The menu shows **usage % + "Resets at 12:00 AM"** (reset = midnight WIB, shown in the device's time zone). A banner appears above the message box at 80%+ and "Limit reached" at 100%. Change the limit with env `DAILY_LIMIT` (default 20).
- **Speed / smoothness**
  - Answers **stream token by token** (SSE) instead of arriving all at once; no more fake typing delay. A **Stop** button cancels the request upstream too.
  - **Hedged requests**: if the top model has no token after `hedgeMs` (Fast 1.8 s, Low 2.6 s, Medium 3.8 s, High 11 s), the next model starts in parallel and the first to produce a token wins; the loser is cancelled. A failing model is replaced immediately.
  - Ranking uses time-to-first-token history (server memory + browser) so the quickest models rise to the top.
  - Fast/Low skip web search unless you ask for it (or the question is clearly about fresh info), so they answer without the search delay.
  - Cooldown 2 s and burst 6/min (was 5 s and 3/min).
  - Regenerate button, retry on error, partial answers are kept if a model stops midway.
- **Models**: curated lists are checked against each provider's live catalog (`/models`) and dead ids are dropped automatically; OpenRouter's free list is read live. Override any list with env `<PROVIDER>_<TIER>_MODELS`, e.g. `NVIDIA_FAST_MODELS=meta/llama-3.3-70b-instruct`, `GROQ_MEDIUM_MODELS=openai/gpt-oss-120b`, `GEMINI_HIGH_MODELS=gemini-3.8-flash`.
- **Files**: text/code files can be attached (first 12,000 characters are used). Images as before.

## What changed in v10.1
- **No auto-scroll**: the page no longer follows the answer while it streams or jumps to the bottom when it finishes. When you send a message, your question is placed at the top once; after that you read at your own pace. A "jump to bottom" button appears when the answer runs below the screen.
- **Image preview**: tap any image you sent (or the thumbnail before sending) to open a full-screen viewer; tap the image to zoom in/out (scroll to pan), tap outside or press Esc to close.
- **Model picker**: a new **Model** chip next to Effort. *Auto* keeps the old behaviour; or pick a specific model (Gemini, Groq, NVIDIA, OpenRouter). A picked model is tried alone first (no racing against others), and if it fails another model from the effort level answers and a note says so. `/api/models` now also returns the live `models` list.
- Why Gemini/GLM rarely answered: in *Auto* the ranking favours Groq (GPT-OSS) and NVIDIA first. Pick Gemini/GLM from the Model chip, or check `/api/models?debug=1` to see whether `GEMINI_API_KEY` is set and the ids exist in the live catalog.

## Environment variables
- `NVIDIA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`: set any of them (more = better fallback).
- `TAVILY_API_KEY`: live web search (optional).
- `RATE_LIMIT_SECRET`: stable cookie-signing secret (recommended).
- `DAILY_LIMIT`: messages per day per browser (default 20).
- `DIAG_SECRET`: enables `/api/diag` (see below).
- `NVIDIA_BASE_URL`, `GROQ_BASE_URL`, `GEMINI_BASE_URL`, `OPENROUTER_BASE_URL`, `PUBLIC_APP_URL`: optional overrides.

## Deploy
Replace the project files with this ZIP (keep `api/`, `lib/`), set env vars in Vercel, **Redeploy**. `npm run check` syntax-checks everything.

## Tools
- `/api/models?debug=1`: shows which models each effort level will use right now.
- `/api/diag?key=<DIAG_SECRET>&model=nvidia::meta/llama-3.3-70b-instruct`: times one model (headers, first token, total) without using chat quota.
- `?debug=1` on the site shows timing and fallback reasons under answers (`?debug=0` turns it off).

## Notes
- Model ids come from public listings and the catalogs rotate often. If a level feels slow, open `/api/models?debug=1` and `/api/diag` to see what is live, then pin better ids with the env overrides.
- Streaming needs a Vercel Node function (already the case). Quota is a signed cookie; clearing site data resets it.
