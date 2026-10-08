const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
const thinkBtn = document.getElementById('thinkBtn');
const thinkPopover = document.getElementById('thinkPopover');
const thinkSwitch = document.getElementById('thinkSwitch');
const menuBtn = document.getElementById('menuBtn');
const newChatBtn = document.getElementById('newChatBtn');
const aboutPopover = document.getElementById('aboutPopover');

let messages = [];
let pendingImage = null;
let thinkHarder = false;
let busy = false;
let toastTimer = null;

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
function safeUrl(value='') {
  try { const u = new URL(value); return ['http:','https:'].includes(u.protocol) ? u.href : '#'; } catch { return '#'; }
}
function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (m,p,url) => `${p}<a href="${escapeAttr(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  return s;
}
function parseTable(lines) {
  if (lines.length < 2 || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[1])) return null;
  const split = line => line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(x=>x.trim());
  const head = split(lines[0]);
  if (head.length < 2) return null;

  // Only consecutive pipe rows belong to the table. Never swallow normal prose
  // that happens to follow the table (the old parser did exactly that).
  const body = [];
  let end = 2;
  while (end < lines.length) {
    const raw = lines[end];
    if (!raw.trim()) break;
    // A table body row must actually look like a pipe-delimited row.
    // Normal prose containing a single pipe, headings, blockquotes, etc.
    // must terminate the table instead of being swallowed into it.
    if (!/^\s*\|?.+\|.+\|?\s*$/.test(raw)) break;
    const row = split(raw);
    if (row.length !== head.length) break;
    body.push(row);
    end++;
  }

  const cols = head.length;
  const norm = row => Array.from({length:cols},(_,i)=>row[i]??'');
  const html = `<div class="table-wrap"><table><thead><tr>${norm(head).map(c=>`<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r=>`<tr>${norm(r).map(c=>`<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return { html, end };
}
function renderMarkdown(md='') {
  const lines = String(md).replace(/\r/g,'').split('\n');
  let html='',i=0;
  while(i<lines.length){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    if(/^```/.test(line.trim())){
      const lang=line.trim().slice(3).trim();let j=i+1;while(j<lines.length&&!/^```/.test(lines[j].trim()))j++;
      const code=lines.slice(i+1,j).join('\n');const encoded=encodeURIComponent(code);
      html+=`<div class="code-wrap"><pre class="code-block"><code>${escapeHtml(code)}</code></pre><button class="code-copy" type="button" data-copy-code="${encoded}" aria-label="Copy code">Copy</button></div>`;i=j+1;continue;
    }
    if(i+1<lines.length && lines[i].includes('|')){
      const table=parseTable(lines.slice(i));
      if(table){ html += table.html; i += table.end; continue; }
    }
    const heading=line.match(/^(#{1,4})\s+(.+)$/);if(heading){html+=`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`;i++;continue;}
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){html+='<hr>';i++;continue;}
    if(/^>\s?/.test(line)){const q=[];while(i<lines.length&&/^>\s?/.test(lines[i])){q.push(lines[i].replace(/^>\s?/,'').trim());i++;}html+=`<blockquote>${q.map(renderInline).join('<br>')}</blockquote>`;continue;}
    if(/^\s*[-*+]\s+/.test(line)){const items=[];while(i<lines.length&&/^\s*[-*+]\s+/.test(lines[i])){items.push(lines[i].replace(/^\s*[-*+]\s+/,''));i++;}html+=`<ul>${items.map(x=>`<li>${renderInline(x)}</li>`).join('')}</ul>`;continue;}
    if(/^\s*\d+[.)]\s+/.test(line)){const items=[];while(i<lines.length&&/^\s*\d+[.)]\s+/.test(lines[i])){items.push(lines[i].replace(/^\s*\d+[.)]\s+/,''));i++;}html+=`<ol>${items.map(x=>`<li>${renderInline(x)}</li>`).join('')}</ol>`;continue;}
    const para=[line.trim()];i++;while(i<lines.length&&lines[i].trim()&&!/^```/.test(lines[i].trim())&&!/^#{1,4}\s+/.test(lines[i])&&!/^\s*[-*+]\s+/.test(lines[i])&&!/^\s*\d+[.)]\s+/.test(lines[i])&&!/^>\s?/.test(lines[i])){para.push(lines[i].trim());i++;}html+=`<p>${para.map(renderInline).join('<br>')}</p>`;
  }
  return `<div class="markdown">${html||'<p></p>'}</div>`;
}
function iconButton(label,icon,extra=''){return `<button type="button" class="action-btn ${extra}" aria-label="${label}"><span class="action-icon">${icon}</span><span class="action-label">${label}</span></button>`;}
function showToast(text){let t=document.querySelector('.toast');if(!t){t=document.createElement('div');t.className='toast';document.body.appendChild(t);}t.textContent=text;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),1500);}
async function copyText(text,button){try{await navigator.clipboard.writeText(text);if(button){const label=button.querySelector('.action-label');if(label){const old=label.textContent;label.textContent='Copied';button.classList.add('selected');setTimeout(()=>{label.textContent=old;button.classList.remove('selected')},1100);}}else showToast('Copied');}catch{showToast('Could not copy');}}
function extractUrls(text){return [...new Set((String(text).match(/https?:\/\/[^\s)\]}>]+/g)||[]).map(u=>u.replace(/[.,;:]+$/,'')))].slice(0,12);}
function addAssistantActions(row,content,elapsedMs,usedThink){
  const wrap=document.createElement('div');wrap.className='assistant-actions';
  const copy=document.createElement('button');copy.type='button';copy.className='action-btn';copy.setAttribute('aria-label','Copy');copy.innerHTML=`<span class="action-icon">${icons.copy}</span><span class="action-label">Copy</span>`;copy.addEventListener('click',()=>copyText(content,copy));
  const like=document.createElement('button');like.type='button';like.className='action-btn';like.setAttribute('aria-label','Like');like.innerHTML=`<span class="action-icon">${icons.like}</span>`;
  const dislike=document.createElement('button');dislike.type='button';dislike.className='action-btn';dislike.setAttribute('aria-label','Dislike');dislike.innerHTML=`<span class="action-icon">${icons.dislike}</span>`;
  like.addEventListener('click',()=>{like.classList.toggle('selected');dislike.classList.remove('selected');});dislike.addEventListener('click',()=>{dislike.classList.toggle('selected');like.classList.remove('selected');});
  const share=document.createElement('button');share.type='button';share.className='action-btn';share.setAttribute('aria-label','Share');share.innerHTML=`<span class="action-icon">${icons.share}</span>`;share.addEventListener('click',async()=>{try{if(navigator.share){await navigator.share({title:'ZennNyx AI',text:content.slice(0,1500)});}else await copyText(content); }catch{}});
  const urls=extractUrls(content);const source=document.createElement('button');source.type='button';source.className=`action-btn ${urls.length?'':'disabled'}`;source.setAttribute('aria-label','Sources');source.innerHTML=`<span class="action-icon">${icons.link}</span>`;source.disabled=!urls.length;
  source.addEventListener('click',()=>{row.querySelectorAll('.sources-popover').forEach(e=>e.remove());if(!urls.length)return;const pop=document.createElement('div');pop.className='sources-popover';pop.innerHTML=`<div class="sources-title">Sources</div>${urls.map(u=>`<a href="${escapeAttr(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a>`).join('')}`;row.appendChild(pop);requestAnimationFrame(()=>pop.classList.add('open'));});
  const meta=document.createElement('div');meta.className='answer-meta';const seconds=(elapsedMs/1000).toFixed(1);meta.textContent=`Generated for ${seconds}s${usedThink?' · Think Harder':''}`;row.querySelector('.answer').prepend(meta);
  wrap.append(copy,like,dislike,share,source);row.appendChild(wrap);
  const disclaimer=document.createElement('div');disclaimer.className='answer-disclaimer';disclaimer.textContent='ZennNyx AI can make mistakes. Check important information.';row.appendChild(disclaimer);
  row.querySelectorAll('.code-copy').forEach(b=>b.addEventListener('click',()=>copyText(decodeURIComponent(b.dataset.copyCode||''),b)));
}
function addMessage(role,content,isError=false,elapsedMs=0,usedThink=false,imageData=null){
  const row=document.createElement('div');row.className=`message ${role}${isError?' error':''}`;row.classList.add(role==='assistant'?'assistant-enter':'message-enter');
  const contentEl=document.createElement('div');contentEl.className=role==='assistant'?'answer':'bubble';
  if(role==='assistant'&&!isError)contentEl.innerHTML=renderMarkdown(content);else contentEl.innerHTML=isError?`<strong>${escapeHtml(content)}</strong>`:escapeHtml(content).replace(/\n/g,'<br>');
  if(role==='user'&&imageData){const img=document.createElement('img');img.className='message-image';img.src=imageData;img.alt='Attached image';contentEl.prepend(img);}
  row.appendChild(contentEl);chat.appendChild(row);if(role==='assistant'&&!isError)addAssistantActions(row,content,elapsedMs,usedThink);return row;
}
function addTyping(){const row=document.createElement('div');row.id='typing';row.className='message assistant responding';row.innerHTML='<div class="answer typing"><span></span><span></span><span></span></div>';chat.appendChild(row);}
function removeTyping(){document.getElementById('typing')?.remove();}
function resizeInput(){input.style.height='auto';input.style.height=Math.min(Math.max(input.scrollHeight,42),180)+'px';}
function closeKeyboard(){input.blur();document.activeElement?.blur?.();}
function updateThinkMode(animate=false){
  thinkBtn.setAttribute('aria-pressed',String(thinkHarder));
  thinkBtn.classList.toggle('active',thinkHarder);
  thinkSwitch.setAttribute('aria-checked',String(thinkHarder));
  if(animate){thinkBtn.classList.remove('pulse');void thinkBtn.offsetWidth;thinkBtn.classList.add('pulse');}
}
function toggleThinkPopover(open){
  if(open){
    thinkPopover.hidden=false;
    requestAnimationFrame(()=>thinkPopover.classList.add('open'));
  }else{
    thinkPopover.classList.remove('open');
    setTimeout(()=>{if(!thinkPopover.classList.contains('open'))thinkPopover.hidden=true},160);
  }
}
function setThinkHarder(value){
  thinkHarder=Boolean(value);
  updateThinkMode(true);
  toggleThinkPopover(false);
}
function showImagePreview(dataUrl){pendingImage=dataUrl;imagePreview.hidden=false;imagePreview.innerHTML=`<img src="${dataUrl}" alt="Selected image"><button type="button" id="removeImage" aria-label="Remove image">×</button>`;document.getElementById('removeImage').addEventListener('click',clearImage);}
function clearImage(){pendingImage=null;imageInput.value='';imagePreview.hidden=true;imagePreview.innerHTML='';}
async function prepareImage(file){
  if(!file||!file.type.startsWith('image/'))return;
  if(file.size>12*1024*1024){showToast('Image too large (max 12 MB)');return;}
  try{
    const src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});
    const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=src;});
    const max=1600,scale=Math.min(1,max/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);showImagePreview(c.toDataURL('image/jpeg',.82));
  }catch{showToast('Could not read that image');}
}
function normalizeError(status,data){
  if(status===413)return 'Pesan atau gambar terlalu besar. Coba kirim versi yang lebih kecil.';
  if(status===429)return 'ZennNyx sedang terlalu sibuk. Coba kirim lagi sebentar lagi.';
  if(status>=500)return 'Maaf, ZennNyx sedang mengalami kendala. Coba kirim lagi.';
  return data?.error||'Maaf, pesan ini belum bisa diproses. Coba kirim lagi.';
}
function prepareHistoryForRequest(){
  const copy=messages.map(m=>({role:m.role,content:m.content}));
  // Keep only the newest image-bearing user turn. Older image payloads are unnecessary and expensive.
  let newestImageIndex=-1;
  for(let i=copy.length-1;i>=0;i--){if(copy[i].role==='user'&&Array.isArray(copy[i].content)&&copy[i].content.some(p=>p?.type==='image_url')){newestImageIndex=i;break;}}
  return copy.map((m,i)=>{
    if(m.role!=='user'||!Array.isArray(m.content))return m;
    if(i===newestImageIndex)return m;
    const textPart=m.content.find(p=>p?.type==='text'&&typeof p.text==='string');
    return {role:'user',content:textPart?.text||'User sent an image.'};
  });
}
async function sendMessage(){
  const text=input.value.trim();if((!text&&!pendingImage)||busy)return;
  busy=true;sendBtn.disabled=true;thinkBtn.disabled=true;attachBtn.disabled=true;document.getElementById('welcome')?.remove();toggleThinkPopover(false);
  const imageForMessage=pendingImage;const userContent=imageForMessage?[{type:'text',text:text||'Please analyze this image.'},{type:'image_url',image_url:{url:imageForMessage}}]:text;
  addMessage('user',text||'Analyze this image.',false,0,false,imageForMessage);messages.push({role:'user',content:userContent});
  input.value='';resizeInput();clearImage();closeKeyboard();addTyping();
  const started=performance.now();
  try{
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:prepareHistoryForRequest(),thinkHarder})});
    const data=await response.json().catch(()=>({}));removeTyping();if(!response.ok)throw new Error(normalizeError(response.status,data));
    const reply=data.reply||'Maaf, ZennNyx tidak menerima jawaban.';const elapsed=performance.now()-started;addMessage('assistant',reply,false,elapsed,Boolean(data.thinkHarder));messages.push({role:'assistant',content:reply});
    if(messages.length>14)messages=messages.slice(-14);
  }catch(error){removeTyping();addMessage('assistant',error.message||'Maaf, terjadi kendala.',true);messages.pop();}
  finally{busy=false;sendBtn.disabled=false;thinkBtn.disabled=false;attachBtn.disabled=false;updateSendState();}
}
function updateSendState(){sendBtn.disabled=busy||(!input.value.trim()&&!pendingImage);}
composer.addEventListener('submit',e=>{e.preventDefault();sendMessage();});
thinkBtn.addEventListener('click',()=>{if(busy)return;toggleThinkPopover(true);});
thinkSwitch.addEventListener('click',()=>{if(busy)return;setThinkHarder(!thinkHarder);});
attachBtn.addEventListener('click',()=>{if(!busy)imageInput.click();});
imageInput.addEventListener('change',()=>prepareImage(imageInput.files?.[0]));
input.addEventListener('input',()=>{resizeInput();updateSendState();});
input.addEventListener('keydown',e=>{if(e.key==='Enter'){/* Enter always inserts a newline; sending is button-only. */if(e.isComposing)return;requestAnimationFrame(resizeInput);}});
input.addEventListener('paste',e=>{const item=[...(e.clipboardData?.items||[])].find(x=>x.type.startsWith('image/'));if(item&&!busy){const file=item.getAsFile();if(file){e.preventDefault();prepareImage(file);}}});
document.addEventListener('click',e=>{if(!e.target.closest('.think-area'))toggleThinkPopover(false);if(!e.target.closest('.about-popover')&&!e.target.closest('#menuBtn'))toggleAbout(false);if(!e.target.closest('.sources-popover')&&!e.target.closest('[aria-label="Sources"]'))document.querySelectorAll('.sources-popover').forEach(el=>el.remove());});
function toggleAbout(open){
  if(open){
    aboutPopover.hidden=false;
    requestAnimationFrame(()=>aboutPopover.classList.add('open'));
  }else{
    aboutPopover.classList.remove('open');
    setTimeout(()=>{if(!aboutPopover.classList.contains('open'))aboutPopover.hidden=true},420);
  }
}
function resetToNewChat(){
  if(busy){showToast('Tunggu sampai ZennNyx selesai merespons.');return;}
  messages=[];
  clearImage();
  input.value='';
  resizeInput();
  thinkHarder=false;
  updateThinkMode(false);
  toggleThinkPopover(false);
  toggleAbout(false);
  document.getElementById('typing')?.remove();
  chat.innerHTML='';
  const welcome=document.createElement('div');
  welcome.id='welcome';
  welcome.className='welcome';
  welcome.innerHTML=`<div class="welcome-mark">Z</div><h1>How can I help?</h1><p>Ask anything, write something, or build an idea.</p><div class="suggestions"><button type="button" data-prompt="Explain something interesting to me.">Explain something</button><button type="button" data-prompt="Help me write a short paragraph.">Help me write</button><button type="button" data-prompt="Give me a creative idea for a website.">Give me an idea</button></div>`;
  chat.appendChild(welcome);
  bindSuggestions();
  updateSendState();
}
function bindSuggestions(){document.querySelectorAll('[data-prompt]').forEach(btn=>btn.addEventListener('click',()=>{input.value=btn.dataset.prompt;resizeInput();updateSendState();input.focus();}));}
menuBtn.addEventListener('click',e=>{e.stopPropagation();toggleThinkPopover(false);toggleAbout(aboutPopover.hidden);});
newChatBtn.addEventListener('click',e=>{e.stopPropagation();resetToNewChat();});
bindSuggestions();updateThinkMode(false);resizeInput();updateSendState();
