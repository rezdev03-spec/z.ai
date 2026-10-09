/* ZennNyx AI v9.2 — UI. Renderer Markdown/LaTeX ada di markdown.js (dimuat lebih dulu). */
const $ = id => document.getElementById(id);
const chat = $("chat");
const chatView = $("chatView");
const previewView = $("previewView");
const input = $("input");
const composer = $("composer");
const sendBtn = $("sendBtn");
const attachBtn = $("attachBtn");
const imageInput = $("imageInput");
const cameraInput = $("cameraInput");
const imagePreview = $("imagePreview");
const voiceBtn = $("voiceBtn");
const attachPopover = $("attachPopover");
const thinkMenuBtn = $("thinkMenuBtn");
const webMenuBtn = $("webMenuBtn");
const modelSelect = $("modelSelect");
const modelPickerBtn = $("modelPickerBtn");
const modelPickerPopover = $("modelPickerPopover");
const modelPickerList = $("modelPickerList");
const selectedModelIcon = $("selectedModelIcon");
const sidebar = $("sidebar");
const sidebarScrim = $("sidebarScrim");
const previewFrame = $("previewFrame");
const previewFrameWrap = $("previewFrameWrap");
const newChatBtn = $("newChatBtn");

let messages = [];
let pendingImage = null;
let thinkHarder = false;
let webMode = "auto";          // "auto" = server menentukan, "on" = selalu cari
let webAvailable = false;
let busy = false;
let toastTimer = null;
let recognition = null;
let recording = false;
let activeProject = null;
let activeModel = "groq::openai/gpt-oss-20b";
let serverQuota = null;
let modelChoices = [];
let guardTimer = null;

const LOCAL_QUOTA_KEY = "zennnyx_daily_usage_v2";
const CLIENT_COOLDOWN_MS = 5000;
const CLIENT_BURST_WINDOW_MS = 60000;
const CLIENT_BURST_LIMIT = 3;
const CLIENT_BURST_COOLDOWN_MS = 10000;
const DAILY_LIMIT = 20;

const icons = {
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11"/><path d="M5 16V5a2 2 0 0 1 2-2h9"/></svg>',
  like: '<svg viewBox="0 0 24 24"><path d="M7 10v11H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3Z"/><path d="M7 21h9.5a2 2 0 0 0 1.9-1.4l2.2-6.5A2 2 0 0 0 18.7 10H14l.7-4.1A3.3 3.3 0 0 0 11.5 2L7 10Z"/></svg>',
  dislike: '<svg viewBox="0 0 24 24"><path d="M7 14V3H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3Z"/><path d="M7 3h9.5a2 2 0 0 1 1.9 1.4l2.2 6.5A2 2 0 0 1 18.7 14H14l.7 4.1A3.3 3.3 0 0 1 11.5 22L7 14Z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 16V3m-5 5 5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1L11 5"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 7 20l1.1-1.1"/></svg>',
  preview: '<svg viewBox="0 0 24 24"><rect x="2.5" y="3.5" width="19" height="17"/><path d="M2.5 8h19M6 5.8h.1M9 5.8h.1"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5"/></svg>'
};

function jakartaDay(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Jakarta", year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(date);
  const o = Object.fromEntries(p.map(x => [x.type,x.value]));
  return `${o.year}-${o.month}-${o.day}`;
}
function readLocalQuota() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_QUOTA_KEY) || "null");
    if (!raw || raw.day !== jakartaDay()) return {day:jakartaDay(), used:0, lastAt:0, burst:[], blockedUntil:0};
    return {
      day:raw.day,
      used:Math.max(0,Math.min(DAILY_LIMIT,Number(raw.used)||0)),
      lastAt:Number(raw.lastAt)||0,
      burst:Array.isArray(raw.burst)?raw.burst.filter(n=>Number.isFinite(n)&&Date.now()-n<CLIENT_BURST_WINDOW_MS):[],
      blockedUntil:Number(raw.blockedUntil)||0
    };
  } catch { return {day:jakartaDay(),used:0,lastAt:0,burst:[],blockedUntil:0}; }
}
function writeLocalQuota(state) {
  try { localStorage.setItem(LOCAL_QUOTA_KEY, JSON.stringify(state)); } catch {}
}
function updateQuota(serverData) {
  if (serverData && typeof serverData === "object" && Number.isFinite(Number(serverData.remaining))) {
    serverQuota = {
      limit:Number(serverData.limit)||DAILY_LIMIT,
      used:Number(serverData.used)||0,
      remaining:Number(serverData.remaining),
      day:serverData.day||jakartaDay(),
      resetAt:Number(serverData.resetAt)||0
    };
    const local=readLocalQuota();
    if (local.day === serverQuota.day) {
      local.used=Math.max(local.used,serverQuota.used);
      writeLocalQuota(local);
    }
  }
  const local=readLocalQuota();
  const serverRemain=serverQuota && serverQuota.day===jakartaDay()?serverQuota.remaining:DAILY_LIMIT;
  const remain=Math.max(0,Math.min(DAILY_LIMIT-local.used,serverRemain));
  const used=DAILY_LIMIT-remain;
  const label=`${remain} / ${DAILY_LIMIT}`;
  $("quotaLabel").textContent=label;
  $("dailyComposerStatus").textContent=remain===0?"Kuota harian habis":`${remain} pesan tersisa hari ini`;
  $("quotaHint").textContent=remain===0?"Jatah balik lagi tengah malam WIB.":"Maksimal 20 pesan per hari (WIB).";
  $("quotaFill").style.width=`${(used/DAILY_LIMIT)*100}%`;
}
function clientGuardRemaining() {
  const s=readLocalQuota(), now=Date.now();
  const wait=Math.max(s.lastAt+CLIENT_COOLDOWN_MS, s.blockedUntil)-now;
  return Math.max(0,wait);
}
function clientCanSend() {
  const s=readLocalQuota();
  const serverRemain=serverQuota&&serverQuota.day===jakartaDay()?serverQuota.remaining:DAILY_LIMIT;
  return s.used<DAILY_LIMIT && serverRemain>0 && clientGuardRemaining()<=0;
}
function scheduleGuardUnlock() {
  clearTimeout(guardTimer);
  const wait=clientGuardRemaining();
  if(wait>0) guardTimer=setTimeout(()=>{guardTimer=null;updateSendState()},Math.min(wait+80,2147483647));
}
function recordClientSend() {
  const now=Date.now(), s=readLocalQuota();
  s.used=Math.min(DAILY_LIMIT,s.used+1);
  s.lastAt=now;
  s.burst=s.burst.filter(t=>now-t<CLIENT_BURST_WINDOW_MS);
  s.burst.push(now);
  if(s.burst.length>=CLIENT_BURST_LIMIT) {
    s.blockedUntil=now+CLIENT_BURST_COOLDOWN_MS;
    s.burst=[];
  }
  writeLocalQuota(s);
  updateQuota();
  scheduleGuardUnlock();
}

function showToast(text) {
  let el=document.querySelector(".toast");
  if(!el){el=document.createElement("div");el.className="toast";document.body.appendChild(el);}
  el.textContent=text;el.classList.add("show");
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),2600);
}
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if(button) {
      const label=button.querySelector(".action-label");
      if(label) {
        const old=label.textContent;
        label.textContent="Tersalin";
        setTimeout(()=>label.textContent=old,1000);
      } else {
        const old=button.textContent;
        button.textContent="Tersalin";
        setTimeout(()=>button.textContent=old,1000);
      }
    } else showToast("Berhasil disalin.");
  } catch { showToast("Clipboard tidak tersedia di browser ini."); }
}
function extractUrls(text) {
  const matches = String(text).match(/https?:\/\/[^\s)\]}>]+/g) || [];
  const urls = matches.map(url => url.replace(/[.,;:]+$/, ""));
  return [...new Set(urls)].slice(0, 10);
}
function nearBottom() { return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 500; }
// Pesan baru selalu diperlihatkan. Kalau jawabannya tinggi, tampilkan dari ATASNYA supaya terbaca dari awal
// (sebelumnya halaman tidak ikut turun kalau jawaban sebelumnya panjang).
function appendMessageElement(row, {force=true}={}) {
  const wasNearBottom=nearBottom();
  chat.appendChild(row);
  if(force||wasNearBottom){
    const tall=row.getBoundingClientRect().height>window.innerHeight*0.55;
    row.scrollIntoView({block:tall?"start":"nearest",behavior:"smooth"});
  }
}

/* ───────────── Pratinjau website ───────────── */

// Mendaftarkan proyek dari jawaban AI: tab Pratinjau langsung aktif (tanpa harus klik tombol dulu).
function registerProject(project, title="Pratinjau website") {
  activeProject=project;
  previewFrame.srcdoc=buildSrcdoc(project);
  $("previewTitle").textContent=title;
  const files=[];
  if(project.html)files.push("index.html");
  if(project.css)files.push("style.css");
  if(project.js)files.push("script.js");
  $("previewMeta").textContent=`${files.join(" · ")} · sandbox terisolasi`;
  $("previewTab").disabled=false;
  $("previewTab").classList.add("has-preview","fresh");
}
function openPreview(project, title="Pratinjau website") {
  if(project&&project!==activeProject)registerProject(project,title);
  if(!activeProject)return;
  switchView("preview");
}
function switchView(view) {
  const isPreview=view==="preview"&&!!activeProject;
  chatView.hidden=isPreview;
  previewView.hidden=!isPreview;
  document.body.classList.toggle("preview-mode",isPreview);
  $("chatTab").classList.toggle("active",!isPreview);
  $("previewTab").classList.toggle("active",isPreview);
  $("chatTab").setAttribute("aria-selected",String(!isPreview));
  $("previewTab").setAttribute("aria-selected",String(isPreview));
  if(isPreview)$("previewTab").classList.remove("fresh");
  $("composeMode").textContent=isPreview?"PREVIEW":"CHAT";
  $("workspaceCaption").textContent=isPreview?"PREVIEW SANDBOX":"RUANG KERJA PRIBADI";
  if(!isPreview&&document.fullscreenElement)document.exitFullscreen?.().catch(()=>{});
  window.scrollTo(0,0);
}
function toggleFullscreen() {
  const el=previewFrameWrap;
  if(document.fullscreenElement||document.webkitFullscreenElement){
    (document.exitFullscreen||document.webkitExitFullscreen).call(document);
    return;
  }
  const request=el.requestFullscreen||el.webkitRequestFullscreen;
  if(!request){showToast("Layar penuh tidak didukung browser ini.");return;}
  Promise.resolve(request.call(el)).catch(()=>showToast("Layar penuh tidak didukung browser ini."));
}

/* ───────────── Pesan ───────────── */

function addAssistantActions(row, content, elapsedMs, usedThink, sources=[], webSearched=false, notes=[]) {
  const wrap=document.createElement("div");wrap.className="assistant-actions";
  const makeButton=(label,icon,fn)=>{
    const b=document.createElement("button");b.type="button";b.className="action-btn";b.innerHTML=`<span class="action-icon">${icon}</span><span class="action-label">${label}</span>`;b.addEventListener("click",fn);return b;
  };
  wrap.appendChild(makeButton("Salin",icons.copy, e=>{}));
  const copyBtn=wrap.lastElementChild;
  copyBtn.addEventListener("click",()=>copyText(content,copyBtn));
  const like=makeButton("Suka",icons.like,()=>{like.classList.toggle("selected");dislike.classList.remove("selected");});
  const dislike=makeButton("Kurang cocok",icons.dislike,()=>{dislike.classList.toggle("selected");like.classList.remove("selected");});
  wrap.append(like,dislike);
  const share=makeButton("Bagikan",icons.share,async()=>{
    try { if(navigator.share) await navigator.share({title:"ZennNyx AI",text:content.slice(0,1800)}); else await copyText(content); } catch {}
  });
  wrap.appendChild(share);

  const liveSources=Array.isArray(sources)?sources.filter(s=>s&&typeof s.url==="string"&&safeUrl(s.url)!=="#").slice(0,8):[];
  const fallbackUrls=webSearched?[]:extractUrls(content).map(url=>({title:url,url,domain:(()=>{try{return new URL(url).hostname}catch{return ""}})()}));
  const sourceList=liveSources.length?liveSources:fallbackUrls;
  const source=makeButton("Sources",icons.link,()=>{
    row.querySelectorAll(".sources-popover").forEach(el=>el.remove());
    if(!sourceList.length)return;
    const pop=document.createElement("div");pop.className="sources-popover";
    const heading=document.createElement("div");heading.className="sources-title";heading.textContent=webSearched?"Sumber dari web untuk jawaban ini":"Tautan yang disebut dalam jawaban";
    pop.appendChild(heading);
    sourceList.forEach((s,i)=>{
      const a=document.createElement("a");a.href=safeUrl(s.url);a.target="_blank";a.rel="noopener noreferrer";
      a.textContent=`${i+1}. ${s.title||s.url}${s.domain?` — ${s.domain}`:""}`;pop.appendChild(a);
      if(s.snippet){const p=document.createElement("p");p.className="source-snippet";p.textContent=s.snippet;pop.appendChild(p);}
    });
    row.appendChild(pop);
  });
  source.disabled=!sourceList.length;
  wrap.appendChild(source);

  const project=extractProjectFiles(content);
  if(project) {
    const preview=makeButton("Pratinjau",icons.preview,()=>openPreview(project,"Pratinjau website"));
    preview.classList.add("primary");
    wrap.appendChild(preview);
  }

  const elapsed=(Math.max(0,elapsedMs)/1000).toFixed(1);
  const meta=document.createElement("div");meta.className="answer-meta";
  meta.textContent=`Dibuat ${elapsed} dtk${usedThink?" · Think Harder":""}${webSearched?" · Web dicari":""}`;
  const answer=row.querySelector(".answer");
  const noteEls=notes.map(text=>{const n=document.createElement("div");n.className="answer-note";n.textContent=text;return n;});
  const top=[meta,...noteEls];
  if(project){
    // Tombol pratinjau ditaruh di ATAS jawaban, supaya langsung kelihatan tanpa menggulir melewati kode panjang.
    const cta=document.createElement("button");cta.type="button";cta.className="preview-cta";
    cta.innerHTML=`<span class="action-icon">${icons.preview}</span><span>Buka pratinjau layar penuh</span><span aria-hidden="true">→</span>`;
    cta.addEventListener("click",()=>openPreview(project,"Pratinjau website"));
    top.push(cta);
  }
  answer.prepend(...top);
  row.appendChild(wrap);
  const disclaimer=document.createElement("div");disclaimer.className="answer-disclaimer";disclaimer.textContent="ZennNyx AI bisa keliru. Cek ulang info penting.";row.appendChild(disclaimer);
}

function addMessage(role, content, options={}) {
  const {elapsedMs=0,usedThink=false,imageData=null,sources=[],webSearched=false,notes=[]}=options;
  const row=document.createElement("article");
  row.className=`message ${role}`;
  row.style.animation="rise-in .22s ease both";
  const body=document.createElement("div");body.className=role==="assistant"?"answer":"bubble";
  if(role==="assistant") {
    body.innerHTML=renderMarkdown(content);
  } else {
    body.textContent=content;
    body.style.whiteSpace="pre-wrap";
  }
  if(role==="user"&&imageData) {
    const img=document.createElement("img");img.className="message-image";img.src=imageData;img.alt="Lampiran gambar";body.prepend(img);
  }
  row.appendChild(body);
  if(role==="assistant")addAssistantActions(row,content,elapsedMs,usedThink,sources,webSearched,notes);
  row.querySelectorAll("[data-copy-code]").forEach(btn=>btn.addEventListener("click",()=>copyText(decodeURIComponent(btn.dataset.copyCode||""),btn)));
  appendMessageElement(row);
  if(role==="assistant")hydrateMath(body);
  return row;
}

// Pesan error + tombol "Kirim ulang" supaya tidak perlu mengetik ulang.
function addErrorMessage(text, retry) {
  const row=document.createElement("article");
  row.className="message assistant error";
  row.style.animation="rise-in .22s ease both";
  const body=document.createElement("div");body.className="answer";
  const msg=document.createElement("div");msg.className="error-text";msg.textContent=text;
  body.appendChild(msg);
  if(retry) {
    const actions=document.createElement("div");actions.className="error-actions";
    const btn=document.createElement("button");btn.type="button";btn.className="retry-btn";
    btn.innerHTML=`<span class="action-icon">${icons.retry}</span><span>Kirim ulang</span>`;
    btn.addEventListener("click",()=>retry(row));
    const hint=document.createElement("small");hint.textContent="Pesanmu masih tersimpan. Boleh ganti model dulu, lalu kirim ulang.";
    actions.append(btn,hint);body.appendChild(actions);
  }
  row.appendChild(body);
  appendMessageElement(row);
  return row;
}
function addTyping() {
  const row=document.createElement("article");row.id="typing";row.className="message assistant";
  row.innerHTML='<div class="answer typing"><span></span><span></span><span></span></div>';
  appendMessageElement(row);
}
function removeTyping() { $("typing")?.remove(); }
function resizeInput() { input.style.height="auto";input.style.height=`${Math.min(Math.max(input.scrollHeight,35),180)}px`; }
function togglePopover(el, open) {
  if(open){el.hidden=false;} else {el.hidden=true;}
}
function updateThinkMenu() {thinkMenuBtn.setAttribute("aria-pressed",String(thinkHarder));}
function setThinkHarder(value) {thinkHarder=Boolean(value);updateThinkMenu();togglePopover(attachPopover,false);showToast(thinkHarder?"Think Harder aktif":"Think Harder nonaktif");}

function updateWebMenu() {
  webMenuBtn.setAttribute("aria-pressed",String(webMode==="on"));
  $("webMenuHint").textContent=!webAvailable?"Belum aktif · pasang TAVILY_API_KEY":(webMode==="on"?"Selalu mencari di web":"Otomatis · ketuk untuk selalu cari");
  $("webStatus").textContent=!webAvailable?"Belum dipasang":(webMode==="on"?"Selalu":"Otomatis");
}
function setWebMode(mode) {
  if(!webAvailable){showToast("Web Search belum aktif: TAVILY_API_KEY belum dipasang di Vercel.");togglePopover(attachPopover,false);return;}
  webMode=mode==="on"?"on":"auto";
  try{localStorage.setItem("zennnyx_web_mode",webMode);}catch{}
  updateWebMenu();togglePopover(attachPopover,false);
  showToast(webMode==="on"?"Web Search: selalu mencari":"Web Search: otomatis");
}
function showImagePreview(url) {
  pendingImage=url;imagePreview.hidden=false;
  imagePreview.innerHTML=`<img src="${url}" alt="Gambar terpilih"><button type="button" id="removeImage" aria-label="Hapus gambar">×</button>`;
  $("removeImage").addEventListener("click",clearImage);
}
function clearImage() {pendingImage=null;imageInput.value="";cameraInput.value="";imagePreview.hidden=true;imagePreview.innerHTML="";}
async function prepareImage(file) {
  if(!file||!file.type.startsWith("image/"))return;
  if(file.size>12*1024*1024){showToast("Ukuran gambar maksimal 12 MB.");return;}
  try {
    const src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});
    const image=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve(el);el.onerror=reject;el.src=src;});
    const scale=Math.min(1,1600/Math.max(image.width,image.height));
    const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
    canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height);
    showImagePreview(canvas.toDataURL("image/jpeg",.82));
  } catch {showToast("Gagal membaca gambar.");}
}
function normalizeError(status,data) {
  if(data?.error)return data.error;
  if(status===429)return "Limit atau jeda penggunaan tercapai. Coba lagi nanti.";
  if(status===413)return "Pesan atau gambarnya terlalu besar. Coba ukuran yang lebih kecil.";
  if(status===504)return "Server terlalu lama menjawab. Coba kirim ulang atau pilih model yang lebih cepat.";
  return "Ada kendala saat memproses pesan.";
}
function prepareHistoryForRequest() {
  const copy=messages.map(m=>({role:m.role,content:m.content,sources:Array.isArray(m.sources)?m.sources:[]}));
  let newestImage=-1;
  for(let i=copy.length-1;i>=0;i--)if(copy[i].role==="user"&&Array.isArray(copy[i].content)&&copy[i].content.some(p=>p?.type==="image_url")){newestImage=i;break;}
  return copy.map((m,i)=>{
    if(m.role==="user"&&Array.isArray(m.content)&&i!==newestImage) {
      const text=m.content.find(p=>p?.type==="text"&&typeof p.text==="string")?.text;
      return {role:"user",content:text||"User mengirim gambar sebelumnya."};
    }
    if(m.role==="assistant"&&m.sources.length) {
      const sourceInfo=m.sources.slice(0,5).map((s,n)=>`[${n+1}] ${s.title||s.url} — ${s.url}`).join("\n");
      return {role:"assistant",content:`${m.content}\n\n[Sumber web dari jawaban sebelumnya; hanya untuk konteks lanjutan]\n${sourceInfo}`};
    }
    return {role:m.role,content:m.content};
  });
}
function updateSendState() {
  sendBtn.disabled=busy||!String(input.value).trim()&&!pendingImage||!clientCanSend()||modelChoices.length===0;
  const remaining=serverQuota&&serverQuota.day===jakartaDay()?serverQuota.remaining:Math.max(0,DAILY_LIMIT-readLocalQuota().used);
  if(remaining<=0) $("composerHint").textContent="Kuota 20 pesan hari ini habis · kembali besok WIB";
  else if(clientGuardRemaining()>0) $("composerHint").textContent="Jeda sebentar sebelum pesan berikutnya";
  else $("composerHint").textContent="Enter kirim · Shift+Enter baris baru";
  scheduleGuardUnlock();
}

function modelIconMarkup(model) {
  const key=`${String(model?.id||"").toLowerCase()} ${String(model?.name||"").toLowerCase()}`;
  if(/gemini/.test(key)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8 14.5 9.5 22.2 12l-7.7 2.5L12 22.2l-2.5-7.7L1.8 12l7.7-2.5Z"/></svg>';
  if(/nvidia/.test(key)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12c3.5-7.5 16.5-7.5 20 0-3.5 7.5-16.5 7.5-20 0Z"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1.5"/></svg>';
  if(/qwen/.test(key)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.5 8.3 4.8v9.4L12 21.5l-8.3-4.8V7.3Z"/><path d="M8 8h8v8H8zM8 8l8 8M16 8l-8 8"/></svg>';
  if(/deepseek/.test(key)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5c3-4.8 9-5.5 13-1.8 1.4 1.3 2.3 3.1 2.4 5.1.1 2.7-1.9 4.7-4.7 4.7H8.4A5.4 5.4 0 0 1 3 11.1Z"/><path d="M8 11.5c1.6-2.5 5.1-2.5 6.6 0M17.5 7.5l3 1.3-1.2 3"/></svg>';
  if(/gpt|openai/.test(key)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.1 16 5.4v4.5l4 2.3v4.5L16 19l-4 2.2L8 19l-4-2.3v-4.5l4-2.3V5.4Z"/><path d="m8 5.4 8 13.6M16 5.4 8 19M4 12.2h16"/></svg>';
  if(/llama|meta/.test(key)) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 14c2-7 6-8 9.5-2s7.5 5 9.5-2M2.5 9c2 7 6 8 9.5 2s7.5-5 9.5 2"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 14.4 9.6 21.5 12l-7.1 2.4L12 21.5l-2.4-7.1L2.5 12l7.1-2.4Z"/></svg>';
}
function displayModelName(model) {
  return String(model?.name||model?.id||"Model AI")
    .replace(/^\s*open\s*router\s*[:—-]?\s*/ig,"")
    .replace(/\bgrok\b/ig,"")
    .replace(/\s+/g," ")
    .replace(/^[:—-]+\s*/,"")
    .trim();
}
function renderModelPicker() {
  if(!modelPickerList)return;
  modelPickerList.replaceChildren();
  if(!modelChoices.length) {
    const empty=document.createElement("div");
    empty.className="model-picker-empty";
    empty.textContent="Belum ada model aktif. Pasang API key di Vercel.";
    modelPickerList.appendChild(empty);
    return;
  }
  for(const model of modelChoices) {
    const option=document.createElement("button");
    option.type="button";
    option.className="model-picker-option";
    option.setAttribute("role","option");
    option.setAttribute("aria-selected",String(model.value===activeModel));
    option.dataset.modelValue=model.value;
    const icon=document.createElement("span");
    icon.className="model-option-icon";
    icon.innerHTML=modelIconMarkup(model);
    const copy=document.createElement("span");
    copy.className="model-option-copy";
    const title=document.createElement("strong");
    title.textContent=displayModelName(model);
    const desc=document.createElement("small");
    desc.textContent=model.vision?"Bisa menerima gambar":(model.provider==="openrouter"?"Gratis saat ini":(model.description||"Model chat"));
    copy.append(title,desc);
    const check=document.createElement("span");
    check.className="model-option-check";
    check.textContent=model.value===activeModel?"✓":"";
    option.append(icon,copy,check);
    modelPickerList.appendChild(option);
  }
}

function buildModelOptions(models, providers) {
  modelChoices=models.filter(m=>!/grok|x-ai\//i.test(`${m.id||""} ${m.name||""}`));
  modelSelect.replaceChildren();
  webAvailable=Boolean(providers?.webSearch);
  updateWebMenu();
  if(!modelChoices.length) {
    const opt=document.createElement("option");
    opt.value="";
    opt.textContent="API key belum dipasang";
    modelSelect.appendChild(opt);
    $("sidebarModelName").textContent="Belum aktif";
    $("modelProviderBadge").textContent="SETUP";
    renderModelPicker();
    updateSendState();
    return;
  }

  const groups=new Map();
  for(const model of modelChoices){
    if(!groups.has(model.provider))groups.set(model.provider,[]);
    groups.get(model.provider).push(model);
  }
  const hiddenGroupNames={groq:"Groq",gemini:"Gemini",openrouter:"Gratis"};
  for(const [provider,list] of groups) {
    const group=document.createElement("optgroup");
    group.label=hiddenGroupNames[provider]||"Model";
    for(const model of list) {
      const option=document.createElement("option");
      option.value=model.value;
      option.textContent=`${displayModelName(model)}${model.vision?" · Vision":""}`;
      option.title=model.description||model.name;
      option.dataset.provider=model.provider;
      option.dataset.model=model.id;
      group.appendChild(option);
    }
    modelSelect.appendChild(group);
  }

  let saved="";
  try { saved=localStorage.getItem("zennnyx_selected_model")||""; } catch {}
  activeModel=modelChoices.some(m=>m.value===saved)
    ? saved
    : (modelChoices.find(m=>m.value==="groq::openai/gpt-oss-20b")?.value||modelChoices[0].value);
  modelSelect.value=activeModel;
  updateModelLabel();
  renderModelPicker();
  updateSendState();
}
function updateModelLabel() {
  const model=modelChoices.find(m=>m.value===activeModel);
  const label=model?displayModelName(model):"Pilih model";
  $("selectedModelLabel").textContent=label;
  $("sidebarModelName").textContent=label;
  $("modelProviderBadge").textContent=model?"AI":"SETUP";
  if(selectedModelIcon)selectedModelIcon.innerHTML=model?modelIconMarkup(model):modelIconMarkup({name:"AI"});
  if(modelPickerBtn){
    modelPickerBtn.title=model?`Model aktif: ${label}`:"Pilih model AI";
    modelPickerBtn.setAttribute("aria-label",model?`Model aktif ${label}. Klik untuk mengganti model.`:"Pilih model AI");
  }
  renderModelPicker();
}
async function loadModels() {
  try {
    const response=await fetch("/api/models",{cache:"no-store"});
    const data=await response.json();
    if(!response.ok)throw new Error("models");
    buildModelOptions(Array.isArray(data.models)?data.models:[],data.providers||{});
  } catch {
    modelSelect.innerHTML='<option value="">Gagal memuat model</option>';
    $("sidebarModelName").textContent="Koneksi gagal";
    updateSendState();
  }
}
async function loadQuota() {
  try {
    const response=await fetch("/api/chat",{method:"GET",cache:"no-store",credentials:"same-origin"});
    const data=await response.json();
    if(response.ok)updateQuota(data.quota);
  } catch {}
  updateQuota();
  updateSendState();
}

/* ───────────── Kirim / kirim ulang ───────────── */

async function sendMessage() {
  const text=input.value.trim();
  if((!text&&!pendingImage)||busy)return;
  if(!modelChoices.length){showToast("Belum ada model aktif. Periksa API key di Vercel.");return;}
  const imageData=pendingImage;
  const active=modelChoices.find(m=>m.value===activeModel);
  if(imageData&&active&&!active.vision&&active.provider==="openrouter"){
    showToast("Model ini tidak bisa membaca gambar. Pilih model yang bertanda \"Bisa menerima gambar\".");
    return;
  }
  if(!clientCanSend()){
    updateQuota();
    showToast(serverQuota?.remaining===0?"Jatah 20 pesan hari ini habis.": "Tunggu sebentar sebelum mengirim lagi.");
    return;
  }
  document.getElementById("welcome")?.remove();
  document.querySelectorAll(".sources-popover").forEach(el=>el.remove());
  togglePopover(attachPopover,false);
  const userContent=imageData?[{type:"text",text:text||"Tolong analisis gambar ini."},{type:"image_url",image_url:{url:imageData}}]:text;
  addMessage("user",text||"Analisis gambar ini.",{imageData});
  input.value="";resizeInput();clearImage();closeKeyboard();
  switchView("chat");
  await runRequest(userContent);
}

async function retryRequest(errorRow, userContent) {
  if(busy)return;
  if(!clientCanSend()){
    updateQuota();
    showToast(serverQuota?.remaining===0?"Jatah 20 pesan hari ini habis.":"Tunggu sebentar sebelum mengirim lagi.");
    return;
  }
  const active=modelChoices.find(m=>m.value===activeModel);
  const hasImage=Array.isArray(userContent)&&userContent.some(p=>p?.type==="image_url");
  if(hasImage&&active&&!active.vision&&active.provider==="openrouter"){
    showToast("Pesan ini berisi gambar. Pilih model yang bertanda \"Bisa menerima gambar\".");
    return;
  }
  errorRow.remove();
  switchView("chat");
  await runRequest(userContent);
}

async function runRequest(userContent) {
  busy=true;
  updateSendState();
  attachBtn.disabled=true;voiceBtn.disabled=true;
  const quotaBackup=readLocalQuota();
  recordClientSend();
  messages.push({role:"user",content:userContent});
  addTyping();
  const started=performance.now();
  let responseData={};
  try {
    const response=await fetch("/api/chat",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      credentials:"same-origin",
      body:JSON.stringify({messages:prepareHistoryForRequest(),thinkHarder,modelChoice:activeModel,webSearch:webMode})
    });
    responseData=await response.json().catch(()=>({}));
    if(responseData.quota)updateQuota(responseData.quota);
    const delay=Math.max(0,900-(performance.now()-started));
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    removeTyping();
    if(!response.ok)throw Object.assign(new Error(normalizeError(response.status,responseData)),{isApiError:true});
    const reply=responseData.reply||"Hmm, model nggak mengembalikan jawaban.";
    const elapsed=performance.now()-started;
    const sources=Array.isArray(responseData.sources)?responseData.sources:[];
    const notes=[];
    if(responseData.searchError)notes.push(`Web search tidak jalan: ${responseData.searchError}`);
    if(responseData.fallbackFrom&&responseData.model){
      const nameOf=id=>{const m=modelChoices.find(x=>x.id===id);return m?displayModelName(m):String(id).replace(/:free$/,"").split("/").pop();};
      notes.push(`${nameOf(responseData.fallbackFrom)} sedang bermasalah, jadi dijawab otomatis oleh ${nameOf(responseData.model)}.`);
    }
    addMessage("assistant",reply,{elapsedMs:elapsed,usedThink:Boolean(responseData.thinkHarder),sources,webSearched:Boolean(responseData.webSearched),notes});
    messages.push({role:"assistant",content:reply,sources});
    if(messages.length>16)messages=messages.slice(-16);
    const project=extractProjectFiles(reply);
    if(project){
      registerProject(project,"Pratinjau website");
      showToast("Website siap — buka tab Pratinjau");
    }
    $("workspaceCaption").textContent="RUANG KERJA PRIBADI";
  } catch(error) {
    const delay=Math.max(0,900-(performance.now()-started));
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    removeTyping();
    // Pesan user tidak masuk riwayat model kalau gagal; tetap tampil di layar dan bisa dikirim ulang.
    if(messages.length&&messages[messages.length-1]?.role==="user")messages.pop();
    // Jatah dikembalikan: error provider bukan salah user (server juga sudah mengembalikannya).
    if(responseData.rejected){
      const s=readLocalQuota();s.used=quotaBackup.used;writeLocalQuota(s);
    } else {
      writeLocalQuota(quotaBackup);
      if(!responseData.quota)loadQuota(); // gagal jaringan: sinkronkan jatah dari server
    }
    const exhausted=Boolean(responseData.quota)&&Number(responseData.quota.remaining)<=0;
    addErrorMessage(error.message||"Ada masalah saat memproses permintaan.",exhausted?null:row=>retryRequest(row,userContent));
  } finally {
    busy=false;attachBtn.disabled=false;voiceBtn.disabled=false;
    updateQuota(responseData.quota);
    updateSendState();
  }
}

function closeKeyboard() {input.blur();}
function resetToNewChat() {
  if(busy){showToast("Tunggu respons selesai dulu.");return;}
  messages=[];clearImage();input.value="";resizeInput();thinkHarder=false;updateThinkMenu();
  togglePopover(attachPopover,false);togglePopover(modelPickerPopover,false);modelPickerBtn.setAttribute("aria-expanded","false");document.querySelectorAll(".sources-popover").forEach(el=>el.remove());
  chat.replaceChildren();
  const template=$("welcomeTemplate");
  if(template)chat.appendChild(template.content.cloneNode(true));
  bindSuggestions();
  activeProject=null;previewFrame.srcdoc="";$("previewTab").disabled=true;$("previewTab").classList.remove("has-preview","fresh");
  switchView("chat");updateSendState();
}
function bindSuggestions() {
  chat.querySelectorAll("[data-prompt]").forEach(btn=>btn.addEventListener("click",()=>{
    input.value=btn.dataset.prompt;resizeInput();updateSendState();input.focus();
  }));
}
function closeSidebar() {
  sidebar.classList.remove("open");sidebarScrim.hidden=true;
}
function updateKeyboardInset() {
  if(!window.visualViewport)return;
  const vv=window.visualViewport;
  const inset=Math.max(0,window.innerHeight-vv.height-vv.offsetTop);
  document.documentElement.style.setProperty("--keyboard-inset",`${Math.round(inset)}px`);
}
function setupRecognition() {
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){voiceBtn.addEventListener("click",()=>showToast("Input suara belum didukung browser ini."));return;}
  recognition=new SR();recognition.lang="id-ID";recognition.interimResults=true;recognition.continuous=false;recognition.maxAlternatives=1;
  let baseText="";
  recognition.onstart=()=>{recording=true;voiceBtn.classList.add("recording");baseText=input.value.trim();};
  recognition.onresult=e=>{const transcript=[...e.results].map(r=>r[0]?.transcript||"").join("");input.value=(baseText?baseText+" ":"")+transcript;resizeInput();updateSendState();};
  recognition.onerror=e=>{if(e.error==="not-allowed"||e.error==="service-not-allowed")showToast("Izin mikrofon ditolak.");else if(e.error!=="aborted")showToast("Input suara gagal.");};
  recognition.onend=()=>{recording=false;voiceBtn.classList.remove("recording");};
  voiceBtn.addEventListener("click",()=>{if(busy)return;if(recording){recognition.stop();return;}try{recognition.start();}catch{}});
}

composer.addEventListener("submit",e=>{e.preventDefault();sendMessage();});
modelSelect.addEventListener("change",()=>{
  activeModel=modelSelect.value;
  try{localStorage.setItem("zennnyx_selected_model",activeModel);}catch{}
  updateModelLabel();updateSendState();renderModelPicker();
});
$("chatTab").addEventListener("click",()=>switchView("chat"));
$("previewTab").addEventListener("click",()=>{if(activeProject)switchView("preview");});
$("copyProjectBtn").addEventListener("click",()=>{if(activeProject)copyText(buildSrcdoc(activeProject));});
$("refreshPreviewBtn").addEventListener("click",()=>{if(activeProject)previewFrame.srcdoc=buildSrcdoc(activeProject);});
$("fullscreenBtn").addEventListener("click",toggleFullscreen);
attachBtn.addEventListener("click",e=>{
  e.stopPropagation();
  togglePopover(modelPickerPopover,false);
  togglePopover(attachPopover,attachPopover.hidden);
});
modelPickerBtn.addEventListener("click",e=>{
  e.stopPropagation();
  togglePopover(attachPopover,false);
  togglePopover(modelPickerPopover,modelPickerPopover.hidden);
  modelPickerBtn.setAttribute("aria-expanded",String(modelPickerPopover.hidden===false));
});
modelPickerList.addEventListener("click",e=>{
  const option=e.target.closest("[data-model-value]");
  if(!option)return;
  const chosen=modelChoices.find(m=>m.value===option.dataset.modelValue);
  if(!chosen)return;
  activeModel=chosen.value;
  modelSelect.value=activeModel;
  try{localStorage.setItem("zennnyx_selected_model",activeModel);}catch{}
  updateModelLabel();
  updateSendState();
  togglePopover(modelPickerPopover,false);
  modelPickerBtn.setAttribute("aria-expanded","false");
});
attachPopover.querySelectorAll(".attach-menu-item").forEach(btn=>btn.addEventListener("click",()=>{
  const action=btn.dataset.action;
  if(action==="camera")cameraInput.click();
  if(action==="photo")imageInput.click();
  if(action==="think")setThinkHarder(!thinkHarder);
  if(action==="web")setWebMode(webMode==="on"?"auto":"on");
}));
imageInput.addEventListener("change",()=>{prepareImage(imageInput.files?.[0]);togglePopover(attachPopover,false);});
cameraInput.addEventListener("change",()=>{prepareImage(cameraInput.files?.[0]);togglePopover(attachPopover,false);});
input.addEventListener("input",()=>{resizeInput();updateSendState();});
input.addEventListener("keydown",e=>{
  if(e.key==="Enter"&&!e.isComposing&&!e.shiftKey){
    e.preventDefault();
    sendMessage();
  } else if(e.key==="Enter"&&e.shiftKey){
    requestAnimationFrame(resizeInput);
  }
});
input.addEventListener("paste",e=>{
  const image=[...(e.clipboardData?.items||[])].find(x=>x.type.startsWith("image/"));
  if(image&&!busy){const file=image.getAsFile();if(file){e.preventDefault();prepareImage(file);}}
});
$("menuBtn").addEventListener("click",()=>{sidebar.classList.add("open");sidebarScrim.hidden=false;});
$("sidebarCloseBtn").addEventListener("click",closeSidebar);
sidebarScrim.addEventListener("click",closeSidebar);
$("newChatTopBtn").addEventListener("click",resetToNewChat);
newChatBtn.addEventListener("click",()=>{closeSidebar();resetToNewChat();});
document.addEventListener("click",e=>{
  if(!e.target.closest(".attach-popover")&&!e.target.closest("#attachBtn"))togglePopover(attachPopover,false);
  if(!e.target.closest(".model-picker-popover")&&!e.target.closest("#modelPickerBtn")){
    togglePopover(modelPickerPopover,false);
    modelPickerBtn.setAttribute("aria-expanded","false");
  }
  if(!e.target.closest(".sources-popover")&&!e.target.closest('[aria-label="Sources"]'))document.querySelectorAll(".sources-popover").forEach(el=>el.remove());
});
document.addEventListener("keydown",e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();resetToNewChat();input.focus();}
  if(e.key==="Escape")closeSidebar();
});
if(window.visualViewport){
  window.visualViewport.addEventListener("resize",updateKeyboardInset,{passive:true});
  window.visualViewport.addEventListener("scroll",updateKeyboardInset,{passive:true});
}
input.addEventListener("focus",()=>{updateKeyboardInset();setTimeout(updateKeyboardInset,100);setTimeout(updateKeyboardInset,300);setTimeout(()=>input.scrollIntoView({block:"nearest",behavior:"smooth"}),80);});
input.addEventListener("blur",()=>setTimeout(updateKeyboardInset,140));
// Cadangan: kalau KaTeX telat/terlambat termuat, render ulang rumus yang masih berupa teks.
window.addEventListener("load",()=>hydrateMath(document));
let refitTimer=null;
window.addEventListener("resize",()=>{clearTimeout(refitTimer);refitTimer=setTimeout(()=>refitAllMath(),150);});

const welcomeTemplate=$("welcomeTemplate");
if(!chat.querySelector("#welcome")&&welcomeTemplate)chat.appendChild(welcomeTemplate.content.cloneNode(true));
try{if(localStorage.getItem("zennnyx_web_mode")==="on")webMode="on";}catch{}
setupRecognition();
bindSuggestions();
updateThinkMenu();
updateWebMenu();
resizeInput();
updateQuota();
updateKeyboardInset();
loadModels();
loadQuota();
