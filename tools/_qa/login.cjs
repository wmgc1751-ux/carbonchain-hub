const http = require('http');
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
function post(p, body) {
  return new Promise((res, rej) => {
    const d = JSON.stringify(body);
    const r = http.request({ host:'127.0.0.1', port:8300, path:p, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}},
      (resp)=>{let s='';resp.on('data',c=>s+=c);resp.on('end',()=>{let b;try{b=JSON.parse(s)}catch{b=s}res({status:resp.statusCode,body:b})})});
    r.on('error',rej); r.write(d); r.end();
  });
}
(async()=>{
  const accts=[['admin','admin123'],['reg001','123456'],['ent001','123456'],['ver001','123456'],['trader01','123456']];
  for(const [u,p] of accts){
    const r=await post('/api/auth/login',{username:u,password:p});
    if(r.status===200&&r.body.code===0){
      fs.writeFileSync(path.join(DIR,`tok-${u}.txt`), r.body.data.token,'utf8');
      console.log(`OK ${u} role=${r.body.data.user.role}`);
    } else console.log(`FAIL ${u} ${r.status} ${JSON.stringify(r.body).slice(0,150)}`);
  }
})();
