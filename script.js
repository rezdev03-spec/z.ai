const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const thinkBtn = document.getElementById('thinkBtn');
const modeHint = document.getElementById('modeHint');
const attachBtn = document.getElementById('attachBtn');
const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');

let messages = [];
let busy = false;
let thinkHarder = false;
let pendingImage = null;

const icon = {
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 16V6a2 2 0 0 1 2-2h10"></path></svg>',
  like: '<svg viewBox="0 0 24 24"><path d="M7 10v10H4V10h3Zm0 0 5-7c1.5 0 2.3 1.2 1.9 2.5L13 10h5.5a2 2 0 0 1 2 2l-1 6.2A2 2 0 0 1 17.5 20H7"></path></svg>',
  dislike: '<svg viewBox="0 0 24 24"><path d="M17 14V4h3v10h-3Zm0 0-5 7c-1.5 0-2.3-1.2-1.9-2.5L11 14H5.5a2 2 0 0 1-2-2l1-6.2A2 2 0 0 1 5.5 4H17"></path></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3m0 0-4 4m4-4 4 4"></path><path d="M5 11v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"></path></svg>',
  source: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"></path><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"></path></svg>'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
}

function renderInline(source) {
  let text = escapeHtml(source);
  text = text.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text = text.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  text = text.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  text = text.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/(?<![_\w])_([^_\n]+)_(?!_)/g, '<em>$1</em>');
  return text;
}

function splitTableRow(row) {
  let clean = row.trim();
  if (clean.startsWith('|')) clean = clean.slice(1);
  if (clean.endsWith('|')) clean = clean.slice(0, -1);
  return clean.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
}

function parseTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length) return null;
  const header = lines[startIndex];
  const separator = lines[startIndex + 1];
  if (!header.includes('|')) return null;
  if (!/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)) return null;

  const headers = splitTableRow(header);
  const alignments = splitTableRow(separator).map(cell => {
    const left = cell.startsWith(':'); const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  });
  const rows = [];
  let i = startIndex + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(splitTableRow(lines[i])); i++; }

  const attr = idx => alignments[idx] ? ` style="text-align:${alignments[idx]}"` : '';
  const ths = headers.map((c, idx) => `<th${attr(idx)}>${renderInline(c)}</th>`).join('');
  const body = rows.map(row => `<tr>${headers.map((_, idx) => `<td${attr(idx)}>${renderInline(row[idx] ?? '')}</td>`).join('')}</tr>`).join('');
  return { html:`<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table></div>`, nextIndex:i };
}

function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  const out = []; let paragraph=[]; let listType=null; let listItems=[]; let quote=[];
  const flushP=()=>{ if(paragraph.length){ out.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g,'<br>')}</p>`); paragraph=[]; } };
  const flushL=()=>{ if(listItems.length){ const tag=listType==='ol'?'ol':'ul'; out.push(`<${tag}>${listItems.map(x=>`<li>${renderInline(x)}</li>`).join('')}</${tag}>`); listItems=[]; listType=null; } };
  const flushQ=()=>{ if(quote.length){ out.push(`<blockquote>${quote.map(x=>renderInline(x)).join('<br>')}</blockquote>`); quote=[]; } };

  for(let i=0;i<lines.length;){
    const line=lines[i], t=line.trim();
    const fence=t.match(/^```([\w.+#-]*)\s*$/);
    if(fence){ flushP();flushL();flushQ(); const lang=fence[1], code=[]; i++; while(i<lines.length&&!/^```\s*$/.test(lines[i].trim())) code.push(lines[i++]); if(i<lines.length)i++; out.push(`<div class="code-wrap"><pre class="code-block" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(code.join('\n'))}</code></pre><button class="code-copy" type="button" data-copy-code="${encodeURIComponent(code.join('\n'))}">Copy</button></div>`); continue; }
    const table=parseTable(lines,i); if(table){flushP();flushL();flushQ();out.push(table.html);i=table.nextIndex;continue;}
    if(/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)){flushP();flushL();flushQ();out.push('<hr>');i++;continue;}
    const h=t.match(/^(#{1,6})\s+(.+)$/); if(h){flushP();flushL();flushQ();out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`);i++;continue;}
    const q=line.match(/^\s*>\s?(.*)$/); if(q){flushP();flushL();quote.push(q[1]);i++;continue;}
    const ol=line.match(/^\s*\d+[.)]\s+(.+)$/), ul=line.match(/^\s*[-*+]\s+(.+)$/); if(ol||ul){flushP();flushQ();const nt=ol?'ol':'ul';if(listType&&listType!==nt)flushL();listType=nt;listItems.push((ol||ul)[1]);i++;continue;}
    if(!t){flushP();flushL();flushQ();i++;continue;}
    flushL();flushQ();paragraph.push(line);i++;
  }
  flushP();flushL();flushQ(); return `<div class="markdown">${out.join('')}</div>`;
}

function extractSources(text){ const urls=String(text??'').match(/https?:\/\/[^\s)< >\]]+/g)||[]; return [...new Set(urls.map(u=>u.replace(/[.,;]+$/,'')))]; }
function formatDuration(ms){ return `${(ms/1000).toFixed(ms<10000?1:0)}s`; }

async function copyText(text, button){
  try{ await navigator.clipboard.writeText(text); const old=button.querySelector('.action-label')?.textContent || 'Copy'; if(button.querySelector('.action-label')) button.querySelector('.action-label').textContent='Copied'; setTimeout(()=>{if(button.querySelector('.action-label'))button.querySelector('.action-label').textContent=old;},1100); }
  catch{ }
}
function actionButton(label, svg){ const b=document.createElement('button'); b.type='button';b.className='action-btn';b.setAttribute('aria-label',label);b.innerHTML=`<span class="action-icon">${svg}</span><span class="action-label">${label}</span>`;return b; }

function addAssistantActions(row, content, elapsedMs, usedThink){
  const meta=document.createElement('div');meta.className='answer-meta';meta.textContent=`Generated for ${formatDuration(elapsedMs)}${usedThink?' · Think Harder':''}`;row.insertBefore(meta,row.firstChild);
  const wrap=document.createElement('div');wrap.className='assistant-actions';
  const copy=actionButton('Copy',icon.copy);copy.addEventListener('click',()=>copyText(content,copy));
  const like=actionButton('Like',icon.like), dislike=actionButton('Dislike',icon.dislike);
  like.addEventListener('click',()=>{like.classList.toggle('selected');dislike.classList.remove('selected');});
  dislike.addEventListener('click',()=>{dislike.classList.toggle('selected');like.classList.remove('selected');});
  const share=actionButton('Share',icon.share);share.addEventListener('click',async()=>{try{if(navigator.share)await navigator.share({title:'ZennNyx AI',text:content});else await copyText(content,share);}catch{}});
  const source=actionButton('Sources',icon.source);const urls=extractSources(content);if(!urls.length)source.classList.add('disabled');
  source.addEventListener('click',()=>{document.querySelectorAll('.sources-popover').forEach(e=>e.remove());if(!urls.length)return;const pop=document.createElement('div');pop.className='sources-popover';pop.innerHTML=`<div class="sources-title">Sources</div>${urls.map(u=>`<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a>`).join('')}`;row.appendChild(pop);requestAnimationFrame(()=>pop.classList.add('open'));});
  wrap.append(copy,like,dislike,share,source);row.appendChild(wrap);
  row.querySelectorAll('.code-copy').forEach(b=>b.addEventListener('click',()=>copyText(decodeURIComponent(b.dataset.copyCode||''),b)));
}

function addMessage(role, content, isError=false, elapsedMs=0, usedThink=false, imageData=null){
  const row=document.createElement('div');row.className=`message ${role}${isError?' error':''}`;row.classList.add(role==='assistant'?'assistant-enter':'message-enter');
  const contentEl=document.createElement('div');contentEl.className=role==='assistant'?'answer':'bubble';
  if(role==='assistant'&&!isError)contentEl.innerHTML=renderMarkdown(content);else contentEl.textContent=content;
  if(role==='user'&&imageData){const img=document.createElement('img');img.className='message-image';img.src=imageData;img.alt='Attached image';contentEl.prepend(img);}
  row.appendChild(contentEl);chat.appendChild(row);
  if(role==='assistant'&&!isError)addAssistantActions(row,content,elapsedMs,usedThink);
  return row;
}
function addTyping(){const row=document.createElement('div');row.id='typing';row.className='message assistant responding';row.innerHTML='<div class="answer typing"><span></span><span></span><span></span></div>';chat.appendChild(row);}
function removeTyping(){document.getElementById('typing')?.remove();}
function resizeInput(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px';}
function closeKeyboard(){input.blur();document.activeElement?.blur?.();}
function updateThinkMode(){thinkBtn.setAttribute('aria-pressed',String(thinkHarder));thinkBtn.classList.toggle('active',thinkHarder);thinkBtn.classList.remove('toggle-pulse');void thinkBtn.offsetWidth;thinkBtn.classList.add('toggle-pulse');modeHint.textContent=thinkHarder?'Structured, deeper answers':'Short, direct answers';}

function showImagePreview(dataUrl){pendingImage=dataUrl;imagePreview.hidden=false;imagePreview.innerHTML=`<img src="${dataUrl}" alt="Selected image"><button type="button" id="removeImage" aria-label="Remove image">×</button>`;document.getElementById('removeImage').addEventListener('click',clearImage);}
function clearImage(){pendingImage=null;imageInput.value='';imagePreview.hidden=true;imagePreview.innerHTML='';}
async function prepareImage(file){
  if(!file||!file.type.startsWith('image/'))return;
  if(file.size>12*1024*1024){alert('Image is too large. Please choose an image under 12 MB.');return;}
  const src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});
  const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=src;});
  const max=1600, scale=Math.min(1,max/Math.max(img.width,img.height));
  const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  const out=c.toDataURL('image/jpeg',0.82);showImagePreview(out);
}

async function sendMessage(){
  const text=input.value.trim();if((!text&&!pendingImage)||busy)return;
  busy=true;sendBtn.disabled=true;thinkBtn.disabled=true;attachBtn.disabled=true;document.getElementById('welcome')?.remove();
  const imageForMessage=pendingImage;
  const userContent=imageForMessage?[{type:'text',text:text||'Please analyze this image.'},{type:'image_url',image_url:{url:imageForMessage}}]:text;
  addMessage('user',text||'Analyze this image.',false,0,false,imageForMessage);
  messages.push({role:'user',content:userContent});
  input.value='';resizeInput();clearImage();closeKeyboard();addTyping();
  const started=performance.now();
  try{
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages,thinkHarder})});
    const data=await response.json().catch(()=>({}));removeTyping();if(!response.ok)throw new Error(data.error||`Request failed (${response.status})`);
    const reply=data.reply||'No response received.';const elapsed=performance.now()-started;addMessage('assistant',reply,false,elapsed,Boolean(data.thinkHarder));messages.push({role:'assistant',content:reply});
    // Do not keep large image data in every subsequent request. The current image is only sent once.
    if(messages.length>12)messages=messages.slice(-12);
  }catch(error){removeTyping();addMessage('assistant',`Error: ${error.message}`,true);messages.pop();}
  finally{busy=false;sendBtn.disabled=false;thinkBtn.disabled=false;attachBtn.disabled=false;}
}

composer.addEventListener('submit',e=>{e.preventDefault();sendMessage();});
thinkBtn.addEventListener('click',()=>{if(busy)return;thinkHarder=!thinkHarder;updateThinkMode();});
attachBtn.addEventListener('click',()=>{if(!busy)imageInput.click();});
imageInput.addEventListener('change',()=>prepareImage(imageInput.files?.[0]));
input.addEventListener('input',resizeInput);
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
document.addEventListener('click',e=>{if(!e.target.closest('.sources-popover')&&!e.target.closest('[aria-label="Sources"]'))document.querySelectorAll('.sources-popover').forEach(el=>el.remove());});
function bindSuggestions(){document.querySelectorAll('[data-prompt]').forEach(btn=>btn.addEventListener('click',()=>{input.value=btn.dataset.prompt;resizeInput();input.focus();}));}
bindSuggestions();updateThinkMode();resizeInput();
