/* ZennNyx AI v10 — client. Markdown/LaTeX renderer ada di markdown.js (dimuat lebih dulu). */
"use strict";
const $ = id => document.getElementById(id);
const chat = $("chat"), scroller = $("scroller"), input = $("input"), composer = $("composer"), actionBtn = $("actionBtn");
const previewFrame = $("previewFrame"), sidebar = $("sidebar"), scrim = $("scrim");

/* ───────────── Konfigurasi & state ───────────── */
const EFFORTS = [
  { id: "fast", label: "Fast", desc: "Quickest replies for simple questions" },
  { id: "low", label: "Low", desc: "Snappy and light for everyday chat" },
  { id: "medium", label: "Medium", desc: "Balanced speed and quality", recommended: true },
  { id: "high", label: "High", desc: "Most thorough, takes longer" }
];
const KEYS = { model: "zennnyx_model_pick_v1", effort: "zennnyx_effort_v1", web: "zennnyx_web_v1", chats: "zennnyx_chats_v1", intro: "zennnyx_intro_seen_v1", health: "zennnyx_model_health_v1", debug: "zennnyx_debug" };
const DEBUG_UI = (() => { try { const q = new URLSearchParams(location.search).get("debug"); if (q === "1") localStorage.setItem(KEYS.debug, "1"); if (q === "0") localStorage.removeItem(KEYS.debug); return localStorage.getItem(KEYS.debug) === "1"; } catch { return false; } })();
const store = {
  get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
};

let messages = [];            // riwayat untuk API: {role, content, sources?, display?, fileName?, hadImage?, model?}
let chatId = null;
let effort = EFFORTS.some(e => e.id === store.get(KEYS.effort)) ? store.get(KEYS.effort) : "medium";
let modelPick = store.get(KEYS.model, "auto") || "auto";   // "auto" atau "provider::id"
let modelList = [];
let webOn = store.get(KEYS.web, "1") !== "0";
let webAvailable = true;
let busy = false, abortCtl = null, lastUserRow = null, lastUsedModel = "";
let pendingImage = null, pendingFile = null;
let activeProject = null;
let quota = { limit: 20, used: 0, resetAt: 0 };
let stick = true, toastTimer = null, recognition = null, recording = false;

const icons = {
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 16V5a2 2 0 0 1 2-2h9"/></svg>',
  like: '<svg viewBox="0 0 24 24"><path d="M7 10v11H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3Z"/><path d="M7 21h9.5a2 2 0 0 0 1.9-1.4l2.2-6.5A2 2 0 0 0 18.7 10H14l.7-4.1A3.3 3.3 0 0 0 11.5 2L7 10Z"/></svg>',
  dislike: '<svg viewBox="0 0 24 24"><path d="M7 14V3H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3Z"/><path d="M7 3h9.5a2 2 0 0 1 1.9 1.4l2.2 6.5A2 2 0 0 1 18.7 14H14l.7 4.1A3.3 3.3 0 0 1 11.5 22L7 14Z"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1L11 5"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 7 20l1.1-1.1"/></svg>',
  preview: '<svg viewBox="0 0 24 24"><rect x="2.5" y="3.5" width="19" height="17" rx="3"/><path d="M2.5 8h19"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
};

/* ───────────── Kelancaran model (dikirim ke server untuk memilih urutan) ───────────── */
function readHealth() { try { const r = JSON.parse(store.get(KEYS.health, "{}")); return r && typeof r === "object" ? r : {}; } catch { return {}; } }
function noteAttempts(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return;
  const health = readHealth();
  for (const a of attempts) {
    if (!a || typeof a.value !== "string") continue;
    const h = health[a.value] || { streak: 0, lastFailAt: 0, ms: 0, ok: 0 };
    if (a.ok) { h.streak = 0; h.ok = Math.min(1000, (h.ok || 0) + 1); h.ms = h.ms ? Math.round(h.ms * 0.6 + a.ms * 0.4) : a.ms; }
    else { h.streak = Math.min(10, (h.streak || 0) + 1); h.lastFailAt = Date.now(); }
    health[a.value] = h;
  }
  store.set(KEYS.health, JSON.stringify(health));
}

function stripToolCitations(text) {
  return String(text)
    .replace(/[ \t]*(?:【[^】\n]{1,40}】)+[ \t]*(?=[.,;:!?)])/g,"")
    .replace(/[ \t]*(?:【[^】\n]{1,40}】)+/g,"");
}
function resolveReferenceLinks(text,sources=[]) {
  const defs=new Map();
  let out=String(text).replace(/^[ \t]*\[([^\]\n]{1,60})\]:[ \t]*<?(https?:\/\/[^\s>]+)>?(?:[ \t]+["(][^\n]*)?[ \t]*$/gim,(m,label,url)=>{defs.set(label.trim().toLowerCase(),url);return "";});
  if(defs.size){
    out=out.replace(/\[([^\]\n]{1,80})\]\[([^\]\n]{0,60})\]/g,(m,t,label)=>{if(/^\d{1,2}$/.test(t.trim()))return m; // "[2][3]" = dua sitasi berurutan, bukan tautan
      const url=defs.get((label||t).trim().toLowerCase());return url?`[${t}](${url})`:m;});
    out=out.replace(/\[([^\]\n]{1,60})\](?![(\[:])/g,(m,label)=>{
      if(/^\d{1,2}$/.test(label))return m; // [1] = sitasi, dibuang di langkah berikutnya
      const url=defs.get(label.trim().toLowerCase());return url?`[${label}](${url})`:m;
    });
  }
  // "[link Spotify]" tanpa alamat apa pun: cocokkan nama situs ke daftar sumber hasil pencarian.
  if(sources.length)out=out.replace(/\[((?:link|tautan|buka|lihat)[^\]\n]{0,40})\](?![(\[:])/gi,(m,label)=>{
    const low=label.toLowerCase();
    const hit=sources.find(src=>(src.domain||domainOf(src.url)).split(".").some(part=>part.length>3&&low.includes(part)));
    return hit?`[${label}](${hit.url})`:m;
  });
  return out;
}
function stripCitations(text,sources=[]) {
  text=resolveReferenceLinks(text,sources).replace(/^[ \t]*:[ \t]*https?:\/\/\S+[ \t]*$/gm,""); // sisa daftar referensi yatim
  const parts=String(text).split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g); // kode tidak disentuh
  let out=parts.map((part,i)=>i%2?part:part.replace(/[ \t]*(?<![\w\\)])\[\d{1,2}(?:\s*[,–-]\s*\d{1,2})*\](?!\()/g,"")).join("");
  // Baris penutup seperti "Referensi: [1] Nama Situs" tidak perlu lagi: sumbernya sudah ada di tombol Sources.
  out=out.replace(/^[ \t]*[*_]*(?:Referensi|Sumber|Sources?|References?)[*_]*[ \t]*:[^\n]{0,200}$/gim,"");
  return out.replace(/[ \t]+([.,;:!?])/g,"$1").replace(/\n{3,}/g,"\n\n").trim();
}
function pillifyLinks(root) {
  root.querySelectorAll(".markdown a[href]").forEach(a=>{
    if(!/^\s*(link|tautan|buka|lihat|open)\b/i.test(a.textContent))return;
    const domain=domainOf(a.href);
    a.classList.add("link-pill");
    if(domain)a.prepend(faviconImg(domain,"pill-favicon"));
  });
}

function faviconUrl(domain) { return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`; }
// Tampilan tautan yang disingkat (klik tetap membuka alamat lengkap): "kompas.com/tren/read/2026/…"
function shortUrl(url) {
  try {
    const u=new URL(url);
    const host=u.hostname.replace(/^www\./,"");
    const path=u.pathname.replace(/\/$/,"");
    if(!path)return host;
    const full=host+path;
    return full.length>38?full.slice(0,37)+"…":full;
  } catch { return String(url).slice(0,38); }
}
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function faviconImg(domain, cls = "source-favicon") {
  const img = document.createElement("img");
  img.className = cls; img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.referrerPolicy = "no-referrer";
  img.src = faviconUrl(domain);
  img.addEventListener("error", () => { const f = document.createElement("span"); f.className = `${cls} fallback`; f.innerHTML = icons.link; img.replaceWith(f); }, { once: true });
  return img;
}
function extractUrls(text) {
  const matches = String(text).match(/https?:\/\/[^\s)\]}>]+/g) || [];
  const urls = matches.map(url => url.replace(/[.,;:]+$/, ""));
  return [...new Set(urls)].slice(0, 10);
}

const GUESS_CHITCHAT=/^(hai|halo|hallo|hello|hi|hey|ok|oke|okay|sip|mantap|thanks|thank you|makasih|terima kasih|wkwk\w*|haha\w*|lol|yo|test|tes|lanjut|lanjutkan|siapa kamu|kamu siapa|who are you|what are you)\b[!.,? ]*$/i;
const GUESS_EXPLICIT=/\b(cari(?:kan|in|\s?tau|\s?tahu)?|search|googling|google|browsing|telusuri|web search|kasih (?:sumber|link|referensi)|sertakan (?:sumber|link|referensi))\b/i;
const GUESS_OFFLINE=/\b(bikin|buatkan|buatin|buat|tuliskan|tulis|rewrite|parafrase|ringkas|rangkum|terjemahkan|translate|debug|perbaiki|fix|refactor|javascript|typescript|html|css|python|kode|code|script|regex|sql|website|landing page|puisi|cerita|caption|hitung|selesaikan|kerjakan|integral|turunan|persamaan|rumus|solve|simplify|ubah|convert)\b/i;
const GUESS_FRESH=/\b(sekarang|saat ini|hari ini|kemarin|besok|terbaru|terkini|latest|today|current|2025|2026|2027|update|berita|news|jadwal|skor|harga|price|rilis|release|cuaca|weather|kurs)\b/i;
const GUESS_QUESTION=/\b(apa itu|apa arti|apakah|apa|siapa|kapan|di ?mana|dimana|berapa|mengapa|kenapa|bagaimana|gimana|jelaskan|jelasin|what|who|when|where|why|which|how|rekomendasi|terbaik|best)\b/i;
function userTextOf(content){
  if(typeof content==="string")return content;
  if(Array.isArray(content))return content.filter(p=>p?.type==="text").map(p=>p.text).join(" ");
  return "";
}
function guessWillSearch(content){
  if(!webAvailable||!webOn)return false;
  const q=userTextOf(content).toLowerCase().trim();
  if(!q||GUESS_CHITCHAT.test(q))return false;
  if(GUESS_EXPLICIT.test(q))return true;
  if(Array.isArray(content)&&content.some(p=>p?.type==="image_url"))return false;
  if(effort==="fast")return false;
  if(effort==="low")return GUESS_FRESH.test(q)&&!GUESS_OFFLINE.test(q);
  if(GUESS_OFFLINE.test(q))return GUESS_FRESH.test(q);
  return GUESS_FRESH.test(q)||GUESS_QUESTION.test(q);
}


/* ───────────── Util UI ───────────── */
function showToast(text) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = text; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) { const old = button.dataset.label || button.textContent; button.dataset.label = old; if (!button.querySelector("svg")) { button.textContent = "Copied"; setTimeout(() => (button.textContent = old), 1100); } else { button.classList.add("on"); setTimeout(() => button.classList.remove("on"), 900); } }
    showToast("Copied");
  } catch { showToast("Clipboard isn't available in this browser."); }
}
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const greeting = () => { const h = new Date().getHours(); return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const fmtTime = ms => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
// Reset jatah = tengah malam WIB (UTC+7), ditampilkan dalam jam perangkat pengguna.
const nextReset = () => { const J = 7 * 3600e3, d = Math.floor((Date.now() + J) / 864e5) + 1; return d * 864e5 - J; };

/* ───────────── Scroll ───────────── */
function atBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90; }
function updateJump() { stick = atBottom(); $("jumpBtn").hidden = stick || !messages.length; }
function scrollBottom(force) { if (force || stick) { scroller.scrollTop = scroller.scrollHeight; } }
scroller.addEventListener("scroll", () => { stick = atBottom(); $("jumpBtn").hidden = stick || !messages.length; }, { passive: true });
$("jumpBtn").addEventListener("click", () => { stick = true; scrollBottom(true); $("jumpBtn").hidden = true; });

/* ───────────── Pemakaian (persen + jam reset) ───────────── */
function updateQuota(q) {
  if (q && Number.isFinite(Number(q.limit))) quota = { limit: Math.max(1, Number(q.limit)), used: Math.max(0, Number(q.used) || 0), resetAt: Number(q.resetAt) || nextReset() };
  renderUsage();
}
function usagePct() { return Math.min(100, Math.round((quota.used / quota.limit) * 100)); }
function renderUsage() {
  if (quota.resetAt && Date.now() >= quota.resetAt) quota = { ...quota, used: 0, resetAt: nextReset() };
  const pct = usagePct(), reset = `Resets at ${fmtTime(quota.resetAt || nextReset())}`;
  $("usagePct").textContent = `${pct}%`;
  $("usageFill").style.width = `${pct}%`;
  $("usageReset").textContent = reset;
  $("usageCard").classList.toggle("warn", pct >= 80 && pct < 100);
  $("usageCard").classList.toggle("full", pct >= 100);
  const banner = $("usageBanner");
  banner.hidden = pct < 80;
  $("bannerTitle").textContent = pct >= 100 ? "Limit reached" : `${pct}% of your limit used`;
  $("bannerSub").textContent = reset;
  updateAction();
}

/* ───────────── Pratinjau website ───────────── */
function registerProject(project, title = "Website preview", fresh = true) {
  activeProject = project;
  previewFrame.srcdoc = buildSrcdoc(project);
  $("previewTitle").textContent = title;
  $("tabs").hidden = false;
  if (fresh) $("previewTab").classList.add("fresh");
}
function openPreview(project) { if (project && project !== activeProject) registerProject(project); if (activeProject) switchView("preview"); }
function switchView(view) {
  const isPreview = view === "preview" && !!activeProject;
  $("chatView").hidden = isPreview; $("previewView").hidden = !isPreview;
  document.body.classList.toggle("preview-mode", isPreview);
  $("chatTab").classList.toggle("active", !isPreview); $("previewTab").classList.toggle("active", isPreview);
  $("chatTab").setAttribute("aria-selected", String(!isPreview)); $("previewTab").setAttribute("aria-selected", String(isPreview));
  if (isPreview) $("previewTab").classList.remove("fresh");
  if (!isPreview && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
function toggleFullscreen() {
  const el = $("previewFrameWrap");
  if (document.fullscreenElement || document.webkitFullscreenElement) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) { showToast("Full screen isn't supported in this browser."); return; }
  Promise.resolve(req.call(el)).catch(() => showToast("Full screen isn't supported in this browser."));
}
function resetPreview() { activeProject = null; previewFrame.srcdoc = ""; $("tabs").hidden = true; $("previewTab").classList.remove("fresh"); switchView("chat"); }

/* ───────────── Baris pesan ───────────── */
function clearWelcome() { $("welcome")?.remove(); chat.classList.remove("empty"); }
function showWelcome() {
  chat.replaceChildren(); chat.classList.add("empty");
  chat.appendChild($("welcomeTemplate").content.cloneNode(true));
  $("greeting").textContent = greeting();
  $("topTitle").textContent = "";
}
/* ───────────── Image preview (lightbox) ───────────── */
function openImage(src) {
  const box = $("imgViewer"), img = $("imgViewerImg");
  img.src = src; img.classList.remove("zoomed"); $("imgViewerScroll").scrollTo(0, 0);
  box.hidden = false; document.body.classList.add("noscroll"); $("imgViewerClose").focus({ preventScroll: true });
}
function closeImage() { const box = $("imgViewer"); if (box.hidden) return; box.hidden = true; $("imgViewerImg").removeAttribute("src"); document.body.classList.remove("noscroll"); }
$("imgViewerClose").addEventListener("click", closeImage);
$("imgViewerScroll").addEventListener("click", e => { if (e.target === $("imgViewerScroll")) closeImage(); });
$("imgViewerImg").addEventListener("click", e => { e.stopPropagation(); $("imgViewerImg").classList.toggle("zoomed"); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeImage(); });
function addUserRow(text, { imageData = null, fileName = "", hadImage = false } = {}) {
  clearWelcome();
  const row = document.createElement("article"); row.className = "msg user";
  if (imageData) { const img = document.createElement("img"); img.className = "msg-image"; img.src = imageData; img.alt = "Attached image"; img.tabIndex = 0; img.setAttribute("role", "button"); img.title = "Tap to enlarge"; img.addEventListener("click", () => openImage(imageData)); img.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openImage(imageData); } }); row.appendChild(img); }
  else if (hadImage) { const c = document.createElement("div"); c.className = "chip-file"; c.innerHTML = icons.file + "<span>Image</span>"; row.appendChild(c); }
  if (fileName) { const c = document.createElement("div"); c.className = "chip-file"; c.innerHTML = icons.file; const s = document.createElement("span"); s.textContent = fileName; c.appendChild(s); row.appendChild(c); }
  if (text) { const b = document.createElement("div"); b.className = "bubble"; b.textContent = text; row.appendChild(b); }
  chat.appendChild(row);
  stick = true; scrollBottom(true);
  return row;
}
function actBtn(label, icon, fn, cls = "") {
  const b = document.createElement("button"); b.type = "button"; b.className = `act ${cls}`; b.title = label; b.setAttribute("aria-label", label);
  b.innerHTML = icon; b.addEventListener("click", fn); return b;
}
function cleanText(text, sources, webSearched) {
  let t = stripToolCitations(text);
  if (webSearched || (sources && sources.length)) t = stripCitations(t, sources || []);
  return t;
}
function buildActions(row, content, { sources = [], webSearched = false, modelLabel = "", project = null, isLast = true } = {}) {
  const wrap = document.createElement("div"); wrap.className = "actions";
  const copy = actBtn("Copy", icons.copy, () => copyText(content, copy));
  const like = actBtn("Good response", icons.like, () => { like.classList.toggle("on"); dislike.classList.remove("on"); });
  const dislike = actBtn("Bad response", icons.dislike, () => { dislike.classList.toggle("on"); like.classList.remove("on"); });
  wrap.append(copy, like, dislike);
  const live = (Array.isArray(sources) ? sources : []).filter(s => s && typeof s.url === "string" && safeUrl(s.url) !== "#").slice(0, 8);
  const list = (live.length ? live : webSearched ? [] : extractUrls(content).map(url => ({ title: url, url }))).map(s => ({ ...s, domain: s.domain || domainOf(s.url) }));
  if (list.length) {
    const src = actBtn("Sources", icons.link, () => {
      const open = row.querySelector(".sources");
      document.querySelectorAll(".sources").forEach(x => x.remove());
      if (open) return;
      const pop = document.createElement("div"); pop.className = "sources";
      list.forEach(s => {
        const a = document.createElement("a"); a.className = "source"; a.href = safeUrl(s.url); a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = s.url;
        a.appendChild(faviconImg(s.domain));
        const t = document.createElement("span"); t.className = "source-text";
        const st = document.createElement("strong"); st.textContent = (s.title && s.title !== s.url) ? s.title : (s.domain || shortUrl(s.url));
        const sm = document.createElement("small"); sm.textContent = shortUrl(s.url);
        t.append(st, sm); a.appendChild(t); pop.appendChild(a);
      });
      row.appendChild(pop);
    });
    src.dataset.sources = "1";
    const stack = document.createElement("span"); stack.className = "favicon-stack";
    [...new Map(list.filter(x => x.domain).map(x => [x.domain, x])).keys()].slice(0, 3).forEach(d => stack.appendChild(faviconImg(d, "stack-favicon")));
    if (stack.children.length) src.replaceChildren(stack);
    wrap.appendChild(src);
  }
  if (project) { const pv = actBtn("Preview", icons.preview + "<span>Preview</span>", () => openPreview(project), "text"); wrap.appendChild(pv); }
  if (isLast) wrap.appendChild(actBtn("Regenerate", icons.retry, regenerate, "regen"));
  if (modelLabel) { const m = document.createElement("span"); m.className = "msg-meta"; m.textContent = modelLabel; wrap.appendChild(m); }
  return wrap;
}
// Isi akhir sebuah jawaban (dipakai setelah streaming selesai dan saat memuat riwayat).
function fillAnswer(row, answer, text, o = {}) {
  const content = cleanText(text, o.sources, o.webSearched);
  answer.innerHTML = renderMarkdown(content);
  pillifyLinks(answer); hydrateMath(answer);
  const top = [];
  (o.notes || []).forEach(t => { const n = document.createElement("div"); n.className = "note"; n.textContent = t; top.push(n); });
  const project = extractProjectFiles(text);
  if (project) {
    const cta = document.createElement("button"); cta.type = "button"; cta.className = "preview-cta";
    cta.innerHTML = `${icons.preview}<span>Open full-screen preview</span><svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 6l6 6-6 6"/></svg>`;
    cta.addEventListener("click", () => openPreview(project));
    top.push(cta);
  }
  answer.prepend(...top);
  document.querySelectorAll(".act.regen").forEach(b => { if (o.isLast !== false) b.remove(); });
  row.appendChild(buildActions(row, content, { sources: o.sources, webSearched: o.webSearched, modelLabel: o.modelLabel, project, isLast: o.isLast !== false }));
  return project;
}
function addAssistantStatic(m, isLast) {
  const row = document.createElement("article"); row.className = "msg assistant";
  const answer = document.createElement("div"); answer.className = "answer"; row.appendChild(answer);
  chat.appendChild(row);
  const project = fillAnswer(row, answer, m.content, { sources: m.sources, webSearched: Boolean(m.sources?.length), modelLabel: m.model || "", isLast });
  return project;
}
function addError(text, retry) {
  const row = document.createElement("article"); row.className = "msg assistant error";
  const answer = document.createElement("div"); answer.className = "answer";
  const t = document.createElement("div"); t.textContent = text; answer.appendChild(t);
  if (retry) {
    const a = document.createElement("div"); a.className = "error-actions";
    const b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.innerHTML = icons.retry + "<span>Try again</span>";
    b.addEventListener("click", () => retry(row)); a.appendChild(b); answer.appendChild(a);
  }
  row.appendChild(answer); chat.appendChild(row); stick = true; scrollBottom(true);
}

/* ───────────── Indikator menunggu ───────────── */
const STATUS = { thinking: "Thinking…", searching: "Searching the web…", still: "Still working on it…" };
let typingTimers = [];
function addTyping(userContent) {
  const row = document.createElement("article"); row.id = "typing"; row.className = "msg assistant";
  row.innerHTML = '<div class="typing" role="status"><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span id="typingLabel"></span></div>';
  chat.appendChild(row); scrollBottom(true);
  const label = t => { const el = $("typingLabel"); if (el) el.textContent = t; };
  const searching = guessWillSearch(userContent);
  label(searching ? STATUS.searching : STATUS.thinking);
  if (searching) typingTimers.push(setTimeout(() => label(STATUS.thinking), 3500));
  typingTimers.push(setTimeout(() => label(STATUS.still), effort === "high" ? 20000 : 11000));
}
function removeTyping() { typingTimers.forEach(clearTimeout); typingTimers = []; $("typing")?.remove(); }

/* ───────────── Kirim & streaming ───────────── */
function userTextFor(content) { return typeof content === "string" ? content : userTextOf(content); }
function prepareHistory() {
  let newestImage = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && Array.isArray(messages[i].content) && messages[i].content.some(p => p?.type === "image_url")) { newestImage = i; break; }
  return messages.slice(-16).map((m, idx, arr) => {
    const i = messages.length - arr.length + idx;
    if (m.role === "user" && Array.isArray(m.content) && i !== newestImage) return { role: "user", content: userTextOf(m.content) || "The user sent an image earlier." };
    if (m.role === "assistant" && m.sources?.length) {
      const info = m.sources.slice(0, 5).map((s, n) => `[${n + 1}] ${s.title || s.url} — ${s.url}`).join("\n");
      return { role: "assistant", content: `${m.content}\n\n[Sumber web dari jawaban sebelumnya; hanya untuk konteks lanjutan]\n${info}` };
    }
    return { role: m.role, content: m.content };
  });
}
function apiError(status, data) {
  const err = new Error(data?.error || (status === 429 ? "Too many requests. Try again in a moment." : status === 504 ? "That took too long. Try Fast or Low effort." : "Something went wrong. Try again."));
  err.status = status; err.data = data || {};
  if (data?.limitReached) err.message = `You've reached today's usage limit. Resets at ${fmtTime(data.quota?.resetAt || quota.resetAt || nextReset())}.`;
  return err;
}
async function readSSE(res, on) {
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(raw)?.[1]; const dataLine = /^data: (.+)$/m.exec(raw)?.[1];
      if (!ev || !dataLine) continue;
      let data; try { data = JSON.parse(dataLine); } catch { continue; }
      on(ev, data);
    }
  }
}
function setBusy(v) { busy = v; $("attachBtn").disabled = v; updateAction(); }
function canSend() { return Boolean(input.value.trim() || pendingImage || pendingFile) && !busy && usagePct() < 100; }
function updateAction() {
  const hasContent = Boolean(input.value.trim() || pendingImage || pendingFile);
  const mode = busy ? "stop" : hasContent ? "send" : "mic";
  actionBtn.dataset.mode = mode;
  actionBtn.setAttribute("aria-label", mode === "stop" ? "Stop" : mode === "send" ? "Send message" : "Voice input");
  actionBtn.disabled = mode === "send" && usagePct() >= 100;
  input.placeholder = usagePct() >= 100 ? "Limit reached. Resets later today." : "Chat with ZennNyx…";
}

async function sendMessage() {
  if (!canSend()) { if (usagePct() >= 100) showToast(`Limit reached. Resets at ${fmtTime(quota.resetAt || nextReset())}.`); return; }
  let text = input.value.trim();
  const imageData = pendingImage, file = pendingFile;
  const shown = text;
  if (file) text = `${text || "Please read this file."}\n\n[Attached file: ${file.name}]\n${file.text}`;
  const userContent = imageData ? [{ type: "text", text: text || "Please analyze this image." }, { type: "image_url", image_url: { url: imageData } }] : text;
  const row = addUserRow(shown || (imageData ? "Analyze this image." : ""), { imageData, fileName: file?.name });
  lastUserRow = row;
  const entry = { role: "user", content: userContent, display: shown, fileName: file?.name || "", hadImage: Boolean(imageData) };
  input.value = ""; autosize(); clearAttachments(); input.blur();
  await runRequest(entry);
}

async function runRequest(entry, { fresh = true } = {}) {
  if (fresh) messages.push(entry);
  setBusy(true);
  addTyping(entry.content);
  abortCtl = new AbortController();
  const started = performance.now();
  let live = null, startData = null, doneData = null, streamError = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", signal: abortCtl.signal,
      body: JSON.stringify({ messages: prepareHistory(), effort, model: modelPick !== "auto" ? modelPick : undefined, stickyModel: lastUsedModel, webSearch: webOn ? "auto" : "off", health: readHealth() })
    });
    if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
      const data = await res.json().catch(() => ({}));
      if (data.quota) updateQuota(data.quota);
      noteAttempts(data.attempts);
      throw apiError(res.status, data);
    }
    await readSSE(res, (ev, data) => {
      if (ev === "start") {
        const hadStick = stick;
        removeTyping(); startData = data; updateQuota(data.quota);
        const row = document.createElement("article"); row.className = "msg assistant";
        const answer = document.createElement("div"); answer.className = "answer streaming"; row.appendChild(answer); chat.appendChild(row);
        live = { row, answer, text: "", timer: 0, sources: data.sources || [], webSearched: Boolean(data.webSearched), ttft: Math.round(performance.now() - started) };
        stick = false; // dari sini jawaban TIDAK menyeret layar ke bawah
        if (hadStick && lastUserRow) { const d = lastUserRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12; if (d > 0) scroller.scrollTop += d; }
        updateJump();
      } else if (ev === "delta" && live) {
        live.text += data.t;
        if (!live.timer) live.timer = setTimeout(() => { live.timer = 0; paintLive(live); }, 60);
      } else if (ev === "done") doneData = data;
      else if (ev === "error") streamError = data.error || "The connection was interrupted.";
    });
    if (!live) throw new Error(streamError || "The model returned no answer. Try again.");
    noteAttempts(doneData?.attempts);
    finishLive(live, startData, { truncated: Boolean(doneData?.truncated) || Boolean(streamError), elapsed: performance.now() - started, note: streamError });
  } catch (error) {
    removeTyping();
    if (error.name === "AbortError") {
      if (live?.text) finishLive(live, startData, { truncated: false, stopped: true, elapsed: performance.now() - started });
      else { // dihentikan sebelum ada jawaban: kembalikan teks ke kotak ketik
        messages.pop(); lastUserRow?.remove(); input.value = userTextFor(entry.content).split("\n\n[Attached file:")[0]; autosize();
        if (!messages.length) showWelcome();
      }
    } else if (live?.text) {
      finishLive(live, startData, { truncated: true, elapsed: performance.now() - started, note: error.message });
    } else {
      live?.row.remove();
      messages.pop();
      const d = error.data || {};
      if (d.rejected && !d.limitReached) { lastUserRow?.remove(); input.value = userTextFor(entry.content).split("\n\n[Attached file:")[0]; autosize(); showToast(error.message); if (!messages.length) showWelcome(); }
      else addError(error.message || "Something went wrong. Try again.", d.limitReached ? null : row => { row.remove(); retryLast(entry); });
    }
  } finally {
    abortCtl = null; setBusy(false); renderUsage();
  }
}
function retryLast(entry) { if (busy) return; runRequest(entry); }
function paintLive(live) {
  live.answer.innerHTML = renderMarkdown(cleanText(live.text, live.sources, live.webSearched));
  updateJump(); // tidak ada auto-scroll: tombol "jump to bottom" muncul kalau jawaban sudah melewati layar
}
function finishLive(live, start, { truncated, stopped, elapsed, note }) {
  clearTimeout(live.timer);
  live.answer.classList.remove("streaming");
  const notes = [];
  if (truncated) notes.push("This answer was cut short. Tap Regenerate to try again.");
  if (modelPick !== "auto" && start?.provider && start?.model && `${start.provider}::${start.model}` !== modelPick) notes.push(`${modelLabelOf(modelPick) || "The model you picked"} didn't respond, so ${start.name} answered instead.`);
  if (DEBUG_UI) notes.push(`${Math.round(elapsed)} ms total · first token ${live.ttft} ms${start?.fallbackFrom ? ` · switched from ${start.fallbackFrom}: ${start.fallbackReason || ""}` : ""}${note ? ` · ${note}` : ""}`);
  const modelLabel = [start?.name, start?.webSearched ? "web" : ""].filter(Boolean).join(" · ");
  fillAnswer(live.row, live.answer, live.text, { sources: live.sources, webSearched: live.webSearched, modelLabel, notes, isLast: true });
  messages.push({ role: "assistant", content: live.text, sources: live.sources, model: start?.name || "" });
  if (start?.provider && start?.model) lastUsedModel = `${start.provider}::${start.model}`;
  const project = extractProjectFiles(live.text);
  if (project) { registerProject(project); showToast("Website ready. Open the Preview tab."); }
  saveChat();
  updateJump();
}
function regenerate() {
  if (busy) return;
  const lastAssistant = chat.querySelector(".msg.assistant:last-of-type");
  if (messages[messages.length - 1]?.role !== "assistant") return;
  messages.pop(); lastAssistant?.remove();
  const entry = messages[messages.length - 1];
  if (!entry || entry.role !== "user") return;
  runRequest(entry, { fresh: false });
}

/* ───────────── Riwayat chat (localStorage) ───────────── */
function readChats() { try { const r = JSON.parse(store.get(KEYS.chats, "[]")); return Array.isArray(r) ? r : []; } catch { return []; } }
function writeChats(list) {
  let l = list.slice(0, 30);
  while (l.length && !store.set(KEYS.chats, JSON.stringify(l))) l = l.slice(0, Math.max(0, l.length - 5)); // penyimpanan penuh: buang yang paling lama
}
function slim(m) {
  const text = typeof m.content === "string" ? m.content : userTextOf(m.content);
  return { role: m.role, content: text.slice(0, 20000), display: m.display, fileName: m.fileName, hadImage: m.hadImage || (Array.isArray(m.content) && m.content.some(p => p?.type === "image_url")), sources: m.sources?.slice(0, 5), model: m.model };
}
function saveChat() {
  if (!messages.length) return;
  const chats = readChats();
  if (!chatId) chatId = uid();
  let c = chats.find(x => x.id === chatId);
  if (!c) { c = { id: chatId, title: "" }; chats.unshift(c); }
  const first = messages.find(m => m.role === "user");
  c.title = c.title || (first?.display || userTextFor(first?.content || "") || "New chat").replace(/\s+/g, " ").slice(0, 60);
  c.updatedAt = Date.now(); c.messages = messages.slice(-40).map(slim);
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  writeChats(chats); renderRecents();
}
function renderRecents() {
  const box = $("recents"), chats = readChats();
  box.replaceChildren();
  if (!chats.length) { const e = document.createElement("div"); e.className = "recents-empty"; e.textContent = "Your chats will show up here."; box.appendChild(e); return; }
  for (const c of chats) {
    const row = document.createElement("div"); row.className = "recent" + (c.id === chatId ? " active" : "");
    const open = document.createElement("button"); open.type = "button"; open.className = "open"; open.textContent = c.title || "New chat"; open.addEventListener("click", () => loadChat(c.id));
    const del = document.createElement("button"); del.type = "button"; del.className = "del"; del.setAttribute("aria-label", "Delete chat"); del.innerHTML = icons.close;
    del.addEventListener("click", e => { e.stopPropagation(); deleteChat(c.id); });
    row.append(open, del); box.appendChild(row);
  }
}
function deleteChat(id) {
  if (busy && id === chatId) { showToast("Wait for the reply to finish."); return; }
  writeChats(readChats().filter(c => c.id !== id));
  if (id === chatId) newChat(true); else renderRecents();
}
function loadChat(id) {
  if (busy) { showToast("Wait for the reply to finish."); return; }
  const c = readChats().find(x => x.id === id); if (!c) return;
  chatId = id; messages = c.messages.map(m => ({ ...m, content: m.content }));
  chat.replaceChildren(); chat.classList.remove("empty"); resetPreview(); lastUsedModel = "";
  let project = null;
  messages.forEach((m, i) => {
    if (m.role === "user") addUserRow(m.display ?? m.content, { fileName: m.fileName, hadImage: m.hadImage });
    else project = addAssistantStatic(m, i === messages.length - 1) || project;
  });
  if (project) registerProject(project, "Website preview", false);
  $("topTitle").textContent = c.title || "";
  closeSidebar(); renderRecents(); stick = true; requestAnimationFrame(() => scrollBottom(true));
}
function newChat(force) {
  if (busy && !force) { showToast("Wait for the reply to finish."); return; }
  messages = []; chatId = null; lastUsedModel = ""; clearAttachments(); input.value = ""; autosize();
  resetPreview(); showWelcome(); closeSidebar(); renderRecents(); updateAction(); $("jumpBtn").hidden = true;
}

/* ───────────── Lampiran ───────────── */
function renderAttachments() {
  const box = $("attachments"); box.replaceChildren();
  if (pendingImage) {
    const a = document.createElement("div"); a.className = "att"; const img = document.createElement("img"); img.src = pendingImage; img.alt = "Selected image"; img.style.cursor = "zoom-in"; img.addEventListener("click", () => openImage(pendingImage));
    const x = document.createElement("button"); x.type = "button"; x.setAttribute("aria-label", "Remove image"); x.innerHTML = icons.close; x.addEventListener("click", () => { pendingImage = null; renderAttachments(); });
    a.append(img, x); box.appendChild(a);
  }
  if (pendingFile) {
    const a = document.createElement("div"); a.className = "att file"; a.innerHTML = icons.file; const s = document.createElement("span"); s.textContent = pendingFile.name; a.appendChild(s);
    const x = document.createElement("button"); x.type = "button"; x.setAttribute("aria-label", "Remove file"); x.innerHTML = icons.close; x.addEventListener("click", () => { pendingFile = null; renderAttachments(); });
    a.appendChild(x); box.appendChild(a);
  }
  box.hidden = !pendingImage && !pendingFile; updateAction();
}
function clearAttachments() { pendingImage = null; pendingFile = null; ["imageInput", "cameraInput", "fileInput"].forEach(i => ($(i).value = "")); renderAttachments(); }
async function prepareImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  if (file.size > 12 * 1024 * 1024) { showToast("Images can be up to 12 MB."); return; }
  try {
    const src = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
    const img = await new Promise((ok, no) => { const el = new Image(); el.onload = () => ok(el); el.onerror = no; el.src = src; });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(img.width * scale)); cv.height = Math.max(1, Math.round(img.height * scale));
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    pendingImage = cv.toDataURL("image/jpeg", .82); renderAttachments();
  } catch { showToast("Couldn't read that image."); }
}
async function prepareFile(file) {
  if (!file) return;
  if (file.size > 600 * 1024) { showToast("Files can be up to 600 KB of text."); return; }
  try {
    const text = await file.text();
    if (text.includes("\u0000")) { showToast("That file type isn't supported. Use a text or code file."); return; }
    const cut = text.length > 12000;
    pendingFile = { name: file.name, text: text.slice(0, 12000) + (cut ? "\n…(file truncated)" : "") };
    if (cut) showToast("Long file: the first 12,000 characters will be used.");
    renderAttachments();
  } catch { showToast("Couldn't read that file."); }
}

/* ───────────── Sheet (Add to chat, Effort) ───────────── */
function openSheet(id) {
  $("sheetLayer").hidden = false;
  ["addSheet", "effortSheet", "modelSheet"].forEach(s => ($(s).hidden = s !== id));
  input.blur();
}
function closeSheets() { $("sheetLayer").hidden = true; ["addSheet", "effortSheet", "modelSheet"].forEach(s => ($(s).hidden = true)); }
function renderEffort() {
  $("effortLabel").textContent = EFFORTS.find(e => e.id === effort).label;
  const list = $("effortList"); list.replaceChildren();
  for (const e of EFFORTS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "opt"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(e.id === effort)); b.dataset.effort = e.id;
    b.innerHTML = `<span class="opt-copy"><span class="opt-title"></span><small></small></span><span class="opt-check">${icons.check}</span>`;
    b.querySelector(".opt-title").textContent = e.label;
    if (e.recommended) { const g = document.createElement("span"); g.className = "badge"; g.textContent = "Recommended"; b.querySelector(".opt-title").appendChild(g); }
    b.querySelector("small").textContent = e.desc;
    b.addEventListener("click", () => { effort = e.id; store.set(KEYS.effort, effort); renderEffort(); setTimeout(closeSheets, 120); });
    list.appendChild(b);
  }
}
function modelLabelOf(value) { return modelList.find(m => m.value === value)?.name || ""; }
function renderModel() {
  if (modelPick !== "auto" && modelList.length && !modelList.some(m => m.value === modelPick)) { modelPick = "auto"; store.set(KEYS.model, "auto"); }
  $("modelLabel").textContent = modelPick === "auto" ? "Auto" : (modelLabelOf(modelPick) || "Auto");
  const list = $("modelList"); list.replaceChildren();
  const add = (value, title, sub, badge) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "opt"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(value === modelPick));
    b.innerHTML = `<span class="opt-copy"><span class="opt-title"></span><small></small></span><span class="opt-check">${icons.check}</span>`;
    b.querySelector(".opt-title").textContent = title;
    if (badge) { const g = document.createElement("span"); g.className = "badge"; g.textContent = badge; b.querySelector(".opt-title").appendChild(g); }
    b.querySelector("small").textContent = sub;
    b.addEventListener("click", () => { modelPick = value; store.set(KEYS.model, value); renderModel(); setTimeout(closeSheets, 120); });
    list.appendChild(b);
  };
  add("auto", "Auto", "Picks the fastest working model for your effort level", "Recommended");
  let group = "";
  for (const m of modelList) {
    if (m.providerLabel !== group) { group = m.providerLabel; const h = document.createElement("div"); h.className = "opt-group"; h.textContent = group; list.appendChild(h); }
    add(m.value, m.name, [m.vision ? "Reads images" : "", m.reasoning ? "Thinks first" : ""].filter(Boolean).join(" · ") || "Text");
  }
  if (!modelList.length) { const p = document.createElement("p"); p.className = "sheet-note"; p.textContent = "Loading models…"; list.appendChild(p); }
}
async function loadModels() {
  try {
    const r = await fetch("/api/models", { cache: "no-store" });
    const d = await r.json();
    if (Array.isArray(d.models)) modelList = d.models;
  } catch {}
  renderModel();
}
function renderWeb() {
  const t = $("webToggle"); t.setAttribute("aria-checked", String(webOn && webAvailable)); t.disabled = !webAvailable;
  $("webHint").textContent = webAvailable ? "Looks things up when a question needs fresh info" : "Not set up on this server";
}

/* ───────────── Suara ───────────── */
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast("Voice input isn't supported in this browser."); return; }
  if (recording) { recognition?.stop(); return; }
  recognition = new SR(); recognition.lang = navigator.language || "en-US"; recognition.interimResults = true; recognition.continuous = false;
  const base = input.value.trim();
  recognition.onstart = () => { recording = true; actionBtn.classList.add("recording"); };
  recognition.onresult = e => { input.value = (base ? base + " " : "") + [...e.results].map(r => r[0]?.transcript || "").join(""); autosize(); updateAction(); };
  recognition.onerror = e => { if (e.error === "not-allowed" || e.error === "service-not-allowed") showToast("Microphone permission denied."); else if (e.error !== "aborted" && e.error !== "no-speech") showToast("Voice input failed."); };
  recognition.onend = () => { recording = false; actionBtn.classList.remove("recording"); updateAction(); };
  try { recognition.start(); } catch {}
}

/* ───────────── Layout / keyboard ───────────── */
function autosize() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, Math.round(innerHeight * .38))}px`; updateAction(); }
function syncViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty("--app-h", `${Math.round(vv ? vv.height : innerHeight)}px`);
  if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
  if (stick) scrollBottom(true);
}
function closeSidebar() { sidebar.classList.remove("open"); scrim.hidden = true; }
function openSidebar() { renderRecents(); renderUsage(); sidebar.classList.add("open"); scrim.hidden = false; }

/* ───────────── Event ───────────── */
composer.addEventListener("submit", e => {
  e.preventDefault();
  const mode = actionBtn.dataset.mode;
  if (mode === "stop") abortCtl?.abort();
  else if (mode === "send") sendMessage();
  else toggleVoice();
});
input.addEventListener("input", autosize);
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.isComposing && !e.shiftKey && matchMedia("(pointer: fine)").matches) { e.preventDefault(); if (canSend()) sendMessage(); }
});
input.addEventListener("paste", e => {
  const item = [...(e.clipboardData?.items || [])].find(x => x.type.startsWith("image/"));
  if (item && !busy) { const f = item.getAsFile(); if (f) { e.preventDefault(); prepareImage(f); } }
});
input.addEventListener("focus", () => { setTimeout(() => { if (atBottom()) scrollBottom(true); }, 250); });
$("attachBtn").addEventListener("click", () => openSheet("addSheet"));
$("effortBtn").addEventListener("click", () => openSheet("effortSheet"));
$("modelBtn").addEventListener("click", () => { openSheet("modelSheet"); if (!modelList.length) loadModels(); });
$("sheetLayer").addEventListener("click", e => { if (e.target.closest("[data-close]")) closeSheets(); });
document.querySelectorAll("#addSheet .tile").forEach(t => t.addEventListener("click", () => {
  const a = t.dataset.act;
  if (a === "camera") $("cameraInput").click(); else if (a === "photo") $("imageInput").click(); else if (a === "file") $("fileInput").click();
  closeSheets();
}));
$("webToggle").addEventListener("click", () => { if (!webAvailable) return; webOn = !webOn; store.set(KEYS.web, webOn ? "1" : "0"); renderWeb(); showToast(webOn ? "Web search on" : "Web search off"); });
$("imageInput").addEventListener("change", e => prepareImage(e.target.files?.[0]));
$("cameraInput").addEventListener("change", e => prepareImage(e.target.files?.[0]));
$("fileInput").addEventListener("change", e => prepareFile(e.target.files?.[0]));
$("menuBtn").addEventListener("click", openSidebar);
$("sideClose").addEventListener("click", closeSidebar);
scrim.addEventListener("click", closeSidebar);
$("newChatTop").addEventListener("click", () => newChat());
$("newChatSide").addEventListener("click", () => newChat());
$("chatTab").addEventListener("click", () => switchView("chat"));
$("previewTab").addEventListener("click", () => { if (activeProject) switchView("preview"); });
$("copyProjectBtn").addEventListener("click", () => { if (activeProject) copyText(buildSrcdoc(activeProject)); });
$("refreshPreviewBtn").addEventListener("click", () => { if (activeProject) previewFrame.srcdoc = buildSrcdoc(activeProject); });
$("fullscreenBtn").addEventListener("click", toggleFullscreen);
chat.addEventListener("click", e => { const b = e.target.closest("[data-copy-code]"); if (b) copyText(decodeURIComponent(b.dataset.copyCode || ""), b); });
document.addEventListener("click", e => { if (!e.target.closest(".sources") && !e.target.closest("[data-sources]")) document.querySelectorAll(".sources").forEach(x => x.remove()); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeSheets(); closeSidebar(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); newChat(); input.focus(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) renderUsage(); });
if (window.visualViewport) { visualViewport.addEventListener("resize", syncViewport, { passive: true }); visualViewport.addEventListener("scroll", syncViewport, { passive: true }); }
addEventListener("resize", () => { syncViewport(); clearTimeout(window.__refit); window.__refit = setTimeout(() => refitAllMath(), 150); }, { passive: true });
addEventListener("load", () => hydrateMath(document));

/* ───────────── Mulai ───────────── */
async function boot() {
  syncViewport(); showWelcome(); renderEffort(); renderModel(); loadModels(); renderWeb(); renderRecents(); autosize(); updateQuota({ limit: quota.limit, used: 0, resetAt: nextReset() });
  try {
    const r = await fetch("/api/chat", { cache: "no-store", credentials: "same-origin" });
    const d = await r.json();
    if (r.ok) { updateQuota(d.quota); webAvailable = Boolean(d.providers?.webSearch); renderWeb(); }
  } catch {}
  if (!store.get(KEYS.intro)) {
    const modal = $("introModal"), shell = $("app");
    const close = () => { store.set(KEYS.intro, "1"); modal.hidden = true; shell.inert = false; };
    modal.querySelectorAll("[data-intro-close]").forEach(el => el.addEventListener("click", close));
    modal.hidden = false; shell.inert = true; $("introCloseBtn").focus({ preventScroll: true });
  }
}
boot();
