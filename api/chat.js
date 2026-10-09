import { createHmac, timingSafeEqual } from "node:crypto";
import { getFreeChatModels, isFreeId, isNonChatModel, pickFallbackModels } from "../lib/openrouter.js";

const DAILY_LIMIT = 20;
const COOLDOWN_MS = 5000;
const BURST_WINDOW_MS = 60 * 1000;
const BURST_LIMIT = 3;
const BURST_COOLDOWN_MS = 10 * 1000;
const TOTAL_BUDGET_MS = 55 * 1000; // vercel.json: maxDuration 60

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

/* ───────────── Kuota harian (cookie bertanda tangan) ───────────── */

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
  // Ganti cookie bernama sama (mis. saat kuota dikembalikan), jangan ditumpuk.
  const kept = (existing ? (Array.isArray(existing) ? existing : [existing]) : []).filter(c => !String(c).startsWith(`${name}=`));
  res.setHeader("Set-Cookie", [...kept, next]);
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

  const before = JSON.parse(JSON.stringify(quota)); // untuk dikembalikan kalau provider gagal
  quota.burst = quota.burst.filter(t => now - t < BURST_WINDOW_MS);
  quota.count += 1;
  quota.lastAt = now;
  quota.burst.push(now);
  if (quota.burst.length >= BURST_LIMIT) {
    quota.blockedUntil = now + BURST_COOLDOWN_MS;
    quota.burst = [];
  }
  writeQuota(res, quota);
  return { ok: true, quota: quotaSummary(quota), before };
}

// Pesan yang gagal karena provider (bukan salah user) tidak boleh menghabiskan jatah 20/hari.
function refundQuota(res, before) {
  writeQuota(res, before);
  return quotaSummary(before);
}

/* ───────────── Web search (Tavily) ───────────── */

function currentDateJakarta() {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());
}

function userText(message) {
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content.replace(/\s+/g, " ").trim();
  if (Array.isArray(message.content)) {
    const text = message.content.find(p => p?.type === "text" && typeof p.text === "string")?.text;
    return text ? text.replace(/\s+/g, " ").trim() : "";
  }
  return "";
}

function extractCurrentUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return userText(messages[i]).slice(0, 1600);
  }
  return "";
}

// Pertanyaan lanjutan pendek ("dan harganya?") butuh konteks pertanyaan sebelumnya supaya hasil pencarian relevan.
function buildSearchQuery(messages) {
  const users = messages.filter(m => m?.role === "user");
  const current = userText(users[users.length - 1]);
  const previous = userText(users[users.length - 2]);
  const query = current.length < 32 && previous ? `${previous.slice(0, 140)} ${current}` : current;
  return query.slice(0, 380);
}

const EXPLICIT_SEARCH = /\b(cari(?:kan|in|\s?tau|\s?tahu)?|search|googling|google|browsing|telusuri|cek (?:di )?(?:web|internet|google)|(?:di|dari|lewat) (?:internet|web|google)|web search|kasih (?:sumber|link|referensi)|sertakan (?:sumber|link|referensi)|pakai sumber)\b/i;
const CHITCHAT = /^(hai|halo|hallo|hello|hi|hey|ok|oke|okay|sip|mantap|thanks|thank you|makasih|terima kasih|wkwk\w*|haha\w*|lol|yo|test|tes|lanjut|lanjutkan|siapa kamu|kamu siapa|who are you|what are you)\b[!.,? ]*$/i;
const OFFLINE_TASK = /\b(bikin|buatkan|buatin|buat|tuliskan|tulis|rewrite|parafrase|ringkas|rangkum|terjemahkan|translate|debug|perbaiki|fix|refactor|optimasi|javascript|typescript|html|css|python|kode|code|script|regex|sql|website|landing page|puisi|cerita|caption|hitung|selesaikan|kerjakan|integral|turunan|persamaan|rumus|solve|simplify|factor|ubah|convert)\b/i;
const FRESH_SIGNAL = /\b(sekarang|saat ini|hari ini|kemarin|besok|terbaru|terkini|latest|today|yesterday|tomorrow|current|2025|2026|2027|update|berita|news|jadwal|schedule|score|skor|ranking|peringkat|harga|price|biaya|tarif|promo|diskon|stok|stock|rilis|release|cuaca|weather|kurs|nilai tukar)\b/i;
const CURRENT_INTENT = /\b(beli|buy|terbaik|best|rekomendasi|recommended|spesifikasi|spec|versi terbaru|official|resmi|lokasi|alamat|buka sekarang|hp|smartphone|iphone|samsung|xiaomi|redmi|poco|oppo|vivo|realme|tecno|infinix|laptop|tablet|film|game|produk|presiden|menteri|gubernur|ceo|juara|pemenang|skor)\b/i;
const QUESTION = /\b(apa itu|apa arti|apakah|apa|siapa|kapan|di ?mana|dimana|berapa|mengapa|kenapa|bagaimana|gimana|jelaskan|jelasin|what|who|when|where|why|which|how)\b/i;

// mode: "auto" (default) | "on" (selalu cari) | "off"
function shouldSearchWeb(query, { mode = "auto", hasImage = false } = {}) {
  const q = String(query || "").toLowerCase().trim();
  if (!q || mode === "off") return false;
  if (CHITCHAT.test(q)) return false;
  if (mode === "on") return true;
  if (EXPLICIT_SEARCH.test(q)) return true;
  if (hasImage) return false;
  if (OFFLINE_TASK.test(q)) return FRESH_SIGNAL.test(q);
  if (FRESH_SIGNAL.test(q) || CURRENT_INTENT.test(q)) return true;
  return QUESTION.test(q);
}

function isIndonesianQuery(query) {
  return /\b(rp|rupiah|indonesia|indonesian|jakarta|jawa|bandung|surabaya|purworejo|kutoarjo)\b/i.test(query);
}

function makeSearchConfig(query) {
  const isNews = /\b(berita|news|latest news|berita terbaru|hari ini|today)\b/i.test(query);
  const config = { query: String(query).slice(0, 380), search_depth: "basic", max_results: 5, include_answer: false, include_raw_content: false };
  config.topic = isNews ? "news" : "general";
  if (isNews) config.time_range = "week";
  if (!isNews && isIndonesianQuery(query)) config.country = "indonesia"; // Tavily menerima nama negara huruf kecil
  return config;
}

function describeTavilyError(status, data) {
  const detail = String(data?.detail?.error || data?.detail || data?.error || "").replace(/\s+/g, " ").slice(0, 160);
  let msg;
  if (status === 401 || status === 403) msg = "API key Tavily ditolak (salah, dicabut, atau tidak punya akses)";
  else if (status === 429) msg = "terlalu banyak permintaan ke Tavily, coba lagi sebentar";
  else if (status === 432 || status === 433) msg = "kuota/limit paket Tavily habis";
  else if (status === 400) msg = "Tavily menolak format permintaan";
  else if (status >= 500) msg = "server Tavily sedang bermasalah";
  else msg = `Tavily membalas status ${status}`;
  return `${msg} (HTTP ${status})${detail ? `: ${detail}` : ""}`;
}

async function searchWeb(query, timeoutMs = 7000) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { used: false, sources: [], error: "TAVILY_API_KEY belum dipasang di Vercel." };
  const attempt = async config => {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };
  try {
    const config = makeSearchConfig(query);
    let { response, data } = await attempt(config);
    if (response.status === 400 && (config.country || config.time_range || config.topic !== "general")) {
      // Parameter opsional ditolak? Ulangi dengan kueri polos supaya pencarian tetap jalan.
      ({ response, data } = await attempt({ query: config.query, search_depth: "basic", max_results: 5 }));
    }
    if (!response.ok) {
      const error = describeTavilyError(response.status, data);
      console.error("Tavily search error:", error);
      return { used: false, sources: [], error };
    }
    const sources = (Array.isArray(data.results) ? data.results : []).filter(r => r && typeof r.url === "string" && /^https?:\/\//i.test(r.url)).slice(0, 5).map(r => ({
      title: String(r.title || r.url).slice(0, 180),
      url: r.url,
      domain: (() => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return ""; } })(),
      snippet: String(r.content || "").replace(/\s+/g, " ").slice(0, 450)
    }));
    if (!sources.length) return { used: false, sources: [], error: "Pencarian web tidak menemukan hasil untuk kueri ini." };
    return { used: true, sources };
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Tavily search failed:", error);
    return { used: false, sources: [], error: timeout ? "Pencarian web melebihi batas waktu." : "Tidak bisa tersambung ke Tavily." };
  }
}

function formatSearchContext(sources) {
  return sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}`).join("\n\n");
}

/* ───────────── Prompt ───────────── */

function systemPrompt({ thinkHarder, currentDate, webSources, wantsWeb, wantsCode }) {
  const tone = `Kamu adalah ZennNyx AI, asisten personal yang cerdas dan enak diajak ngobrol. Balas dengan bahasa yang dipakai user. Kalau user ngobrol dalam bahasa Indonesia, pakai bahasa Indonesia sehari-hari yang natural dan santai, lebih mirip teman ngobrol daripada customer service. Ikuti gaya "gue/lu" jika user memakai gaya itu; hindari "saya/Anda" dan bahasa kantor yang kaku kecuali user minta formal. Jangan memaksakan slang di setiap kalimat. Jaga jawaban tetap jelas, jujur, dan berguna. Tanggal saat ini di WIB: ${currentDate}. Gunakan Markdown dengan benar.

MATEMATIKA: tulis rumus dengan LaTeX. Inline: \\( ... \\). Rumus blok: \\[ ... \\]. Beberapa langkah yang sejajar ditaruh dalam SATU blok: \\[ \\begin{aligned} x_1 &= ... \\\\ x_2 &= ... \\end{aligned} \\]. Jangan pernah menaruh format Markdown (** _ \`) di dalam rumus; pakai x_1 atau x_{1} untuk subskrip. Jangan pakai tanda $ untuk rumus (bentrok dengan tanda uang). Jangan menulis perintah LaTeX seperti \\times atau \\frac sebagai teks polos di luar delimiter.

Jangan mengarang sumber atau mengaku melakukan pencarian jika tidak ada hasil web saat ini. Jangan membuka chain-of-thought privat; berikan jawaban dan alasan ringkas yang berguna.`;
  const coding = wantsCode ? `\n\nMODE PEMBUATAN KODE: User mungkin meminta aplikasi atau website. Berikan kode yang lengkap dan benar-benar bisa dijalankan, bukan pseudo-code. Untuk website, utamakan SATU blok \`\`\`html berisi file HTML mandiri (CSS di <style>, JavaScript di <script>) karena hasilnya langsung ditampilkan sebagai pratinjau layar penuh. Jangan memecah jadi banyak file kecuali user memintanya. Kode HARUS lengkap sampai </html> dan tidak boleh terpotong: kalau fiturnya banyak, tulis ringkas dan efisien supaya muat. Wajib responsive (mobile dulu) dengan <meta name="viewport">, tidak bergantung pada file lokal; CDN publik boleh bila perlu. Jangan menulis placeholder untuk bagian inti. Jika user hanya bertanya atau ngobrol (bukan meminta perubahan kode), jawab biasa tanpa menulis ulang seluruh kode. Penjelasan setelah kode cukup singkat.` : "";
  const thinking = thinkHarder ? `\n\nMODE THINK HARDER: Analisis kebutuhan dengan cermat dan jawab lebih mendalam serta terstruktur, tetapi tetap gunakan gaya bahasa santai yang sesuai user. Jangan bertele-tele tanpa manfaat.` : "";
  const web = webSources.length
    ? `\n\nPENCARIAN WEB UNTUK PERTANYAAN TERAKHIR INI:\nGunakan sumber di bawah sebagai bukti untuk klaim faktual/aktual. Sumber ini hanya milik pertanyaan TERAKHIR, bukan seluruh percakapan. Jangan gunakan kembali sumber lama sebagai sumber pertanyaan baru. Beri penanda [1], [2], dst hanya untuk sumber yang tersedia di bawah. Bila tidak mendukung sebuah klaim, akui belum terverifikasi.\n\n${formatSearchContext(webSources)}`
    : wantsWeb ? "\n\nUser membutuhkan fakta yang mungkin aktual, tetapi pencarian web tidak menghasilkan sumber. Jangan berpura-pura sudah mencari; jelaskan keterbatasan/ketidakpastian." : "";
  return tone + coding + thinking + web;
}

function modelIdentity(model) {
  const rawModelId = String(model || "model AI").replace(/:free$/, "");
  const shortModelName = rawModelId.split("/").pop().replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return `\n\nIDENTITAS MODEL AKTIF: ${shortModelName} (ID model: ${rawModelId}). ZennNyx AI adalah nama aplikasi/asisten, bukan klaim bahwa model dasarnya dikembangkan oleh ZennNyx. Jika user bertanya model apa yang dipakai, jawab jujur dengan menyebut model aktif tersebut. Jangan mengarang identitas atau mengaku sebagai model buatan ZennNyx.`;
}

/* ───────────── Util pesan ───────────── */

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

// Beberapa model menyelipkan proses berpikir di dalam <think>…</think>; itu tidak untuk ditampilkan.
function stripThinking(text) {
  return String(text || "")
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^\s*<(think|thinking|reasoning)>[\s\S]*$/i, "")
    .trim();
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

// Model yang menolak role "system"/"developer" (mis. Gemma): sisipkan instruksi ke pesan user pertama.
function foldSystemIntoUser(messages, prompt) {
  const header = `[INSTRUKSI SISTEM]\n${prompt}\n[AKHIR INSTRUKSI]\n\n`;
  const copy = messages.map(m => ({ ...m }));
  const idx = copy.findIndex(m => m.role === "user");
  if (idx === -1) return [{ role: "user", content: header }, ...copy];
  const target = copy[idx];
  if (typeof target.content === "string") target.content = header + target.content;
  else if (Array.isArray(target.content)) {
    const parts = target.content.map(p => ({ ...p }));
    const t = parts.find(p => p.type === "text");
    if (t) t.text = header + t.text; else parts.unshift({ type: "text", text: header });
    target.content = parts;
  }
  return copy;
}

/* ───────────── Error provider ───────────── */

class UpstreamError extends Error {
  constructor(message, { status = 502, upstreamStatus = 0, detail = "", fatal = false, globalLimit = false } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.detail = detail;
    this.fatal = fatal;           // percuma coba model lain (API key salah, kuota harian habis, dst.)
    this.globalLimit = globalLimit;
  }
}

function cleanDetail(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1***").slice(0, 220);
}

function upstreamMessage(data) {
  const e = data?.error;
  const parts = [];
  if (typeof e === "string") parts.push(e);
  if (typeof e?.message === "string") parts.push(e.message);
  const raw = e?.metadata?.raw;
  if (typeof raw === "string") parts.push(raw);
  else if (typeof raw?.error?.message === "string") parts.push(raw.error.message);
  if (typeof data?.message === "string") parts.push(data.message);
  return cleanDetail([...new Set(parts.filter(Boolean))].join(" — "));
}

function upstreamFail(label, status, data) {
  const detail = upstreamMessage(data);
  let message, httpStatus = 502, fatal = false, globalLimit = false;
  if (status === 401 || status === 403) { message = `${label}: API key ditolak atau tidak punya akses ke model ini.`; fatal = true; }
  else if (status === 402) { message = `${label}: kredit/saldo tidak cukup untuk model ini.`; fatal = true; }
  else if (status === 404) message = `${label}: model tidak ditemukan atau sedang tidak punya endpoint aktif.`;
  else if (status === 408 || status === 504) { message = `${label}: respons terlalu lama.`; httpStatus = 504; }
  else if (status === 429) {
    httpStatus = 429;
    if (label === "OpenRouter" && /free-models-per-day/i.test(detail)) {
      message = "OpenRouter: kuota harian SEMUA model gratis habis (batas akun tanpa top-up). Reset sekitar 07:00 WIB; top up kredit ≥ $10 di OpenRouter untuk jatah 1000 pesan/hari, atau pakai model Groq/Gemini dulu.";
      fatal = true; globalLimit = true;
    } else if (label === "OpenRouter" && /free-models-per-min/i.test(detail)) {
      message = "OpenRouter: terlalu banyak permintaan ke model gratis dalam 1 menit. Tunggu sekitar semenit lalu kirim ulang.";
      globalLimit = true;
    } else if (/per[- ]day|\bRPD\b|\bTPD\b|daily/i.test(detail)) message = `${label}: kuota harian model ini sudah habis. Coba model lain atau tunggu reset.`;
    else message = `${label}: limit pemakaian model ini tercapai. Coba lagi sebentar atau ganti model.`;
  }
  else if (status >= 500) message = `${label}: server provider sedang bermasalah.`;
  else message = `${label}: permintaan ditolak (HTTP ${status}).`;
  if (detail && !fatal) message += ` (${detail})`;
  return new UpstreamError(message, { status: httpStatus, upstreamStatus: status, detail, fatal, globalLimit });
}

async function postJson(label, url, headers, body, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new UpstreamError(
      timeout ? `${label}: respons terlalu lama (lebih dari ${Math.round(timeoutMs / 1000)} detik).` : `${label}: gagal tersambung ke server provider.`,
      { status: timeout ? 504 : 502 }
    );
  }
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function makeDeadline(startedAt, total = TOTAL_BUDGET_MS) {
  return {
    left: () => total - (Date.now() - startedAt),
    timeout(cap) {
      const left = total - (Date.now() - startedAt) - 1200;
      if (left < 3000) throw new UpstreamError("Waktu proses habis sebelum model sempat menjawab. Coba lagi atau pilih model yang lebih cepat.", { status: 504 });
      return Math.min(cap, left);
    }
  };
}

/* ───────────── Provider ───────────── */

const tokenBudget = {
  groq: o => (o.wantsCode ? 8192 : o.thinkHarder ? 6144 : 4096),
  gemini: o => (o.wantsCode ? 16384 : o.thinkHarder ? 8192 : 4096),
  openrouter: o => (o.wantsCode ? 6144 : o.thinkHarder ? 5000 : 4096)
};

async function callGroq(model, messages, prompt, opts, deadline) {
  const { response, data } = await postJson("Groq", "https://api.groq.com/openai/v1/chat/completions",
    { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    {
      model,
      messages: [{ role: "system", content: prompt }, ...messages],
      max_completion_tokens: tokenBudget.groq(opts),
      temperature: opts.thinkHarder ? 0.55 : 0.7
    },
    deadline.timeout(opts.wantsCode ? 45000 : 28000));
  if (!response.ok) { console.error("Groq error:", response.status, upstreamMessage(data)); throw upstreamFail("Groq", response.status, data); }
  const reply = stripThinking(textFromOpenAIResponse(data));
  if (!reply) throw new UpstreamError("Groq: model mengembalikan jawaban kosong. Coba kirim ulang.", { status: 502 });
  return reply;
}

async function callGemini(model, messages, prompt, opts, deadline) {
  const { response, data } = await postJson("Gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {},
    {
      systemInstruction: { parts: [{ text: prompt }] },
      contents: toGeminiContents(messages),
      generationConfig: { maxOutputTokens: tokenBudget.gemini(opts) }
    },
    deadline.timeout(opts.wantsCode ? 50000 : 28000));
  if (!response.ok) { console.error("Gemini error:", response.status, upstreamMessage(data)); throw upstreamFail("Gemini", response.status, data); }
  if (data?.promptFeedback?.blockReason) {
    throw new UpstreamError(`Gemini menolak pesan ini (${data.promptFeedback.blockReason}). Coba ubah kalimatnya.`, { status: 502, fatal: true });
  }
  const reply = stripThinking((data?.candidates?.[0]?.content?.parts || []).map(p => typeof p.text === "string" ? p.text : "").join(""));
  if (!reply) {
    const why = data?.candidates?.[0]?.finishReason;
    throw new UpstreamError(`Gemini mengembalikan jawaban kosong${why ? ` (${why})` : ""}. Coba kirim ulang.`, { status: 502 });
  }
  return reply;
}

async function callOpenRouterOnce(model, messages, promptFor, opts, variant, deadline) {
  const prompt = promptFor(model);
  const body = {
    model,
    messages: variant.fold ? foldSystemIntoUser(messages, prompt) : [{ role: "system", content: prompt }, ...messages],
    max_tokens: variant.maxTokens,
    temperature: opts.thinkHarder ? 0.55 : 0.7
  };
  if (variant.reasoning) body.reasoning = { effort: opts.thinkHarder ? "medium" : "low", exclude: true };
  const { response, data } = await postJson("OpenRouter", "https://openrouter.ai/api/v1/chat/completions", {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "X-Title": "ZennNyx AI",
    ...(process.env.PUBLIC_APP_URL ? { "HTTP-Referer": process.env.PUBLIC_APP_URL } : {})
  }, body, deadline.timeout(opts.wantsCode ? 45000 : 28000));

  // OpenRouter sering membalas HTTP 200 dengan isi {error:{…}} saat provider upstream gagal.
  const embeddedError = data?.error || data?.choices?.[0]?.error;
  if (!response.ok || embeddedError) {
    const status = response.ok ? Number(embeddedError?.code) || 502 : response.status;
    const errorBody = { error: embeddedError || data?.error };
    console.error("OpenRouter error:", model, status, upstreamMessage(errorBody));
    throw upstreamFail("OpenRouter", status, errorBody);
  }
  const choice = data?.choices?.[0];
  const reply = stripThinking(textFromOpenAIResponse(data));
  if (!reply) {
    const why = choice?.finish_reason === "length" ? " (token habis dipakai untuk berpikir)" : "";
    throw new UpstreamError(`OpenRouter: model ${model.split("/").pop().replace(/:free$/, "")} mengembalikan jawaban kosong${why}.`, { status: 502 });
  }
  return reply;
}

async function callOpenRouterModel(model, messages, promptFor, opts, deadline) {
  let variant = { fold: /gemma/i.test(model), reasoning: true, maxTokens: tokenBudget.openrouter(opts) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callOpenRouterOnce(model, messages, promptFor, opts, variant, deadline);
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.upstreamStatus !== 400 || attempt === 2) throw error;
      const detail = error.detail || "";
      if (!variant.fold && /developer instruction|system (instruction|prompt|message|role)|instruction is not enabled|role/i.test(detail)) {
        variant = { ...variant, fold: true };
      } else if (variant.reasoning || variant.maxTokens > 4096) {
        variant = { ...variant, reasoning: false, maxTokens: Math.min(variant.maxTokens, 4096) };
      } else throw error;
    }
  }
  throw new UpstreamError("OpenRouter: gagal memproses permintaan.", { status: 502 });
}

// Model gratis sering penuh/offline. Kalau gagal, coba otomatis sampai 2 model gratis lain.
async function callOpenRouterWithFallback(choiceModel, messages, promptFor, opts, deadline, hasImage) {
  const tried = [];
  let model = choiceModel, firstError = null;
  for (let n = 0; n < 3; n++) {
    try {
      const reply = await callOpenRouterModel(model, messages, promptFor, opts, deadline);
      return { reply, model, fallbackFrom: n > 0 ? choiceModel : undefined };
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      if (!firstError) firstError = error;
      tried.push(model);
      // Masalah yang berlaku untuk SEMUA model (key salah, kuota harian habis, waktu habis): jangan lanjut mencoba.
      if (error.fatal || error.globalLimit || deadline.left() < 9000) throw error;
      const next = (await pickFallbackModels(tried, { needVision: hasImage, limit: 1 }))[0];
      if (!next) throw firstError;
      model = next;
    }
  }
  firstError.message += ` Cadangan otomatis (${tried.length - 1} model gratis lain) juga gagal.`;
  throw firstError;
}

/* ───────────── Handler ───────────── */

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

  const startedAt = Date.now();
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
    if (!isFreeId(chosenModel)) return res.status(400).json({ error: "Untuk menjaga biaya tetap aman, ZennNyx hanya mengizinkan model OpenRouter bertanda free." });
    if (isNonChatModel(chosenModel)) return res.status(400).json({ error: "Model ini bukan model chat (khusus moderasi/embedding). Pilih model lain." });
    if (hasImage) {
      const info = (await getFreeChatModels()).find(m => m.id === chosenModel);
      if (info && !info.vision) return res.status(400).json({ error: "Model ini tidak bisa membaca gambar. Pilih model yang bertanda \"Bisa menerima gambar\"." });
    }
  } else {
    return res.status(400).json({ error: "Provider model tidak dikenal." });
  }

  // Jatah dipotong sebelum search/provider dipanggil, supaya request over-limit tidak memakai kredit API.
  const quotaResult = takeDailyQuota(req, res);
  if (!quotaResult.ok) return res.status(quotaResult.status).json({ error: quotaResult.error, quota: quotaResult.quota, rejected: true });

  const thinkHarder = body.thinkHarder === true;
  const searchMode = ["on", "off"].includes(body.webSearch) ? body.webSearch : "auto";
  const userQuery = extractCurrentUserText(messages);
  const prevHadWebsite = messages.some(m => m.role === "assistant" && typeof m.content === "string" && /```\s*html/i.test(m.content));
  const wantsCode = prevHadWebsite || /\b(buat|bikin|buatkan|buatin|build|create|website|web app|landing page|html|css|javascript|react|komponen|preview|pratinjau|aplikasi)\b/i.test(userQuery);
  const opts = { thinkHarder, wantsCode };
  const wantsWeb = shouldSearchWeb(userQuery, { mode: searchMode, hasImage });

  try {
    const currentDate = currentDateJakarta();
    const webResult = wantsWeb ? await searchWeb(buildSearchQuery(messages)) : { used: false, sources: [] };
    const promptFor = model => systemPrompt({ thinkHarder, currentDate, webSources: webResult.sources, wantsWeb, wantsCode }) + modelIdentity(model);
    const deadline = makeDeadline(startedAt);

    let reply = "", usedModel = chosenModel, fallbackFrom;
    if (choice.provider === "groq") reply = await callGroq(chosenModel, messages, promptFor(chosenModel), opts, deadline);
    else if (choice.provider === "gemini") reply = await callGemini(chosenModel, messages, promptFor(chosenModel), opts, deadline);
    else ({ reply, model: usedModel, fallbackFrom } = await callOpenRouterWithFallback(chosenModel, messages, promptFor, opts, deadline, hasImage));

    return res.status(200).json({
      reply: String(reply).trim(),
      provider: choice.provider,
      model: usedModel,
      fallbackFrom,
      thinkHarder,
      hasImage,
      sources: webResult.sources,
      webSearched: webResult.used,
      searchError: wantsWeb && !webResult.used ? webResult.error || "Pencarian web tidak menghasilkan sumber." : undefined,
      quota: quotaResult.quota,
      projectHint: wantsCode
    });
  } catch (error) {
    const known = error instanceof UpstreamError;
    if (!known) console.error("chat handler failed:", error);
    const quota = refundQuota(res, quotaResult.before);
    return res.status(known ? Number(error.status) || 502 : 500).json({
      error: known ? error.message : "Ada kendala di server saat menghubungi model AI. Coba kirim ulang.",
      quota,
      refunded: true
    });
  }
}
