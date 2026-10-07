# ZennNyx AI

Minimal black/white AI chat UI for Vercel + Groq.

## Environment variable

Set this in Vercel:

`GROQ_API_KEY=your_groq_api_key`

The frontend never receives the key.

## Notes

- Theme follows the device/browser system light/dark preference.
- Chat responses render common Markdown formatting.
- The page does not force-scroll when an AI response arrives.
- The disclaimer lives inside the composer area so it does not overlap the chat UI.
