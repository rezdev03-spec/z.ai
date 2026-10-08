# ZennNyx AI v8.8

Daily-use AI chatbot frontend + Vercel serverless backend.

## v8.8 changes
- ChatGPT-like bottom composer with real browser voice input button.
- Plus menu now contains Camera, Photo, and Think Harder.
- Camera/Photo use local file selection; images are compressed in-browser before sending.
- Think Harder is toggled from the plus menu and remains a frontend state passed to the backend.
- Top header is simplified to centered "ZennNyx AI" with liquid-glass hamburger and New Chat buttons.
- Header fade now includes a stronger-to-weaker blur gradient.
- Popovers use a liquid-glass style with blur, translucent fill, thin highlight stroke, and depth shadow.
- Send button is circular with a compact, thick arrow icon.
- Markdown/table renderer remains optimized for readable body text, smaller table text, and horizontal table overflow without blocking vertical page scrolling.
- No provider branding is shown in the frontend.

## Environment variables
- `GROQ_API_KEY` (required)
- `GROQ_MODEL` (optional)
- `GROQ_VISION_MODEL` (optional)
