import { createHmac, timingSafeEqual } from "node:crypto";

const DAILY_LIMIT = 20;
const COOLDOWN_MS = 5000;
const BURST_WINDOW_MS = 60 * 1000;
const BURST_LIMIT = 3;
const BURST_COOLDOWN_MS = 10 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const GROQ_ALLOWED = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b"
]);
const GEMINI_ALLOWED = new Set([
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite"
]);

const burstStore = globalThis.__zennnyxBurstStore || new Map();
globalThis.__zennnyxBurstStore = burstStore;

function jakartaDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}

function jakartaResetAt(day = jakartaDay()) {
  // Jakarta is UTC+7: next local midnight is 17:00 UTC on the current local date.
  return Date.parse(`${day}T17:00:00.000Z`);
}

function signingSecret() {
  return process.env.RATE_LIMIT_SECRET ||
    process.env.GROQ_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    "zennnyx-local-only-change-before-production";
}

function sign(payload) {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

function readCookie(req, name) {
  const cookieHeader = String(req.headers?.cookie || "");
  const pair = cookieHeader.split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  if (!pair) return "";
  try { return decodeURIComponent(pair.slice(name.length + 1)); } catch { return ""; }
}

function saveCookie(res, name, value) {
  const existing = res.getHeader("Set-Cookie");
  const next = `${name}=${encodeURIComponent(value)}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax${process.env.VERCEL_URL ? "; Secure" : ""}`;
  const list = existing ? (Array.isArray(existing) ? [...existing, next] : [existing, next]) : [next];
  res.setHeader("Set-Cookie", list);
}

function emptyQuota(day = jakartaDay()) {
  return { v: 1, day, count: 0, lastAt: 0, burst: [], blockedUntil: 0 };
}

function readQuota(req) {
  const token = readCookie(req, "znx_quota");
  if (!token) return emptyQuota();
  const dot = token.lastIndexOf(".");
  if (dot < 1) return emptyQuota();
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return emptyQuota();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded || decoded.v !== 1 || decoded.day !== jakartaDay() || !Number.isInteger(decoded.count) || decoded.count < 0 || decoded.count > DAILY_LIMIT) return emptyQuota();
    return {
      v: 1,
      day: decoded.day,
      count: decoded.count,
      lastAt: Number(decoded.lastAt) || 0,
      burst: Array.isArray(decoded.burst) ? decoded.burst.filter(t => Number.isFinite(t)) : [],
      blockedUntil: Number(decoded.blockedUntil) || 0
    };
  } catch {
    return emptyQuota();
  }
}

function writeQuota(res, quota) {
  const payload = Buffer.from(JSON.stringify(quota)).toString("base64url");
  const token = `${payload}.${sign(payload)}`;
  saveCookie(res, "znx_quota", token);
}

function quotaSummary(quota) {
  return {
    limit: DAILY_LIMIT,
    used: Math.min(DAILY_LIMIT, quota.count),
    remaining: Math.max(0, DAILY_LIMIT - quota.count),
    day: quota.day,
    resetAt: jakartaResetAt(quota.day)
  };
}

function takeDailyQuota(req, res) {
  const now = Date.now();
  const quota = readQuota(req);
  const summary = quotaSummary(quota);

  if (quota.count >= DAILY_LIMIT) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((summary.resetAt - now) / 1000))));
    return { ok: false, status: 429, error: "Jatah 20 pesan hari ini sudah habis. Besok bisa lanjut lagi.", quota: summary };
  }

  if (quota.blockedUntil > now) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((quota.blockedUntil - now) / 1000))));
    return { ok: false, status: 429, error: "Pelan-pelan dulu, bro. Tunggu sebentar sebelum mengirim pesan lagi.", quota: summary };
  }

  if (quota.lastAt && now - quota.lastAt < COOLDOWN_MS) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((COOLDOWN_MS - (now - quota.lastAt)) / 1000))));
    return { ok: false, status: 429, error: "Tunggu sebentar sebelum mengirim pesan berikutnya.", quota: summary };
  }

  quota.burst = quota.burst.filter(t => now - t < BURST_WINDOW_MS);
  quota.count += 1;
  quota.lastAt = now;
  quota.burst.push(now);
  if (quota.burst.length >= BURST_LIMIT) {
    quota.blockedUntil = now + BURST_COOLDOWN_MS;
    quota.burst = [];
  }
  writeQuota(res, quota);
  return { ok: true, quota: quotaSummary(quota) };
}

function currentDateJakarta() {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());
}

function extractCurrentUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content.replace(/\s+/g, " ").trim().slice(0, 1600);
    if (Array.isArray(m.content)) {
      const text = m.content.find(p => p?.type === "text" && typeof p.text === "string")?.text;
      if (text) return text.replace(/\s+/g, " ").trim().slice(0, 1600);
    }
    break;
  }
  return "";
}

function shouldSearchWeb(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return false;
  if (/^(hai|halo|hello|hi|hey|ok|oke|thanks|makasih|terima kasih|wkwk|lol|yo|test|tes|siapa kamu|who are you|what are you)\b[!.? ]*$/i.test(q)) return false;
  const currentIntent = /\b(sekarang|saat ini|hari ini|kemarin|besok|terbaru|terkini|latest|today|yesterday|tomorrow|current|2026|update|berita|news|jadwal|schedule|score|skor|ranking|peringkat|harga|price|biaya|tarif|promo|diskon|beli|buy|terbaik|best|rekomendasi|recommended|spesifikasi|spec|stok|stock|rilis|release|versi terbaru|official|resmi|cuaca|weather|kurs|exchange|nilai tukar|lokasi|alamat|buka sekarang|hp|smartphone|iphone|samsung|xiaomi|redmi|poco|oppo|vivo|realme|tecno|infinix|laptop|tablet|film|game|produk)\b/i.test(q);
  if (currentIntent) return true;
  if (/\b(bikin|buatkan|buat|tuliskan|rewrite|parafrase|terjemahkan|translate|debug|javascript|typescript|html|css|python|kode|code|regex|website|landing page)\b/i.test(q)) return false;
  if (/^\s*(berapa|hitung|calculate|what is)\s+[0-9\s+\-*/().=]+[?!.]*\s*$/i.test(q)) return false;
  if (/\b(apa itu|apa arti|siapa|kapan|di mana|dimana|berapa|mengapa|kenapa|how|what|who|when|where|why|which)\b/i.test(q)) return true;
  return false;
}

function isIndonesianQuery(query) {
  return /\b(rp|rupiah|indonesia|indonesian|jakarta|jawa|bandung|surabaya|purworejo|kutoarjo)\b/i.test(query);
}

function makeSearchConfig(query) {
  const isNews = /\b(berita|news|latest news|berita terbaru|hari ini|today)\b/i.test(query);
  const config = { query: String(query).slice(0, 380), search_depth: "basic", max_results: 5, include_answer: false, include_raw_content: false };
  config.topic = isNews ? "news" : "general";
  if (isNews) config.time_range = "week";
  if (isIndonesianQuery(query)) config.country = "Indonesia";
  return config;
}

async function searchWeb(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { used: false, sources: [] };
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(makeSearchConfig(query)),
      signal: AbortSignal.timeout(8000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Tavily search error:", response.status, data?.detail || data?.error || "unknown");
      return { used: false, sources: [] };
    }
    const sources = (Array.isArray(data.results) ? data.results : []).filter(r => r && typeof r.url === "string" && /^https?:\/\//i.test(r.url)).slice(0, 5).map(r => ({
      title: String(r.title || r.url).slice(0, 180),
      url: r.url,
      domain: (() => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return ""; } })(),
      snippet: String(r.content || "").replace(/\s+/g, " ").slice(0, 450)
    }));
    return { used: sources.length > 0, sources };
  } catch (error) {
    console.error("Tavily search failed:", error);
    return { used: false, sources: [] };
  }
}

function formatSearchContext(sources) {
  return sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}`).join("\n\n");
}

function systemPrompt({ thinkHarder, currentDate, webSources, wantsWeb, wantsCode }) {
  const tone = `Kamu adalah ZennNyx AI, asisten personal yang cerdas dan enak diajak ngobrol. Balas dengan bahasa yang dipakai user. Kalau user ngobrol dalam bahasa Indonesia, pakai bahasa Indonesia sehari-hari yang natural dan santai, lebih mirip teman ngobrol daripada customer service. Ikuti gaya "gue/lu" jika user memakai gaya itu; hindari "saya/Anda" dan bahasa kantor yang kaku kecuali user minta formal. Jangan memaksakan slang di setiap kalimat. Jaga jawaban tetap jelas, jujur, dan berguna. Tanggal saat ini di WIB: ${currentDate}. Gunakan Markdown dengan benar. Untuk matematika, tulis rumus memakai LaTeX dengan delimiter: inline gunakan \\( ... \\), rumus blok gunakan \\[ ... \\]. Jangan menulis perintah seperti \\times sebagai teks polos di luar delimiter. Jangan mengarang sumber atau mengaku melakukan pencarian jika tidak ada hasil web saat ini. Jangan membuka chain-of-thought privat; berikan jawaban dan alasan ringkas yang berguna.`;
  const coding = wantsCode ? `\n\nMODE PEMBUATAN KODE: User mungkin meminta aplikasi atau website. Berikan kode yang lengkap dan benar-benar bisa dijalankan, bukan pseudo-code. Untuk project web, sertakan satu blok \`\`\`html lengkap yang bisa dijalankan mandiri; jika diminta terpisah, sertakan juga blok \`\`\`css dan \`\`\`javascript. Pastikan fitur yang disebutkan di prompt benar-benar dibuat, responsive untuk mobile/desktop, dan jangan menulis placeholder untuk bagian inti. Setelah kode, jelaskan file dan cara menjalankannya secara singkat.` : "";
  const thinking = thinkHarder ? `\n\nMODE THINK HARDER: Analisis kebutuhan dengan cermat dan jawab lebih mendalam serta terstruktur, tetapi tetap gunakan gaya bahasa santai yang sesuai user. Jangan bertele-tele tanpa manfaat.` : "";
  const web = webSources.length
    ? `\n\nPENCARIAN WEB UNTUK PERTANYAAN TERAKHIR INI:\nGunakan sumber di bawah sebagai bukti untuk klaim faktual/aktual. Sumber ini hanya milik pertanyaan TERAKHIR, bukan seluruh percakapan. Jangan gunakan kembali sumber lama sebagai sumber pertanyaan baru. Beri penanda [1], [2], dst hanya untuk sumber yang tersedia di bawah. Bila tidak mendukung sebuah klaim, akui belum terverifikasi.\n\n${formatSearchContext(webSources)}`
    : wantsWeb ? "\n\nUser membutuhkan fakta yang mungkin aktual, tetapi pencarian web tidak menghasilkan sumber. Jangan berpura-pura sudah mencari; jelaskan keterbatasan/ketidakpastian." : "";
  return tone + coding + thinking + web;
}

function normalizeMessages(incoming) {
  return (Array.isArray(incoming) ? incoming : []).filter(m => m && (m.role === "user" || m.role === "assistant")).slice(-18).map(m => {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content.slice(0, m.role === "assistant" ? 14000 : 8000) };
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      const content = m.content.filter(part => {
        if (!part || typeof part !== "object") return false;
        if (part.type === "text") return typeof part.text === "string" && part.text.length <= 8000;
        if (part.type === "image_url") return typeof part.image_url?.url === "string" && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(part.image_url.url);
        return false;
      }).slice(0, 2);
      return content.length ? { role: "user", content } : null;
    }
    return null;
  }).filter(Boolean);
}

function parseChoice(choice) {
  const raw = typeof choice === "string" ? choice : "";
  const parts = raw.split("::");
  if (parts.length !== 2) return null;
  return { provider: parts[0], model: parts[1] };
}

function textFromOpenAIResponse(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(p => typeof p?.text === "string" ? p.text : "").join("");
  return "";
}

function isBase64Image(url) {
  const match = String(url || "").match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([\s\S]+)$/i);
  return match ? { mimeType: match[1].toLowerCase(), data: match[2] } : null;
}

function toGeminiContents(messages) {
  return messages.map(message => {
    const role = message.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof message.content === "string") {
      parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item?.type === "text" && typeof item.text === "string") parts.push({ text: item.text });
        if (item?.type === "image_url") {
          const image = isBase64Image(item.image_url?.url);
          if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
        }
      }
    }
    return { role, parts };
  }).filter(m => m.parts.length > 0);
}

async function callGroq(model, messages, prompt, thinkHarder) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: prompt }, ...messages],
      max_completion_tokens: thinkHarder ? 4096 : 4096,
      temperature: thinkHarder ? 0.55 : 0.7
    }),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Groq error:", response.status, data?.error?.message || "unknown");
    const error = new Error("Model Groq gagal memproses permintaan. Coba model lain atau periksa limit API.");
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  return textFromOpenAIResponse(data);
}

async function callGemini(model, messages, prompt, thinkHarder) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt }] },
      contents: toGeminiContents(messages),
      generationConfig: { maxOutputTokens: thinkHarder ? 8192 : 4096 }
    }),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Gemini error:", response.status, data?.error?.message || "unknown");
    const error = new Error("Model Gemini gagal memproses permintaan. Cek API key, akses model, atau coba model lain.");
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  const reply = (data?.candidates?.[0]?.content?.parts || []).map(p => typeof p.text === "string" ? p.text : "").join("");
  if (!reply) throw Object.assign(new Error("Gemini mengembalikan jawaban kosong."), { status: 502 });
  return reply;
}

async function callOpenRouter(model, messages, prompt, thinkHarder) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "ZennNyx AI",
      ...(process.env.PUBLIC_APP_URL ? { "HTTP-Referer": process.env.PUBLIC_APP_URL } : {})
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: prompt }, ...messages],
      max_tokens: thinkHarder ? 4096 : 4096,
      temperature: thinkHarder ? 0.55 : 0.7
    }),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("OpenRouter error:", response.status, data?.error?.message || "unknown");
    const error = new Error("Model OpenRouter gagal memproses permintaan. Bisa jadi model sedang offline atau kuota provider habis.");
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  const reply = textFromOpenAIResponse(data);
  if (!reply) throw Object.assign(new Error("OpenRouter mengembalikan jawaban kosong."), { status: 502 });
  return reply;
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const quota = readQuota(req);
    writeQuota(res, quota);
    return res.status(200).json({
      quota: quotaSummary(quota),
      providers: {
        groq: Boolean(process.env.GROQ_API_KEY),
        gemini: Boolean(process.env.GEMINI_API_KEY),
        openrouter: Boolean(process.env.OPENROUTER_API_KEY),
        webSearch: Boolean(process.env.TAVILY_API_KEY)
      }
    });
  }

  const body = req.body || {};
  const messages = normalizeMessages(body.messages);
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return res.status(400).json({ error: "Pesan user wajib ada." });

  const choice = parseChoice(body.modelChoice || "groq::openai/gpt-oss-20b");
  if (!choice) return res.status(400).json({ error: "Pilihan model tidak valid." });

  const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p?.type === "image_url"));
  let chosenModel = choice.model;
  if (choice.provider === "groq") {
    if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: "API key Groq belum dipasang di Vercel." });
    if (!GROQ_ALLOWED.has(chosenModel)) return res.status(400).json({ error: "Model Groq tidak diizinkan." });
    if (hasImage && chosenModel !== "qwen/qwen3.8-27b") chosenModel = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
  } else if (choice.provider === "gemini") {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "Tambahkan GEMINI_API_KEY di Vercel untuk memakai model Gemini." });
    if (!GEMINI_ALLOWED.has(chosenModel)) return res.status(400).json({ error: "Model Gemini tidak diizinkan." });
  } else if (choice.provider === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: "Tambahkan OPENROUTER_API_KEY di Vercel untuk memakai OpenRouter." });
    if (!/^[a-zA-Z0-9._/-]{2,140}:free$/.test(chosenModel)) return res.status(400).json({ error: "Untuk menjaga biaya tetap aman, ZennNyx hanya mengizinkan model OpenRouter bertanda free." });
  } else {
    return res.status(400).json({ error: "Provider model tidak dikenal." });
  }

  // Consume quota before external searches/provider requests, so over-limit calls never use API credits.
  const quotaResult = takeDailyQuota(req, res);
  if (!quotaResult.ok) return res.status(quotaResult.status).json({ error: quotaResult.error, quota: quotaResult.quota });

  const userQuery = extractCurrentUserText(messages);
  const wantsWeb = shouldSearchWeb(userQuery);
  const wantsCode = /\b(buat|bikin|buatkan|build|create|website|web app|landing page|html|css|javascript|react|komponen|preview|aplikasi)\b/i.test(userQuery);
  const currentDate = currentDateJakarta();
  const webResult = wantsWeb ? await searchWeb(userQuery) : { used: false, sources: [] };
  const rawModelId=String(chosenModel||"model AI").replace(/:free$/,"");
  const shortModelName=rawModelId.split("/").pop().replace(/[-_]/g," ").replace(/\b\w/g,c=>c.toUpperCase());
  const modelIdentity=`${shortModelName} (ID model: ${rawModelId})`;
  const prompt = `${systemPrompt({ thinkHarder: body.thinkHarder === true, currentDate, webSources: webResult.sources, wantsWeb, wantsCode })}\n\nIDENTITAS MODEL AKTIF: ${modelIdentity}. ZennNyx AI adalah nama aplikasi/asisten, bukan klaim bahwa model dasarnya dikembangkan oleh ZennNyx. Jika user bertanya model apa yang dipakai, jawab jujur dengan menyebut model aktif tersebut. Jangan mengarang identitas atau mengaku sebagai model buatan ZennNyx.`;
  const thinkHarder = body.thinkHarder === true;

  try {
    let reply = "";
    if (choice.provider === "groq") reply = await callGroq(chosenModel, messages, prompt, thinkHarder);
    else if (choice.provider === "gemini") reply = await callGemini(chosenModel, messages, prompt, thinkHarder);
    else reply = await callOpenRouter(chosenModel, messages, prompt, thinkHarder);

    const finalReply = String(reply).trim();
    return res.status(200).json({
      reply: finalReply,
      provider: choice.provider,
      model: chosenModel,
      thinkHarder,
      hasImage,
      sources: webResult.sources,
      webSearched: webResult.used,
      quota: quotaResult.quota,
      projectHint: wantsCode
    });
  } catch (error) {
    const status = Number(error?.status) || 502;
    return res.status(status).json({ error: error?.message || "Ada kendala saat menghubungi model AI.", quota: quotaResult.quota });
  }
}
