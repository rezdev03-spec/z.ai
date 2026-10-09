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
const modelSelect = $("modelSelect");
const sidebar = $("sidebar");
const sidebarScrim = $("sidebarScrim");
const previewFrame = $("previewFrame");
const newChatBtn = $("newChatBtn");

let messages = [];
let pendingImage = null;
let thinkHarder = false;
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
  preview: '<svg viewBox="0 0 24 24"><rect x="2.5" y="3.5" width="19" height="17"/><path d="M2.5 8h19M6 5.8h.1M9 5.8h.1"/></svg>'
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

function escapeHtml(value="") {
  return String(value).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}
function escapeAttr(value="") { return escapeHtml(value).replace(/`/g,"&#96;"); }
function safeUrl(value="") {
  try { const u=new URL(value); return ["http:","https:"].includes(u.protocol)?u.href:"#"; }
  catch { return "#"; }
}
function renderInline(text) {
  let s=escapeHtml(text);
  s=s.replace(/&lt;br\s*\/?&gt;/gi,"<br>");
  s=s.replace(/`([^`]+)`/g,'<code class="inline-code">$1</code>');
  s=s.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");
  s=s.replace(/__(.+?)__/g,"<strong>$1</strong>");
  s=s.replace(/~~(.+?)~~/g,"<del>$1</del>");
  s=s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g,(m,p,url)=>`${p}<a href="${escapeAttr(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);
  s=s.replace(/\*([^*\n]+)\*/g,"<em>$1</em>");
  s=s.replace(/_([^_\n]+)_/g,"<em>$1</em>");
  return s;
}
function parseTable(lines) {
  if (lines.length<2 || !/^[|\s]*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[1])) return null;
  const split=line=>line.trim().replace(/^\|/,"").replace(/\|$/,"").split("|").map(x=>x.trim());
  const head=split(lines[0]);
  if(head.length<2)return null;
  const body=[]; let end=2;
  while(end<lines.length) {
    const raw=lines[end];
    if(!raw.trim() || /^\s*[-*+]\s+/.test(raw) || /^\s*#{1,4}\s+/.test(raw) || /^\s*>/.test(raw))break;
    if(!/^\s*\|?.+\|.+\|?\s*$/.test(raw))break;
    const row=split(raw); if(row.length!==head.length)break;
    body.push(row); end++;
  }
  const normalise=row=>Array.from({length:head.length},(_,i)=>row[i]??"");
  const html=`<div class="table-wrap"><table><thead><tr>${normalise(head).map(x=>`<th>${renderInline(x)}</th>`).join("")}</tr></thead><tbody>${body.map(r=>`<tr>${normalise(r).map(x=>`<td>${renderInline(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  return {html,end};
}
function renderMarkdown(markdown="") {
  const lines=String(markdown).replace(/\r/g,"").split("\n");
  let html="", i=0;
  while(i<lines.length) {
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    if(/^```/.test(line.trim())) {
      const lang=line.trim().slice(3).trim().toLowerCase();
      let j=i+1; while(j<lines.length&&!/^```/.test(lines[j].trim()))j++;
      const code=lines.slice(i+1,j).join("\n");
      html+=`<div class="code-wrap" data-code-lang="${escapeAttr(lang)}"><div class="code-heading"><span>${escapeHtml(lang||"code")}</span><button class="code-copy" type="button" data-copy-code="${encodeURIComponent(code)}">Salin kode</button></div><pre class="code-block"><code>${escapeHtml(code)}</code></pre></div>`;
      i=j+1; continue;
    }
    if(i+1<lines.length&&lines[i].includes("|")) {
      const table=parseTable(lines.slice(i));
      if(table){html+=table.html;i+=table.end;continue;}
    }
    const h=line.match(/^(#{1,4})\s+(.+)$/);
    if(h){html+=`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`;i++;continue;}
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){html+="<hr>";i++;continue;}
    if(/^>\s?/.test(line)){const quote=[];while(i<lines.length&&/^>\s?/.test(lines[i]))quote.push(lines[i++].replace(/^>\s?/,""));html+=`<blockquote>${quote.map(renderInline).join("<br>")}</blockquote>`;continue;}
    if(/^\s*[-*+]\s+/.test(line)){const items=[];while(i<lines.length&&/^\s*[-*+]\s+/.test(lines[i]))items.push(lines[i++].replace(/^\s*[-*+]\s+/,""));html+=`<ul>${items.map(x=>`<li>${renderInline(x)}</li>`).join("")}</ul>`;continue;}
    if(/^\s*\d+[.)]\s+/.test(line)){const items=[];while(i<lines.length&&/^\s*\d+[.)]\s+/.test(lines[i]))items.push(lines[i++].replace(/^\s*\d+[.)]\s+/,""));html+=`<ol>${items.map(x=>`<li>${renderInline(x)}</li>`).join("")}</ol>`;continue;}
    const para=[line.trim()];i++;
    while(i<lines.length&&lines[i].trim()&&!/^```/.test(lines[i].trim())&&!/^#{1,4}\s+/.test(lines[i])&&!/^\s*[-*+]\s+/.test(lines[i])&&!/^\s*\d+[.)]\s+/.test(lines[i])&&!/^>\s?/.test(lines[i])) {
      para.push(lines[i].trim());i++;
    }
    html+=`<p>${para.map(renderInline).join("<br>")}</p>`;
  }
  return `<div class="markdown">${html||"<p></p>"}</div>`;
}
function renderMath(root) {
  if(!root || typeof window.renderMathInElement!=="function")return;
  try {
    window.renderMathInElement(root, {
      delimiters:[
        {left:"$$",right:"$$",display:true},
        {left:"\\[",right:"\\]",display:true},
        {left:"\\(",right:"\\)",display:false},
        {left:"$",right:"$",display:false}
      ],
      throwOnError:false,
      ignoredTags:["script","noscript","style","textarea","pre","code","option"]
    });
  } catch(error) { console.warn("Math render:",error); }
}
function showToast(text) {
  let el=document.querySelector(".toast");
  if(!el){el=document.createElement("div");el.className="toast";document.body.appendChild(el);}
  el.textContent=text;el.classList.add("show");
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),2200);
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
function appendMessageElement(row) {
  const wasNearBottom=nearBottom();
  chat.appendChild(row);
  if(wasNearBottom) row.scrollIntoView({block:"nearest",behavior:"smooth"});
}

function extractProjectFiles(content) {
  const files={html:"",css:"",js:""};
  const regex=/```([a-zA-Z0-9_#+.-]*)[ \t]*\n([\s\S]*?)```/g;
  let match;
  while((match=regex.exec(String(content)))) {
    const label=match[1].toLowerCase();
    if(label==="html"||label==="htm")files.html=match[2].trim();
    else if(label==="css"||label==="scss")files.css=match[2].trim();
    else if(["js","javascript","mjs"].includes(label))files.js=match[2].trim();
  }
  if(!files.html) {
    const raw=String(content).trim();
    if(/<!doctype html|<html[\s>]/i.test(raw))files.html=raw;
  }
  return files.html?files:null;
}
function buildSrcdoc(project) {
  let html=project.html||"<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>";
  if(!/<html[\s>]/i.test(html)) html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`;
  const css=(project.css||"").replace(/<\/style/gi,"<\\/style");
  const js=(project.js||"").replace(/<\/script/gi,"<\\/script");
  const styleTag=css?`<style>\n${css}\n</style>`:"";
  const scriptTag=js?`<script>\n${js}\n<\/script>`:"";
  if(styleTag) {
    if(/<\/head>/i.test(html)) {
      html=html.replace(/<\/head>/i,`${styleTag}</head>`);
    } else if(/<head[\\s>]/i.test(html)) {
      html=html.replace(/<head([^>]*)>/i,`$&${styleTag}`);
    } else if(/<html[\\s>]/i.test(html)) {
      html=html.replace(/<html([^>]*)>/i,`$&<head>${styleTag}</head>`);
    } else {
      html=`<!doctype html><html><head>${styleTag}</head><body>${html}</body></html>`;
    }
  }
  if(scriptTag) {
    if(/<\/body>/i.test(html))html=html.replace(/<\/body>/i,`${scriptTag}</body>`);
    else html+=scriptTag;
  }
  return html;
}
function openPreview(project, title="Pratinjau proyek") {
  activeProject=project;
  previewFrame.srcdoc=buildSrcdoc(project);
  $("previewTitle").textContent=title;
  $("previewTab").disabled=false;
  $("previewTab").classList.add("has-preview");
  const files=[];
  if(project.html)files.push("index.html");
  if(project.css)files.push("style.css");
  if(project.js)files.push("script.js");
  $("projectFilesList").replaceChildren(...files.map(name=>{const n=document.createElement("span");n.className="project-file-chip";n.textContent=name;return n;}));
  $("workspaceCaption").textContent="PREVIEW SANDBOX";
  switchView("preview");
}
function switchView(view) {
  const isPreview=view==="preview"&&!!activeProject;
  chatView.hidden=isPreview;
  previewView.hidden=!isPreview;
  $("chatTab").classList.toggle("active",!isPreview);
  $("previewTab").classList.toggle("active",isPreview);
  $("chatTab").setAttribute("aria-selected",String(!isPreview));
  $("previewTab").setAttribute("aria-selected",String(isPreview));
  $("composeMode").textContent=isPreview?"PREVIEW":"CHAT";
  $("workspaceCaption").textContent=isPreview?"PREVIEW SANDBOX":"RUANG KERJA PRIBADI";
}
function addAssistantActions(row, content, elapsedMs, usedThink, sources=[], webSearched=false) {
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
    const preview=makeButton("Preview",icons.preview,()=>openPreview(project,"Preview hasil kode"));
    wrap.appendChild(preview);
  }

  const elapsed=(Math.max(0,elapsedMs)/1000).toFixed(1);
  const meta=document.createElement("div");meta.className="answer-meta";
  meta.textContent=`Dibuat ${elapsed} dtk${usedThink?" · Think Harder":""}${webSearched?" · Web dicari":""}`;
  const answer=row.querySelector(".answer");
  answer.prepend(meta);
  wrap.querySelectorAll("[data-copy-code]").forEach(()=>{});
  row.appendChild(wrap);
  const disclaimer=document.createElement("div");disclaimer.className="answer-disclaimer";disclaimer.textContent="ZennNyx AI bisa keliru. Cek ulang info penting.";row.appendChild(disclaimer);
}

function addMessage(role, content, options={}) {
  const {isError=false,elapsedMs=0,usedThink=false,imageData=null,sources=[],webSearched=false}=options;
  const row=document.createElement("article");
  row.className=`message ${role}${isError?" error":""}`;
  row.style.animation="rise-in .22s ease both";
  const body=document.createElement("div");body.className=role==="assistant"?"answer":"bubble";
  if(role==="assistant"&&!isError) {
    body.innerHTML=renderMarkdown(content);
    renderMath(body);
  } else if(isError) {
    body.textContent=content;
  } else {
    body.textContent=content;
    body.style.whiteSpace="pre-wrap";
  }
  if(role==="user"&&imageData) {
    const img=document.createElement("img");img.className="message-image";img.src=imageData;img.alt="Lampiran gambar";body.prepend(img);
  }
  row.appendChild(body);
  if(role==="assistant"&&!isError)addAssistantActions(row,content,elapsedMs,usedThink,sources,webSearched);
  row.querySelectorAll("[data-copy-code]").forEach(btn=>btn.addEventListener("click",()=>copyText(decodeURIComponent(btn.dataset.copyCode||""),btn)));
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
  if(status===429)return data?.error||"Limit atau jeda penggunaan tercapai. Coba lagi nanti.";
  if(status===413)return "Pesan atau gambarnya terlalu besar. Coba ukuran yang lebih kecil.";
  return data?.error||"Ada kendala saat memproses pesan.";
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
  else $("composerHint").textContent="Enter untuk baris baru · Kirim lewat tombol panah";
  scheduleGuardUnlock();
}
function buildModelOptions(models, providers) {
  modelChoices=models;
  modelSelect.replaceChildren();
  if(!models.length) {
    const opt=document.createElement("option");opt.value="";opt.textContent="API key belum dipasang";modelSelect.appendChild(opt);
    $("modelDescription")?.remove();
    $("sidebarModelName").textContent="Belum aktif";
    $("modelProviderBadge").textContent="SETUP";
    updateSendState();return;
  }
  const groups=new Map();
  for(const m of models){if(!groups.has(m.provider))groups.set(m.provider,[]);groups.get(m.provider).push(m);}
  const names={groq:"Groq",gemini:"Gemini",openrouter:"OpenRouter · gratis"};
  for(const [provider,list] of groups) {
    const group=document.createElement("optgroup");group.label=names[provider]||provider;
    for(const m of list) {
      const option=document.createElement("option");option.value=m.value;
      option.textContent=`${m.name}${m.vision?" · Vision":""}`;
      option.title=m.description||m.name;
      option.dataset.provider=m.provider;option.dataset.model=m.id;
      group.appendChild(option);
    }
    modelSelect.appendChild(group);
  }
  let saved="";
  try { saved=localStorage.getItem("zennnyx_selected_model")||""; } catch {}
  activeModel=models.some(m=>m.value===saved)?saved:(models.find(m=>m.value==="groq::openai/gpt-oss-20b")?.value||models[0].value);
  modelSelect.value=activeModel;
  updateModelLabel();
  $("webStatus").textContent=providers?.webSearch?"Aktif":"Butuh Tavily key";
  updateSendState();
}
function updateModelLabel() {
  const model=modelChoices.find(m=>m.value===activeModel);
  $("selectedModelLabel").textContent=model?model.name:"Pilih model";
  $("sidebarModelName").textContent=model?model.name:"Belum aktif";
  $("modelProviderBadge").textContent=model?(model.provider==="openrouter"?"OR":model.provider.toUpperCase()):"AI";
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
async function sendMessage() {
  const text=input.value.trim();
  if((!text&&!pendingImage)||busy)return;
  if(!modelChoices.length){showToast("Belum ada model aktif. Periksa API key di Vercel.");return;}
  if(!clientCanSend()){
    updateQuota();
    showToast(serverQuota?.remaining===0?"Jatah 20 pesan hari ini habis.": "Tunggu sebentar sebelum mengirim lagi.");
    return;
  }
  busy=true;
  updateSendState();
  attachBtn.disabled=true;voiceBtn.disabled=true;
  recordClientSend();
  document.getElementById("welcome")?.remove();
  document.querySelectorAll(".sources-popover").forEach(el=>el.remove());
  togglePopover(attachPopover,false);
  const imageData=pendingImage;
  const userContent=imageData?[{type:"text",text:text||"Tolong analisis gambar ini."},{type:"image_url",image_url:{url:imageData}}]:text;
  addMessage("user",text||"Analisis gambar ini.");
  messages.push({role:"user",content:userContent});
  input.value="";resizeInput();clearImage();closeKeyboard();
  switchView("chat");
  addTyping();
  const started=performance.now();
  let responseData={};
  try {
    const response=await fetch("/api/chat",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      credentials:"same-origin",
      body:JSON.stringify({messages:prepareHistoryForRequest(),thinkHarder,modelChoice:activeModel})
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
    addMessage("assistant",reply,{elapsedMs:elapsed,usedThink:Boolean(responseData.thinkHarder),sources,webSearched:Boolean(responseData.webSearched)});
    messages.push({role:"assistant",content:reply,sources});
    if(messages.length>16)messages=messages.slice(-16);
    if(responseData.model) {
      const model=modelChoices.find(m=>m.id===responseData.model);
      if(model){$("selectedModelLabel").textContent=model.name;}
    }
    $("workspaceCaption").textContent="RUANG KERJA PRIBADI";
  } catch(error) {
    const delay=Math.max(0,900-(performance.now()-started));
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    removeTyping();
    addMessage("assistant",error.message||"Ada masalah saat memproses permintaan.",{isError:true});
    // Keep the attempted user message visible in conversation, but don't send it to the model history.
    if(messages.length&&messages[messages.length-1]?.role==="user")messages.pop();
  } finally {
    busy=false;attachBtn.disabled=false;voiceBtn.disabled=false;
    updateQuota(responseData.quota);
    updateSendState();
  }
}
function closeKeyboard() {input.blur();}
function renderWelcome() {
  const source=document.querySelector(".welcome-template");
  if(source)return source.content.cloneNode(true);
  return null;
}
function resetToNewChat() {
  if(busy){showToast("Tunggu respons selesai dulu.");return;}
  messages=[];clearImage();input.value="";resizeInput();thinkHarder=false;updateThinkMenu();
  togglePopover(attachPopover,false);document.querySelectorAll(".sources-popover").forEach(el=>el.remove());
  chat.replaceChildren();
  // Reload the same documented welcome structure from the HTML template.
  const template=$("welcomeTemplate");
  if(template)chat.appendChild(template.content.cloneNode(true));
  bindSuggestions();
  activeProject=null;previewFrame.srcdoc="";$("previewTab").disabled=true;$("previewTab").classList.remove("has-preview");
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
  updateModelLabel();updateSendState();
});
$("chatTab").addEventListener("click",()=>switchView("chat"));
$("previewTab").addEventListener("click",()=>{if(activeProject)switchView("preview");});
$("copyProjectBtn").addEventListener("click",()=>{if(activeProject)copyText(buildSrcdoc(activeProject));});
$("refreshPreviewBtn").addEventListener("click",()=>{if(activeProject)previewFrame.srcdoc=buildSrcdoc(activeProject);});
attachBtn.addEventListener("click",e=>{e.stopPropagation();togglePopover(attachPopover,attachPopover.hidden);});
attachPopover.querySelectorAll(".attach-menu-item").forEach(btn=>btn.addEventListener("click",()=>{
  const action=btn.dataset.action;
  if(action==="camera")cameraInput.click();
  if(action==="photo")imageInput.click();
  if(action==="think")setThinkHarder(!thinkHarder);
}));
imageInput.addEventListener("change",()=>{prepareImage(imageInput.files?.[0]);togglePopover(attachPopover,false);});
cameraInput.addEventListener("change",()=>{prepareImage(cameraInput.files?.[0]);togglePopover(attachPopover,false);});
input.addEventListener("input",()=>{resizeInput();updateSendState();});
input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.isComposing)requestAnimationFrame(resizeInput);});
input.addEventListener("paste",e=>{
  const image=[...(e.clipboardData?.items||[])].find(x=>x.type.startsWith("image/"));
  if(image&&!busy){const file=image.getAsFile();if(file){e.preventDefault();prepareImage(file);}}
});
$("menuBtn").addEventListener("click",()=>{sidebar.classList.add("open");sidebarScrim.hidden=false;});
$("sidebarCloseBtn").addEventListener("click",closeSidebar);
sidebarScrim.addEventListener("click",closeSidebar);
$("newChatTopBtn").addEventListener("click",resetToNewChat);
newChatBtn.addEventListener("click",resetToNewChat);
document.addEventListener("click",e=>{
  if(!e.target.closest(".attach-popover")&&!e.target.closest("#attachBtn"))togglePopover(attachPopover,false);
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
const welcomeTemplate=$("welcomeTemplate");
if(!chat.querySelector("#welcome")&&welcomeTemplate)chat.appendChild(welcomeTemplate.content.cloneNode(true));
setupRecognition();
bindSuggestions();
updateThinkMenu();
resizeInput();
updateQuota();
updateKeyboardInset();
loadModels();
loadQuota();
