import { createHmac, timingSafeEqual } from "node:crypto";
import { getFreeChatModels, isFreeId, isNonChatModel } from "../lib/openrouter.js";
import { GROQ_MODELS, GEMINI_MODELS, listAvailableModels } from "../lib/models.js";

const DAILY_LIMIT = 20;
const COOLDOWN_MS = 5000;
const BURST_WINDOW_MS = 60 * 1000;
const BURST_LIMIT = 3;
const BURST_COOLDOWN_MS = 10 * 1000;
const TOTAL_BUDGET_MS = 55 * 1000; // vercel.json: maxDuration 60

const MAX_ATTEMPTS = 4; // model pertama + sampai 3 cadangan otomatis (lintas provider)
const GROQ_ALLOWED = new Set(GROQ_MODELS.map(m => m.id));
const GEMINI_ALLOWED = new Set(GEMINI_MODELS.map(m => m.id));

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

// Pertanyaan lanjutan ("kira-kira lagunya kayak gimana sih") tidak menyebut topiknya, jadi kueri pencarian harus
// membawa pertanyaan sebelumnya. Dulu hanya dilakukan kalau pesan < 32 huruf, sehingga kalimat lanjutan yang
// agak panjang dicari tanpa konteks dan hasilnya melenceng ke topik lain.
const ANAPHORA = /(nya\b|\b(itu|ini|tadi|tersebut|dia|mereka|lanjut|kira-kira|lagi|juga|selain|gimana|bagaimana)\b|\b(that|it|this|they|them|those)\b)/i;
function isSelfContained(text) { return text.split(/\s+/).length >= 4 && !ANAPHORA.test(text); }

function buildSearchQuery(messages) {
  const users = messages.filter(m => m?.role === "user").map(userText).filter(Boolean);
  const current = users[users.length - 1] || "";
  if (!current) return "";
  if (users.length < 2 || isSelfContained(current)) return current.slice(0, 380);
  const context = [];
  for (let i = users.length - 2; i >= 0 && context.length < 2; i--) {
    context.unshift(users[i].slice(0, 140));
    if (isSelfContained(users[i])) break; // sudah cukup jelas topiknya
  }
  return `${context.join(" ")} ${current}`.slice(0, 380);
}

const EXPLICIT_SEARCH = /\b(cari(?:kan|in|\s?tau|\s?tahu)?|search|googling|google|browsing|telusuri|cek (?:di )?(?:web|internet|google)|(?:di|dari|lewat) (?:internet|web|google)|web search|kasih (?:sumber|link|referensi)|sertakan (?:sumber|link|referensi)|pakai sumber)\b/i;
const CHITCHAT = /^(hai|halo|hallo|hello|hi|hey|ok|oke|okay|sip|mantap|thanks|thank you|makasih|terima kasih|wkwk\w*|haha\w*|lol|yo|test|tes|lanjut|lanjutkan|siapa kamu|kamu siapa|who are you|what are you)\b[!.,? ]*$/i;
const OFFLINE_TASK = /\b(bikin|buatkan|buatin|buat|tuliskan|tulis|rewrite|parafrase|ringkas|rangkum|terjemahkan|translate|debug|perbaiki|fix|refactor|optimasi|javascript|typescript|html|css|python|kode|code|script|regex|sql|website|landing page|puisi|cerita|caption|hitung|selesaikan|kerjakan|integral|turunan|persamaan|rumus|solve|simplify|factor|ubah|convert)\b/i;
const FRESH_SIGNAL = /\b(sekarang|saat ini|hari ini|kemarin|besok|terbaru|terkini|latest|today|yesterday|tomorrow|current|2025|2026|2027|update|berita|news|jadwal|schedule|score|skor|ranking|peringkat|harga|price|biaya|tarif|promo|diskon|stok|stock|rilis|release|cuaca|weather|kurs|nilai tukar)\b/i;
const CURRENT_INTENT = /\b(beli|buy|terbaik|best|rekomendasi|recommended|spesifikasi|spec|versi terbaru|official|resmi|lokasi|alamat|buka sekarang|hp|smartphone|iphone|samsung|xiaomi|redmi|poco|oppo|vivo|realme|tecno|infinix|laptop|tablet|film|game|produk|presiden|menteri|gubernur|ceo|juara|pemenang|skor)\b/i;
const QUESTION = /\b(apa itu|apa arti|apakah|apa|siapa|kapan|di ?mana|dimana|berapa|mengapa|kenapa|bagaimana|gimana|jelaskan|jelasin|what|who|when|where|why|which|how)\b/i;

// mode: "auto" (default) | "on" (selalu cari) | "off"
function shouldSearchWeb(query, { mode = "auto", hasImage = false, isFollowUp = false } = {}) {
  const q = String(query || "").toLowerCase().trim();
  if (!q || mode === "off") return false;
  if (CHITCHAT.test(q)) return false;
  if (mode === "on") return true;
  if (EXPLICIT_SEARCH.test(q)) return true;
  if (hasImage) return false;
  if (OFFLINE_TASK.test(q)) return FRESH_SIGNAL.test(q);
  if (FRESH_SIGNAL.test(q)) return true;
  // Lanjutan berupa CERITA/PENDAPAT (bukan pertanyaan) mis. "di Douyin aku liat ada orang juara terus dibelikan iQOO 15":
  // kata seperti "hp"/"juara" tidak boleh memicu pencarian, karena hasil web yang melenceng malah mengacaukan jawaban.
  const isQuestion = /\?/.test(q) || QUESTION.test(q);
  if (isFollowUp && !isQuestion) return false;
  return CURRENT_INTENT.test(q) || isQuestion;
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

/* ───────────── Kesinambungan percakapan antar model ───────────── */

// Model bisa berganti di tengah percakapan (mode Otomatis / auto-switch), dan model kecil gampang menebak maksud pesan
// lanjutan yang pendek lalu menjawab dengan skenario generik. Blok ini memberi SEMUA model pegangan yang sama:
// topik awal, pesan user sebelumnya, ringkasan jawaban terakhir, dan aturan menanggapi detail spesifik user.
function clip(text, n) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function assistantText(message) {
  return message?.role === "assistant" && typeof message.content === "string"
    ? message.content.replace(/\n\n\[Sumber web dari jawaban sebelumnya[\s\S]*$/, "")
    : "";
}

function buildContinuity(messages) {
  const users = messages.filter(m => m.role === "user").map(userText).filter(Boolean);
  if (users.length < 2) return { isFollowUp: false, prompt: "" };
  const assistants = messages.map(assistantText).filter(Boolean);
  const lastAssistant = assistants[assistants.length - 1] || "";
  const current = users[users.length - 1];
  const previous = users[users.length - 2];
  const first = users[0];
  const lines = [
    "\n\nKESINAMBUNGAN PERCAKAPAN (penting):",
    "Ini LANJUTAN percakapan yang sudah berjalan; jawaban sebelumnya mungkin ditulis oleh model AI lain. Kamu meneruskan percakapan yang SAMA, bukan memulai baru.",
    `- Topik awal user: "${clip(first, 160)}"`
  ];
  if (previous !== first) lines.push(`- Pesan user sebelumnya: "${clip(previous, 160)}"`);
  if (lastAssistant) lines.push(`- Inti jawaban terakhir (dari asisten): "${clip(lastAssistant, 280)}"`);
  lines.push(
    `- Pesan user sekarang: "${clip(current, 260)}"`,
    "Aturan: (1) Anggap pesan sekarang sebagai respons langsung atas jawaban terakhir dan topik di atas, termasuk kalau berupa cerita, pendapat, atau pesan pendek tanpa tanda tanya. (2) Tanggapi detail SPESIFIK yang user sebut persis apa adanya (nama platform, tempat, nama orang, produk, angka). Jangan menggantinya dengan skenario generik yang tidak user sebut, misalnya \"teman atau saudara\" atau \"seseorang\". (3) Jangan mengubah sudut pandang: kalau user menceritakan apa yang ia LIHAT/DENGAR dari orang lain, tanggapi ceritanya itu, bukan berasumsi user sendiri yang mengalaminya. (4) Sambungkan ke topik awal, jangan mulai topik baru. (5) Kalau maksud pesan benar-benar ambigu, tafsirkan dengan wajar lalu tanggapi; jangan mengarang cerita."
  );
  return { isFollowUp: true, prompt: lines.join("\n") };
}

/* ───────────── Prompt ───────────── */

function systemPrompt({ thinkHarder, currentDate, webSources, wantsWeb, wantsCode, continuity = "" }) {
  const tone = `Kamu adalah ZennNyx AI, asisten personal yang cerdas dan enak diajak ngobrol. Balas dengan bahasa yang dipakai user. Kalau user ngobrol dalam bahasa Indonesia, pakai bahasa Indonesia sehari-hari yang natural dan santai, lebih mirip teman ngobrol daripada customer service. Ikuti gaya "gue/lu" jika user memakai gaya itu; hindari "saya/Anda" dan bahasa kantor yang kaku kecuali user minta formal. Jangan memaksakan slang di setiap kalimat. Jaga jawaban tetap jelas, jujur, dan berguna. Tanggal saat ini di WIB: ${currentDate}. Gunakan Markdown dengan benar.

MATEMATIKA: tulis rumus dengan LaTeX. Inline: \\( ... \\). Rumus blok: \\[ ... \\]. Beberapa langkah yang sejajar ditaruh dalam SATU blok: \\[ \\begin{aligned} x_1 &= ... \\\\ x_2 &= ... \\end{aligned} \\]. Jangan pernah menaruh format Markdown (** _ \`) di dalam rumus; pakai x_1 atau x_{1} untuk subskrip. Jangan pakai tanda $ untuk rumus (bentrok dengan tanda uang). Jangan menulis perintah LaTeX seperti \\times atau \\frac sebagai teks polos di luar delimiter.

Jangan mengarang sumber atau mengaku melakukan pencarian jika tidak ada hasil web saat ini. Jangan membuka chain-of-thought privat; berikan jawaban dan alasan ringkas yang berguna.`;
  const coding = wantsCode ? `\n\nMODE PEMBUATAN KODE: User mungkin meminta aplikasi atau website. Berikan kode yang lengkap dan benar-benar bisa dijalankan, bukan pseudo-code. Untuk website, utamakan SATU blok \`\`\`html berisi file HTML mandiri (CSS di <style>, JavaScript di <script>) karena hasilnya langsung ditampilkan sebagai pratinjau layar penuh. Jangan memecah jadi banyak file kecuali user memintanya. Kode HARUS lengkap sampai </html> dan tidak boleh terpotong: kalau fiturnya banyak, tulis ringkas dan efisien supaya muat. Wajib responsive (mobile dulu) dengan <meta name="viewport">, tidak bergantung pada file lokal; CDN publik boleh bila perlu. Jangan menulis placeholder untuk bagian inti. Jika user hanya bertanya atau ngobrol (bukan meminta perubahan kode), jawab biasa tanpa menulis ulang seluruh kode. Penjelasan setelah kode cukup singkat.` : "";
  const thinking = thinkHarder ? `\n\nMODE THINK HARDER: Analisis kebutuhan dengan cermat dan jawab lebih mendalam serta terstruktur, tetapi tetap gunakan gaya bahasa santai yang sesuai user. Jangan bertele-tele tanpa manfaat.` : "";
  const web = webSources.length
    ? `\n\nPENCARIAN WEB UNTUK PERTANYAAN TERAKHIR INI:\nGunakan sumber di bawah sebagai bukti untuk klaim faktual/aktual. Sumber ini hanya milik pertanyaan TERAKHIR, bukan seluruh percakapan. Jangan gunakan kembali sumber lama sebagai sumber pertanyaan baru. Beri penanda [1], [2], dst hanya untuk sumber yang tersedia di bawah. Bila tidak mendukung sebuah klaim, akui belum terverifikasi. Jika hasil pencarian tampak tidak berkaitan dengan topik percakapan sebelumnya (mis. judul atau nama yang berbeda), abaikan hasil itu, tetap lanjutkan topik yang sedang dibahas, dan katakan jujur bila infonya belum ditemukan.\n\n${formatSearchContext(webSources)}`
    : wantsWeb ? "\n\nUser membutuhkan fakta yang mungkin aktual, tetapi pencarian web tidak menghasilkan sumber. Jangan berpura-pura sudah mencari; jelaskan keterbatasan/ketidakpastian." : "";
  return tone + continuity + coding + thinking + web;
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
    deadline.timeout(opts.attemptCap));
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
    deadline.timeout(opts.attemptCap));
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
  }, body, deadline.timeout(opts.attemptCap));

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

/* ───────────── Kelancaran model + pemilihan otomatis ───────────── */

const HEALTH_WINDOW_MS = 15 * 60 * 1000;
const serverHealth = globalThis.__zennnyxHealth || new Map();
globalThis.__zennnyxHealth = serverHealth;

const num = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));

// Catatan kelancaran dari browser (localStorage) ikut dipakai karena instance serverless sering "lupa" memori.
function sanitizeClientHealth(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, v] of Object.entries(raw).slice(0, 60)) {
    if (!/^(groq|gemini|openrouter)::[\w.:/-]{1,140}$/.test(key) || !v || typeof v !== "object") continue;
    out[key] = { streak: num(v.streak, 0, 10), lastFailAt: num(v.lastFailAt, 0, Date.now()), ms: num(v.ms, 0, 60000), ok: num(v.ok, 0, 1000) };
  }
  return out;
}

function recordHealth(value, ok, ms) {
  const h = serverHealth.get(value) || { streak: 0, lastFailAt: 0, ms: 0, ok: 0 };
  if (ok) { h.streak = 0; h.ok = Math.min(1000, h.ok + 1); h.ms = h.ms ? h.ms * 0.6 + ms * 0.4 : ms; }
  else { h.streak = Math.min(10, h.streak + 1); h.lastFailAt = Date.now(); }
  serverHealth.set(value, h);
}

// Makin tinggi makin diutamakan: nilai awal - hukuman gagal (memudar 15 menit) - hukuman lambat + bonus sering sukses.
function scoreModel(model, clientHealth) {
  const h = clientHealth[model.value] || serverHealth.get(model.value);
  let score = model.prior || 50;
  if (h) {
    const age = Date.now() - (h.lastFailAt || 0);
    if (h.streak && age < HEALTH_WINDOW_MS) score -= Math.min(70, h.streak * 28) * (1 - age / HEALTH_WINDOW_MS);
    if (h.ms) score -= Math.min(25, h.ms / 400);
    if (h.ok) score += Math.min(4, h.ok * 0.4);
  }
  return score;
}

// Urutan percobaan: pilihan user (kalau bukan "auto") dulu, lalu semua model lain dari yang paling lancar.
// Model "lengket": di mode Otomatis, model yang menjawab giliran sebelumnya dipakai lagi selama masih sehat, supaya gaya,
// pemahaman konteks, dan nada jawaban tidak berubah-ubah tiap pesan. Kalau baru gagal, ranking biasa yang menentukan.
function isRecentlyFailing(model, clientHealth) {
  const h = clientHealth[model.value] || serverHealth.get(model.value);
  return Boolean(h && h.streak && Date.now() - (h.lastFailAt || 0) < HEALTH_WINDOW_MS);
}

function buildChain(choice, available, hasImage, clientHealth, stickyValue = "") {
  const usable = available.filter(m => !hasImage || m.vision);
  const ranked = [...usable].sort((a, b) => scoreModel(b, clientHealth) - scoreModel(a, clientHealth));
  const chain = [];
  if (choice.provider === "auto" && stickyValue) {
    const sticky = usable.find(m => m.value === stickyValue);
    if (sticky && !isRecentlyFailing(sticky, clientHealth)) chain.push(sticky);
  }
  if (choice.provider !== "auto") {
    const value = `${choice.provider}::${choice.model}`;
    const known = available.find(m => m.value === value) || { provider: choice.provider, id: choice.model, value, vision: false, prior: 50 };
    if (!hasImage || known.vision) chain.push(known);
  }
  for (const m of ranked) if (!chain.some(c => c.value === m.value)) chain.push(m);
  return chain;
}

function callCandidate(model, messages, promptFor, opts, deadline) {
  if (model.provider === "groq") return callGroq(model.id, messages, promptFor(model.id), opts, deadline);
  if (model.provider === "gemini") return callGemini(model.id, messages, promptFor(model.id), opts, deadline);
  return callOpenRouterModel(model.id, messages, promptFor, opts, deadline);
}

// Coba model satu per satu. Error APAPUN (limit, 5xx, timeout, kosong, key salah di satu provider) = lanjut ke model berikutnya.
async function runWithAutoSwitch(chain, messages, promptFor, opts, deadline) {
  const attempts = [];
  const skipProviders = new Set();
  let firstError = null;
  for (const model of chain) {
    if (attempts.length >= MAX_ATTEMPTS) break;
    if (skipProviders.has(model.provider)) continue;
    if (attempts.length && deadline.left() < 7000) break;
    const n = attempts.length;
    opts.attemptCap = opts.wantsCode ? [44000, 22000, 18000, 18000][n] : [20000, 14000, 12000, 12000][n];
    const t0 = Date.now();
    try {
      const reply = await callCandidate(model, messages, promptFor, opts, deadline);
      const ms = Date.now() - t0;
      recordHealth(model.value, true, ms);
      attempts.push({ value: model.value, ok: true, ms });
      return { reply, model, attempts };
    } catch (raw) {
      const error = raw instanceof UpstreamError ? raw : new UpstreamError("Kesalahan tak terduga saat memanggil model.", { status: 500 });
      if (!(raw instanceof UpstreamError)) console.error("model call crashed:", model.value, raw);
      recordHealth(model.value, false, Date.now() - t0);
      attempts.push({ value: model.value, ok: false, ms: Date.now() - t0 });
      if (!firstError) firstError = error;
      if (error.fatal || error.globalLimit) skipProviders.add(model.provider); // key salah / kuota provider habis: provider lain masih boleh
    }
  }
  const err = firstError || new UpstreamError("Tidak ada model aktif yang cocok untuk permintaan ini (mis. butuh model yang bisa membaca gambar).", { status: 503 });
  if (attempts.length > 1) err.message += ` Sudah otomatis mencoba ${attempts.length} model, semuanya gagal.`;
  err.attempts = attempts;
  throw err;
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

  const choice = parseChoice(body.modelChoice || "auto::auto");
  if (!choice) return res.status(400).json({ error: "Pilihan model tidak valid." });

  const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p?.type === "image_url"));
  const available = await listAvailableModels();
  if (!available.length) return res.status(503).json({ error: "Belum ada API key model yang dipasang di Vercel (GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY)." });
  const chosenModel = choice.model;
  if (choice.provider === "auto") {
    // Server memilih sendiri model paling lancar.
  } else if (choice.provider === "groq") {
    if (!GROQ_ALLOWED.has(chosenModel)) return res.status(400).json({ error: "Model Groq tidak diizinkan." });
  } else if (choice.provider === "gemini") {
    if (!GEMINI_ALLOWED.has(chosenModel)) return res.status(400).json({ error: "Model Gemini tidak diizinkan." });
  } else if (choice.provider === "openrouter") {
    if (!isFreeId(chosenModel)) return res.status(400).json({ error: "Untuk menjaga biaya tetap aman, ZennNyx hanya mengizinkan model OpenRouter bertanda free." });
    if (isNonChatModel(chosenModel)) return res.status(400).json({ error: "Model ini bukan model chat (khusus moderasi/embedding). Pilih model lain." });
  } else {
    return res.status(400).json({ error: "Provider model tidak dikenal." });
  }
  const clientHealth = sanitizeClientHealth(body.health);
  const stickyValue = typeof body.stickyModel === "string" && /^(groq|gemini|openrouter)::[\w.:/-]{1,140}$/.test(body.stickyModel) ? body.stickyModel : "";
  const chain = buildChain(choice, available, hasImage, clientHealth, stickyValue);
  if (!chain.length) return res.status(400).json({ error: "Tidak ada model aktif yang bisa membaca gambar. Kirim tanpa gambar atau pasang API key Gemini/Groq." });

  // Jatah dipotong sebelum search/provider dipanggil, supaya request over-limit tidak memakai kredit API.
  const quotaResult = takeDailyQuota(req, res);
  if (!quotaResult.ok) return res.status(quotaResult.status).json({ error: quotaResult.error, quota: quotaResult.quota, rejected: true });

  const thinkHarder = body.thinkHarder === true;
  const searchMode = ["on", "off"].includes(body.webSearch) ? body.webSearch : "auto";
  const userQuery = extractCurrentUserText(messages);
  const prevHadWebsite = messages.some(m => m.role === "assistant" && typeof m.content === "string" && /```\s*html/i.test(m.content));
  const wantsCode = prevHadWebsite || /\b(buat|bikin|buatkan|buatin|build|create|website|web app|landing page|html|css|javascript|react|komponen|preview|pratinjau|aplikasi)\b/i.test(userQuery);
  const opts = { thinkHarder, wantsCode };
  const continuity = buildContinuity(messages);
  const wantsWeb = shouldSearchWeb(userQuery, { mode: searchMode, hasImage, isFollowUp: continuity.isFollowUp });

  try {
    const currentDate = currentDateJakarta();
    const webResult = wantsWeb ? await searchWeb(buildSearchQuery(messages)) : { used: false, sources: [] };
    const promptFor = model => systemPrompt({ thinkHarder, currentDate, webSources: webResult.sources, wantsWeb, wantsCode, continuity: continuity.prompt }) + modelIdentity(model);
    const deadline = makeDeadline(startedAt);

    const { reply, model: used, attempts } = await runWithAutoSwitch(chain, messages, promptFor, opts, deadline);
    const failedFirst = attempts[0] && !attempts[0].ok ? chain.find(m => m.value === attempts[0].value) : null;

    return res.status(200).json({
      reply: String(reply).trim(),
      provider: used.provider,
      model: used.id,
      fallbackFrom: failedFirst ? failedFirst.id : undefined,
      attempts,
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
      attempts: known ? error.attempts : undefined,
      quota,
      refunded: true
    });
  }
}
