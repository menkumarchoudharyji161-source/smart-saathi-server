
'use strict';
// SMART SAATHI API — Gemini primary, Groq backup. No paid OpenAI calls.
const http = require('http');
const PORT = Number(process.env.PORT || 10000);
const GEMINI_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const MAX_BODY = 12 * 1024 * 1024;
const TIMEOUT = 85000;

class ApiError extends Error {
  constructor(message, status=502, code='API_ERROR') {
    super(message); this.status=status; this.code=code;
  }
}
function send(res,status,data) {
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let raw='';
    req.on('data',c=>{
      raw+=c.toString('utf8');
      if(Buffer.byteLength(raw)>MAX_BODY) {
        reject(new ApiError('अनुरोध बहुत बड़ा है।',413,'BODY_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end',()=>{
      try {
        const x=raw?JSON.parse(raw):{};
        if(!x||typeof x!=='object'||Array.isArray(x)) throw Error();
        resolve(x);
      } catch {
        reject(new ApiError('अनुरोध का JSON सही नहीं है।',400,'INVALID_JSON'));
      }
    });
    req.on('error',reject);
  });
}
async function requestJSON(url,options,provider) {
  let r;
  try {
    r=await fetch(url,{...options,signal:AbortSignal.timeout(TIMEOUT)});
  } catch {
    throw new ApiError(`${provider} सेवा से कनेक्शन नहीं हुआ।`,502,'PROVIDER_NETWORK');
  }
  let d={};
  try { d=await r.json(); } catch {}
  if(!r.ok) {
    const m=d?.error?.message||d?.message||'';
    if(r.status===401||r.status===403||/invalid.*key|api.?key.*invalid|unauthorized|authentication/i.test(m))
      throw new ApiError(`${provider} API Key अमान्य है। Render में ${provider==='Gemini'?'GEMINI_API_KEY':'GROQ_API_KEY'} जाँचें।`,502,'INVALID_PROVIDER_KEY');
    if(r.status===429)
      throw new ApiError(`${provider} की API सीमा पूरी हो गई है। बाद में कोशिश करें।`,429,'RATE_LIMIT');
    throw new ApiError(`${provider} से जवाब नहीं मिला${m?': '+m.slice(0,180):'.'}`,502,'PROVIDER_ERROR');
  }
  return d;
}
function getMessages(body) {
  let out=[];
  if(Array.isArray(body.messages)&&body.messages.length)
    out=body.messages.slice(-12).map(m=>({role:m?.role==='assistant'?'assistant':'user',content:m?.content??''}));
  else {
    for(const h of (Array.isArray(body.history)?body.history.slice(-10):[])) {
      const c=String(h?.content??'').trim();
      if(c&&c!=='[object MouseEvent]')
        out.push({role:h?.role==='assistant'?'assistant':'user',content:c.slice(0,12000)});
    }
    const p=body.message??body.prompt??body.text??'';
    if(!String(p).trim()||String(p).trim()==='[object MouseEvent]')
      throw new ApiError('मैसेज खाली या गलत है। कृपया सवाल दोबारा लिखें।',400,'EMPTY_MESSAGE');
    out.push({role:'user',content:String(p).slice(0,12000)});
  }
  if(!out.length) throw new ApiError('मैसेज खाली है।',400,'EMPTY_MESSAGE');
  return out;
}
function instruction(body,extra='') {
  return [
    'आप Smart Saathi हैं। उपयोगकर्ता की भाषा में स्पष्ट, उपयोगी और विनम्र उत्तर दें।',
    `उत्तर की पसंदीदा भाषा: ${String(body.languageName||body.language||'Hindi').slice(0,50)}.`,
    String(body.instructions||'').slice(0,3000),
    extra,
    'तथ्य अनिश्चित हों तो साफ बताएं। अनुमान को तथ्य न बताएं।'
  ].filter(Boolean).join('\n');
}
function geminiParts(content) {
  if(!Array.isArray(content)) return [{text:String(content??'')}];
  return content.map(p=>{
    if(p?.type==='text') return {text:String(p.text||'')};
    if(p?.type==='image_url') {
      const u=p.image_url?.url||'';
      const m=/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(u);
      if(m) return {inlineData:{mimeType:m[1],data:m[2]}};
    }
    return {text:''};
  }).filter(p=>p.text||p.inlineData);
}
async function askGemini(messages,system) {
  if(!GEMINI_KEY) throw new ApiError('Gemini Key सेट नहीं है।',503,'GEMINI_KEY_MISSING');
  const contents=messages.map(m=>({
    role:m.role==='assistant'?'model':'user',
    parts:geminiParts(m.content)
  })).filter(m=>m.parts.length);
  const payload={contents,generationConfig:{temperature:0.6,maxOutputTokens:2048}};
  if(system) payload.systemInstruction={parts:[{text:system}]};
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const d=await requestJSON(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  },'Gemini');
  const reply=(d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
  if(!reply) throw new ApiError('Gemini से खाली जवाब मिला।',502,'EMPTY_REPLY');
  return {reply,provider:'Gemini'};
}
async function askGroq(messages,system,model=GROQ_MODEL) {
  if(!GROQ_KEY) throw new ApiError('Groq backup Key सेट नहीं है।',503,'GROQ_KEY_MISSING');
  const msgs=[];
  if(system) msgs.push({role:'system',content:system});
  for(const m of messages) {
    let c=m.content;
    if(Array.isArray(c))
      c=c.filter(p=>p?.type==='text').map(p=>p.text).join('\n')||'इस फोटो का वर्णन करें।';
    msgs.push({role:m.role,content:String(c??'')});
  }
  const d=await requestJSON('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',
    headers:{Authorization:`Bearer ${GROQ_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({model,messages:msgs,temperature:0.6,max_completion_tokens:2048})
  },'Groq');
  const reply=d?.choices?.[0]?.message?.content||'';
  if(!String(reply).trim()) throw new ApiError('Groq से खाली जवाब मिला।',502,'EMPTY_REPLY');
  return {reply:String(reply),provider:'Groq'};
}
// Gemini primary, then Groq backup. OpenAI is never called.
async function askAI(messages,system) {
  const errors=[];
  if(GEMINI_KEY) {
    try { return await askGemini(messages,system); }
    catch(e) { errors.push(e); }
  }
  if(GROQ_KEY) {
    try { return await askGroq(messages,system); }
    catch(e) { errors.push(e); }
  }
  if(errors.length) {
    const rate=errors.find(e=>e.code==='RATE_LIMIT');
    throw rate||errors[0];
  }
  throw new ApiError('Gemini चालू करने के लिए Render में GEMINI_API_KEY जोड़ें। Groq बैकअप के रूप में रहेगा।',503,'GEMINI_KEY_MISSING');
}
async function chat(body) {
  return askAI(getMessages(body),instruction(body));
}
function imageData(s) {
  if(typeof s!=='string') return null;
  const m=/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(s.trim());
  return m?{mimeType:m[1],data:m[2]}:null;
}
async function vision(body) {
  const img=body.image||body.imageUrl||body.photo||body.dataUrl;
  if(!img) throw new ApiError('तस्वीर नहीं मिली।',400,'IMAGE_MISSING');
  if(!imageData(img)) throw new ApiError('फोटो विश्लेषण के लिए कैमरा/गैलरी की Base64 तस्वीर भेजें।',400,'INVALID_IMAGE');
  const q=String(body.question||body.prompt||body.message||'इस तस्वीर में क्या दिखाई दे रहा है?');
  const msgs=[{role:'user',content:[
    {type:'text',text:q.slice(0,3000)},
    {type:'image_url',image_url:{url:img}}
  ]}];
  const sys=instruction(body,'तस्वीर का ध्यान से विश्लेषण करें। जो साफ दिखाई देता है वही बताएं।');
  const errors=[];
  if(GEMINI_KEY) {
    try { return await askGemini(msgs,sys); }
    catch(e) { errors.push(e); }
  }
  if(GROQ_KEY) {
    try { return await askGroq(msgs,sys,GROQ_VISION_MODEL); }
    catch(e) { errors.push(e); }
  }
  if(errors.length) throw errors.find(e=>e.code==='RATE_LIMIT')||errors[0];
  throw new ApiError('फोटो समझने के लिए GEMINI_API_KEY जोड़ें।',503,'GEMINI_KEY_MISSING');
}
function clean(s) {
  return String(s||'').replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,'')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"')
    .replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
    .replace(/\s+/g,' ').trim();
}
async function webSearch(q) {
  let r;
  try {
    r=await fetch('https://html.duckduckgo.com/html/?q='+encodeURIComponent(q),{
      headers:{'User-Agent':'Mozilla/5.0 SmartSaathi/5.0'},
      signal:AbortSignal.timeout(20000)
    });
  } catch { throw new ApiError('इंटरनेट सर्च से कनेक्शन नहीं हुआ।',502,'SEARCH_NETWORK'); }
  if(!r.ok) throw new ApiError('इंटरनेट सर्च उपलब्ध नहीं है।',502,'SEARCH_UNAVAILABLE');
  const html=await r.text(),results=[];
  for(const block of html.split(/<div[^>]*class="[^"]*result[^"]*"[^>]*>/i)) {
    if(results.length>=8) break;
    const m=block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if(!m) continue;
    let link=m[1];
    try {
      const u=new URL(link,'https://duckduckgo.com');
      if(u.searchParams.has('uddg')) link=u.searchParams.get('uddg');
    } catch { continue; }
    if(!/^https?:\/\//i.test(link)) continue;
    const sm=block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
    results.push({title:clean(m[2]),url:link,snippet:clean(sm?.[1]||'')});
  }
  return results;
}
async function search(body) {
  const q=String(body.query||body.message||body.prompt||'').trim();
  if(!q) throw new ApiError('खोजने के लिए सवाल लिखें।',400,'EMPTY_QUERY');
  const sources=await webSearch(q.slice(0,500));
  if(!sources.length) throw new ApiError('इस सवाल के लिए इंटरनेट परिणाम नहीं मिले।',404,'NO_RESULTS');
  const context=sources.map((s,i)=>`${i+1}. ${s.title}\nURL: ${s.url}\nजानकारी: ${s.snippet}`).join('\n\n');
  const result=await askAI([{role:'user',content:`मेरा सवाल: ${q}\n\nइंटरनेट सर्च परिणाम:\n${context}\n\nइनके आधार पर जवाब दें और स्रोत URL अंत में दें।`}],instruction(body,'वेब सर्च परिणामों के आधार पर जवाब दें। अपुष्ट दावे न करें।'));
  return {...result,sources,liveSearch:true};
}
const routes={'/api/chat':chat,'/api/vision':vision,'/api/search':search};
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS') {
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type, Authorization'
    });
    return res.end();
  }
  let u;
  try { u=new URL(req.url,`http://${req.headers.host||'localhost'}`); }
  catch { return send(res,400,{status:'error',error:'गलत URL है।'}); }
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/api/health'))
    return send(res,200,{
      status:'ok',name:'Smart Saathi API',
      aiConfigured:Boolean(GEMINI_KEY||GROQ_KEY),
      geminiConfigured:Boolean(GEMINI_KEY),
      groqConfigured:Boolean(GROQ_KEY),
      visionConfigured:Boolean(GEMINI_KEY||GROQ_KEY),
      searchConfigured:true,openaiConfigured:false,
      paidOpenAIFallback:false,
      providerOrder:['Gemini','Groq'],
      geminiModel:GEMINI_MODEL,
      endpoints:['/api/health','/api/chat','/api/vision','/api/search']
    });
  if(req.method==='POST'&&routes[u.pathname]) {
    try {
      const result=await routes[u.pathname](await readBody(req));
      return send(res,200,{status:'ok',...result,paidOpenAIFallback:false});
    } catch(e) {
      return send(res,Number.isInteger(e.status)?e.status:500,{
        status:'error',error:e.message||'Server error',
        code:e.code||'SERVER_ERROR',paidOpenAIFallback:false
      });
    }
  }
  return send(res,404,{status:'error',error:'Endpoint नहीं मिला।'});
});
server.listen(PORT,()=>console.log(`Smart Saathi API running on port ${PORT}`));
