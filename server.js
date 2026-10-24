'use strict';
const http = require('http');
const { URL } = require('url');
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY = 12 * 1024 * 1024;
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'});
  res.end(body);
}
function readBody(req) { return new Promise((resolve,reject)=>{ let raw='', done=false; req.on('data',chunk=>{ if(done)return; raw+=chunk; if(Buffer.byteLength(raw)>MAX_BODY){done=true; reject(Object.assign(new Error('Request too large; maximum body is 12 MB.'),{status:413})); req.destroy();} }); req.on('end',()=>{if(done)return; try{resolve(raw?JSON.parse(raw):{});}catch{reject(Object.assign(new Error('Invalid JSON request.'),{status:400}));}}); req.on('error',e=>{if(!done)reject(e);}); }); }
function promptFor(data){const lang=String(data.languageName||data.language||'Hindi').slice(0,80);return `You are Smart Saathi, a helpful, friendly assistant. Reply in ${lang} unless the user asks for another language. Give clear, practical answers. Show calculations with units. Never claim to control the user's phone or apps unless a connected tool actually performed that action.`;}
function extractText(d){if(typeof d.output_text==='string'&&d.output_text.trim())return d.output_text.trim();const out=[];for(const item of d.output||[])for(const c of item.content||[])if(c.type==='output_text'&&c.text)out.push(c.text);return out.join('\n').trim();}
async function responsesAPI(payload){if(!API_KEY)throw Object.assign(new Error('सर्वर पर OPENAI_API_KEY सेट नहीं है।'),{status:503});const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(d.error?.message||`AI provider HTTP ${r.status}`),{status:r.status>=500?502:(r.status===429?429:400)});return d;}
function errorReply(res,e){const status=Number(e.status)||500;return send(res,status,{status:'error',error:e.message||'सर्वर में समस्या हुई।'});}
const server=http.createServer(async(req,res)=>{
 if(req.method==='OPTIONS')return send(res,204,{});
 const url=new URL(req.url,`http://${req.headers.host||'localhost'}`); const path=url.pathname;
 if(req.method==='GET'&&path==='/')return send(res,200,{name:'Smart Saathi API',status:'ok',endpoints:['/api/health','/api/chat','/api/vision','/api/search']});
 if(req.method==='GET'&&path==='/api/health')return send(res,200,{status:'ok',name:'Smart Saathi API',aiConfigured:!!API_KEY,visionConfigured:!!API_KEY,searchConfigured:!!API_KEY,pushConfigured:false,model:MODEL,endpoints:['/api/health','/api/chat','/api/vision','/api/search'],message:API_KEY?'AI key configured':'OPENAI_API_KEY missing'});
 if(req.method!=='POST'||!['/api/chat','/api/vision','/api/search'].includes(path))return send(res,404,{status:'error',error:'Endpoint नहीं मिला।',path,method:req.method,available:['GET /','GET /api/health','POST /api/chat','POST /api/vision','POST /api/search']});
 try{
  const data=await readBody(req); let response, reply;
  if(path==='/api/chat'){
   const message=String(data.message??data.prompt??data.text??'').trim(); if(!message)return send(res,400,{status:'error',error:'सवाल खाली है।'});
   const input=[];const history=Array.isArray(data.messages)?data.messages:(Array.isArray(data.history)?data.history:[]);
   for(const item of history.slice(-20)){const role=['user','assistant'].includes(item?.role)?item.role:null;const content=item?.content??item?.text;if(role&&typeof content==='string'&&content.trim())input.push({role,content:content.slice(0,6000)});}
   input.push({role:'user',content:message.slice(0,12000)});
   response=await responsesAPI({model:MODEL,instructions:promptFor(data),input}); reply=extractText(response);
   if(!reply)return send(res,502,{status:'error',error:'AI से खाली जवाब मिला।'});
   return send(res,200,{status:'ok',reply,message:reply,model:MODEL});
  }
  if(path==='/api/vision'){
   const image=String(data.image??data.imageUrl??data.photo??data.dataUrl??'').trim();const question=String(data.message??data.prompt??data.question??'इस फोटो में क्या है?').slice(0,2000);
   if(!image)return send(res,400,{status:'error',error:'फोटो नहीं मिली।'});
   if(!/^https:\/\/\S+/i.test(image)&&!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(image))return send(res,400,{status:'error',error:'फोटो HTTPS URL या मान्य image data URL होनी चाहिए।'});
   response=await responsesAPI({model:MODEL,instructions:promptFor(data),input:[{role:'user',content:[{type:'input_text',text:question},{type:'input_image',image_url:image}]}]});reply=extractText(response);
   if(!reply)return send(res,502,{status:'error',error:'फोटो का जवाब नहीं मिला।'});
   return send(res,200,{status:'ok',reply,description:reply,model:MODEL});
  }
  const query=String(data.query??data.message??data.search??data.prompt??'').trim();if(!query)return send(res,400,{status:'error',error:'सर्च का सवाल खाली है।'});
  response=await responsesAPI({model:MODEL,tools:[{type:'web_search'}],instructions:`${promptFor(data)} Search the web for the user's query, summarize useful current information, and include source links when available.`,input:query.slice(0,8000)});reply=extractText(response);
  const sources=[];for(const item of response.output||[])for(const c of item.content||[])for(const a of c.annotations||[])if(a.type==='url_citation'&&a.url&&!sources.some(s=>s.url===a.url))sources.push({title:a.title||a.url,url:a.url});
  if(!reply)return send(res,502,{status:'error',error:'सर्च के नतीजे नहीं मिले।'});
  return send(res,200,{status:'ok',reply,results:reply,sources,model:MODEL});
 }catch(e){console.error('request error:',e.status||'',e.message||e);return errorReply(res,e);}
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Smart Saathi API listening on ${PORT}; model=${MODEL}; key=${!!API_KEY}`));
