import { listAvailableModels } from "../lib/models.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");
  const models = (await listAvailableModels()).map(({ prior, ...model }) => model);
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
