const GROQ_MODELS = [
  { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", description: "Cepat dan serbaguna", vision: false },
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", description: "Lebih kuat untuk analisis", vision: false },
  { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B", description: "Multimodal · bisa membaca gambar", vision: true }
];

const GEMINI_MODELS = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "Coding dan penalaran", vision: true },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", description: "Cepat dan hemat", vision: true }
];

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");
  const models = [];

  if (process.env.GROQ_API_KEY) {
    for (const model of GROQ_MODELS) {
      models.push({ provider: "groq", id: model.id, value: `groq::${model.id}`, name: model.name, description: model.description, vision: model.vision, available: true });
    }
  }

  if (process.env.GEMINI_API_KEY) {
    for (const model of GEMINI_MODELS) {
      models.push({ provider: "gemini", id: model.id, value: `gemini::${model.id}`, name: model.name, description: model.description, vision: model.vision, available: true });
    }
  }

  if (process.env.OPENROUTER_API_KEY) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models?output_modalities=text&sort=pricing-low-to-high", {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
        signal: AbortSignal.timeout(6000)
      });
      if (response.ok) {
        const payload = await response.json();
        const freeModels = (Array.isArray(payload.data) ? payload.data : [])
          .filter(model => {
            return model && typeof model.id === "string" &&
              model.id.endsWith(":free") &&
              Array.isArray(model?.architecture?.input_modalities) &&
              model.architecture.input_modalities.includes("text") &&
              Array.isArray(model?.architecture?.output_modalities) &&
              model.architecture.output_modalities.includes("text") &&
              model.id.length <= 160;
          })
          .sort((a, b) => {
            const score = m => (/coder|code|dev|qwen|deepseek|gemini|gpt-oss/i.test(m.id) ? 0 : 1);
            return score(a) - score(b) || String(a.name).localeCompare(String(b.name));
          })
          .slice(0, 24);

        for (const model of freeModels) {
          models.push({
            provider: "openrouter",
            id: model.id,
            value: `openrouter::${model.id}`,
            name: String(model.name || model.id).slice(0, 100),
            description: "OpenRouter · gratis saat ini",
            vision: Array.isArray(model?.architecture?.input_modalities) && model.architecture.input_modalities.includes("image"),
            available: true
          });
        }
      }
    } catch (error) {
      console.error("OpenRouter model list failed:", error);
    }
  }

  return res.status(200).json({
    models,
    providers: {
      groq: Boolean(process.env.GROQ_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      webSearch: Boolean(process.env.TAVILY_API_KEY)
    }
  });
}
