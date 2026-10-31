import {readFileSync} from 'node:fs';
import mysql from 'mysql2/promise';
const env=readFileSync('.env','utf8');
const g=k=>{const m=env.match(new RegExp('^'+k+'=(.*)$','m'));return m?m[1].trim():'';};
const url=g('TURSO_URL').replace('libsql://','https://'), tok=g('TURSO_AUTH_TOKEN');

async function tq(sql){
  const r=await fetch(url+'/v2/pipeline',{method:'POST',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'},
    body:JSON.stringify({requests:[{type:'execute',stmt:{sql}},{type:'close'}]})});
  const j=await r.json();const res=j.results?.[0];
  if(!res||res.type!=='ok')throw new Error(JSON.stringify(res||j).slice(0,220));
  const rs=res.response.result;
  const cols=rs.cols.map(c=>c.name);
  return rs.rows.map(row=>{const o={};row.forEach((c,i)=>{o[cols[i]]=(c.type==='null')?null:(c.type==='blob'?Buffer.from(c.base64||'','base64'):c.value);});return o;});
}

/* 跳过清单：
 *  - real_emission_year / cems_reading / real_facility：EPA 与 CEMS 原始真实数据（55 万行），
 *    与你要恢复的三张图无关，且本地真实数据模式已停用。
 *  - sys_user：保留本地 11 个演示账号，否则登录态与密码全部失效。 */
const SKIP=new Set(['real_emission_year','cems_reading','real_facility','sys_user']);
const DRY=process.argv.includes('--dry');

const conn=await mysql.createConnection({host:'127.0.0.1',user:'root',password:'123456',database:'carbon_chain',multipleStatements:false});
const [tabs]=await conn.query('SELECT table_name t FROM information_schema.tables WHERE table_schema="carbon_chain" AND table_type="BASE TABLE"');
const localTables=new Set(tabs.map(r=>r.t));
const rows=await tq("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
const targets=rows.map(r=>r.name).filter(n=>!n.startsWith('sqlite_')&&!n.startsWith('cc_')&&localTables.has(n)&&!SKIP.has(n));

let total=0,report=[];
for(const t of targets){
  let recs;
  try{recs=await tq(`SELECT * FROM "${t}"`);}catch(e){report.push([t,'读失败',e.message.slice(0,60)]);continue;}
  total+=recs.length;
  if(DRY){report.push([t,recs.length,'dry']);continue;}
  if(!recs.length){report.push([t,0,'空表跳过']);continue;}
  const cols=Object.keys(recs[0]);
  const [lcols]=await conn.query('SELECT column_name c, extra e, column_key k FROM information_schema.columns WHERE table_schema="carbon_chain" AND table_name=?',[t]);
  const use=cols.filter(c=>lcols.some(x=>x.c===c));
  const autoInc=lcols.find(x=>String(x.e||'').includes('auto_increment'));
  // 自增列要显式插值，否则 id 会漂移：先确认列在 use 里
  /* ⚠ 多行插入必须为**每一行**生成一组占位符。
   *   初版写成 `VALUES (${ph})`（只有一组），却把整批 200 行的值平铺传进去，
   *   mysql2 不报错、只消费第一组参数 → 每批静默地只插入第一行。
   *   症状：enterprise 60 行只进 1 行、emission_report 362 行只进 id=1 与 id=201
   *   （正好是 2 个批次的首行）、emission_item 1282 行只进 7 行。
   *   现在按批大小动态生成 `(?,?),(?,?)...`。 */
  const oneRow='('+use.map(()=>'?').join(',')+')';
  const tpl=`INSERT INTO \`${t}\` (${use.map(c=>'`'+c+'`').join(',')}) VALUES `;
  await conn.query('SET FOREIGN_KEY_CHECKS=0');
  try{
    await conn.beginTransaction();
    // enterprise 保留 61~63 的 e2e 测试企业，其余整表替换
    if(t==='enterprise') await conn.query('DELETE FROM enterprise WHERE id <= 60');
    else await conn.query(`DELETE FROM \`${t}\``);
    const B=200;
    for(let i=0;i<recs.length;i+=B){
      const chunk=recs.slice(i,i+B);
      const vals=[];chunk.forEach(r=>use.forEach(c=>vals.push(r[c]===undefined?null:r[c])));
      const sqlIns=tpl+chunk.map(()=>oneRow).join(',');
      await conn.query(sqlIns,vals);
    }
    await conn.commit();
    report.push([t,recs.length,'OK'+(autoInc?' (含自增 '+autoInc.c+')':'')]);
  }catch(e){
    await conn.rollback();
    report.push([t,recs.length,'失败: '+e.message.slice(0,90)]);
  }
}
await conn.query('SET FOREIGN_KEY_CHECKS=1');
await conn.end();
console.log(DRY?'=== DRY RUN ===':'=== 同步完成 ===');
console.log('目标表:',targets.length,'总行数:',total);
const bad=report.filter(r=>String(r[2]).startsWith('失败')||String(r[2]).includes('读失败'));
console.log('异常表:',bad.length);
bad.forEach(r=>console.log('  '+r[0]+' -> '+r[2]));
console.log('\n明细:');
report.forEach(r=>console.log('  '+String(r[0]).padEnd(26)+String(r[1]).padStart(7)+'  '+r[2]));
