const http=require('http'), fs=require('fs'), path=require('path');
const DIR=__dirname, HOST='127.0.0.1', PORT=8300;
function req(m,p,tok,body,raw){
  return new Promise((res)=>{
    const d=raw!==undefined?raw:(body?JSON.stringify(body):null);
    const h={}; if(d!==null){h['Content-Type']='application/json';h['Content-Length']=Buffer.byteLength(d);}
    if(tok)h.Authorization='Bearer '+tok;
    const r=http.request({host:HOST,port:PORT,path:encodeURI(p),method:m,headers:h},(resp)=>{
      let s='';resp.on('data',c=>s+=c);resp.on('end',()=>{let b;try{b=JSON.parse(s)}catch{b=s}res({status:resp.statusCode,body:b})})});
    r.on('error',e=>res({status:-1,body:e.message})); if(d!==null)r.write(d); r.end();
  });
}
const tok=(u)=>{const f=path.join(DIR,'tok-'+u+'.txt');return fs.existsSync(f)?fs.readFileSync(f,'utf8'):null;};
const out=[];
const ck=(n,p,d)=>{out.push({name:n,pass:p,detail:d||''});console.log(`${p?'✔':'✘'} ${n}${d?' — '+d:''}`)};
(async()=>{
  const t=tok('ent001');
  console.log('===== 注入 / 越界 =====');
  let r=await req('GET',"/api/chain/txs?keyword=' OR 1=1 --",t);
  ck('SQL 注入不生效', r.status===200 && (r.body.data&&r.body.data.rows||[]).length===0, `rows=${r.body.data?r.body.data.rows.length:'?'}`);
  r=await req('GET','/api/chain/address/0xZZZ',t);
  ck('非法钱包地址被拒', r.status===400, `status=${r.status}`);
  r=await req('GET','/api/chain/blocks/abc',t);
  ck('非数字区块高度优雅处理', [400,404,500].includes(r.status), `status=${r.status}`);
  r=await req('GET','/api/chain/blocks/999999999',t);
  ck('不存在区块返回 404', r.status===404, `status=${r.status}`);

  console.log('\n===== 分页越界 =====');
  r=await req('GET','/api/chain/txs?page=99999&size=10',t);
  ck('超大页码不报错', r.status===200, `status=${r.status} rows=${r.body.data?r.body.data.rows.length:'?'}`);
  r=await req('GET','/api/chain/txs?size=99999',t);
  ck('超大 size 被夹紧', r.status===200 && r.body.data.size<=200, `size=${r.body.data&&r.body.data.size}`);
  r=await req('GET','/api/chain/txs?page=-5',t);
  ck('负数页码被修正', r.status===200 && r.body.data.page>=1, `page=${r.body.data&&r.body.data.page}`);

  console.log('\n===== 超大请求体 =====');
  const big=JSON.stringify({username:'x'.repeat(3*1024*1024),password:'a'});
  r=await req('POST','/api/auth/login',null,null,big);
  ck('3MB 请求体被拒', r.status===413, `status=${r.status}`);

  console.log('\n===== 令牌安全 =====');
  r=await req('GET','/api/enterprise/overview','Bearer abc.def.ghi');
  ck('畸形 token 被拒', r.status===401, `status=${r.status}`);
  // 过期 token 无法本地构造，跳过
  r=await req('GET','/api/enterprise/overview',null);
  ck('无 token 访问私有数据被拒', r.status===401, `status=${r.status}`);

  console.log('\n===== 敏感信息泄露 =====');
  r=await req('GET','/api/regulator/enterprises',tok('reg001'));
  const row=(r.body.data&&r.body.data.rows||[])[0]||{};
  ck('企业列表不含联系方式', !('contact_phone' in row) && !('legal_person' in row), Object.keys(row).join(','));
  r=await req('GET','/api/enterprise/wallet',t);
  ck('钱包接口不返回私钥', !JSON.stringify(r.body).match(/privateKey|PRIVATE KEY/), '');
  r=await req('GET','/api/ops/health',tok('admin'));
  const hs=JSON.stringify(r.body);
  ck('健康检查不含密码', !/password|DB_PASSWORD|JWT_SECRET/i.test(hs), '');

  const bad=out.filter(x=>!x.pass);
  console.log(`\n>>> ${out.length} 项，未通过 ${bad.length}`);
  fs.writeFileSync(path.join(DIR,'tech-audit2.json'),JSON.stringify(out,null,1),'utf8');
})();
