import { TIER_IDS, modelsForTier, modelsForClient, providerEnabled, tiersForClient } from "../lib/models.js";

// Daftar tingkat Effort + provider yang aktif. Tambah ?debug=1 untuk melihat model yang dipakai tiap tingkat (urutan awal).
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");
  const out = {
    tiers: tiersForClient(),
    models: await modelsForClient().catch(() => []),
    providers: { nvidia: providerEnabled("nvidia"), openrouter: providerEnabled("openrouter"), groq: providerEnabled("groq"), gemini: providerEnabled("gemini"), webSearch: Boolean(process.env.TAVILY_API_KEY) }
  };
  if (req.query?.debug === "1") {
    out.chains = {};
    for (const t of TIER_IDS) out.chains[t] = (await modelsForTier(t)).map(m => m.value);
  }
  return res.status(200).json(out);
}
