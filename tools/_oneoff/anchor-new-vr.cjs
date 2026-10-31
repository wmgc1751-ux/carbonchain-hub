'use strict';
const mysql = require('mysql2/promise');
const cfg = require('D:/workspace/Challenge Cup/碳链通平台/CarbonChainHub/server/config');
const anchorSvc = require('D:/workspace/Challenge Cup/碳链通平台/CarbonChainHub/server/services/anchor');
(async () => {
  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  const [rows] = await conn.query(`
    SELECT v.id, v.report_no, v.ent_id, v.verifier_id, v.declared_value, v.verified_value,
           v.deviation_rate, v.conclusion, v.seal_hash, v.auditor, v.submitted_by, v.approved_by,
           e.ent_name, er.report_no AS em_report_no
      FROM verify_report v
      JOIN enterprise e ON e.id = v.ent_id
      LEFT JOIN emission_report er ON er.id = v.emission_report_id
     WHERE (v.chain_tx_id IS NULL OR v.chain_tx_id = '')`);
  console.log('待锚核查结论', rows.length);
  for (const v of rows) {
    const r = await anchorSvc.anchor({
      txType: 'VERIFY_REPORT', bizNo: v.report_no,
      fromLabel: `verifier:${v.verifier_id}`,
      payload: {
        verifyReportNo: v.report_no, emissionReportNo: v.em_report_no,
        entId: v.ent_id, entName: v.ent_name, verifierId: v.verifier_id,
        declared: Number(v.declared_value), verified: Number(v.verified_value),
        deviationRate: Number(v.deviation_rate), conclusion: v.conclusion,
        sealHash: v.seal_hash, auditor: v.auditor,
        submittedBy: v.submitted_by, approvedBy: v.approved_by,
        dualControl: '经办与批准为不同账号（系统强制）',
      },
    });
    await conn.query('UPDATE verify_report SET chain_block_index=?, chain_tx_id=? WHERE id=?',
      [r.blockIndex, r.txId, v.id]);
    console.log('✔', v.report_no, '→ #' + r.blockIndex);
  }
  await conn.end();
})().catch(e => { console.error(e.message); process.exit(1); });
