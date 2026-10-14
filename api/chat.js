import { createHmac, timingSafeEqual } from "node:crypto";
import { streamChatCompletion, describeStall } from "../lib/stream.js";
import { TIERS, normalizeTier, PROVIDERS, providerBaseUrl, providerEnabled, anyProviderEnabled, modelsForTier, allModels, cleanKey, tiersForClient } from "../lib/models.js";

const clampInt = (v, d, min, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
// Batas pesan per hari per browser (ganti lewat env DAILY_LIMIT tanpa edit kode). UI hanya menampilkan persentase + jam reset.
const DAILY_LIMIT = clampInt(process.env.DAILY_LIMIT, 20, 1, 5000);
const COOLDOWN_MS = 2000;
const BURST_WINDOW_MS = 60 * 1000;
const BURST_LIMIT = 6;
const BURST_COOLDOWN_MS = 10 * 1000;
const TOTAL_BUDGET_MS = 55 * 1000; // vercel.json: maxDuration 60

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
    if (!decoded || decoded.v !== 1 || decoded.day !== jakartaDay() || !Number.isInteger(decoded.count) || decoded.count < 0 || decoded.count > 100000) return emptyQuota();
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
    return { ok: false, status: 429, error: "You've reached today's usage limit.", limitReached: true, quota: summary };
  }

  if (quota.blockedUntil > now) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((quota.blockedUntil - now) / 1000))));
    return { ok: false, status: 429, error: "Slow down a little, then try again in a few seconds.", quota: summary };
  }

  if (quota.lastAt && now - quota.lastAt < COOLDOWN_MS) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((COOLDOWN_MS - (now - quota.lastAt)) / 1000))));
    return { ok: false, status: 429, error: "Just a moment before the next message.", quota: summary };
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
// policy (dari tingkat Effort): "explicit" = hanya kalau user minta mencari; "fresh" = + kata yang menandakan info terbaru; "auto" = semua heuristik.
function shouldSearchWeb(query, { mode = "auto", hasImage = false, isFollowUp = false, policy = "auto" } = {}) {
  const q = String(query || "").toLowerCase().trim();
  if (!q || mode === "off") return false;
  if (CHITCHAT.test(q)) return false;
  if (mode === "on") return true;
  if (EXPLICIT_SEARCH.test(q)) return true;
  if (hasImage || policy === "explicit") return false;
  if (policy === "fresh") return FRESH_SIGNAL.test(q) && !OFFLINE_TASK.test(q);
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

async function searchWeb(query, timeoutMs = 5000) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { used: false, sources: [], error: "TAVILY_API_KEY is not set." };
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

function systemPrompt({ tier, currentDate, webSources, wantsWeb, wantsCode, continuity = "" }) {
  const tone = `Kamu adalah ZennNyx AI, asisten personal yang cerdas dan enak diajak ngobrol. Balas dengan bahasa yang dipakai user. Untuk bahasa Indonesia, pakai bahasa sehari-hari yang natural, hangat, dan tidak kaku, seperti teman yang pintar, bukan customer service. Sesuaikan cara menyapa dengan user: pakai "gue/lu" HANYA kalau user sendiri memakainya di pesannya; kalau user memakai "aku/kamu" atau tidak memakai kata ganti, pakai "aku/kamu" atau hindari kata ganti sama sekali. Jangan memaksakan slang atau kata gaul; kalau ragu, pilih gaya netral yang santai dan sopan. Hindari "saya/Anda" kecuali user meminta formal. Jaga jawaban tetap jelas, jujur, dan berguna. Tanggal saat ini di WIB: ${currentDate}. Gunakan Markdown dengan benar.

MATEMATIKA: tulis rumus dengan LaTeX. Inline: \\( ... \\). Rumus blok: \\[ ... \\]. Beberapa langkah yang sejajar ditaruh dalam SATU blok: \\[ \\begin{aligned} x_1 &= ... \\\\ x_2 &= ... \\end{aligned} \\]. Jangan pernah menaruh format Markdown (** _ \`) di dalam rumus; pakai x_1 atau x_{1} untuk subskrip. Jangan pakai tanda $ untuk rumus (bentrok dengan tanda uang). Jangan menulis perintah LaTeX seperti \\times atau \\frac sebagai teks polos di luar delimiter.

Jangan mengarang sumber atau mengaku melakukan pencarian jika tidak ada hasil web saat ini. Jangan membuka chain-of-thought privat; berikan jawaban dan alasan ringkas yang berguna.`;
  const coding = wantsCode ? `\n\nMODE PEMBUATAN KODE: User mungkin meminta aplikasi atau website. Berikan kode yang lengkap dan benar-benar bisa dijalankan, bukan pseudo-code. Untuk website, utamakan SATU blok \`\`\`html berisi file HTML mandiri (CSS di <style>, JavaScript di <script>) karena hasilnya langsung ditampilkan sebagai pratinjau layar penuh. Jangan memecah jadi banyak file kecuali user memintanya. Kode HARUS lengkap sampai </html> dan tidak boleh terpotong: kalau fiturnya banyak, tulis ringkas dan efisien supaya muat. Wajib responsive (mobile dulu) dengan <meta name="viewport">, tidak bergantung pada file lokal; CDN publik boleh bila perlu. Jangan menulis placeholder untuk bagian inti. Jika user hanya bertanya atau ngobrol (bukan meminta perubahan kode), jawab biasa tanpa menulis ulang seluruh kode. Penjelasan setelah kode cukup singkat.` : "";
  const thinking = tier === "high"
    ? `\n\nMODE TELITI: Analisis kebutuhan dengan cermat dan jawab lebih mendalam serta terstruktur, tetapi tetap gunakan gaya bahasa santai yang sesuai user. Jangan bertele-tele tanpa manfaat.`
    : wantsCode ? ""
    : tier === "fast" ? `\n\nMODE CEPAT: Jawab langsung ke intinya dan ringkas (biasanya di bawah 150 kata), tanpa pembukaan atau basa-basi. Beri detail hanya kalau user memintanya.`
    : tier === "low" ? `\n\nMODE RINGKAS: Jawab jelas dan padat, tanpa bertele-tele.`
    : "";
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
      return { role: m.role, content: m.content.slice(0, m.role === "assistant" ? 14000 : 24000) };
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      const content = m.content.filter(part => {
        if (!part || typeof part !== "object") return false;
        if (part.type === "text") return typeof part.text === "string" && part.text.length <= 24000;
        if (part.type === "image_url") return typeof part.image_url?.url === "string" && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(part.image_url.url);
        return false;
      }).slice(0, 2);
      return content.length ? { role: "user", content } : null;
    }
    return null;
  }).filter(Boolean);
}

// Beberapa model menyelipkan proses berpikir di dalam <think>…</think>; itu tidak untuk ditampilkan.
// Filter ini bekerja per potongan (streaming) dan menahan potongan tag yang terbelah di antara dua chunk.
class ThinkFilter {
  constructor() { this.buf = ""; this.close = null; }
  push(chunk) {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.close) {
        const idx = this.buf.toLowerCase().indexOf(this.close);
        if (idx < 0) { this.buf = this.buf.slice(-(this.close.length - 1)); return out; }
        this.buf = this.buf.slice(idx + this.close.length);
        this.close = null;
        continue;
      }
      const m = this.buf.match(/<(think|thinking|reasoning)>/i);
      if (m) {
        out += this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.close = `</${m[1].toLowerCase()}>`;
        continue;
      }
      // tahan ekor yang mungkin awal sebuah tag pembuka ("<thi")
      const lt = this.buf.lastIndexOf("<");
      if (lt >= 0 && this.buf.length - lt < 11 && /^<\/?[a-z]*$/i.test(this.buf.slice(lt)) && ["<think>", "<thinking>", "<reasoning>"].some(t => t.startsWith(this.buf.slice(lt).toLowerCase()))) {
        out += this.buf.slice(0, lt);
        this.buf = this.buf.slice(lt);
      } else { out += this.buf; this.buf = ""; }
      return out;
    }
  }
  flush() { const rest = this.close ? "" : this.buf; this.buf = ""; return rest; }
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
    this.fatal = fatal;           // percuma coba model lain dari provider yang sama (API key salah, kuota harian habis, dst.)
    this.globalLimit = globalLimit;
  }
}

function cleanDetail(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1***").slice(0, 220);
}

function upstreamMessage(data) {
  if (Array.isArray(data)) data = data[0]; // Gemini kadang membungkus error dalam array
  const e = data?.error;
  const parts = [];
  if (typeof e === "string") parts.push(e);
  if (typeof e?.message === "string") parts.push(e.message);
  const raw = e?.metadata?.raw;
  if (typeof raw === "string") parts.push(raw);
  else if (typeof raw?.error?.message === "string") parts.push(raw.error.message);
  if (typeof data?.message === "string") parts.push(data.message);
  if (typeof data?.detail === "string") parts.push(data.detail);
  return cleanDetail([...new Set(parts.filter(Boolean))].join(" — "));
}

function upstreamFail(label, status, data) {
  const detail = upstreamMessage(data);
  let message, httpStatus = 502, fatal = false, globalLimit = false;
  if (label === "OpenRouter" && /data policy|privacy|guardrail/i.test(detail) && (status === 404 || status === 403 || status === 400)) {
    message = "OpenRouter: this free model is blocked by your OpenRouter privacy settings. Open openrouter.ai/settings/privacy and allow free endpoints (the ones that may train on inputs), then try again.";
  }
  else if (status === 401) { message = `${label}: API key rejected. Check the key in your environment variables.`; fatal = true; }
  else if (status === 403) message = `${label}: access to this model was denied.`;
  else if (status === 402) { message = `${label}: not enough credit for this model.`; fatal = true; }
  else if (status === 410) message = `${label}: this model has been retired by the provider.`;
  else if (status === 404) message = `${label}: model not found or has no active endpoint.`;
  else if (status === 408 || status === 504) { message = `${label}: the model took too long to respond.`; httpStatus = 504; }
  else if (status === 429) {
    httpStatus = 429;
    if (label === "OpenRouter" && /free-models-per-day/i.test(detail)) {
      message = "OpenRouter: the daily limit for all free models is used up (resets around 07:00 WIB). Adding $10 of credit raises it.";
      fatal = true; globalLimit = true;
    } else if (label === "OpenRouter" && /free-models-per-min/i.test(detail)) {
      message = "OpenRouter: too many free-model requests in one minute. Wait a minute and try again.";
      globalLimit = true;
    } else message = `${label}: rate limit reached for this model.`;
  }
  else if (status >= 500) message = `${label}: the provider is having problems.`;
  else message = `${label}: request rejected (HTTP ${status}).`;
  if (detail && !fatal) message += ` (${detail})`;
  return new UpstreamError(message, { status: httpStatus, upstreamStatus: status, detail, fatal, globalLimit });
}

function makeDeadline(startedAt, total = TOTAL_BUDGET_MS) {
  return { left: () => total - (Date.now() - startedAt) };
}

/* ───────────── Pemanggilan model (streaming, OpenAI-compatible) ───────────── */

// NVIDIA NIM dan OpenRouter sama-sama OpenAI-compatible, jadi satu fungsi melayani keduanya.
async function streamModel(model, messages, prompt, ctx, hooks) {
  const cfg = PROVIDERS[model.provider];
  const headers = { Authorization: `Bearer ${cleanKey(process.env[cfg.env])}` };
  if (model.provider === "openrouter") {
    headers["X-Title"] = "ZennNyx AI";
    if (process.env.PUBLIC_APP_URL) headers["HTTP-Referer"] = process.env.PUBLIC_APP_URL;
  }
  // Model "berpikir" memakai token untuk berpikir juga, jadi beri ruang tambahan supaya jawabannya tidak kosong.
  const maxTokens = ctx.maxTokens + (model.reasoning ? 3072 : 0);
  let variant = { fold: model.provider === "openrouter" && /gemma/i.test(model.id), reasoning: model.provider === "openrouter" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = {
      model: model.id,
      messages: variant.fold ? foldSystemIntoUser(messages, prompt) : [{ role: "system", content: prompt }, ...messages],
      max_tokens: maxTokens,
      temperature: ctx.temperature
    };
    if (variant.reasoning) body.reasoning = { effort: ctx.tierId === "high" ? "medium" : "low", exclude: true };
    const r = await streamChatCompletion({
      url: `${providerBaseUrl(model.provider)}/chat/completions`, headers, body,
      firstByteMs: hooks.firstTokenMs, firstTokenMs: hooks.firstTokenMs, idleMs: 15000, totalMs: hooks.totalMs,
      signal: hooks.signal, onText: hooks.onText
    });
    if (r.errorData) {
      const status = r.status && r.status !== 200 ? r.status : 502;
      const err = upstreamFail(cfg.label, status, r.errorData);
      console.error(`${cfg.label} error:`, model.id, status, upstreamMessage(r.errorData));
      // OpenRouter: sebagian model menolak role system atau parameter reasoning -> ulangi sekali dengan penyesuaian.
      if (status === 400 && attempt < 2 && !hooks.started()) {
        if (!variant.fold && /developer instruction|system (instruction|prompt|message|role)|instruction is not enabled|role/i.test(err.detail)) { variant = { ...variant, fold: true }; continue; }
        if (variant.reasoning) { variant = { ...variant, reasoning: false }; continue; }
      }
      throw err;
    }
    return r;
  }
  throw new UpstreamError(`${cfg.label}: could not process the request.`, { status: 502 });
}

/* ───────────── Kelancaran model + urutan ───────────── */

const HEALTH_WINDOW_MS = 15 * 60 * 1000;
const serverHealth = globalThis.__zennnyxHealth || new Map();
globalThis.__zennnyxHealth = serverHealth;

const num = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));

// Catatan kelancaran dari browser (localStorage) ikut dipakai karena instance serverless sering "lupa" memori.
function sanitizeClientHealth(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, v] of Object.entries(raw).slice(0, 80)) {
    if (!/^(nvidia|openrouter|groq|gemini)::[\w.:/-]{1,140}$/.test(key) || !v || typeof v !== "object") continue;
    out[key] = { streak: num(v.streak, 0, 10), lastFailAt: num(v.lastFailAt, 0, Date.now()), ms: num(v.ms, 0, 60000), ok: num(v.ok, 0, 1000) };
  }
  return out;
}

// `ms` = waktu sampai token pertama yang terlihat (bukan total), supaya ranking benar-benar mengejar yang paling cepat mulai menjawab.
function recordHealth(value, ok, ms) {
  const h = serverHealth.get(value) || { streak: 0, lastFailAt: 0, ms: 0, ok: 0 };
  if (ok) { h.streak = 0; h.ok = Math.min(1000, h.ok + 1); h.ms = h.ms ? h.ms * 0.6 + ms * 0.4 : ms; }
  else { h.streak = Math.min(10, h.streak + 1); h.lastFailAt = Date.now(); }
  serverHealth.set(value, h);
}

function healthOf(model, clientHealth) { return clientHealth[model.value] || serverHealth.get(model.value); }
function isRecentlyFailing(model, clientHealth) {
  const h = healthOf(model, clientHealth);
  return Boolean(h && h.streak && Date.now() - (h.lastFailAt || 0) < HEALTH_WINDOW_MS);
}

// Makin tinggi makin diutamakan: nilai awal - hukuman gagal (memudar 15 menit) - hukuman lambat + bonus sering sukses.
function scoreModel(model, clientHealth, tierId) {
  const h = healthOf(model, clientHealth);
  let score = model.prior || 50;
  if (h) {
    const age = Date.now() - (h.lastFailAt || 0);
    if (h.streak && age < HEALTH_WINDOW_MS) score -= Math.min(70, h.streak * 28) * (1 - age / HEALTH_WINDOW_MS);
    if (h.ms) score -= Math.min(25, h.ms / (tierId === "fast" ? 200 : 400));
    if (h.ok) score += Math.min(4, h.ok * 0.4);
  }
  return score;
}

// "Model lengket": model yang menjawab giliran sebelumnya dipakai lagi (kalau masih sehat dan ada di tingkat ini),
// supaya gaya dan pemahaman konteks tidak berubah-ubah tiap pesan.
function buildChain(candidates, clientHealth, tierId, stickyValue = "") {
  const ranked = [...candidates].sort((a, b) => scoreModel(b, clientHealth, tierId) - scoreModel(a, clientHealth, tierId));
  const chain = [];
  const sticky = stickyValue && candidates.find(m => m.value === stickyValue);
  if (sticky && !isRecentlyFailing(sticky, clientHealth)) chain.push(sticky);
  for (const m of ranked) if (!chain.some(c => c.value === m.value)) chain.push(m);
  return chain;
}

/* ───────────── Balapan model (hedged requests) ─────────────
   Model terbaik dicoba dulu. Kalau belum ada token setelah `hedgeMs`, model berikutnya dijalankan PARALEL dan
   siapa pun yang mengeluarkan token pertama menang (yang lain dibatalkan). Model yang error langsung diganti
   tanpa menunggu. Setelah ada pemenang, token langsung dialirkan ke browser lewat `sink`. */
function raceModels({ chain, messages, promptFor, ctx, deadline, signal, sink }) {
  const tier = ctx.tier;
  return new Promise((resolve, reject) => {
    const pending = [...chain];
    const running = new Map();
    const attempts = [];
    const penalized = new Set();
    let winner = null, firstError = null, firstFailed = null, started = 0, settled = false;
    let hedgeTimer = null, deadlineTimer = null;

    const abortAll = except => { for (const h of running.values()) if (h !== except) { h.cancelled = true; h.ctrl.abort(); } };
    const cleanup = () => { clearTimeout(hedgeTimer); clearTimeout(deadlineTimer); signal?.removeEventListener("abort", onClientAbort); };
    const finish = fn => { if (settled) return; settled = true; cleanup(); abortAll(null); fn(); };
    const fail = () => finish(() => {
      const base = firstError || new UpstreamError("No model could answer right now. Try again in a moment.", { status: 503 });
      const err = new UpstreamError(attempts.length > 1 ? `${base.message} Tried ${attempts.length} models.` : base.message, { status: base.status });
      err.attempts = attempts;
      reject(err);
    });
    function onClientAbort() { finish(() => { const e = new Error("aborted"); e.aborted = true; e.attempts = attempts; reject(e); }); }
    if (signal) { if (signal.aborted) return onClientAbort(); signal.addEventListener("abort", onClientAbort, { once: true }); }

    const nextCandidate = () => {
      let i = pending.findIndex(m => !penalized.has(m.provider));
      if (i < 0) i = pending.length ? 0 : -1;
      return i < 0 ? null : pending.splice(i, 1)[0];
    };
    const launch = () => {
      if (settled || winner || started >= tier.maxAttempts) return false;
      if (started && deadline.left() < 5000) return false;
      const model = nextCandidate();
      if (!model) return false;
      started++;
      run(model);
      armHedge();
      return true;
    };
    function armHedge() {
      clearTimeout(hedgeTimer);
      if (settled || winner || ctx.pinned) return;
      hedgeTimer = setTimeout(() => {
        if (settled || winner) return;
        if (running.size < 3 && launch()) return;
        armHedge();
      }, tier.hedgeMs);
    }

    const emitVisible = (h, vis) => {
      if (!vis || settled || (winner && winner !== h)) return;
      if (!winner) {
        winner = h;
        h.ttft = Date.now() - h.t0;
        clearTimeout(hedgeTimer);
        abortAll(h);
        sink.start({ model: h.model, fallbackFrom: firstFailed?.id, fallbackReason: firstError ? String(firstError.message || "").slice(0, 300) : undefined });
      }
      h.text += vis;
      sink.delta(vis);
    };

    const onEnd = (h, r) => {
      running.delete(h.model.value);
      if (settled || h.cancelled || (winner && winner !== h)) return;
      emitVisible(h, h.filter.flush());
      if (h === winner) {
        const partial = Boolean(r.abort || r.networkError);
        recordHealth(h.model.value, true, h.ttft);
        attempts.push({ value: h.model.value, ok: true, ms: h.ttft });
        finish(() => resolve({ reply: h.text, model: h.model, attempts, truncated: partial || r.finish === "length", firstError, firstFailed }));
        return;
      }
      if (r.abort || r.networkError) return onFail(h, new UpstreamError(describeStall(PROVIDERS[h.model.provider].label, r), { status: 504 }));
      const why = r.finish === "length" ? " (token budget used up while thinking)" : "";
      onFail(h, new UpstreamError(`${PROVIDERS[h.model.provider].label}: the model returned an empty answer${why}.`, { status: 502 }));
    };

    function onFail(h, err) {
      running.delete(h.model.value);
      if (settled || h.cancelled || (winner && winner !== h)) return;
      const error = err instanceof UpstreamError ? err : new UpstreamError("Unexpected error while calling the model.", { status: 500 });
      if (!(err instanceof UpstreamError)) console.error("model call crashed:", h.model.value, err);
      if (h === winner) { // gagal di tengah jawaban: tampilkan yang sudah ada sebagai jawaban terpotong
        recordHealth(h.model.value, true, h.ttft);
        attempts.push({ value: h.model.value, ok: true, ms: h.ttft });
        finish(() => resolve({ reply: h.text, model: h.model, attempts, truncated: true, firstError, firstFailed }));
        return;
      }
      recordHealth(h.model.value, false, Date.now() - h.t0);
      attempts.push({ value: h.model.value, ok: false, ms: Date.now() - h.t0 });
      if (!firstError) { firstError = error; firstFailed = h.model; }
      if (error.status === 429) penalized.add(h.model.provider);
      if (error.fatal || error.globalLimit) for (let i = pending.length - 1; i >= 0; i--) if (pending[i].provider === h.model.provider) pending.splice(i, 1);
      if (!launch() && running.size === 0) fail();
    }

    function run(model) {
      const h = { model, ctrl: new AbortController(), t0: Date.now(), filter: new ThinkFilter(), text: "", ttft: null, cancelled: false };
      running.set(model.value, h);
      const wait = Math.min(tier.firstTokenMs, Math.max(4000, deadline.left() - 1500));
      streamModel(model, messages, promptFor(model), ctx, {
        signal: h.ctrl.signal, firstTokenMs: wait, totalMs: Math.max(5000, deadline.left() - 1200),
        started: () => h.text.length > 0,
        onText: chunk => emitVisible(h, h.filter.push(chunk))
      }).then(r => onEnd(h, r), err => onFail(h, err));
    }

    deadlineTimer = setTimeout(() => {
      if (winner) { const w = winner; finish(() => resolve({ reply: w.text, model: w.model, attempts: [...attempts, { value: w.model.value, ok: true, ms: w.ttft }], truncated: true, firstError, firstFailed })); }
      else { firstError = firstError || new UpstreamError("Ran out of time before a model answered. Try Fast or Low effort.", { status: 504 }); fail(); }
    }, Math.max(3000, deadline.left() - 800));

    if (!launch()) fail();
  });
}


/* ───────────── Handler ───────────── */

const providerFlags = () => ({ nvidia: providerEnabled("nvidia"), openrouter: providerEnabled("openrouter"), groq: providerEnabled("groq"), gemini: providerEnabled("gemini"), webSearch: Boolean(process.env.TAVILY_API_KEY) });

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const quota = readQuota(req);
    writeQuota(res, quota);
    return res.status(200).json({ quota: quotaSummary(quota), providers: providerFlags(), tiers: tiersForClient() });
  }

  const startedAt = Date.now();
  const body = req.body || {};
  const messages = normalizeMessages(body.messages);
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return res.status(400).json({ error: "A user message is required." });

  const tierId = normalizeTier(body.effort);
  const tier = TIERS[tierId];
  const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p?.type === "image_url"));
  if (!anyProviderEnabled()) return res.status(503).json({ error: "No model provider is set up yet. Add NVIDIA_API_KEY, GROQ_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY in Vercel, then redeploy." });
  const candidates = await modelsForTier(tierId, { hasImage });
  if (!candidates.length) return res.status(hasImage ? 400 : 503).json({ error: hasImage ? "None of the active models can read images. Send the message without the image." : "No models are available right now. Try again in a moment." });
  const clientHealth = sanitizeClientHealth(body.health);
  const stickyValue = typeof body.stickyModel === "string" && /^(nvidia|openrouter|groq|gemini)::[\w.:/-]{1,140}$/.test(body.stickyModel) ? body.stickyModel : "";
  let chain = buildChain(candidates, clientHealth, tierId, stickyValue);
  // Model pilihan manual: dicoba lebih dulu dan TIDAK dibalap model lain; baru kalau gagal, model lain dari tingkat ini jadi cadangan.
  const pickedValue = typeof body.model === "string" && /^(nvidia|openrouter|groq|gemini)::[\w.:/-]{1,140}$/.test(body.model) ? body.model : "";
  let pinned = false;
  if (pickedValue) {
    const picked = (await allModels({ hasImage })).find(m => m.value === pickedValue);
    if (picked) { chain = [picked, ...chain.filter(m => m.value !== pickedValue)]; pinned = true; }
  }

  // Jatah dipotong sebelum search/provider dipanggil, supaya request over-limit tidak memakai kredit API.
  const quotaResult = takeDailyQuota(req, res);
  if (!quotaResult.ok) return res.status(quotaResult.status).json({ error: quotaResult.error, quota: quotaResult.quota, rejected: true, limitReached: Boolean(quotaResult.limitReached) });

  const searchMode = ["on", "off"].includes(body.webSearch) ? body.webSearch : "auto";
  const userQuery = extractCurrentUserText(messages);
  const prevHadWebsite = messages.some(m => m.role === "assistant" && typeof m.content === "string" && /```\s*html/i.test(m.content));
  const wantsCode = prevHadWebsite || /\b(buat|bikin|buatkan|buatin|build|create|website|web app|landing page|html|css|javascript|react|komponen|preview|pratinjau|aplikasi)\b/i.test(userQuery);
  const continuity = buildContinuity(messages);
  const wantsWeb = shouldSearchWeb(userQuery, { mode: searchMode, hasImage, isFollowUp: continuity.isFollowUp, policy: tier.search });
  const ctx = { tier, tierId, pinned, wantsCode, maxTokens: wantsCode ? tier.codeTokens : tier.maxTokens, temperature: tier.temperature };

  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); }); // browser menekan Stop / tab ditutup: hentikan request ke provider
  let streaming = false;
  const sse = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  };

  try {
    const currentDate = currentDateJakarta();
    const webResult = wantsWeb ? await searchWeb(buildSearchQuery(messages)) : { used: false, sources: [] };
    const promptFor = model => systemPrompt({ tier: tierId, currentDate, webSources: webResult.sources, wantsWeb, wantsCode, continuity: continuity.prompt }) + modelIdentity(model.id);
    const deadline = makeDeadline(startedAt);

    // Header SSE baru dikirim setelah token pertama ada, jadi kegagalan sebelum itu masih bisa dibalas JSON biasa dan jatah dikembalikan.
    const sink = {
      start({ model, fallbackFrom, fallbackReason }) {
        streaming = true;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, no-transform");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        sse("start", {
          provider: model.provider, model: model.id, name: model.name, tier: tierId, fallbackFrom, fallbackReason,
          sources: webResult.sources, webSearched: webResult.used,
          searchError: wantsWeb && !webResult.used ? webResult.error || "Web search returned no sources." : undefined,
          quota: quotaResult.quota, projectHint: wantsCode, hasImage
        });
      },
      delta(t) { sse("delta", { t }); }
    };

    const result = await raceModels({ chain, messages, promptFor, ctx, deadline, signal: ac.signal, sink });
    sse("done", { attempts: result.attempts, truncated: Boolean(result.truncated), elapsedMs: Date.now() - startedAt });
    return res.end();
  } catch (error) {
    if (error?.aborted) { try { if (!res.writableEnded) res.end(); } catch {} return; }
    const known = error instanceof UpstreamError;
    if (!known) console.error("chat handler failed:", error);
    const message = known ? error.message : "Something went wrong on the server while contacting the model. Try again.";
    if (streaming) { sse("error", { error: message }); return res.end(); }
    const quota = refundQuota(res, quotaResult.before);
    return res.status(known ? Number(error.status) || 502 : 500).json({ error: message, attempts: known ? error.attempts : undefined, quota, refunded: true });
  }
}

