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
  const ent=tok('ent001'), ver=tok('ver001'), reg=tok('reg001'), tr=tok('trader01'), adm=tok('admin');

  console.log('===== A. 企业上报 → 核查任务生成 =====');
  const r1=await req('POST','/api/enterprise/reports',ent,{year:2026,quarter:3,submit:true,
    items:[{energyType:'原煤',amount:1200},{energyType:'电力',amount:80000}]});
  console.log('上报:',r1.status,r1.body.message, 'reportId=',r1.body.data&&r1.body.data.reportId);

  const tasks=await req('GET','/api/verifier/tasks',ver);
  const list=tasks.body.data&&(tasks.body.data.rows||tasks.body.data);
  console.log('核查任务数:',Array.isArray(list)?list.length:'?');
  const t0=Array.isArray(list)&&list[0];
  if(t0) console.log('首个任务:',t0.task_no||t0.id, t0.status);

  console.log('\n===== B. 核查机构受理并出具报告 =====');
  if(t0){
    const tid=t0.id;
    const acc=await req('POST',`/api/verifier/tasks/${tid}/accept`,ver,{});
    console.log('受理:',acc.status,acc.body.message);
    const vf=await req('POST',`/api/verifier/tasks/${tid}/verify`,ver,{conclusion:'PASS',auditor:'核查员'});
    console.log('出报告:',vf.status,vf.body.message,JSON.stringify(vf.body.data||{}).slice(0,150));
  }

  console.log('\n===== C. 监管端视角 =====');
  const ov=await req('GET','/api/regulator/overview',reg);
  console.log('监管概览 KPI:',JSON.stringify(ov.body.data&&ov.body.data.kpi||{}).slice(0,200));
  const al=await req('GET','/api/regulator/allocations',reg);
  console.log('配额分配:',al.status,'rows',al.body.data&&al.body.data.rows&&al.body.data.rows.length);

  console.log('\n===== D. 交易端下单 =====');
  const mk=await req('GET','/api/trade/market',tr);
  console.log('市场:',mk.status,JSON.stringify(mk.body.data).slice(0,150));
  const ob=await req('GET','/api/trade/orderbook',tr);
  console.log('盘口:',ob.status,JSON.stringify(ob.body.data).slice(0,200));
  const ord=await req('POST','/api/trade/orders',tr,{side:'BUY',price:68.5,amount:10});
  console.log('下单:',ord.status,ord.body.message,JSON.stringify(ord.body.data||{}).slice(0,200));

  console.log('\n===== E. 管理端 =====');
  const ao=await req('GET','/api/admin/overview',adm);
  console.log('管理概览:',ao.status,JSON.stringify(ao.body.data).slice(0,200));
  const vr=await req('GET','/api/admin/verifier-registrations',adm);
  console.log('待审机构:',vr.status,'rows',vr.body.data&&vr.body.data.length);
})();
