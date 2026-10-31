const http=require('http'), fs=require('fs'), path=require('path');
const DIR=__dirname;
function req(m,p,tok,body){
  return new Promise((res)=>{
    const d=body?JSON.stringify(body):null;
    const h={}; if(d){h['Content-Type']='application/json';h['Content-Length']=Buffer.byteLength(d);}
    if(tok)h.Authorization='Bearer '+tok;
    const r=http.request({host:'127.0.0.1',port:8300,path:p,method:m,headers:h},(resp)=>{
      let s='';resp.on('data',c=>s+=c);resp.on('end',()=>{let b;try{b=JSON.parse(s)}catch{b=s}res({status:resp.statusCode,body:b})})});
    r.on('error',e=>res({status:-1,body:e.message})); if(d)r.write(d); r.end();
  });
}
const tok=(u)=>{const f=path.join(DIR,'tok-'+u+'.txt');return fs.existsSync(f)?fs.readFileSync(f,'utf8'):null;};

(async()=>{
  console.log('===== 越权测试：企业账号访问监管/管理接口 =====');
  const ent=tok('ent001');
  for(const [m,p] of [['GET','/api/regulator/overview'],['GET','/api/admin/overview'],['POST','/api/regulator/allocations'],['GET','/api/verifier/tasks'],['POST','/api/admin/factors']]){
    const r=await req(m,p,ent,{});
    const blocked = r.status===401||r.status===403;
    console.log(`${blocked?'✔ 已拦':'✗ 越权!'} ${m} ${p.padEnd(34)} -> ${r.status} ${blocked?'':JSON.stringify(r.body).slice(0,80)}`);
  }

  console.log('\n===== 越权测试：交易端访问企业私有数据 =====');
  const tr=tok('trader01');
  for(const p of ['/api/enterprise/overview','/api/enterprise/reports','/api/enterprise/wallet']){
    const r=await req('GET',p,tr);
    const blocked=r.status===401||r.status===403;
    console.log(`${blocked?'✔ 已拦':'✗ 越权!'} GET ${p.padEnd(32)} -> ${r.status}`);
  }

  console.log('\n===== 越权测试：核查端访问监管接口 =====');
  const ver=tok('ver001');
  for(const p of ['/api/regulator/overview','/api/admin/overview']){
    const r=await req('GET',p,ver);
    const blocked=r.status===401||r.status===403;
    console.log(`${blocked?'✔ 已拦':'✗ 越权!'} GET ${p.padEnd(32)} -> ${r.status}`);
  }

  console.log('\n===== 未登录访问受保护接口 =====');
  for(const p of ['/api/enterprise/overview','/api/regulator/overview','/api/admin/overview','/api/trade/orders']){
    const r=await req('GET',p,null);
    console.log(`${r.status===401?'✔ 401':'✗ '+r.status} GET ${p.padEnd(32)}`);
  }

  console.log('\n===== 伪造 token =====');
  const fake='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwicm9sZSI6IkFETUlOIn0.bad';
  const r=await req('GET','/api/admin/overview',fake);
  console.log(`${r.status===401?'✔ 401 拒绝':'✗ '+r.status} 伪造 token`);
})();
