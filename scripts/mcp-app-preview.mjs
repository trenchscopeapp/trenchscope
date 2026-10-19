// Local-only MCP Apps host for visual and interaction checks. Uses the real public MCP handler.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPublicMcp } from '../packages/mcp/src/http.ts';
import { appResource } from '../packages/mcp/src/app-resource.ts';

const mcp = createPublicMcp(); mcp.listen(0, '127.0.0.1'); await once(mcp, 'listening');
const endpoint = `http://127.0.0.1:${mcp.address().port}/mcp`;

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trenchscope MCP App preview</title><style>body{margin:0;background:#202020;color:#ededed;font:14px monospace;padding:24px}p{max-width:880px;margin:0 auto 16px;color:#a6a6a6}iframe{display:block;width:100%;max-width:880px;height:680px;border:1px solid #343434;border-radius:12px;margin:auto}@media(max-width:480px){body{padding:16px}iframe{border-radius:8px}}</style><p id="label">Trenchscope / MCP Apps test host / live market data</p><iframe title="Trenchscope market" sandbox="allow-scripts"></iframe><script>
const frame=document.querySelector('iframe'); let started=false; const query=new URLSearchParams(location.search);
const initialName=query.has('dossier')?'get_dossier':'screener_query'; const initialArgs=query.has('dossier')?{mint:'So11111111111111111111111111111111111111112'}:{preset:'trending',limit:8};
const sample={preset:'trending',now:Date.now(),rows:[{mint:'So11111111111111111111111111111111111111112',symbol:'SOL',priceUsd:152.48,mcap:89000000000,liquidityUsd:56800000,volH1:1840000,priceChange:{h1:2.84}},{mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCaC8NtjRtH5vssm2T',symbol:'BONK',priceUsd:.00001876,mcap:1420000000,liquidityUsd:34100000,volH1:421000,priceChange:{h1:-1.25}},{mint:'11111111111111111111111111111111',symbol:query.has('stress')?'<img src=x onerror=alert(1)>LONG_SYMBOL_WITHOUT_BREAKS_'.repeat(3):'UNKNOWN',priceUsd:null,mcap:null,liquidityUsd:null,volH1:null,priceChange:{h1:null}}],errors:{}};
if(query.has('sample')) document.getElementById('label').textContent='Trenchscope / MCP Apps test host / illustrative sample data';
async function call(name,args){const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const m=await r.json();if(m.error)throw Error(m.error.message);return m.result;}
function send(message){frame.contentWindow.postMessage({jsonrpc:'2.0',...message},'*');}
window.addEventListener('message',async e=>{if(e.source!==frame.contentWindow||e.data?.jsonrpc!=='2.0')return;const m=e.data;try{if(m.method==='ui/initialize'){send({id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'trenchscope-preview',version:'1'},hostCapabilities:{serverTools:{},openLinks:{}},hostContext:{theme:query.has('light')?'light':'dark',toolInfo:{tool:{name:initialName}},containerDimensions:{width:880}}}});}else if(m.method==='ui/notifications/initialized'&&!started){started=true;send({method:'ui/notifications/tool-input',params:{arguments:initialArgs}});const result=query.has('sample')?{content:[{type:'text',text:JSON.stringify(sample)}],structuredContent:sample}:await call(initialName,initialArgs);send({method:'ui/notifications/tool-result',params:result});}else if(m.method==='ui/open-link'){window.__lastOpenedUrl=m.params.url;send({id:m.id,result:{}});}else if(m.method==='tools/call'){const result=await call(m.params.name,m.params.arguments);send({id:m.id,result});}else if(m.method==='ui/notifications/size-changed'){frame.style.height=Math.max(200,Math.min(m.params.height+4,1800))+'px';}}catch(error){send({id:m.id,error:{code:-32000,message:error.message}});}});
fetch('/view').then(r=>r.text()).then(html=>frame.srcdoc=html);
</script></html>`;
const server = createServer(async (req, res) => {
  if (req.url === '/view') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(appResource().contents[0].text); return; }
  if (req.url === '/rpc' && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    try { const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: Buffer.concat(chunks) }); res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(await result.text()); }
    catch { res.writeHead(502); res.end('{"error":{"message":"Local MCP request failed"}}'); }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});
server.listen(3422, '127.0.0.1', () => console.log('MCP App preview: http://127.0.0.1:3422'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); mcp.close(); });
