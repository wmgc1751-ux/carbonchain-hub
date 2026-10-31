const http=require('http'), fs=require('fs'), path=require('path');
const DIR=__dirname;
function req(m,p,tok,body){
  return new Promise((res)=>{
    const d=body?JSON.stringify(body):null;
    const h={}; if(d){h['Content-Type']='application/json';h['Content-Length']=Buffer.byteLength(d);}
    if(tok)h.Authorization='Bearer '+tok;
    const r=http.request({host:'127.0.0.1',port:8300,path:encodeURI(p),method:m,headers:h},(resp)=>{
      let s='';resp.on('data',c=>s+=c);resp.on('end',()=>{let b;try{b=JSON.parse(s)}catch{b=s}res({status:resp.statusCode,body:b})})});
    r.setTimeout(25000,()=>{r.destroy();res({status:-2,body:'TIMEOUT'})});
    r.on('error',e=>res({status:-1,body:e.message})); if(d!==null)r.write(d); r.end();
  });
}
const suf=Date.now().toString().slice(-6);
const step=(n,ok,d)=>console.log(`${ok?'✔':'✘'} ${n}${d?' — '+d:''}`);
(async()=>{
  console.log('===== 新注册企业：端到端 =====');
  const reg=await req('POST','/api/auth/register',null,{
    role:'ENTERPRISE',username:'e2eent'+suf,password:'test123456',
    realName:'端到端测试',orgName:'端到端碳科技'+suf,industry:'钢铁',region:'江苏',contactPhone:'13700000000',
  });
  step('注册成功', reg.status===200&&reg.body.code===0, reg.body.message);
  if(reg.body.code!==0) return;
  const tok=reg.body.data.token;
  step('注册即登录（已发 token）', !!tok, `len=${(tok||'').length}`);
  const entId=reg.body.data.user.orgId;

  const o=await req('GET','/api/enterprise/overview',tok);
  step('企业总览可访问', o.status===200&&o.body.code===0, `wallet=${o.body.data&&o.body.data.enterprise?(o.body.data.enterprise.wallet||'NULL'):'?'}`);
  step('注册即开户', !!(o.body.data&&o.body.data.enterprise&&o.body.data.enterprise.wallet), o.body.data?.enterprise?.wallet||'');

  const w=await req('GET','/api/enterprise/wallet',tok);
  step('链上身份可查', w.status===200 && !!w.body.data.address, w.body.data?.address||'');
  step('公钥已生成', !!(w.body.data&&w.body.data.publicKey), `len=${(w.body.data?.publicKey||'').length}`);

  const rep=await req('POST','/api/enterprise/reports',tok,{year:2026,quarter:1,submit:true,
    items:[{energyType:'原煤',amount:500},{energyType:'电力',amount:20000}]});
  step('新建并提交上报', rep.status===200&&rep.body.code===0, rep.body.message);
  step('上报已上链', !!(rep.body.data&&rep.body.data.chain&&rep.body.data.chain.txId), rep.body.data?.chain?.txId?.slice(0,16)||'');

  const rs=await req('GET','/api/enterprise/reports',tok);
  step('上报列表含新记录', (rs.body.data?.rows||[]).length>0, `rows=${(rs.body.data?.rows||[]).length}`);

  const rid=rep.body.data?.reportId;
  if(rid){
    const ch=await req('GET',`/api/enterprise/reports/${rid}/chain`,tok);
    step('链上存证明细可查', ch.status===200&&ch.body.code===0, `merkle.path=${ch.body.data?.merkle?.path?.length}`);
  }

  const dy=await req('GET','/api/dynamic/me',tok);
  step('动态核算可访问', dy.status===200, `code=${dy.body&&dy.body.code}`);

  const no=await req('GET','/api/enterprise/notices',tok);
  step('通知公告可读', no.status===200, `rows=${(no.body.data?.rows||no.body.data||[]).length}`);

  const aw=await req('GET','/api/regulator/overview',tok);
  step('越权访问监管被拒', aw.status===403, `status=${aw.status}`);

  console.log('\n===== 新注册核查机构：审核链路 =====');
  const vreg=await req('POST','/api/auth/register',null,{
    role:'VERIFIER',username:'e2ever'+suf,password:'test123456',
    realName:'机构测试',orgName:'端到端核查院'+suf,region:'浙江',contactPhone:'13600000000',
  });
  step('机构注册成功', vreg.status===200&&vreg.body.code===0, vreg.body.message);
  step('返回待审核状态', !!vreg.body.data?.pending, JSON.stringify(vreg.body.data?.user||{}).slice(0,60));
  const vl=await req('POST','/api/auth/login',null,{username:'e2ever'+suf,password:'test123456'});
  step('待审核不可登录', vl.status===403, vl.body.message?.slice(0,50));

  // 管理员审核通过
  const adm=fs.existsSync(path.join(DIR,'tok-admin.txt'))?fs.readFileSync(path.join(DIR,'tok-admin.txt'),'utf8'):null;
  const list=await req('GET','/api/admin/verifier-registrations',adm);
  const target=(list.body.data||[]).find(x=>String(x.org_name||'').includes(suf));
  if(target){
    const rv=await req('POST',`/api/admin/verifier-registrations/${target.id}/review`,adm,{action:'approve'});
    step('管理员审核通过', rv.status===200&&rv.body.code===0, rv.body.message);
    const vl2=await req('POST','/api/auth/login',null,{username:'e2ever'+suf,password:'test123456'});
    step('审核后可登录', vl2.status===200&&vl2.body.code===0, vl2.body.message?.slice(0,40));
    if(vl2.body.code===0){
      const vt=vl2.body.data.token;
      const vo=await req('GET','/api/verifier/overview',vt);
      step('核查端总览可访问', vo.status===200, `code=${vo.body&&vo.body.code}`);
      const vw=await req('GET','/api/verifier/wallet',vt);
      step('核查机构有链上身份', !!(vw.body.data&&vw.body.data.address), vw.body.data?.address||'');
    }
  } else {
    step('找到待审机构记录', false, '未在待审列表中找到');
  }
  console.log(`\n测试账号：e2eent${suf} / e2ever${suf}（entId=${entId}）`);
})();
