import http from 'node:http'; import fs from 'node:fs'
const LOG = new URL('./log.ndjson', import.meta.url)
http.createServer((req,res)=>{
  if (req.method==='POST'){let b='';req.on('data',d=>b+=d);req.on('end',()=>{fs.appendFileSync(LOG,b+'\n');res.writeHead(204);res.end()});return}
  if (req.url.startsWith('/evt.m3u8')) {
    const P='https://streamloom.softarchium.com/api/proxy?url='; const O='http://59.103.38.46:8000/play/a052/index.m3u8'
    fetch(P+encodeURIComponent(O)).then(r=>r.text()).then(m=>{const v=m.split('\n').find(l=>l.startsWith('http')); return fetch(v).then(r=>r.text())}).then(pl=>{
      const out=pl.replace('#EXT-X-TARGETDURATION:3\n','#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:EVENT\n')
      res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl','cache-control':'no-store','access-control-allow-origin':'*'}); res.end(out)
    }).catch(e=>{res.writeHead(502);res.end(String(e))}); return }
  const q=new URL(req.url,'http://x').searchParams
  if (q.get('slow')) {
    const fp=new URL('./'+req.url.split('?')[0].slice(1),import.meta.url); const body=fs.readFileSync(fp)
    const kbps=+q.get('slow'), delay=+(q.get('delay')||1200), chunk=16384
    res.writeHead(200,{'content-type':'video/mp2t','content-length':body.length,'cache-control':'no-store'})
    let off=0; const tick=()=>{ if(off>=body.length){res.end();return} res.write(body.subarray(off,off+chunk)); off+=chunk; setTimeout(tick, chunk/(kbps*1024)*1000) }
    setTimeout(tick, delay); return }
  const f=req.url.split('?')[0].slice(1)||'index.html'
  try{const body=fs.readFileSync(new URL('./'+f,import.meta.url));res.writeHead(200,{'content-type':({js:'text/javascript',m3u8:'application/vnd.apple.mpegurl',ts:'video/mp2t'})[f.split('.').pop()]||'text/html','cache-control':'no-store'});res.end(body)}catch{res.writeHead(404);res.end()}
}).listen(8780,'127.0.0.1',()=>console.log('up'))
