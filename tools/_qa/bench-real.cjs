const http=require('http');
function hit(p, tok){return new Promise(res=>{
  const t0=Date.now();
  const headers=tok?{Authorization:'Bearer '+tok}:{};
  const req=http.request({host:'127.0.0.1',port:8300,path:p,headers},(r)=>{
    let n=0;r.on('data',c=>n+=c.length);r.on('end',()=>res({p,code:r.statusCode,ms:Date.now()-t0,bytes:n}));
  });
  req.setTimeout(45000,()=>{req.destroy();res({p,code:-2,ms:45000,timeout:true})});
  req.on('error',e=>res({p,code:-1,ms:Date.now()-t0,err:e.message}));
  req.end();
});}
const paths=['/api/real/overview','/api/real/facilities','/api/real/benchmarks','/api/real/trend','/api/real/macro','/api/real/sources','/api/real/cn/regions','/api/real/truth','/api/real/cn/crosscheck','/api/evidence/nodes','/api/evidence/list','/api/zk/commitments','/api/zk/selftest'];
(async()=>{
  for(const p of paths){
    const r=await hit(p);
    console.log(`${String(r.code).padEnd(4)} ${String(r.ms).padStart(6)}ms ${String(r.bytes||0).padStart(8)}B  ${p}`);
  }
})();
