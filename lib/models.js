// Registry model: 4 tingkat "Effort" (fast / low / medium / high) di atas NVIDIA NIM, Groq, Gemini, dan OpenRouter (gratis). Mistral tidak dipakai.
// Tiap tingkat punya tangga model (urut dari yang paling cepat/andal), batas waktu, dan anggaran token sendiri.
// Katalog gratis sering berganti, jadi:
//   1. daftar kurasi dicocokkan dengan katalog hidup tiap provider (/v1/models); id yang sudah mati dibuang otomatis,
//   2. kalau tersisa sedikit, model lain dari katalog dipilih lewat heuristik (ukuran, reasoning atau bukan),
//   3. daftar OpenRouter selalu diambil hidup dari API (hanya yang :free),
//   4. semua daftar bisa diganti lewat env <PROVIDER>_<TINGKAT>_MODELS, mis. NVIDIA_FAST_MODELS, GROQ_MEDIUM_MODELS (dipisah koma).
import { getFreeChatModels } from "./openrouter.js";

export const TIERS = {
  fast: {
    id: "fast", label: "Fast", description: "Quickest replies for simple questions",
    maxTokens: 1536, codeTokens: 6144, temperature: 0.6,
    hedgeMs: 1800,        // belum ada token setelah ini -> jalankan model cadangan PARALEL, ambil yang menjawab duluan
    firstTokenMs: 9000,   // batas tunggu token pertama sebelum satu percobaan dianggap gagal
    maxAttempts: 5, search: "explicit"
  },
  low: {
    id: "low", label: "Low", description: "Snappy and light for everyday chat",
    maxTokens: 2560, codeTokens: 7168, temperature: 0.65,
    hedgeMs: 2600, firstTokenMs: 11000, maxAttempts: 5, search: "fresh"
  },
  medium: {
    id: "medium", label: "Medium", description: "Balanced speed and quality", recommended: true,
    maxTokens: 4096, codeTokens: 8192, temperature: 0.7,
    hedgeMs: 3800, firstTokenMs: 15000, maxAttempts: 5, search: "auto"
  },
  high: {
    id: "high", label: "High", description: "Most thorough, takes longer",
    maxTokens: 6144, codeTokens: 12288, temperature: 0.55,
    hedgeMs: 11000, firstTokenMs: 40000, maxAttempts: 4, search: "auto"
  }
};
export const TIER_IDS = Object.keys(TIERS);
export const DEFAULT_TIER = "medium";
export const normalizeTier = value => (TIER_IDS.includes(String(value)) ? String(value) : DEFAULT_TIER);

export const PROVIDERS = {
  nvidia: { label: "NVIDIA", env: "NVIDIA_API_KEY", baseUrlEnv: "NVIDIA_BASE_URL", baseUrl: "https://integrate.api.nvidia.com/v1", prior: 70 },
  openrouter: { label: "OpenRouter", env: "OPENROUTER_API_KEY", baseUrlEnv: "OPENROUTER_BASE_URL", baseUrl: "https://openrouter.ai/api/v1", prior: 46 },
  // Groq (chip inferensi super cepat) dan Gemini (lewat endpoint OpenAI-compatible Google) memakai format streaming yang sama.
  groq: { label: "Groq", env: "GROQ_API_KEY", baseUrlEnv: "GROQ_BASE_URL", baseUrl: "https://api.groq.com/openai/v1", prior: 74 },
  gemini: { label: "Gemini", env: "GEMINI_API_KEY", baseUrlEnv: "GEMINI_BASE_URL", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", prior: 72 }
};
export const providerBaseUrl = provider => String(process.env[PROVIDERS[provider].baseUrlEnv] || PROVIDERS[provider].baseUrl).replace(/\/+$/, "");
export const providerEnabled = provider => Boolean(PROVIDERS[provider] && process.env[PROVIDERS[provider].env]);
export const anyProviderEnabled = () => Object.keys(PROVIDERS).some(providerEnabled);

// Urutan = prioritas awal. `reasoning`: model "berpikir" dulu (lambat di token pertama), jadi hanya jadi andalan di tingkat High.
const NVIDIA_DEFAULTS = {
  fast: [
    { id: "google/gemma-4-31b-it", name: "Gemma 4 31B", vision: true },
    { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B" }
  ],
  low: [
    { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
    { id: "google/gemma-4-31b-it", name: "Gemma 4 31B", vision: true }
  ],
  medium: [
    { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
    { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", name: "Nemotron Super 49B" },
    { id: "google/gemma-4-31b-it", name: "Gemma 4 31B", vision: true },
    { id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash", vision: true, reasoning: true }
  ],
  high: [
    { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", reasoning: true },
    { id: "deepseek-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", vision: true, reasoning: true },
    { id: "z-ai/glm-5.3", name: "GLM-5.3", reasoning: true },
    { id: "nvidia/nemotron-3-super-120b-a12b", name: "Nemotron 3 Super", reasoning: true },
    { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", name: "Nemotron Super 49B" },
    { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B" }
  ]
};

const GROQ_DEFAULTS = {
  fast: [{ id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", reasoning: true }],
  low: [{ id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", reasoning: true }, { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B", vision: true }],
  medium: [{ id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", reasoning: true }, { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B", vision: true }],
  high: [{ id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", reasoning: true }]
};
const GEMINI_DEFAULTS = {
  fast: [{ id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", vision: true }],
  low: [{ id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", vision: true }],
  medium: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", vision: true }, { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", vision: true }],
  high: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", vision: true }]
};

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,99}$/;
const REASONING_RE = /deepseek|r1\b|reason|think|gpt-oss|qwq|glm|kimi|nemotron-(super|ultra|3)|qwen3|\bo[134]\b/i;
const FASTWORD_RE = /nano|mini|small|lite|flash|turbo|instant|gemma|e2b|e4b/i;
const VISION_RE = /vision|[-_]vl\b|vl-|pixtral|llava|multimodal|gemma-[34]/i;
// Bukan model chat: pengaman, embedding, reranker, suara, gambar, parser dokumen, dll.
const NON_CHAT_RE = /mistral|ministral|mixtral|codestral|magistral|guard|safety|moderat|classif|embed|rerank|reward|shield|detector|whisper|\btts\b|speech|transcri|diffusion|image-gen|audio|retriev|parse|ocr|clip|riva|cosmos|flux|stable|sdxl|parakeet|canary|maxine|bge|translate|nemoguard|paddle|deplot|neva|fuyu|kosmos/i;

export function prettyModelName(id) {
  return String(id).replace(/:free$/, "").split("/").pop().replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// Perkiraan jumlah parameter (miliar) dari id, mis. "llama-3.3-70b" -> 70. Abaikan "a12b" (parameter aktif) dan "e4b".
function paramsB(id) {
  let best = null;
  for (const m of String(id).toLowerCase().matchAll(/(?:^|[^a-z0-9.])(\d{1,4}(?:\.\d)?)b(?![a-z])/g)) best = Math.max(best ?? 0, Number(m[1]));
  return best;
}

// Heuristik kecocokan model dengan sebuah tingkat. Dipakai hanya untuk model hasil temuan otomatis (OpenRouter / katalog NVIDIA).
export function tierFit(id, tier, { reasoning } = {}) {
  const r = reasoning ?? REASONING_RE.test(id);
  const p = paramsB(id);
  const small = FASTWORD_RE.test(id);
  if (tier === "fast") return (small ? 30 : 0) + (p ? Math.max(0, 42 - p * 0.6) : 12) - (r ? 45 : 0);
  if (tier === "low") return (small ? 18 : 0) + (p ? Math.max(0, 40 - Math.abs(p - 30) * 0.5) : 12) - (r ? 30 : 0);
  if (tier === "medium") return 20 + (p ? -Math.abs(p - 70) * 0.25 : 0) - (r ? 18 : 0) - (small ? 5 : 0);
  return (p ? Math.min(60, p * 0.25) : 15) + (r ? 25 : 0);
}

/* ───────────── Katalog hidup per provider (NVIDIA, Groq, Gemini) ───────────── */

const catalogCache = globalThis.__zennnyxCatalogs || {};
globalThis.__zennnyxCatalogs = catalogCache;

export function cleanKey(value) {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "").replace(/^Bearer\s+/i, "").trim();
}

async function getCatalog(provider) {
  if (!providerEnabled(provider)) return null;
  const c = catalogCache[provider] || (catalogCache[provider] = { at: 0, ids: null });
  if (c.ids && Date.now() - c.at < 10 * 60 * 1000) return c.ids;
  try {
    const response = await fetch(`${providerBaseUrl(provider)}/models`, {
      headers: { Authorization: `Bearer ${cleanKey(process.env[PROVIDERS[provider].env])}` },
      signal: AbortSignal.timeout(3500)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const ids = (Array.isArray(payload.data) ? payload.data : []).map(m => m?.id).filter(id => typeof id === "string").map(id => id.replace(/^models\//, ""));
    if (ids.length) { c.ids = new Set(ids); c.at = Date.now(); }
  } catch (error) {
    console.error(`${provider} catalog failed:`, error?.message || error);
    c.at = Date.now() - 8 * 60 * 1000; // coba lagi sekitar 2 menit lagi, jangan menahan tiap request
  }
  return c.ids;
}

const DEFAULTS = { nvidia: NVIDIA_DEFAULTS, groq: GROQ_DEFAULTS, gemini: GEMINI_DEFAULTS };

function customList(provider, tier) {
  const raw = String(process.env[`${provider.toUpperCase()}_${tier.toUpperCase()}_MODELS`] || "").split(",").map(x => x.trim()).filter(x => ID_RE.test(x));
  if (!raw.length) return null;
  const known = Object.values(DEFAULTS[provider]).flat();
  return [...new Set(raw)].map(id => known.find(k => k.id === id) || { id, name: prettyModelName(id), vision: VISION_RE.test(id), reasoning: REASONING_RE.test(id) });
}

async function curatedForTier(provider, tier) {
  if (!providerEnabled(provider)) return [];
  const catalog = await getCatalog(provider);
  const custom = customList(provider, tier);
  let list = custom || DEFAULTS[provider][tier];
  if (catalog && !custom) list = list.filter(m => catalog.has(m.id));
  // Katalog NVIDIA berganti: kalau daftar kurasi menyusut, tambah model lain dari katalog hidup menurut kecocokan tingkat.
  if (provider === "nvidia" && catalog && !custom && list.length < 3) {
    const have = new Set(list.map(m => m.id));
    const extra = [...catalog].filter(id => !have.has(id) && !NON_CHAT_RE.test(id) && ID_RE.test(id))
      .sort((a, b) => tierFit(b, tier) - tierFit(a, tier)).slice(0, 4 - list.length)
      .map(id => ({ id, name: prettyModelName(id), vision: VISION_RE.test(id), reasoning: REASONING_RE.test(id) }));
    list = [...list, ...extra];
  }
  const step = provider === "nvidia" ? 2 : 1;
  return list.map((m, i) => ({ provider, id: m.id, value: `${provider}::${m.id}`, name: m.name, vision: Boolean(m.vision), reasoning: Boolean(m.reasoning), prior: PROVIDERS[provider].prior - i * step }));
}

/* ───────────── OpenRouter: daftar gratis hidup ───────────── */

async function openrouterForTier(tier) {
  if (!providerEnabled("openrouter")) return [];
  const free = await getFreeChatModels();
  return free.filter(m => !/mistral|ministral|mixtral|codestral|magistral/i.test(m.id)).map(m => ({ m, reasoning: REASONING_RE.test(m.id), fit: tierFit(m.id, tier) }))
    .sort((a, b) => b.fit - a.fit).slice(0, 6)
    .map(({ m, reasoning }, i) => ({ provider: "openrouter", id: m.id, value: `openrouter::${m.id}`, name: prettyModelName(m.name || m.id), vision: m.vision, reasoning, prior: PROVIDERS.openrouter.prior - i * 1.2 }));
}

/** Kandidat model untuk satu tingkat (belum diurutkan menurut kelancaran; itu dikerjakan chat.js). */
export async function modelsForTier(tier, { hasImage = false } = {}) {
  const t = normalizeTier(tier);
  const forTier = x => Promise.all([curatedForTier("nvidia", x), curatedForTier("groq", x), curatedForTier("gemini", x), openrouterForTier(x)]);
  let list = (await forTier(t)).flat();
  if (hasImage) {
    list = list.filter(m => m.vision);
    if (!list.length) { // tingkat ini tidak punya model yang bisa membaca gambar: pinjam dari tingkat lain
      const others = await Promise.all(TIER_IDS.filter(x => x !== t).map(forTier));
      const seen = new Set();
      list = others.flat(2).filter(m => m.vision && !seen.has(m.value) && seen.add(m.value));
    }
  }
  return list;
}

export function tiersForClient() {
  return TIER_IDS.map(id => ({ id, label: TIERS[id].label, description: TIERS[id].description, recommended: Boolean(TIERS[id].recommended) }));
}
