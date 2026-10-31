const http=require('http'), fs=require('fs'), path=require('path');
const DIR=__dirname, TIMEOUT=15000;
function get(p, tok){
  return new Promise((res)=>{
    const headers = tok?{Authorization:'Bearer '+tok}:{};
    const t0=Date.now();
    const req=http.request({host:'127.0.0.1',port:8300,path:p,method:'GET',headers},(resp)=>{
      let s='';resp.on('data',c=>s+=c);resp.on('end',()=>{
        let b=null;try{b=JSON.parse(s)}catch{}
        res({status:resp.statusCode,code:b&&b.code,msg:b&&b.message,ms:Date.now()-t0,
             rows:b&&b.data&&(Array.isArray(b.data)?b.data.length:(b.data.rows?b.data.rows.length:null))});
      })});
    req.setTimeout(TIMEOUT,()=>{req.destroy();res({status:-2,msg:'TIMEOUT '+TIMEOUT+'ms',ms:TIMEOUT})});
    req.on('error',e=>res({status:-1,msg:e.message,ms:Date.now()-t0}));
    req.end();
  });
}
const suites=JSON.parse(fs.readFileSync(path.join(DIR,'suites.json'),'utf8'));
(async()=>{
  const all=[];
  for(const [user,paths] of Object.entries(suites)){
    const tf=path.join(DIR,`tok-${user}.txt`);
    const t=fs.existsSync(tf)?fs.readFileSync(tf,'utf8'):null;
    console.log(`\n===== ${user} (${paths.length}) =====`);
    /* 分页并发，避免一次性打爆服务 */
    for(let i=0;i<paths.length;i+=6){
      const chunk=paths.slice(i,i+6);
      const rs=await Promise.all(chunk.map(p=>get(p,t).then(r=>({p,...r}))));
      for(const r of rs){
        const ok=r.status===200&&r.code===0;
        all.push({user,path:r.p,status:r.status,code:r.code,msg:r.msg,ms:r.ms});
        if(!ok||r.ms>3000) console.log(`${ok?'  ':'XX'} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(6)}ms ${r.p.padEnd(46)} ${r.msg?'| '+String(r.msg).slice(0,60):''}`);
      }
    }
  }
  const bad=all.filter(r=>!(r.status===200&&r.code===0));
  const slow=all.filter(r=>r.ms>3000);
  console.log(`\n>>> 总 ${all.length} · 失败 ${bad.length} · 慢(>3s) ${slow.length}`);
  fs.writeFileSync(path.join(DIR,'probe-result.json'),JSON.stringify({bad,slow,all},null,1),'utf8');
})();
