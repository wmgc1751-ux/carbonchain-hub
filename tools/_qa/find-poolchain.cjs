/* 精确找出"仍然走业务池访问链表"的位置：逐个 SQL 字符串向上找最近的 db.xxx 调用 */
const fs=require('fs'), path=require('path');
const SRV=path.join(__dirname,'..','..','server');
function walk(d, out=[]) {
  for (const e of fs.readdirSync(d,{withFileTypes:true})) {
    const p=path.join(d,e.name);
    if(e.isDirectory()) walk(p,out); else if(/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const bad=[];
for(const f of walk(SRV)){
  if(/[\/](db\.js|blockchain[\/])/.test(f)) continue;
  const lines=fs.readFileSync(f,'utf8').split(/\r?\n/);
  lines.forEach((line,i)=>{
    if(!/FROM chain_(tx|block|node|node_replica|payload_backup)|JOIN chain_|INTO chain_|UPDATE chain_|DELETE FROM chain_/.test(line)) return;
    if(/ledger/i.test(line)) return;
    // 向上找 6 行内的 db.xxx(
    for(let k=i;k>=Math.max(0,i-6);k--){
      const m=lines[k].match(/db\.(query|one|value|paginate)\(/);
      if(m){ bad.push({file:path.relative(DIR_ROOT(),f),line:i+1,call:'db.'+m[1],sql:line.trim().slice(0,90)}); break; }
      if(/db\.(ledgerQuery|ledgerOne|ledgerValue|ledgerPaginate|ledgerTx)\(/.test(lines[k])) break;
    }
  });
}
function DIR_ROOT(){ return path.join(__dirname,'..','..'); }
console.log('疑似业务池访问链表:', bad.length);
bad.forEach(b=>console.log(` ${b.file}:${b.line}  ${b.call}  ${b.sql}`));
