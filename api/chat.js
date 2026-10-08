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
  const found=raw.split(';')
    .map(v=>v.trim())
    .find(v=>v.startsWith(name+'='));

  return found
    ? decodeURIComponent(found.slice(name.length+1))
    : '';
}

function ensureDeviceCookie(req,res){
  const existing=getCookie(req,'znx_device');

  if(existing&&/^[A-Za-z0-9-]{16,100}$/.test(existing))
    return existing;

  const id=crypto.randomUUID();

  res.setHeader(
    'Set-Cookie',
    `znx_device=${encodeURIComponent(id)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure`
  );

  return id;
}

function cleanBucket(bucket,now){
  if(!bucket)
    return {hour:[],burst:[],blockedUntil:0};

  bucket.hour=bucket.hour.filter(t=>now-t<HOUR_MS);
  bucket.burst=bucket.burst.filter(
    t=>now-t<DEVICE_BURST_WINDOW_MS
  );

  if(bucket.blockedUntil<now)
    bucket.blockedUntil=0;

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
    const retry=Math.max(
      1,
      Math.ceil(((device.hour[0]||now)+HOUR_MS-now)/1000)
    );

    res.setHeader('Retry-After',String(retry));
    rateStore.set(deviceKey,device);

    return {
      ok:false,
      status:429,
      error:'ZennNyx sudah mencapai batas penggunaan sementara. Coba lagi nanti.'
    };
  }

  // Server-side burst guard mirrors the hidden client guard.
  if(device.blockedUntil>now){
    const retry=Math.max(
      1,
      Math.ceil((device.blockedUntil-now)/1000)
    );

    res.setHeader('Retry-After',String(retry));
    rateStore.set(deviceKey,device);

    return {
      ok:false,
      status:429,
      error:'Terlalu banyak permintaan dalam waktu singkat.'
    };
  }

  // Extra IP-level shield: protects the API if a user clears browser data or changes browser.
  if(ipBucket.hour.length>=IP_HOUR_LIMIT){
    const retry=Math.max(
      1,
      Math.ceil(((ipBucket.hour[0]||now)+HOUR_MS-now)/1000)
    );

    res.setHeader('Retry-After',String(retry));
    rateStore.set(ipKey,ipBucket);

    return {
      ok:false,
      status:429,
      error:'Terlalu banyak permintaan dari jaringan ini. Coba lagi nanti.'
    };
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

export default async function handler(req,res){
  if(req.method!=='POST')
    return res.status(405).json({error:'Method not allowed'});

  res.setHeader('Cache-Control','no-store');

  const rate=takeRateLimit(req,res);

  if(!rate.ok)
    return res.status(rate.status).json({error:rate.error});

  const apiKey=process.env.GROQ_API_KEY;

  if(!apiKey)
    return res.status(500).json({
      error:'ZennNyx is not configured yet.'
    });

  const body=req.body||{};
  const incoming=Array.isArray(body.messages)
    ? body.messages
    : [];

  const thinkHarder=body.thinkHarder===true;

  let messages=incoming
    .filter(
      m=>m&&(m.role==='user'||m.role==='assistant')
    )
    .slice(-20)
    .map(m=>{
      if(m.role==='assistant'&&typeof m.content==='string'){
        return {
          role:'assistant',
          content:m.content.slice(0,12000)
        };
      }

      if(m.role==='user'&&typeof m.content==='string'){
        return {
          role:'user',
          content:m.content.slice(0,8000)
        };
      }

      if(m.role==='user'&&Array.isArray(m.content)){
        const safeContent=m.content
          .filter(part=>{
            if(!part||typeof part!=='object')
              return false;

            if(part.type==='text')
              return typeof part.text==='string'&&part.text.length<=8000;

            if(part.type==='image_url')
              return typeof part.image_url?.url==='string' &&
                /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(
                  part.image_url.url
                );

            return false;
          })
          .slice(0,2);

        return safeContent.length
          ? {role:'user',content:safeContent}
          : null;
      }

      return null;
    })
    .filter(Boolean);

  const last=messages[messages.length-1];

  if(!last||last.role!=='user')
    return res.status(400).json({
      error:'A user message is required.'
    });

  // If the conversation contains an image, use the vision-capable model.
  const hasImage=messages.some(
    m=>Array.isArray(m.content) &&
      m.content.some(p=>p?.type==='image_url')
  );

  const model=hasImage
    ? (process.env.GROQ_VISION_MODEL||'qwen/qwen3.8-27b')
    : (process.env.GROQ_MODEL||'openai/gpt-oss-20b');

  const normalPrompt=`You are ZennNyx AI, a helpful, friendly AI assistant. Match the user's language and tone. Keep answers concise, direct, natural, and useful by default. Use Markdown when it improves readability. Maintain continuity with earlier messages. If an image is present anywhere in the conversation, use it as visual context when relevant to a follow-up question. Describe only what is actually supported by the image. Do not identify a real person in an image or guess their identity. Do not invent citations or claim to have browsed the web. Never reveal private chain-of-thought; give the answer and concise rationale instead.`;

  const thinkPrompt=`You are ZennNyx AI in Think Harder mode. Match the user's language and tone. Think carefully before answering, then provide a structured, professional, well-organized response. Use headings, steps, bullets, examples, comparisons, and concise conclusions when useful. Maintain continuity with earlier messages. If an image is present anywhere in the conversation, analyze it carefully when relevant. Do not identify a real person in an image or guess their identity. Be thorough without unnecessary repetition. Never reveal private chain-of-thought; provide the useful conclusion and concise rationale instead. Use Markdown naturally. Do not invent citations or claim to have browsed the web.`;

  try{
    const upstream=await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method:'POST',
        headers:{
          Authorization:`Bearer ${apiKey}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          model,
          messages:[
            {
              role:'system',
              content:thinkHarder
                ? thinkPrompt
                : normalPrompt
            },
            ...messages
          ],
          temperature:thinkHarder?0.55:0.7,
          max_completion_tokens:thinkHarder?4096:2048
        })
      }
    );

    const data=await upstream.json().catch(()=>({}));

    if(!upstream.ok){
      console.error(
        'ZennNyx upstream error:',
        upstream.status,
        data?.error?.message||data?.error||'unknown'
      );

      const status=
        upstream.status===429
          ? 429
          : upstream.status>=500
            ? 502
            : 500;

      return res.status(status).json({
        error:'ZennNyx could not process that request right now.'
      });
    }

    const reply=data?.choices?.[0]?.message?.content;

    if(!reply)
      return res.status(502).json({
        error:'ZennNyx received an empty response.'
      });

    return res.status(200).json({
      reply,
      thinkHarder,
      hasImage
    });

  }catch(error){
    console.error('ZennNyx server error:',error);

    return res.status(500).json({
      error:'ZennNyx could not connect to its AI service.'
    });
  }
}