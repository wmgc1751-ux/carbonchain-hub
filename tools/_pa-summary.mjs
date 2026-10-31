/* 平台审计报告紧凑摘要：只打需要看的东西，避免 PowerShell 中文管道乱码 */
import fs from 'node:fs';

const files = process.argv.slice(2);
for (const f of files) {
  if (!fs.existsSync(f)) { console.log('MISSING ' + f); continue; }
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log('BADJSON ' + f); continue; }
  for (const r of j.roles || []) {
    for (const p of r.pages || []) {
      const d = p.desktop || {}, m = p.mobile || {}, c = p.console || {};
      const bad = [];
      if ((d.placeholders || []).length) bad.push('placeholder:' + d.placeholders.length);
      if ((d.unlabeled || []).length) bad.push('unlabeled:' + d.unlabeled.length);
      if ((d.namelessBtns || []).length) bad.push('namelessBtn:' + d.namelessBtns.length);
      if ((d.noAlt || []).length) bad.push('noAlt:' + d.noAlt.length);
      if ((d.contrastLow || []).length) bad.push('lowContrast:' + d.contrastLow.length);
      if ((c.warns || []).length) bad.push('warn:' + c.warns.length);
      if ((c.errs || []).length) bad.push('err:' + c.errs.length);
      if (m.docOverflow > 0) bad.push('docOverflow:' + m.docOverflow);
      if (m.hOverflow > 0) bad.push('hOverflow:' + m.hOverflow);
      if ((m.wide || []).length) bad.push('wide:' + m.wide.length);
      if (m.smallTapCramped > 0) bad.push('cramped:' + m.smallTapCramped);
      if (m.tinyText > 0) bad.push('tiny:' + m.tinyText);
      const st = d.contrastSelfTest || {}, cc = d.contrastControls || {};
      if (st.ok === false) bad.push('selfTestBad');
      if (cc.ok2 === false) bad.push('controlsBad');
      console.log(`${bad.length ? '✘' : '✔'} ${r.role.padEnd(10)} ${p.path.padEnd(20)} ${bad.length ? bad.join(' ') : 'OK'}`);
      if ((d.unlabeled || []).length) console.log('   unlabeled ' + JSON.stringify(d.unlabeled).slice(0, 300));
      if ((d.contrastLow || []).length) console.log('   low ' + JSON.stringify(d.contrastLow).slice(0, 600));
      if ((m.wide || []).length) console.log('   wide ' + JSON.stringify(m.wide).slice(0, 300));
      if ((c.warns || []).length) console.log('   warn ' + JSON.stringify(c.warns).slice(0, 300));
      if ((c.errs || []).length) console.log('   err ' + JSON.stringify(c.errs).slice(0, 300));
    }
  }
}
