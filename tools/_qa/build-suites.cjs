/* 按角色为每个 GET 路由构造可测路径（把 :param 替换成真实 ID，或标记为 skip） */
const fs=require('fs'), path=require('path');
const routes=JSON.parse(fs.readFileSync(path.join(__dirname,'routes.json'),'utf8'));
const getOnly=routes.filter(r=>r.method==='GET');

/* 需要真实 ID 的路径：给出当前库里已知可用的 ID */
const ID_FILL = {
  '/api/enterprise/reports/:id': '1',
  '/api/enterprise/reports/:id/chain': '1',
  '/api/verifier/tasks/:id': '1',
  '/api/verifier/reports/:id/chain': '1',
  '/api/regulator/enterprises/:id': '1',
  '/api/chain/blocks/:index': '1',
  '/api/chain/tx/:txId': null,
};
const ROLE_PREFIX = {
  admin: ['/api/admin','/api/ops','/api/chain','/api/consortium','/api/keys','/api/intelligence','/api/regulator','/api/real','/api/mrv','/api/evidence','/api/public','/api/notice','/api/notify','/api/dynamic','/api/uncertainty','/api/zk','/api/settlement','/api/international'],
  reg001: ['/api/regulator','/api/chain','/api/settlement','/api/credit','/api/mrv','/api/public','/api/notice','/api/notify','/api/evidence','/api/consortium'],
  ent001: ['/api/enterprise','/api/chain','/api/dynamic','/api/credit','/api/mrv','/api/public','/api/notice','/api/notify','/api/evidence'],
  ver001: ['/api/verifier','/api/chain','/api/mrv','/api/public','/api/notice','/api/notify','/api/evidence','/api/uncertainty'],
  trader01: ['/api/trade','/api/credit','/api/chain','/api/public','/api/notice','/api/notify','/api/evidence'],
};
const suites={};
for(const [role,prefs] of Object.entries(ROLE_PREFIX)){
  const paths=[];
  for(const r of getOnly){
    if(!prefs.some(p=>r.path===p||r.path.startsWith(p+'/'))) continue;
    if(r.path.includes(':')){
      const fill=ID_FILL[r.path];
      if(!fill) continue;
      paths.push(r.path.replace(/:\w+/g,fill));
    } else paths.push(r.path);
  }
  suites[role]=[...new Set(paths)];
}
fs.writeFileSync(path.join(__dirname,'suites.json'),JSON.stringify(suites,null,1),'utf8');
for(const [k,v] of Object.entries(suites)) console.log(k, v.length+' 条');
