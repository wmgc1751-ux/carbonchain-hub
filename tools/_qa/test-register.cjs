const http=require('http');
function req(method,p,body,tok){
  return new Promise((res)=>{
    const d=body?JSON.stringify(body):null;
    const headers={}; if(d)headers['Content-Type']='application/json';
    if(d)headers['Content-Length']=Buffer.byteLength(d);
    if(tok)headers.Authorization='Bearer '+tok;
    const r=http.request({host:'127.0.0.1',port:8300,path:p,method,headers},(resp)=>{
      let s='';resp.on('data',c=>s+=c);resp.on('end',()=>{let b;try{b=JSON.parse(s)}catch{b=s}res({status:resp.statusCode,body:b})})});
    r.on('error',e=>res({status:-1,body:e.message}));
    if(d)r.write(d); r.end();
  });
}
const suf=Date.now().toString().slice(-6);
(async()=>{
  console.log('===== 1. 企业自主注册 =====');
  const entReg=await req('POST','/api/auth/register',{
    role:'ENTERPRISE',username:'newent'+suf,password:'test123456',
    realName:'测试联系人',orgName:'测试碳素新材料有限公司'+suf,
    industry:'化工',region:'河北',contactPhone:'13800000000',
  });
  console.log('status',entReg.status,JSON.stringify(entReg.body).slice(0,200));
  if(entReg.body.code!==0) return;
  const entTok=entReg.body.data.token;
  require('fs').writeFileSync(__dirname+'/tok-newent.txt',entTok,'utf8');
  const entId=entReg.body.data.user.orgId;
  console.log('新企业 entId=',entId);

  console.log('\n===== 2. 新企业核心接口 =====');
  for(const p of ['/api/enterprise/overview','/api/enterprise/reports','/api/enterprise/quotas','/api/enterprise/wallet','/api/enterprise/notices','/api/dynamic/me','/api/chain/stats']){
    const r=await req('GET',p,null,entTok);
    const okk=r.status===200&&r.body.code===0;
    console.log(`${okk?'  ':'XX'} ${String(r.status).padEnd(4)} ${p.padEnd(32)} ${okk?'':JSON.stringify(r.body).slice(0,120)}`);
  }

  console.log('\n===== 3. 核查机构注册（待审核） =====');
  const verReg=await req('POST','/api/auth/register',{
    role:'VERIFIER',username:'newver'+suf,password:'test123456',
    realName:'核查联系人',orgName:'测试核查技术研究院'+suf,
    region:'河北',contactPhone:'13900000000',
  });
  console.log('status',verReg.status,JSON.stringify(verReg.body).slice(0,200));

  console.log('\n===== 4. 待审核账号尝试登录（应被拒） =====');
  const badLogin=await req('POST','/api/auth/login',{username:'newver'+suf,password:'test123456'});
  console.log('status',badLogin.status,'msg:',badLogin.body.message);
})();
