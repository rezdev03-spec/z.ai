// Daftar model yang dipakai bersama oleh api/models.js (dropdown) dan api/chat.js (pemilihan + cadangan otomatis).
// `prior` = nilai awal (kualitas + kecepatan) sebelum ada data nyata. Urutan sebenarnya dihitung ulang di chat.js
// dari seberapa lancar tiap model baru-baru ini (gagal / lambat = turun, lancar / cepat = naik).
import { getFreeChatModels } from "./openrouter.js";

export const GROQ_MODELS = [
  { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", description: "Cepat dan ringkas", vision: false, prior: 64 },
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", description: "Lebih teliti untuk analisis", vision: false, prior: 74 },
  { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B", description: "Multimodal · bisa membaca gambar", vision: true, prior: 66 }
];

export const GEMINI_MODELS = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "Coding dan penalaran", vision: true, prior: 78 },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", description: "Cepat dan hemat", vision: true, prior: 76 }
];

// Provider tambahan yang memakai format OpenAI-compatible (satu fungsi pemanggil untuk semuanya).
// Daftar model bisa diganti lewat env <NAMA>_MODELS (dipisah koma) tanpa edit kode, mis. MISTRAL_MODELS=mistral-small-latest.
// Kalau mau menambah provider gratis lain yang OpenAI-compatible, cukup tambah satu blok di sini.
export const COMPAT_PROVIDERS = {
  mistral: {
    label: "Mistral", env: "MISTRAL_API_KEY", modelsEnv: "MISTRAL_MODELS", baseUrl: "https://api.mistral.ai/v1", prior: 64,
    defaults: [
      { id: "mistral-small-latest", name: "Mistral Small", description: "Cepat dan serbaguna", vision: true },
      { id: "mistral-large-latest", name: "Mistral Large", description: "Lebih teliti untuk analisis", vision: true }
    ]
  },
  nvidia: {
    label: "NVIDIA", env: "NVIDIA_API_KEY", modelsEnv: "NVIDIA_MODELS", baseUrl: "https://integrate.api.nvidia.com/v1", prior: 62,
    defaults: [
      // Katalog NVIDIA sering berganti: model lama dihentikan (HTTP 410). Dua ini terdaftar "Free Endpoint" di build.nvidia.com.
      // Kalau suatu saat 410/404, ganti lewat env NVIDIA_MODELS (id model persis seperti di build.nvidia.com).
      // reasoning: model "berpikir" dulu (butuh ruang token lebih besar). slow: boleh menunggu lebih lama sebelum dianggap gagal.
      { id: "deepseek-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", description: "Teliti, bisa baca gambar", vision: true, reasoning: true, slow: true },
      { id: "z-ai/glm-5.3", name: "GLM-5.3", description: "Teliti untuk coding dan analisis", vision: false, reasoning: true, slow: true },
      { id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash", description: "Cepat dan enak diajak ngobrol, bisa baca gambar", vision: true, reasoning: true, slow: true, prior: 77 }
    ]
  }
};

// Tebakan untuk model buatan sendiri lewat env: keluarga model yang umumnya "berpikir" dulu sebelum menjawab.
const REASONING_RE = /deepseek|glm|kimi|r1\b|reasoning|thinking|gpt-oss|nemotron-(super|ultra)|qwen3/i;
const COMPAT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,99}$/;

function prettyModelName(id) {
  return id.split("/").pop().replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export function getCompatModels(provider) {
  const cfg = COMPAT_PROVIDERS[provider];
  if (!cfg) return [];
  const custom = String(process.env[cfg.modelsEnv] || "").split(",").map(x => x.trim()).filter(x => COMPAT_ID_RE.test(x));
  const base = custom.length
    ? [...new Set(custom)].map(id => cfg.defaults.find(d => d.id === id) || { id, name: prettyModelName(id), description: cfg.label, vision: /pixtral|vision|[-_]vl\b/i.test(id), reasoning: REASONING_RE.test(id), slow: REASONING_RE.test(id) })
    : cfg.defaults;
  return base.map((m, i) => ({ ...m, prior: m.prior ?? cfg.prior - i * 0.5 }));
}

export async function listAvailableModels() {
  const models = [];
  for (const [provider, cfg] of Object.entries(COMPAT_PROVIDERS)) {
    if (!process.env[cfg.env]) continue;
    for (const m of getCompatModels(provider)) models.push({ provider, id: m.id, value: `${provider}::${m.id}`, name: m.name, description: m.description, vision: m.vision, reasoning: Boolean(m.reasoning), slow: Boolean(m.slow), prior: m.prior, available: true });
  }
  if (process.env.GROQ_API_KEY) {
    for (const m of GROQ_MODELS) models.push({ provider: "groq", id: m.id, value: `groq::${m.id}`, name: m.name, description: m.description, vision: m.vision, prior: m.prior, available: true });
  }
  if (process.env.GEMINI_API_KEY) {
    for (const m of GEMINI_MODELS) models.push({ provider: "gemini", id: m.id, value: `gemini::${m.id}`, name: m.name, description: m.description, vision: m.vision, prior: m.prior, available: true });
  }
  if (process.env.OPENROUTER_API_KEY) {
    const list = await getFreeChatModels();
    list.forEach((m, i) => models.push({
      provider: "openrouter", id: m.id, value: `openrouter::${m.id}`, name: m.name,
      description: "OpenRouter · gratis saat ini", vision: m.vision, prior: 55 - i * 0.5, available: true
    }));
  }
  return models;
}
