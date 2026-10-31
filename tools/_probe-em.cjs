const https = require('https');
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}
(async () => {
  const boardUrl = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14';
  const j = JSON.parse(await get(boardUrl));
  const boards = (j.data && j.data.diff) || [];
  console.log('行业板块数:', boards.length);
  const want = ['钢铁', '水泥', '电力', '化工', '有色', '造纸', '化学', '煤炭', '石油'];
  const hits = boards.filter((b) => want.some((w) => String(b.f14).includes(w)));
  console.log('\n匹配板块:');
  hits.forEach((b) => console.log('  ', b.f12, b.f14));
  if (hits.length) {
    const code = hits[0].f12;
    const url2 = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b:${code}&fields=f12,f14,f20,f100`;
    const j2 = JSON.parse(await get(url2));
    console.log(`\n${hits[0].f14}(${code}) 成分股:`);
    ((j2.data && j2.data.diff) || []).forEach((s) => {
      console.log(`  ${s.f12}  ${String(s.f14).padEnd(14)}  ${(Number(s.f20)/1e8).toFixed(1)} 亿  ${s.f100 || ''}`);
    });
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
