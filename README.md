# ZennNyx AI v8

A lightweight AI assistant UI designed for comfortable daily use.

## Features
- ZennNyx-branded frontend with provider details kept server-side
- Multi-turn text and image conversations
- Vision follow-ups without the previous multimodal-history format bug
- Think Harder popover and animated active state
- Enter creates a new line; Send button is the only send action
- Markdown, code blocks, tables, copy/share/feedback/source controls
- Mobile-friendly composer and keyboard behavior
- Image preview, resize/compression, paste image support
- Friendly user-facing errors; provider errors stay server-side

## Environment variables
Set these in Vercel:
- `GROQ_API_KEY` — required server-side key
- `GROQ_MODEL` — optional text model override; default `openai/gpt-oss-20b`
- `GROQ_VISION_MODEL` — optional vision model override; default `qwen/qwen3.8-27b`

Do not expose the API key in frontend code.
