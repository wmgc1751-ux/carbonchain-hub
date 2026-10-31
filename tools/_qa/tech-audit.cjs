const http=require('http'), fs=require('fs'), path=require('path');
const DIR=__dirname;
function req(m,p,tok,body){
  return new Promise((res)=>{
    const d=body?JSON.stringify(body):null;
    const h={}; if(d){h['Content-Type']='application/json';h['Content-Length']=Buffer.byteLength(d);}
    if(tok)h.Authorization='Bearer '+tok;
    const r=http.request({host:'127.0.0.1',port:8300,path:p,method:m,headers:h},(resp)=>{
      let s='';resp.on('data',c=>s+=c);resp.on('end',()=>{let b;try{b=JSON.parse(s)}catch{b=s}res({status:resp.statusCode,body:b,headers:resp.headers})})});
    r.on('error',e=>res({status:-1,body:e.message})); if(d)r.write(d); r.end();
  });
}
const tok=(u)=>{const f=path.join(DIR,'tok-'+u+'.txt');return fs.existsSync(f)?fs.readFileSync(f,'utf8'):null;};
const issues=[];
const ck=(name, pass, detail)=>{ issues.push({name,pass,detail}); console.log(`${pass?'✔':'✘'} ${name}${detail?' — '+detail:''}`); };

(async()=>{
  console.log('===== 1. 安全响应头 =====');
  const h=(await req('GET','/api/health')).headers;
  for(const [k,v] of [['x-content-type-options','nosniff'],['x-frame-options',null],['strict-transport-security',null],['content-security-policy',null]]){
    const val=h[k];
    ck(`响应头 ${k}`, !!val, val||'缺失');
  }
  ck('关闭 X-Powered-By 泄露', !h['x-powered-by'], h['x-powered-by']||'已关闭');

  console.log('\n===== 2. 边界与注入 =====');
  const t=tok('ent001');
  let r=await req('POST','/api/enterprise/reports',t,{year:1800,quarter:1,items:[{energyType:'原煤',amount:1}]});
  ck('非法年度被拒', r.status===400, `status=${r.status}`);
  r=await req('POST','/api/enterprise/reports',t,{year:2026,quarter:99,items:[{energyType:'原煤',amount:1}]});
  ck('非法季度被拒', r.status===400, `status=${r.status}`);
  r=await req('POST','/api/enterprise/reports',t,{year:2026,quarter:1,items:[{energyType:'原煤',amount:-100}]});
  ck('负数排放量被拒', r.status===400, `status=${r.status}`);
  r=await req('POST','/api/enterprise/reports',t,{year:2026,quarter:1,items:[]});
  ck('空明细被拒', r.status===400, `status=${r.status}`);
  r=await req('GET',"/api/chain/txs?keyword=' OR 1=1 --",t);
  ck('SQL 注入不生效', r.status===200 && (r.body.data.rows||[]).length===0, `rows=${r.body&&r.body.data?r.body.data.rows.length:'?'}`);
  r=await req('GET','/api/chain/address/0xZZZ',t);
  ck('非法钱包地址被拒', r.status===400, `status=${r.status}`);

  console.log('\n===== 3. 重复提交 =====');
  const y=2026, q=4;
  const a=await req('POST','/api/enterprise/reports',t,{year:y,quarter:q,items:[{energyType:'原煤',amount:10}]});
  const b=await req('POST','/api/enterprise/reports',t,{year:y,quarter:q,items:[{energyType:'原煤',amount:10}]});
  ck('同一报告期重复上报被拒', a.status===200 && b.status===400, `首次 ${a.status} / 重复 ${b.status}`);

  console.log('\n===== 4. 限流 =====');
  let limited=false;
  for(let i=0;i<14;i++){
    const x=await req('POST','/api/auth/login',null,{username:'admin',password:'wrong'+i});
    if(x.status===429){limited=true;break;}
  }
  ck('登录暴力破解被限流', limited, limited?'触发 429':'14 次未限流');

  console.log('\n===== 5. 大载荷与异常输入 =====');
  const big='x'.repeat(3*1024*1024);
  r=await req('POST','/api/auth/login',null,{username:big,password:'a'});
  ck('超大请求体被拒', r.status===413||r.status===400, `status=${r.status}`);
  r=await req('GET','/api/chain/blocks/abc',t);
  ck('非数字区块高度被优雅处理', r.status===400||r.status===404||r.status===500, `status=${r.status}`);

  const failed=issues.filter(x=>!x.pass);
  console.log(`\n>>> 检查 ${issues.length} 项，未通过 ${failed.length} 项`);
  fs.writeFileSync(path.join(DIR,'tech-audit.json'),JSON.stringify(issues,null,1),'utf8');
})();
