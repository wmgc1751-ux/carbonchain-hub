const http=require('http'), fs=require('fs'), path=require('path');
const DIR=__dirname;
function req(m,p,tok,body){
  return new Promise((res)=>{
    const d=body?JSON.stringify(body):null;
    const h={}; if(d){h['Content-Type']='application/json';h['Content-Length']=Buffer.byteLength(d);}
    if(tok)h.Authorization='Bearer '+tok;
    const t0=Date.now();
    const r=http.request({host:'127.0.0.1',port:8300,path:encodeURI(p),method:m,headers:h},(resp)=>{
      let s='';resp.on('data',c=>s+=c);resp.on('end',()=>{let b;try{b=JSON.parse(s)}catch{b=s}res({status:resp.statusCode,body:b,ms:Date.now()-t0})})});
    r.setTimeout(30000,()=>{r.destroy();res({status:-2,body:'TIMEOUT',ms:30000})});
    r.on('error',e=>res({status:-1,body:e.message,ms:Date.now()-t0})); if(d)r.write(d); r.end();
  });
}
const tok=(u)=>{const f=path.join(DIR,'tok-'+u+'.txt');return fs.existsSync(f)?fs.readFileSync(f,'utf8'):null;};
(async()=>{
  console.log('===== 并发一致性 =====');
  const tr=tok('trader01');
  // 并发 5 笔同金额下单，检查是否超卖/资金穿透
  const before=await req('GET','/api/trade/account',tr);
  const balBefore=before.body.data&&before.body.data.funds?before.body.data.funds.balance:null;
  const results=await Promise.all(Array.from({length:5},()=>req('POST','/api/trade/orders',tr,{side:'BUY',price:69.99,amount:10})));
  const okN=results.filter(r=>r.status===200&&r.body.code===0).length;
  const failN=results.length-okN;
  console.log(`  5 笔并发下单：成功 ${okN} · 失败 ${failN}`);
  // 撤掉这些单
  if(okN){
    const list=await req('GET','/api/trade/orders',tr);
    const mine=(list.body.data||[]).filter(o=>o.status==='OPEN'&&Number(o.price)===69.99);
    for(const o of mine){ await req('POST',`/api/trade/orders/${o.id}/cancel`,tr); }
    console.log(`  已撤销 ${mine.length} 笔测试挂单`);
  }
  const after=await req('GET','/api/trade/account',tr);
  const balAfter=after.body.data&&after.body.data.funds?after.body.data.funds.balance:null;
  console.log(`  资金：下单前 ${balBefore} → 撤单后 ${balAfter} ${balBefore===balAfter?'✔ 已还原':'✘ 未还原'}`);

  console.log('\n===== 并发读压测（10 并发）=====');
  const heavy=['/api/real/overview','/api/chain/stats','/api/public/dashboard','/api/chain/trust-model'];
  for(const p of heavy){
    const rs=await Promise.all(Array.from({length:10},()=>req('GET',p,null)));
    const ok=rs.filter(r=>r.status===200).length;
    const max=Math.max(...rs.map(r=>r.ms));
    console.log(`  ${p.padEnd(28)} ${ok}/10 成功 · 最慢 ${max}ms`);
  }

  console.log('\n===== 错误响应一致性 =====');
  const e1=await req('GET','/api/not-exist');
  const e2=await req('GET','/api/chain/blocks/999999999');
  const e3=await req('POST','/api/auth/login',null,{});
  console.log(`  未知路径 ${e1.status} ${JSON.stringify(e1.body).slice(0,60)}`);
  console.log(`  不存在资源 ${e2.status} ${JSON.stringify(e2.body).slice(0,60)}`);
  console.log(`  参数缺失 ${e3.status} ${JSON.stringify(e3.body).slice(0,60)}`);
  const allJson=[e1,e2,e3].every(r=>r.body&&typeof r.body==='object'&&'code' in r.body);
  console.log(`  ${allJson?'✔':'✘'} 错误响应统一为 JSON`);

  console.log('\n===== 500 错误是否泄露堆栈 =====');
  const t=await req('GET','/api/chain/anchor/stats',tok('admin'));
  console.log(`  anchor/stats ${t.status} ${t.status===200?'正常':'需检查'}`);
})();
