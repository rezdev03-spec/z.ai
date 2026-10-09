// Daftar model yang dipakai bersama oleh api/models.js (dropdown) dan api/chat.js (pemilihan + cadangan otomatis).
// `prior` = nilai awal (kualitas + kecepatan) sebelum ada data nyata. Urutan sebenarnya dihitung ulang di chat.js
// dari seberapa lancar tiap model baru-baru ini (gagal / lambat = turun, lancar / cepat = naik).
import { getFreeChatModels } from "./openrouter.js";

export const GROQ_MODELS = [
  { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", description: "Cepat dan serbaguna", vision: false, prior: 72 },
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", description: "Lebih kuat untuk analisis", vision: false, prior: 74 },
  { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B", description: "Multimodal · bisa membaca gambar", vision: true, prior: 66 }
];

export const GEMINI_MODELS = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "Coding dan penalaran", vision: true, prior: 78 },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", description: "Cepat dan hemat", vision: true, prior: 76 }
];

export async function listAvailableModels() {
  const models = [];
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
