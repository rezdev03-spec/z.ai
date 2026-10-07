export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ZennNyx is not configured yet.' });

  const body = req.body || {};
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const thinkHarder = body.thinkHarder === true;

  let messages = incoming
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-20)
    .map(m => {
      if (m.role === 'assistant' && typeof m.content === 'string') {
        return { role: 'assistant', content: m.content.slice(0, 12000) };
      }
      if (m.role === 'user' && typeof m.content === 'string') {
        return { role: 'user', content: m.content.slice(0, 8000) };
      }
      if (m.role === 'user' && Array.isArray(m.content)) {
        const safeContent = m.content.filter(part => {
          if (!part || typeof part !== 'object') return false;
          if (part.type === 'text') return typeof part.text === 'string' && part.text.length <= 8000;
          if (part.type === 'image_url') return typeof part.image_url?.url === 'string' && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(part.image_url.url);
          return false;
        }).slice(0, 2);
        return safeContent.length ? { role: 'user', content: safeContent } : null;
      }
      return null;
    })
    .filter(Boolean);

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return res.status(400).json({ error: 'A user message is required.' });

  // The previous version selected a text-only model when a follow-up had no new image.
  // That left an earlier multimodal message in history and caused a provider validation error.
  // If the conversation contains an image, use the vision-capable model for the whole request.
  const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p?.type === 'image_url'));
  const model = hasImage
    ? (process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b')
    : (process.env.GROQ_MODEL || 'openai/gpt-oss-20b');

  const normalPrompt = `You are ZennNyx AI, a helpful, friendly AI assistant. Match the user's language and tone. Keep answers concise, direct, natural, and useful by default. Use Markdown when it improves readability. Maintain continuity with earlier messages. If an image is present anywhere in the conversation, use it as visual context when relevant to a follow-up question. Describe only what is actually supported by the image. Do not identify a real person in an image or guess their identity. Do not invent citations or claim to have browsed the web. Never reveal private chain-of-thought; give the answer and concise rationale instead.`;
  const thinkPrompt = `You are ZennNyx AI in Think Harder mode. Match the user's language and tone. Think carefully before answering, then provide a structured, professional, well-organized response. Use headings, steps, bullets, examples, comparisons, and concise conclusions when useful. Maintain continuity with earlier messages. If an image is present anywhere in the conversation, analyze it carefully when relevant. Do not identify a real person in an image or guess their identity. Be thorough without unnecessary repetition. Never reveal private chain-of-thought; provide the useful conclusion and concise rationale instead. Use Markdown naturally. Do not invent citations or claim to have browsed the web.`;

  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: thinkHarder ? thinkPrompt : normalPrompt }, ...messages],
        temperature: thinkHarder ? 0.55 : 0.7,
        max_completion_tokens: thinkHarder ? 4096 : 2048
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('ZennNyx upstream error:', upstream.status, data?.error?.message || data?.error || 'unknown');
      const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 500;
      return res.status(status).json({ error: 'ZennNyx could not process that request right now.' });
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) return res.status(502).json({ error: 'ZennNyx received an empty response.' });

    return res.status(200).json({ reply, thinkHarder, hasImage: hasImage });
  } catch (error) {
    console.error('ZennNyx server error:', error);
    return res.status(500).json({ error: 'ZennNyx could not connect to its AI service.' });
  }
}
