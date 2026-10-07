export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY is not configured on Vercel.' });

  const body = req.body || {};
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const thinkHarder = body.thinkHarder === true;

  const messages = incoming
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
          if (part.type === 'image_url') return typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:image/');
          return false;
        }).slice(0, 2);
        return safeContent.length ? { role: 'user', content: safeContent } : null;
      }
      return null;
    })
    .filter(Boolean);

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return res.status(400).json({ error: 'A user message is required.' });

  const hasImage = Array.isArray(last.content) && last.content.some(p => p.type === 'image_url');
  const model = hasImage
    ? (process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b')
    : (process.env.GROQ_MODEL || 'openai/gpt-oss-20b');

  const normalPrompt = `You are ZennNyx AI, a helpful and friendly AI assistant. Match the user's language. Keep answers concise, direct, and useful by default. Prefer clear paragraphs or bullets over long essays. Use Markdown naturally. If the user provides an image, inspect it carefully and answer based on what is actually visible. Do not invent citations or claim to have browsed the web. Do not reveal private chain-of-thought.`;
  const thinkPrompt = `You are ZennNyx AI in Think Harder mode. Match the user's language. Think carefully before answering, then provide a structured, professional, well-organized response. Use clear headings, steps, bullets, examples, comparisons, and concise conclusions when useful. If an image is provided, analyze relevant visual details carefully. Be more thorough than normal mode without needless repetition. Do not reveal private chain-of-thought; provide the useful conclusion and concise rationale instead. Use Markdown naturally. Do not invent citations or claim to have browsed the web.`;

  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: hasImage ? `${thinkHarder ? thinkPrompt : normalPrompt}\nThis is a vision request. Read the image directly.` : (thinkHarder ? thinkPrompt : normalPrompt) }, ...messages],
        temperature: thinkHarder ? 0.55 : 0.7,
        max_completion_tokens: thinkHarder ? 4096 : 2048
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const providerMessage = data?.error?.message || data?.error || `Groq returned HTTP ${upstream.status}`;
      return res.status(upstream.status).json({ error: `Groq error: ${String(providerMessage)}`, model });
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) return res.status(502).json({ error: 'Groq returned an empty response.', model });

    return res.status(200).json({ reply, model, thinkHarder, hasImage });
  } catch (error) {
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
