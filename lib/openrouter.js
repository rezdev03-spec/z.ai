// Daftar model gratis OpenRouter yang dipakai bersama oleh api/models.js (dropdown) dan api/chat.js (cadangan otomatis).

// Model yang BUKAN model chat (pengklasifikasi keamanan, embedding, reranker, dll). Contohnya
// "NVIDIA: Nemotron Content Safety" yang hanya membalas "User Safety: safe".
const NON_CHAT_RE = /guard|safety|moderat|classif|embed|rerank|reward|shield|detector|whisper|\btts\b|speech|transcri|diffusion|image-gen|audio/i;
const PREFERRED_RE = /coder|code|dev|qwen|deepseek|gemini|gpt-oss|llama|mistral|glm|kimi/i;
const MIN_CONTEXT = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;

export function isFreeId(id) {
  return /^[a-zA-Z0-9._/-]{2,140}:free$/.test(String(id || ""));
}

export function isNonChatModel(idOrModel) {
  const text = typeof idOrModel === "string" ? idOrModel : `${idOrModel?.id || ""} ${idOrModel?.name || ""}`;
  return NON_CHAT_RE.test(text);
}

function normalize(model) {
  const input = model?.architecture?.input_modalities || [];
  return {
    id: model.id,
    name: String(model.name || model.id).slice(0, 100),
    vision: Array.isArray(input) && input.includes("image"),
    context: Number(model.context_length) || 0
  };
}

function isUsableFreeChatModel(model) {
  return model && typeof model.id === "string" &&
    isFreeId(model.id) &&
    !isNonChatModel(model) &&
    Array.isArray(model?.architecture?.input_modalities) && model.architecture.input_modalities.includes("text") &&
    Array.isArray(model?.architecture?.output_modalities) && model.architecture.output_modalities.includes("text") &&
    (Number(model.context_length) || MIN_CONTEXT) >= MIN_CONTEXT;
}

function rank(a, b) {
  const pa = PREFERRED_RE.test(a.id) ? 0 : 1;
  const pb = PREFERRED_RE.test(b.id) ? 0 : 1;
  return pa - pb || b.context - a.context || a.name.localeCompare(b.name);
}

const cache = globalThis.__zennnyxOpenRouterCache || { at: 0, list: [] };
globalThis.__zennnyxOpenRouterCache = cache;

export async function getFreeChatModels({ force = false } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return [];
  if (!force && cache.list.length && Date.now() - cache.at < CACHE_TTL_MS) return cache.list;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models?output_modalities=text", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const list = (Array.isArray(payload.data) ? payload.data : [])
      .filter(isUsableFreeChatModel)
      .map(normalize)
      .sort(rank)
      .slice(0, 30);
    if (list.length) { cache.list = list; cache.at = Date.now(); }
    return list.length ? list : cache.list;
  } catch (error) {
    console.error("OpenRouter model list failed:", error?.message || error);
    return cache.list; // pakai cache lama kalau ada
  }
}

// Kandidat cadangan: model gratis lain (bukan yang sedang gagal), dan harus bisa gambar kalau ada gambar.
export async function pickFallbackModels(failedIds, { needVision = false, limit = 2 } = {}) {
  const skip = new Set(failedIds);
  const list = await getFreeChatModels();
  return list.filter(m => !skip.has(m.id) && (!needVision || m.vision)).slice(0, limit).map(m => m.id);
}
