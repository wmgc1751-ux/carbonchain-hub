/**
 * protocol-check.cjs —— HJ 212-2017 协议实现合规自检运行器
 * ==================================================================
 * 运行 server/protocol/hj212.js 内建的三重锚定自检，并打印报文样例。
 *
 * 用法：node tools/protocol-check.cjs [--sample]
 *   退出码 0 = 全部锚点通过；1 = 存在失败项
 */
const H = require('../server/protocol/hj212.js');

const showSample = process.argv.includes('--sample');

console.log('');
console.log('════════════════════════════════════════════════════════════════');
console.log('  碳链通 · HJ 212-2017 协议实现合规自检');
console.log('════════════════════════════════════════════════════════════════');
console.log('  实现文件    server/protocol/hj212.js');
console.log('  标准依据    HJ 212-2017 表2 / 表3 / 6.3.3 / 附录A + HJ 525-2009 编码表');
console.log('  CRC 参数    poly=0x8005(reflected 0xA001) · init=0xFFFF · xorout=0 · 高字节在前');
console.log('              （参数集同 CRC-16/MODBUS；**不是** CCITT 0x1021）');
console.log('────────────────────────────────────────────────────────────────');

const r = H.conformance();
for (const d of r.details) {
  console.log(`  ${d.pass ? '✔' : '✘'} ${d.anchor}`);
  for (const p of d.problems) console.log(`      · ${p}`);
}
console.log('────────────────────────────────────────────────────────────────');
console.log(`  结果：${r.passed}/${r.total} 个锚点通过`);
console.log(r.pass
  ? '  ✔ CRC 参数集正确、双实现互证、长度口径正确、往返恒等、拆包器抗粘包/半包。'
  : '  ✘ 存在未通过锚点，协议实现不符合标准。');

/* 组合一张真实形态的报文，直观展示 */
const frame = H.encode({
  qn: H.fmtQN(new Date(2026, 9, 12, 12, 0, 0), 1),
  st: '31',
  cn: '2011',
  pw: '123456',
  mn: '010000A8900016F000169DC0',
  flag: H.buildFlag({ version: 1, needAck: true }),
  cp: H.buildCP({
    dataTime: new Date(2026, 9, 12, 12, 0, 0),
    pollutants: [
      { code: 'a34013', Rtd: 12.5, Flag: 'N' },
      { code: 'a21026', Rtd: 35.2, Flag: 'N' },
      { code: 'a21002', Rtd: 28.4, Flag: 'N' },
      { code: 'a19001', Rtd: 6.8, Flag: 'N' },
      { code: 'a01011', Rtd: 14.6, Flag: 'N' },
      { code: 'a01012', Rtd: 128.3, Flag: 'N' },
    ],
  }),
});
const back = H.decode(frame);
console.log('────────────────────────────────────────────────────────────────');
console.log('  报文样例（CN=2011 实时数据，六因子）');
console.log(`    ${frame.replace(/\r\n$/, '')}`);
console.log('  解析回读');
console.log(`    QN=${back.qn}  ST=${back.st}(${back.stName || '—'})  CN=${back.cn}(${back.cnName})`);
console.log(`    MN=${back.mn}  Flag=${back.flag} → ${back.flagInfo.versionName}`
  + ` / 应答=${back.flagInfo.needAck} / 分包=${back.flagInfo.hasPnum}`);
console.log(`    DataTime=${back.cpParsed.dataTime}  CRC=${back.crc}(${back.crcOk ? '通过' : '失败'})`);
for (const code of back.cpParsed.order) {
  const p = back.cpParsed.pollutants[code];
  console.log(`    ${code} ${p.name}  Rtd=${p.Rtd}  Flag=${p.Flag}(${H.DATA_FLAGS[p.Flag] || '?'})`
    + ` → 质量标记 ${H.FLAG_TO_QUALITY[p.Flag] || '?'}`);
}
console.log('════════════════════════════════════════════════════════════════');
console.log('');

if (showSample) {
  console.log('  粘包/半包演示（FrameDecoder）');
  const f2 = H.encode({ st: '31', cn: '2011', mn: 'B'.repeat(24), flag: 4, cp: H.buildCP({ dataTime: '20261012120001', pollutants: [{ code: 'a19001', Rtd: 6.9, Flag: 'N' }] }) });
  const d = new H.FrameDecoder();
  const oneShot = d.push(frame + f2);
  console.log(`    整段一次喂入 → ${oneShot.length} 帧（粘包已正确切分）`);
  const d2 = new H.FrameDecoder();
  let n = 0;
  for (const ch of (frame + f2)) n += d2.push(ch).length;
  console.log(`    逐字节喂入   → ${n} 帧（半包已正确缓冲）`);
  console.log('');
}

process.exit(r.pass ? 0 : 1);
