const HOUR_MS = 60 * 60 * 1000;
const DEVICE_HOUR_LIMIT = 20;
const DEVICE_BURST_LIMIT = 3;
const DEVICE_BURST_WINDOW_MS = 60 * 1000;
const DEVICE_BURST_COOLDOWN_MS = 10 * 1000;
const IP_HOUR_LIMIT = 60;

const rateStore = globalThis.__zennnyxRateStore || new Map();
globalThis.__zennnyxRateStore = rateStore;

function getClientIp(req){
  const forwarded=String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim();
  return forwarded||req.socket?.remoteAddress||'unknown';
}
function getCookie(req,name){
  const raw=String(req.headers?.cookie||'');
  const found=raw.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='));
  return found?decodeURIComponent(found.slice(name.length+1)) : '';
}
function ensureDeviceCookie(req,res){
  const existing=getCookie(req,'znx_device');
  if(existing&&/^[A-Za-z0-9-]{16,100}$/.test(existing))return existing;
  const id=crypto.randomUUID();
  res.setHeader('Set-Cookie',`znx_device=${encodeURIComponent(id)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure`);
  return id;
}
function cleanBucket(bucket,now){
  if(!bucket)return {hour:[],burst:[],blockedUntil:0};
  bucket.hour=bucket.hour.filter(t=>now-t<HOUR_MS);
  bucket.burst=bucket.burst.filter(t=>now-t<DEVICE_BURST_WINDOW_MS);
  if(bucket.blockedUntil<now)bucket.blockedUntil=0;
  return bucket;
}
function takeRateLimit(req,res){
  const now=Date.now();
  const ip=getClientIp(req);
  const deviceId=ensureDeviceCookie(req,res);
  const deviceKey=`device:${ip}:${deviceId}`;
  const ipKey=`ip:${ip}`;
  const device=cleanBucket(rateStore.get(deviceKey),now);
  const ipBucket=cleanBucket(rateStore.get(ipKey),now);

  // Per-device/user guard: 20 accepted requests per rolling hour.
  if(device.hour.length>=DEVICE_HOUR_LIMIT){
    const retry=Math.max(1,Math.ceil(((device.hour[0]||now)+HOUR_MS-now)/1000));
    res.setHeader('Retry-After',String(retry));
    rateStore.set(deviceKey,device);
    return {ok:false,status:429,error:'ZennNyx sudah mencapai batas penggunaan sementara. Coba lagi nanti.'};
  }
  // Server-side burst guard mirrors the hidden client guard.
  if(device.blockedUntil>now){
    const retry=Math.max(1,Math.ceil((device.blockedUntil-now)/1000));
    res.setHeader('Retry-After',String(retry));
    rateStore.set(deviceKey,device);
    return {ok:false,status:429,error:'Terlalu banyak permintaan dalam waktu singkat.'};
  }
  // Extra IP-level shield: protects the API if a user clears browser data or changes browser.
  if(ipBucket.hour.length>=IP_HOUR_LIMIT){
    const retry=Math.max(1,Math.ceil(((ipBucket.hour[0]||now)+HOUR_MS-now)/1000));
    res.setHeader('Retry-After',String(retry));
    rateStore.set(ipKey,ipBucket);
    return {ok:false,status:429,error:'Terlalu banyak permintaan dari jaringan ini. Coba lagi nanti.'};
  }

  device.hour.push(now);
  device.burst.push(now);
  if(device.burst.length>=DEVICE_BURST_LIMIT){
    device.blockedUntil=now+DEVICE_BURST_COOLDOWN_MS;
    device.burst=[];
  }
  ipBucket.hour.push(now);
  rateStore.set(deviceKey,device);
  rateStore.set(ipKey,ipBucket);
  return {ok:true};
}


function extractUserText(messages){
  // Search only the current user turn.
  // The old implementation joined the previous four user messages, which caused
  // unrelated sources from earlier questions to leak into the current Sources panel.
  for(let i=messages.length-1;i>=0;i--){
    const m=messages[i];
    if(m?.role!=='user')continue;

    if(typeof m.content==='string')
      return m.content.replace(/\s+/g,' ').trim().slice(0,1800);

    if(Array.isArray(m.content)){
      const text=m.content.find(
        p=>p?.type==='text'&&typeof p.text==='string'
      )?.text;

      if(text)
        return text.replace(/\s+/g,' ').trim().slice(0,1800);
    }

    break;
  }

  return '';
}

function shouldSearchWeb(query){
  const q=String(query||'').toLowerCase().trim();
  if(!q)return false;

  if(/^(hai|halo|hello|hi|hey|ok|oke|thanks|makasih|terima kasih|wkwk|lol|yo|test|tes|siapa kamu|who are you|what are you)\b[!.? ]*$/i.test(q))return false;

  // Current/recommendation/product intent takes priority, even when phrased as a creation request.
  const currentIntent=/\b(sekarang|saat ini|hari ini|kemarin|besok|terbaru|terkini|latest|today|yesterday|tomorrow|current|2026|update|berita|news|jadwal|schedule|score|skor|ranking|peringkat|harga|price|biaya|tarif|promo|diskon|beli|buy|terbaik|best|rekomendasi|recommended|spesifikasi|spec|stok|stock|rilis|release|versi terbaru|official|resmi|cuaca|weather|kurs|exchange|nilai tukar|lokasi|alamat|open sekarang|buka sekarang|hp|smartphone|iphone|samsung|xiaomi|redmi|poco|oppo|vivo|realme|tecno|infinix|laptop|tablet|film|game|produk)\b/i.test(q);
  if(currentIntent)return true;

  // Skip obvious writing/coding/translation tasks that do not need external facts.
  if(/\b(bikin|buatkan|tuliskan|rewrite|parafrase|terjemahkan|translate|debug|javascript|typescript|html|css|python|kode|code|regex)\b/i.test(q))return false;
  if(/^\s*(berapa|hitung|calculate|what is)\s+[0-9\s+\-*/().=]+[?!.]*\s*$/i.test(q))return false;

  // Other factual questions benefit from citations.
  if(/\b(apa itu|apa arti|siapa|kapan|di mana|dimana|berapa|mengapa|kenapa|how|what|who|when|where|why|which)\b/i.test(q))return true;

  return false;
}

function isIndonesianQuery(query){
  return /\b(rp|rupiah|indonesia|indonesian|jakarta|jawa|bandung|surabaya|purworejo|kutoarjo)\b/i.test(query);
}

function buildSearchConfig(query){
  const isNews=/\b(berita|news|latest news|berita terbaru|hari ini|today)\b/i.test(query);
  const config={
    query:String(query).slice(0,380),
    search_depth:'basic',
    max_results:5,
    include_answer:false,
    include_raw_content:false
  };
  if(isNews){
    config.topic='news';
    config.time_range='week';
  }else{
    config.topic='general';
  }
  if(isIndonesianQuery(query))config.country='Indonesia';
  return config;
}

async function searchWeb(query){
  const tavilyKey=process.env.TAVILY_API_KEY;
  if(!tavilyKey)return {used:false,sources:[],reason:'missing-key'};

  try{
    const config=buildSearchConfig(query);
    const upstream=await fetch('https://api.tavily.com/search',{
      method:'POST',
      headers:{
        Authorization:`Bearer ${tavilyKey}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(config)
    });

    const data=await upstream.json().catch(()=>({}));
    if(!upstream.ok){
      console.error('Tavily search error:',upstream.status,data?.detail||data?.error||data);
      return {used:false,sources:[],reason:'search-error'};
    }

    const results=Array.isArray(data?.results)?data.results:[];
    const sources=results
      .filter(r=>r&&typeof r.url==='string')
      .slice(0,5)
      .map(r=>({
        title:String(r.title||r.url).slice(0,180),
        url:r.url,
        domain: (()=>{try{return new URL(r.url).hostname.replace(/^www\./,'')}catch{return ''}})(),
        snippet:String(r.content||r.snippet||'').replace(/\s+/g,' ').slice(0,500)
      }));

    return {used:sources.length>0,sources,reason:sources.length?'ok':'empty'};
  }catch(error){
    console.error('Tavily request failed:',error);
    return {used:false,sources:[],reason:'exception'};
  }
}

function formatWebContext(sources){
  if(!sources.length)return '';
  return sources.map((s,i)=>`[${i+1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}`).join('\n\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control','no-store');

  const rate=takeRateLimit(req,res);
  if(!rate.ok)return res.status(rate.status).json({error:rate.error});

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ZennNyx is not configured yet.' });

  const body = req.body || {};
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const thinkHarder = body.thinkHarder === true;

  let messages = incoming
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-20)
    .map(m => {
      if (m.role === 'assistant' && typeof m.content === 'string') {
        return { role: 'assistant', content: m.content.slice(0, 12000) };
      }
      if (m.role === 'user' && typeof m.content === 'string') {
        return { role: 'user', content: m.content.slice(0, 8000) };
      }
      if (m.role === 'user' && Array.isArray(m.content)) {
        const safeContent = m.content.filter(part => {
          if (!part || typeof part !== 'object') return false;
          if (part.type === 'text') return typeof part.text === 'string' && part.text.length <= 8000;
          if (part.type === 'image_url') return typeof part.image_url?.url === 'string' && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(part.image_url.url);
          return false;
        }).slice(0, 2);
        return safeContent.length ? { role: 'user', content: safeContent } : null;
      }
      return null;
    })
    .filter(Boolean);

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return res.status(400).json({ error: 'A user message is required.' });

  // The previous version selected a text-only model when a follow-up had no new image.
  // That left an earlier multimodal message in history and caused a provider validation error.
  // If the conversation contains an image, use the vision-capable model for the whole request.
  const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p?.type === 'image_url'));
  const model = hasImage
    ? (process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b')
    : (process.env.GROQ_MODEL || 'openai/gpt-oss-20b');

  const userQuery=extractUserText(messages);
  const wantsWeb=shouldSearchWeb(userQuery);
  const webResult=wantsWeb?await searchWeb(userQuery):{used:false,sources:[],reason:'not-needed'};
  const webContext=webResult.used?formatWebContext(webResult.sources):'';
  const currentDate=new Date().toISOString().slice(0,10);

  const webInstruction=webResult.used
    ? `\n\nLIVE WEB RESEARCH IS AVAILABLE FOR THIS REQUEST. Use the sources below as the primary evidence for current/factual claims. These sources belong to THIS user turn only. Do not reuse source lists from earlier turns. Do not invent details that are not supported by the sources. When a claim is based on a source, append a simple citation marker like [1], [2], etc. Only use citation numbers that exist below. If sources disagree, say so briefly.\n\n${webContext}`
    : (wantsWeb?`\n\nThe user asked for information that may require current web data, but live web search was unavailable. Be explicit about uncertainty and do not pretend that you searched the web.`:'');

  const normalPrompt = `You are ZennNyx AI, a helpful, friendly AI assistant. Today's date is ${currentDate}. When the user speaks Indonesian, default to casual, natural Indonesian for a personal chat. Prefer 'gue/lu', 'nggak/gak', 'udah', 'aja', 'kayak', and normal conversational phrasing when it fits. Do NOT use 'saya'/'Anda' or customer-service/formal-office language unless the user asks for formal language or the task clearly requires it. Do not force slang into every sentence; sound like a smart friend, not a call-center agent. Match the user's language mix and energy. Keep answers clear and respectful. Keep answers concise, direct, natural, and useful by default. Use Markdown when it improves readability. Maintain continuity with earlier messages. If an image is present anywhere in the conversation, use it as visual context when relevant to a follow-up question. Describe only what is actually supported by the image. Do not identify a real person in an image or guess their identity. Never reveal private chain-of-thought; give the answer and concise rationale instead. Previous assistant messages may contain a [Web sources used...] metadata block. Treat it as context from the previous turn only; do not present those old sources as sources for the current turn. Do not claim to have browsed the web unless live web research is actually supplied below.${webInstruction}`;
  const thinkPrompt = `You are ZennNyx AI in Think Harder mode. Today's date is ${currentDate}. When the user speaks Indonesian, default to casual, natural Indonesian for a personal chat. Prefer 'gue/lu', 'nggak/gak', 'udah', 'aja', 'kayak', and normal conversational phrasing when it fits. Do NOT use 'saya'/'Anda' or customer-service/formal-office language unless the user asks for formal language or the task clearly requires it. Do not force slang into every sentence; sound like a smart friend, not a call-center agent. Match the user's language mix and energy. Keep answers clear and respectful. Think carefully before answering, then provide a structured, professional, well-organized response. Use headings, steps, bullets, examples, comparisons, and concise conclusions when useful. Maintain continuity with earlier messages. If an image is present anywhere in the conversation, analyze it carefully when relevant. Do not identify a real person in an image or guess their identity. Be thorough without unnecessary repetition. Never reveal private chain-of-thought; provide the useful conclusion and concise rationale instead. Use Markdown naturally. Previous assistant messages may contain a [Web sources used...] metadata block. Treat it as context from the previous turn only; do not present those old sources as sources for the current turn. Do not claim to have browsed the web unless live web research is actually supplied below.${webInstruction}`;

  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: thinkHarder ? thinkPrompt : normalPrompt }, ...messages],
        temperature: thinkHarder ? 0.55 : 0.7,
        max_completion_tokens: thinkHarder ? 4096 : 2048
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('ZennNyx upstream error:', upstream.status, data?.error?.message || data?.error || 'unknown');
      const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 500;
      return res.status(status).json({ error: 'ZennNyx could not process that request right now.' });
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) return res.status(502).json({ error: 'ZennNyx received an empty response.' });

    return res.status(200).json({ reply, thinkHarder, hasImage, sources: webResult.sources, webSearched: webResult.used });
  } catch (error) {
    console.error('ZennNyx server error:', error);
    return res.status(500).json({ error: 'ZennNyx could not connect to its AI service.' });
  }
}
