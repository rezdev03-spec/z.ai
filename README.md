# ZennNyx AI v9.2 — Workspace

Static HTML/CSS/JS client with Vercel serverless API. Crisp bordered UI, model picker, full-screen website preview, KaTeX math, real web sources, and a 20-message daily quota (WIB).

## Deploy
1. Replace the project files with this ZIP's files, keeping the folder structure (`api/`, `lib/`, plus `markdown.js` next to `script.js`).
2. Environment variables (Vercel → Settings → Environment Variables), then **Redeploy**.
3. Run `npm run check` locally if you want to syntax-check everything.

## Environment variables
- `GROQ_API_KEY` (needed for Groq models)
- `GEMINI_API_KEY` (optional; Gemini models)
- `OPENROUTER_API_KEY` (optional; the picker lists free **chat** models only)
- `TAVILY_API_KEY` (optional; live web search)
- `RATE_LIMIT_SECRET` (optional but recommended; stable cookie-signing secret)
- `GROQ_VISION_MODEL` (optional; defaults to `qwen/qwen3.8-27b`)
- `PUBLIC_APP_URL` (optional; OpenRouter attribution)

API keys stay on the server.

## v9.2 — what changed
**Errors / OpenRouter**
- Non-chat models (e.g. *NVIDIA Nemotron Content Safety*, which only answers "User Safety: safe", plus embedding/moderation models) are removed from the list and rejected by the server.
- If an OpenRouter free model is busy/offline (429, 404, 5xx, empty answer), the server automatically tries up to 2 other free models. The answer shows which model actually replied.
- Models that refuse a system prompt (e.g. Gemma) are retried automatically with the instructions folded into the user message. `<think>…</think>` blocks are stripped.
- Real error reasons are shown (invalid key, daily free limit, 1-minute limit, timeout…) instead of one generic message. OpenRouter's account-wide limits (`free-models-per-day` / `-per-min`) get their own explanation, because trying another free model cannot help there.
- A failed request no longer costs one of the 20 daily messages (the server and the client both give it back).
- **Kirim ulang** button on every error: your message (text + image) is kept, you can switch model first and resend.

**Web search (Tavily)**
- Auto mode is much broader than the old keyword list (questions, news, prices, "cari…", follow-ups such as "dan harganya?" use the previous question as context). Coding, math and chit-chat are skipped.
- New **Web Search** switch in the `+` menu: *Otomatis* (default) or *Selalu cari*.
- If Tavily fails, the answer now says why (invalid key, plan limit reached, timeout…). `country` is sent in the lowercase form Tavily expects, and a rejected optional parameter triggers a plain retry.

**Markdown & math** (`markdown.js`)
- LaTeX is extracted *before* Markdown runs, so `x_1`, `a*b` and `\\` are no longer turned into italics. Supports `\( \)`, `\[ \]`, `$ $`, `$$ $$`, bare `\begin{aligned}…`, double-escaped `\\(`, and `[ … ]` blocks.
- Real nested lists (numbering no longer restarts), code blocks inside list items, `[text](url)` links, table alignment, rows with missing cells.
- Wide formulas scroll sideways instead of being clipped on the left.

**Layout**
- Side menu now reaches the bottom of the screen on phones.
- **Obrolan** (left) and **Pratinjau** (right) sit on the same row.
- When the AI writes a website, the Pratinjau tab turns on immediately (pulsing dot + "Buka pratinjau layar penuh" button). The preview fills the whole screen area with no box around it, the composer is hidden while previewing, and there is a fullscreen button. Truncated code (cut off at the token limit) still renders.
- Website requests get a larger output budget and a prompt that asks for one complete, self-contained HTML file.

## Quota notes
A signed cookie with the Jakarta-local date allows 20 requests/day per browser. Without a database/login, clearing site data resets it.
