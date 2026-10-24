const BASE_URL = process.env.BASE_URL || 'http://localhost:10000';
async function check(path, options={}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const raw = await response.text(); let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  console.log(`${response.status} ${options.method || 'GET'} ${path}`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data));
  if (!response.ok) process.exitCode = 1;
}
(async()=>{
 await check('/api/health');
 await check('/not-a-real-route');
 if(process.env.TEST_CHAT==='1') await check('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'नमस्ते'})});
})().catch(e=>{console.error(e);process.exitCode=1;});
