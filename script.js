const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const imageInput = document.getElementById('imageInput');
const cameraInput = document.getElementById('cameraInput');
const imagePreview = document.getElementById('imagePreview');
const voiceBtn = document.getElementById('voiceBtn');
const attachPopover = document.getElementById('attachPopover');
const thinkMenuBtn = document.getElementById('thinkMenuBtn');
const menuBtn = document.getElementById('menuBtn');
const newChatBtn = document.getElementById('newChatBtn');
const aboutPopover = document.getElementById('aboutPopover');

let messages = [];
let pendingImage = null;
let thinkHarder = false;
let busy = false;
let toastTimer = null;
let recognition = null;
let recording = false;

// ZennNyx anti-spam guard: mostly invisible client-side protection.
const GUARD_KEY = 'zennnyx_guard_v1';
const GUARD_COOLDOWN_MS = 5000;
const BURST_WINDOW_MS = 60000;
const BURST_LIMIT = 3;
const BURST_COOLDOWN_MS = 10000;
const HOUR_WINDOW_MS = 60 * 60 * 1000;
const HOUR_LIMIT = 20;
const MIN_RESPONSE_DELAY_MS = 1600;
let guardTimer = null;

function readGuardState(){
  const fallback={lastSentAt:0,burstSends:[],hourSends:[],blockedUntil:0};
  try{
    const parsed=JSON.parse(localStorage.getItem(GUARD_KEY)||'null');
    if(!parsed||typeof parsed!=='object')return fallback;
    const now=Date.now();
    return {
      lastSentAt:Number(parsed.lastSentAt)||0,
      burstSends:Array.isArray(parsed.burstSends)?parsed.burstSends.filter(t=>Number.isFinite(t)&&now-t<BURST_WINDOW_MS):[],
      hourSends:Array.isArray(parsed.hourSends)?parsed.hourSends.filter(t=>Number.isFinite(t)&&now-t<HOUR_WINDOW_MS):[],
      blockedUntil:Number(parsed.blockedUntil)||0
    };
  }catch{return fallback}
}
function writeGuardState(state){
  try{localStorage.setItem(GUARD_KEY,JSON.stringify(state))}catch{}
}
function guardStatus(){
  const state=readGuardState();
  const now=Date.now();
  const recentHour=state.hourSends.filter(t=>now-t<HOUR_WINDOW_MS);
  const recentBurst=state.burstSends.filter(t=>now-t<BURST_WINDOW_MS);
  const hourLocked=recentHour.length>=HOUR_LIMIT;
  const hourUntil=hourLocked?((recentHour[0]||now)+HOUR_WINDOW_MS):0;
  const blockedUntil=Math.max(state.blockedUntil,hourUntil);
  if(recentHour.length!==state.hourSends.length||recentBurst.length!==state.burstSends.length){
    writeGuardState({...state,hourSends:recentHour,burstSends:recentBurst,blockedUntil});
  }
  const cooldownUntil=Math.max(state.lastSentAt+GUARD_COOLDOWN_MS,blockedUntil);
  return {state:{...state,hourSends:recentHour,burstSends:recentBurst,blockedUntil},blockedUntil:cooldownUntil,remaining:Math.max(0,cooldownUntil-now)};
}
function scheduleGuardUnlock(){
  clearTimeout(guardTimer);
  const {remaining}=guardStatus();
  if(remaining>0)guardTimer=setTimeout(()=>{guardTimer=null;updateSendState()},Math.min(remaining+60,2147483647));
}
function guardCanSend(){return guardStatus().remaining<=0}
function recordGuardSend(){
  const now=Date.now();
  const state=readGuardState();
  state.hourSends=state.hourSends.filter(t=>now-t<HOUR_WINDOW_MS);
  state.burstSends=state.burstSends.filter(t=>now-t<BURST_WINDOW_MS);
  state.hourSends.push(now);
  state.burstSends.push(now);
  state.lastSentAt=now;
  if(state.burstSends.length>=BURST_LIMIT){
    state.blockedUntil=now+BURST_COOLDOWN_MS;
    state.burstSends=[];
  }
  writeGuardState(state);
  scheduleGuardUnlock();
}

const icons = {
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 16V5a2 2 0 0 1 2-2h9"></path></svg>',
  like: '<svg viewBox="0 0 24 24"><path d="M7 10v11H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3Z"></path><path d="M7 21h9.5a2 2 0 0 0 1.9-1.4l2.2-6.5A2 2 0 0 0 18.7 10H14l.7-4.1A3.3 3.3 0 0 0 11.5 2L7 10"></path></svg>',
  dislike: '<svg viewBox="0 0 24 24"><path d="M7 14V3H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3Z"></path><path d="M7 3h9.5a2 2 0 0 1 1.9 1.4l2.2 6.5A2 2 0 0 1 18.7 14H14l.7 4.1A3.3 3.3 0 0 1 11.5 22L7 14"></path></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 16V3"></path><path d="m7 8 5-5 5 5"></path><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"></path></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"></path><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 7 20l1.1-1.1"></path></svg>'
};

function escapeHtml(value='') {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function escapeAttr(value=''){return escapeHtml(value).replace(/`/g,'&#96;');}
function safeUrl(value='') { try { const u = new URL(value); return ['http:','https:'].includes(u.protocol) ? u.href : '#'; } catch { return '#'; } }
function renderInline(text){let s=escapeHtml(text);s=s.replace(/&lt;br\s*\/?&gt;/gi,'<br>');s=s.replace(/`([^`]+)`/g,'<code class="inline-code">$1</code>');s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');s=s.replace(/__(.+?)__/g,'<strong>$1</strong>');s=s.replace(/~~(.+?)~~/g,'<del>$1</del>');s=s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g,(m,p,url)=>`${p}<a href="${escapeAttr(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);s=s.replace(/\*([^*\n]+)\*/g,'<em>$1</em>');s=s.replace(/_([^_\n]+)_/g,'<em>$1</em>');return s;}
function parseTable(lines){
  if(lines.length<2||!/^[|\s]*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[1]))return null;
  const split=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(x=>x.trim());
  const head=split(lines[0]);if(head.length<2)return null;
  const body=[];let end=2;
  while(end<lines.length){const raw=lines[end];if(!raw.trim())break;if(/^\s*[-*+]>?\s+/.test(raw)||/^\s*#{1,4}\s+/.test(raw)||/^>/.test(raw))break;if(!/^\s*\|?.+\|.+\|?\s*$/.test(raw))break;const row=split(raw);if(row.length!==head.length)break;body.push(row);end++;}
  const cols=head.length;const norm=r=>Array.from({length:cols},(_,i)=>r[i]??'');
  const html=`<div class="table-wrap"><table><thead><tr>${norm(head).map(c=>`<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r=>`<tr>${norm(r).map(c=>`<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return {html,end};
}
function renderMarkdown(md=''){
  const lines=String(md).replace(/\r/g,'').split('\n');let html='',i=0;
  while(i<lines.length){const line=lines[i];if(!line.trim()){i++;continue;}
    if(/^```/.test(line.trim())){const lang=line.trim().slice(3).trim();let j=i+1;while(j<lines.length&&!/^```/.test(lines[j].trim()))j++;const code=lines.slice(i+1,j).join('\n');const encoded=encodeURIComponent(code);html+=`<div class="code-wrap"><pre class="code-block"><code>${escapeHtml(code)}</code></pre><button class="code-copy" type="button" data-copy-code="${encoded}" aria-label="Copy code">Copy</button></div>`;i=j+1;continue;}
    if(i+1<lines.length&&lines[i].includes('|')){const table=parseTable(lines.slice(i));if(table){html+=table.html;i+=table.end;continue;}}
    const heading=line.match(/^(#{1,4})\s+(.+)$/);if(heading){html+=`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`;i++;continue;}
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){html+='<hr>';i++;continue;}
    if(/^>\s?/.test(line)){const q=[];while(i<lines.length&&/^>\s?/.test(lines[i])){q.push(lines[i].replace(/^>\s?/,'').trim());i++;}html+=`<blockquote>${q.map(renderInline).join('<br>')}</blockquote>`;continue;}
    if(/^\s*[-*+]\s+/.test(line)){const items=[];while(i<lines.length&&/^\s*[-*+]\s+/.test(lines[i])){items.push(lines[i].replace(/^\s*[-*+]\s+/,''));i++;}html+=`<ul>${items.map(x=>`<li>${renderInline(x)}</li>`).join('')}</ul>`;continue;}
    if(/^\s*\d+[.)]\s+/.test(line)){const items=[];while(i<lines.length&&/^\s*\d+[.)]\s+/.test(lines[i])){items.push(lines[i].replace(/^\s*\d+[.)]\s+/,''));i++;}html+=`<ol>${items.map(x=>`<li>${renderInline(x)}</li>`).join('')}</ol>`;continue;}
    const para=[line.trim()];i++;while(i<lines.length&&lines[i].trim()&&!/^```/.test(lines[i].trim())&&!/^#{1,4}\s+/.test(lines[i])&&!/^\s*[-*+]\s+/.test(lines[i])&&!/^\s*\d+[.)]\s+/.test(lines[i])&&!/^>\s?/.test(lines[i])){para.push(lines[i].trim());i++;}html+=`<p>${para.map(renderInline).join('<br>')}</p>`;
  }
  return `<div class="markdown">${html||'<p></p>'}</div>`;
}
function showToast(text){let t=document.querySelector('.toast');if(!t){t=document.createElement('div');t.className='toast';document.body.appendChild(t);}t.textContent=text;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),1700);}
async function copyText(text,button){try{await navigator.clipboard.writeText(text);if(button){const label=button.querySelector('.action-label');if(label){const old=label.textContent;label.textContent='Copied';button.classList.add('selected');setTimeout(()=>{label.textContent=old;button.classList.remove('selected')},1100);}}else showToast('Copied');}catch{showToast('Could not copy');}}
function extractUrls(text){return [...new Set((String(text).match(/https?:\/\/[^\s)\]}>]+/g)||[]).map(u=>u.replace(/[.,;:]+$/,'')))].slice(0,12);}
function addAssistantActions(row,content,elapsedMs,usedThink,sources=[],webSearched=false){
  const wrap=document.createElement('div');wrap.className='assistant-actions';
  const copy=document.createElement('button');copy.type='button';copy.className='action-btn';copy.setAttribute('aria-label','Copy');copy.innerHTML=`<span class="action-icon">${icons.copy}</span><span class="action-label">Copy</span>`;copy.addEventListener('click',()=>copyText(content,copy));
  const like=document.createElement('button');like.type='button';like.className='action-btn';like.setAttribute('aria-label','Like');like.innerHTML=`<span class="action-icon">${icons.like}</span>`;
  const dislike=document.createElement('button');dislike.type='button';dislike.className='action-btn';dislike.setAttribute('aria-label','Dislike');dislike.innerHTML=`<span class="action-icon">${icons.dislike}</span>`;
  like.addEventListener('click',()=>{like.classList.toggle('selected');dislike.classList.remove('selected')});dislike.addEventListener('click',()=>{dislike.classList.toggle('selected');like.classList.remove('selected')});
  const share=document.createElement('button');share.type='button';share.className='action-btn';share.setAttribute('aria-label','Share');share.innerHTML=`<span class="action-icon">${icons.share}</span>`;share.addEventListener('click',async()=>{try{if(navigator.share)await navigator.share({title:'ZennNyx AI',text:content.slice(0,1500)});else await copyText(content)}catch{}});

  const liveSources=Array.isArray(sources)
    ? sources.filter(s=>s&&typeof s.url==='string'&&safeUrl(s.url)!=='#').slice(0,8)
    : [];

  const fallbackUrls=extractUrls(content).map(u=>({
    title:u,
    url:u,
    snippet:'Link referenced in the answer.'
  }));

  // Never show old/quoted URLs as "Sources" for a live-searched answer.
  const sourceList=liveSources.length
    ? liveSources
    : (webSearched ? [] : fallbackUrls);

  const source=document.createElement('button');source.type='button';source.className=`action-btn ${sourceList.length?'':'disabled'}`;source.setAttribute('aria-label','Sources');source.innerHTML=`<span class="action-icon">${icons.link}</span><span class="action-label">Sources</span>`;source.disabled=!sourceList.length;
  source.addEventListener('click',()=>{
    row.querySelectorAll('.sources-popover').forEach(e=>e.remove());
    if(!sourceList.length)return;
    const pop=document.createElement('div');pop.className='sources-popover';
    pop.innerHTML=`<div class="sources-title">Sources</div>${sourceList.map((s,i)=>{
      const url=safeUrl(s.url);
      const title=escapeHtml(s.title||s.url);
      const domain=s.domain?` — ${escapeHtml(s.domain)}`:'';
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${i+1}. ${title}${domain}</a>`;
    }).join('')}`;
    row.appendChild(pop);requestAnimationFrame(()=>pop.classList.add('open'));
  });

  const meta=document.createElement('div');
  meta.className='answer-meta';
  const seconds=(elapsedMs/1000).toFixed(1);
  meta.textContent=`Generated for ${seconds}s${usedThink?' · Think Harder':''}${webSearched?' · Web searched':''}`;row.querySelector('.answer').prepend(meta);
  wrap.append(copy,like,dislike,share,source);row.appendChild(wrap);
  const disclaimer=document.createElement('div');disclaimer.className='answer-disclaimer';disclaimer.textContent='ZennNyx AI can make mistakes. Check important information.';row.appendChild(disclaimer);
  row.querySelectorAll('.code-copy').forEach(b=>b.addEventListener('click',()=>copyText(decodeURIComponent(b.dataset.copyCode||''),b)));
}
function addMessage(role,content,isError=false,elapsedMs=0,usedThink=false,imageData=null,sources=[],webSearched=false){const row=document.createElement('div');row.className=`message ${role}${isError?' error':''}`;row.classList.add(role==='assistant'?'assistant-enter':'message-enter');row.style.animation=role==='assistant'?'assistantIn .95s cubic-bezier(.16,1,.3,1) both':'messageIn .85s cubic-bezier(.16,1,.3,1) both';const contentEl=document.createElement('div');contentEl.className=role==='assistant'?'answer':'bubble';if(role==='assistant'&&!isError)contentEl.innerHTML=renderMarkdown(content);else contentEl.innerHTML=isError?`<strong>${escapeHtml(content)}</strong>`:escapeHtml(content).replace(/\n/g,'<br>');if(role==='user'&&imageData){const img=document.createElement('img');img.className='message-image';img.src=imageData;img.alt='Attached image';contentEl.prepend(img);}row.appendChild(contentEl);chat.appendChild(row);if(role==='assistant'&&!isError)addAssistantActions(row,content,elapsedMs,usedThink,sources,webSearched);return row;}
function addTyping(){const row=document.createElement('div');row.id='typing';row.className='message assistant responding';row.innerHTML='<div class="answer typing"><span></span><span></span><span></span></div>';chat.appendChild(row)}
function removeTyping(){document.getElementById('typing')?.remove()}
function resizeInput(){input.style.height='auto';input.style.height=Math.min(Math.max(input.scrollHeight,42),180)+'px'}
function closeKeyboard(){input.blur();document.activeElement?.blur?.()}
function updateThinkMenu(){thinkMenuBtn.setAttribute('aria-pressed',String(thinkHarder));}
function togglePopover(el,open){if(open){el.hidden=false;requestAnimationFrame(()=>el.classList.add('open'))}else{el.classList.remove('open');setTimeout(()=>{if(!el.classList.contains('open'))el.hidden=true},340)}}
function setThinkHarder(value){thinkHarder=Boolean(value);updateThinkMenu();togglePopover(attachPopover,false)}
function showImagePreview(dataUrl){pendingImage=dataUrl;imagePreview.hidden=false;imagePreview.innerHTML=`<img src="${dataUrl}" alt="Selected image"><button type="button" id="removeImage" aria-label="Remove image">×</button>`;document.getElementById('removeImage').addEventListener('click',clearImage)}
function clearImage(){pendingImage=null;imageInput.value='';cameraInput.value='';imagePreview.hidden=true;imagePreview.innerHTML=''}
async function prepareImage(file){if(!file||!file.type.startsWith('image/'))return;if(file.size>12*1024*1024){showToast('Image too large (max 12 MB)');return}try{const src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)});const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=src});const max=1600,scale=Math.min(1,max/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);showImagePreview(c.toDataURL('image/jpeg',.82))}catch{showToast('Could not read that image')}}
function normalizeError(status,data){if(status===413)return'Pesan atau gambar terlalu besar. Coba kirim versi yang lebih kecil.';if(status===429)return'ZennNyx sedang terlalu sibuk. Coba kirim lagi sebentar lagi.';if(status>=500)return'Maaf, ZennNyx sedang mengalami kendala. Coba kirim lagi.';return data?.error||'Maaf, pesan ini belum bisa diproses. Coba kirim lagi.'}
function prepareHistoryForRequest(){
  const copy=messages.map(m=>({
    role:m.role,
    content:m.content,
    sources:Array.isArray(m.sources)?m.sources:[]
  }));

  let newestImageIndex=-1;

  for(let i=copy.length-1;i>=0;i--){
    if(
      copy[i].role==='user' &&
      Array.isArray(copy[i].content) &&
      copy[i].content.some(p=>p?.type==='image_url')
    ){
      newestImageIndex=i;
      break
    }
  }

  return copy.map((m,i)=>{
    if(m.role!=='user' || !Array.isArray(m.content)){
      if(m.role==='assistant'&&m.sources.length){
        const sourceMemory=m.sources.slice(0,5).map((s,n)=>
          `[${n+1}] ${s.title||s.url}\n${s.url}`
        ).join('\n');

        return {
          role:'assistant',
          content:`${m.content}\n\n[Web sources used in this previous answer — metadata for continuity only]\n${sourceMemory}`
        }
      }

      return {
        role:m.role,
        content:m.content
      }
    }

    if(i===newestImageIndex)return{role:'user',content:m.content};

    const textPart=m.content.find(
      p=>p?.type==='text'&&typeof p.text==='string'
    );

    return{
      role:'user',
      content:textPart?.text||'User sent an image.'
    }
  })
}
async function sendMessage(){
  const text=input.value.trim();
  if((!text&&!pendingImage)||busy||!guardCanSend())return;

  // Prevent a Sources popover from a previous answer from appearing attached to a new answer.
  document.querySelectorAll('.sources-popover').forEach(el=>el.remove());
  busy=true;
  sendBtn.disabled=true;
  attachBtn.disabled=true;
  voiceBtn.disabled=true;
  recordGuardSend();
  document.getElementById('welcome')?.remove();
  togglePopover(attachPopover,false);
  const imageForMessage=pendingImage;
  const userContent=imageForMessage?[{type:'text',text:text||'Please analyze this image.'},{type:'image_url',image_url:{url:imageForMessage}}]:text;
  addMessage('user',text||'Analyze this image.',false,0,false,imageForMessage);
  messages.push({role:'user',content:userContent});
  input.value='';
  resizeInput();
  clearImage();
  closeKeyboard();
  addTyping();
  const started=performance.now();
  try{
    const response=await fetch('/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:prepareHistoryForRequest(),thinkHarder})
    });
    const data=await response.json().catch(()=>({}));
    const waitRemaining=Math.max(0,MIN_RESPONSE_DELAY_MS-(performance.now()-started));
    if(waitRemaining)await new Promise(resolve=>setTimeout(resolve,waitRemaining));
    removeTyping();
    if(!response.ok)throw new Error(normalizeError(response.status,data));
    const reply=data.reply||'Maaf, ZennNyx tidak menerima jawaban.';
    const elapsed=performance.now()-started;
    const responseSources=Array.isArray(data.sources)?data.sources:[];
    const webSearched=Boolean(data.webSearched);

    addMessage(
      'assistant',
      reply,
      false,
      elapsed,
      Boolean(data.thinkHarder),
      null,
      responseSources,
      webSearched
    );

    messages.push({
      role:'assistant',
      content:reply,
      sources:responseSources
    });
    if(messages.length>14)messages=messages.slice(-14);
  }catch(error){
    const waitRemaining=Math.max(0,MIN_RESPONSE_DELAY_MS-(performance.now()-started));
    if(waitRemaining)await new Promise(resolve=>setTimeout(resolve,waitRemaining));
    removeTyping();
    addMessage('assistant',error.message||'Maaf, terjadi kendala.',true);
    messages.pop();
  }finally{
    busy=false;
    attachBtn.disabled=false;
    voiceBtn.disabled=false;
    scheduleGuardUnlock();
    updateSendState();
  }
}
function updateSendState(){const hasContent=Boolean(input.value.trim()||pendingImage);sendBtn.disabled=busy||!hasContent||!guardCanSend();scheduleGuardUnlock()}

// Mobile keyboard fallback: keep the fixed composer above the on-screen keyboard
// on browsers where the visual viewport does not automatically reposition fixed UI.
function updateKeyboardInset(){
  if(!window.visualViewport)return;

  const vv=window.visualViewport;
  const keyboardInset=Math.max(
    0,
    window.innerHeight-vv.height-vv.offsetTop
  );

  document.documentElement.style.setProperty(
    '--keyboard-inset',
    `${Math.round(keyboardInset)}px`
  );
}

if(window.visualViewport){
  window.visualViewport.addEventListener('resize',updateKeyboardInset,{passive:true});
  window.visualViewport.addEventListener('scroll',updateKeyboardInset,{passive:true});
}

input.addEventListener('focus',()=>{
  updateKeyboardInset();
  setTimeout(updateKeyboardInset,80);
  setTimeout(updateKeyboardInset,260);
});

input.addEventListener('blur',()=>{
  setTimeout(updateKeyboardInset,140);
});

function setupRecognition(){const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){voiceBtn.addEventListener('click',()=>showToast('Voice input belum didukung browser ini.'));return}recognition=new SR();recognition.lang='id-ID';recognition.interimResults=true;recognition.continuous=false;recognition.maxAlternatives=1;let baseText='';recognition.onstart=()=>{recording=true;voiceBtn.classList.add('recording');voiceBtn.setAttribute('aria-label','Stop voice input');baseText=input.value.trim()};recognition.onresult=e=>{const transcript=[...e.results].map(r=>r[0]?.transcript||'').join('');input.value=(baseText?baseText+' ':'')+transcript;resizeInput();updateSendState()};recognition.onerror=e=>{if(e.error==='not-allowed'||e.error==='service-not-allowed')showToast('Izin mikrofon ditolak.');else if(e.error!=='aborted')showToast('Voice input gagal digunakan.');recording=false;voiceBtn.classList.remove('recording');voiceBtn.setAttribute('aria-label','Voice input')};recognition.onend=()=>{recording=false;voiceBtn.classList.remove('recording');voiceBtn.setAttribute('aria-label','Voice input');updateSendState()};voiceBtn.addEventListener('click',()=>{if(busy)return;if(recording){recognition.stop();return}try{recognition.start()}catch{}})}
function toggleAbout(open){togglePopover(aboutPopover,open)}
function renderWelcome(){
  const welcome=document.createElement('div');
  welcome.id='welcome';
  welcome.className='welcome';
  welcome.innerHTML=`<div id="welcome" class="welcome">
  <div class="welcome-hero">
    <div class="welcome-eyebrow"><span class="welcome-eyebrow-dot"></span> PERSONAL AI ASSISTANT</div>
    <div class="welcome-mark">Z</div>
    <h1>Ngobrol aja. Gue siap bantu.</h1>
    <p>ZennNyx AI adalah ruang chat pribadi buat cari jawaban, cari info terbaru, baca gambar, mikirin ide, sampai bantu ngulik hal teknis.</p>
  </div>

  <div class="welcome-docs" aria-label="Tentang ZennNyx AI">
    <article class="welcome-doc-card">
      <div class="welcome-card-top">
        <span class="welcome-card-kicker">01 / APA ITU</span>
        <span class="welcome-card-icon" aria-hidden="true">
          <svg viewBox="0 0 64 64"><path d="M12 45V19c0-4 3-7 7-7h26c4 0 7 3 7 7v26c0 4-3 7-7 7H19c-4 0-7-3-7-7Z"/><path d="M20 27h24M20 35h17M20 43h10"/><circle cx="49" cy="47" r="7"/><path d="m46 47 2 2 4-5"/></svg>
        </span>
      </div>
      <h2>ZennNyx AI itu apa?</h2>
      <p>Asisten AI yang dibuat buat ngobrol santai, ngerjain ide, belajar, dan bantu cari informasi tanpa harus buka banyak tab.</p>
      <div class="welcome-graphic" aria-hidden="true">
        <svg viewBox="0 0 520 170">
          <path d="M34 126h452" />
          <rect x="62" y="44" width="154" height="82" rx="18" />
          <rect x="304" y="25" width="154" height="101" rx="18" />
          <path d="M216 85h76" />
          <path d="m277 78 15 7-15 7" />
          <circle cx="112" cy="71" r="8" />
          <circle cx="340" cy="54" r="8" />
          <circle cx="389" cy="84" r="8" />
          <path d="M348 54 382 79M345 55 118 71" />
        </svg>
      </div>
    </article>

    <article class="welcome-doc-card">
      <div class="welcome-card-top">
        <span class="welcome-card-kicker">02 / BISA NGAPAIN</span>
        <span class="welcome-card-icon" aria-hidden="true">
          <svg viewBox="0 0 64 64"><path d="M9 13h46v38H9z"/><path d="m18 23 7 7-7 7M31 37h14"/><path d="M43 13v38"/></svg>
        </span>
      </div>
      <h2>Kerjain dari satu tempat.</h2>
      <p>Chat biasa, web search dengan sumber, analisis gambar, voice input, dan Think Harder buat pertanyaan yang butuh mikir lebih dalam.</p>
      <div class="welcome-graphic" aria-hidden="true">
        <svg viewBox="0 0 520 170">
          <rect x="45" y="36" width="430" height="98" rx="20"/>
          <path d="M71 63h98M71 83h68M71 103h128"/>
          <path d="M261 55h176M261 75h136M261 95h156M261 115h102"/>
          <circle cx="438" cy="55" r="9"/>
          <path d="m433 55 4 4 8-10"/>
        </svg>
      </div>
    </article>

    <article class="welcome-doc-card welcome-doc-card-wide">
      <div class="welcome-card-top">
        <span class="welcome-card-kicker">03 / GAYA CHAT</span>
        <span class="welcome-card-icon" aria-hidden="true">
          <svg viewBox="0 0 64 64"><path d="M12 18h40v28H28l-10 9v-9h-6z"/><path d="M22 29h20M22 36h13"/></svg>
        </span>
      </div>
      <div class="welcome-wide-copy">
        <div>
          <h2>Nggak perlu bahasa kantor.</h2>
          <p>Ngobrol pakai bahasa yang biasa lu pakai. Mau santai, campur Indonesia–English, atau bahas teknis juga oke.</p>
        </div>
        <div class="welcome-quote">“Tanya aja. Nanti kita bedah bareng.”</div>
      </div>
    </article>
  </div>

  <div class="suggestions-title">Mulai dari sini</div>
  <div class="suggestions">
    <button type="button" data-prompt="Jelasin sesuatu yang menurut lu menarik hari ini.">Jelasin sesuatu</button>
    <button type="button" data-prompt="Bantu gue bikin sesuatu dari nol.">Bantu bikin sesuatu</button>
    <button type="button" data-prompt="Cari info terbaru tentang teknologi yang lagi menarik sekarang.">Cari info terbaru</button>
    <button type="button" data-prompt="Gue punya ide, bantu gue ngembanginnya.">Kembangin ide</button>
  </div>
</div>`;
  return welcome;
}

function resetToNewChat(){
  if(busy){
    showToast('Tunggu sampai ZennNyx selesai merespons.');
    return
  }
  messages=[];
  clearImage();
  input.value='';
  resizeInput();
  thinkHarder=false;
  updateThinkMenu();
  togglePopover(attachPopover,false);
  toggleAbout(false);
  document.getElementById('typing')?.remove();
  document.querySelectorAll('.sources-popover').forEach(el=>el.remove());
  chat.innerHTML='';
  chat.appendChild(renderWelcome());
  bindSuggestions();
  updateSendState()
}
function bindSuggestions(){document.querySelectorAll('[data-prompt]').forEach(btn=>btn.addEventListener('click',()=>{input.value=btn.dataset.prompt;resizeInput();updateSendState();input.focus()}))}
composer.addEventListener('submit',e=>{e.preventDefault();sendMessage()});
attachBtn.addEventListener('click',e=>{e.stopPropagation();if(!busy){togglePopover(attachPopover,attachPopover.hidden);toggleAbout(false)}});
attachPopover.querySelectorAll('.attach-menu-item').forEach(btn=>btn.addEventListener('click',()=>{const action=btn.dataset.action;if(action==='camera')cameraInput.click();if(action==='photo')imageInput.click();if(action==='think')setThinkHarder(!thinkHarder)}));
imageInput.addEventListener('change',()=>{prepareImage(imageInput.files?.[0]);togglePopover(attachPopover,false)});cameraInput.addEventListener('change',()=>{prepareImage(cameraInput.files?.[0]);togglePopover(attachPopover,false)});
input.addEventListener('input',()=>{resizeInput();updateSendState()});
input.addEventListener('keydown',e=>{if(e.key==='Enter'){if(e.isComposing)return;requestAnimationFrame(resizeInput)}});
input.addEventListener('paste',e=>{const item=[...(e.clipboardData?.items||[])].find(x=>x.type.startsWith('image/'));if(item&&!busy){const file=item.getAsFile();if(file){e.preventDefault();prepareImage(file)}}});
document.addEventListener('click',e=>{if(!e.target.closest('.attach-popover')&&!e.target.closest('#attachBtn'))togglePopover(attachPopover,false);if(!e.target.closest('.about-popover')&&!e.target.closest('#menuBtn'))toggleAbout(false);if(!e.target.closest('.sources-popover')&&!e.target.closest('[aria-label="Sources"]'))document.querySelectorAll('.sources-popover').forEach(el=>el.remove())});
menuBtn.addEventListener('click',e=>{e.stopPropagation();togglePopover(attachPopover,false);toggleAbout(aboutPopover.hidden)});
newChatBtn.addEventListener('click',e=>{e.stopPropagation();resetToNewChat()});
const initialWelcome=document.getElementById('welcome');
if(initialWelcome)initialWelcome.replaceWith(renderWelcome());
setupRecognition();bindSuggestions();updateThinkMenu();resizeInput();updateKeyboardInset();scheduleGuardUnlock();updateSendState();
