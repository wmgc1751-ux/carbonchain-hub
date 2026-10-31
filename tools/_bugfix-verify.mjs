/* 对照《BUG清单-20261029》逐项核对最新 text-audit 落盘。
 * 每项给出：坏签名（不应出现）/ 好签名（应出现）→ PASS/FAIL/WARN */
import fs from 'node:fs';
import path from 'node:path';

const PAGES = path.resolve('_ui-check/text-audit/pages');
const read = (f) => { const p = path.join(PAGES, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };

const checks = [
  { id: 'P0-1', page: 'ENTERPRISE___ent_overview.txt',
    bad: [/盈余0tCO₂e/, /履约缺口 \/ 盈余0/],
    good: [/尚未分配配额|缺口无法计算|履约缺口\s*[1-9]/] },
  { id: 'P0-2', page: 'REGULATOR___reg_overview.txt',
    bad: [/排放总量0\b/, /核查进度空环/],
    good: [/674\.99|6,749,926|6749926/, /年度2025|2025 年度/] },
  { id: 'P0-3', page: 'REGULATOR___reg_enterprises.txt',
    bad: [/本年度排放0/, /—{2,}/] ,
    good: [/\d{2,3},\d{3}/] },
  { id: 'P0-3b', page: 'REGULATOR___reg_allocations.txt',
    bad: [/累计分配0tCO₂e/, /暂无数据/],
    good: [/802\.63|8,026,311|全部年度/] },
  { id: 'P0-4', page: 'ENTERPRISE___ent_analytics.txt',
    bad: [/—tCO₂e—/],
    good: [/本年度未分配配额|2024 年度 362,613/] },
  { id: 'P0-5', page: 'REGULATOR___reg_consortium.txt',
    bad: [/#3128/, /#2444/, /副本一致节点0\/5/, /全部落后主链/, /有0个节点副本落后/],
    good: [/1,138|1138/] },
  { id: 'P0-6', page: 'ENTERPRISE___ent_predict.txt',
    bad: [/占配额0%/, /超限概率0%/, /抵销额度上限0\.00/],
    good: [/无法计算占配额|本年度配额为0|有效读数不足/] },
  { id: 'P0-8', page: 'ENTERPRISE___mrv_activity.txt',
    bad: [/年度合计14\.58 t（?kg/],
    good: [/14\.58/, /t/] },
  { id: 'P0-9', page: 'ENTERPRISE___ent_quota.txt',
    bad: [/362,613\.08−308,724\.00≠2,806\.91/],
    good: [/已卖出|已交易|51,082/] },
  { id: 'P0-11', page: 'PUBLIC___verify.txt',
    bad: [/scripts\/uncertainty/, /scripts\/bench-crypto/, /smoke-test\.js/],
    good: [/tools\/uncertainty-selftest/, /tools\/bench-crypto/] },
  { id: 'P0-12', page: 'PUBLIC___twin.txt',
    bad: [/24\.08 km².*5680 × 4380/],
    good: [/5600 × 4300|24\.08/] },
  { id: 'P0-13', page: 'PUBLIC___explorer.txt',
    bad: [/平均出块—/, /出块耗时0 ms/],
    good: [] },
  { id: 'P1-15', page: 'TRADER___trade_market.txt',
    bad: [],
    good: [/暂无挂单/] },
  { id: 'P1-19', page: 'PUBLIC___notice.txt',
    bad: [/\(\d\)$/m],
    good: [/分类|平台公告|政策法规/] },
  { id: 'P1-20a', page: 'PUBLIC___verify.txt', bad: [/\*\*/], good: [] },
  { id: 'P1-20b', page: 'REGULATOR___keys.txt', bad: [/\*\*/], good: [] },
  { id: 'P1-22', page: 'REGULATOR___reg_integrity.txt',
    bad: [/^#/],
    good: [/内控|完整性|治理/] },
  { id: 'P1-25', page: 'ADMIN___admin_users.txt',
    bad: [],
    good: [/操作/, /重置口令|禁用|停用/] },
  { id: 'P1-26', page: 'REGULATOR___keys.txt',
    bad: [/D:\\workspace/, /sm2-keystore\.json/],
    good: [] },
  { id: 'P1-28', page: 'PUBLIC___real_truth.txt',
    bad: [],
    good: [/不符|偏离|差异/] },
  { id: 'P1-30', page: 'REGULATOR___gov_iot.txt',
    bad: [],
    good: [/共\d+页|下一页|尾页|第 1 \/ \d+ 页|上一页/] },
  { id: 'P1-31', page: 'VERIFIER___ver_overview.txt',
    bad: [/链上存证0笔/, /专职核查员0人/],
    good: [/\d+ 笔/, /\d+ 人/] },
  { id: 'P2-34', page: 'REGULATOR___reg_system.txt',
    bad: [/agg\.industry_sta…/, /cems_emission_ho…/, /real_emission_ye…/],
    good: [/agg_industry|cems_emission|real_emission/] },
  { id: 'P2-35k', page: 'REGULATOR___keys.txt',
    bad: [],
    good: [/共\d+页|下一页|尾页|第 1 \/ \d+ 页|上一页/] },
  { id: 'P2-40', page: 'PUBLIC___cems.txt',
    bad: [/43\.95(?!\d)[^\d]*43\.952/],
    good: [/43\.952/] },
  { id: 'P2-40b', page: 'ENTERPRISE___ent_wallet.txt',
    bad: [],
    good: [/复制公钥/] },
  { id: 'P3-41', page: 'PUBLIC___cems.txt',
    bad: [/降解/],
    good: [/降级/] },
  { id: 'P3-42', page: 'ENTERPRISE___mrv_activity.txt',
    bad: [/SUBMITTED，需核查员复核/],
    good: [/已提交/] },
  { id: 'P3-43', page: 'ENTERPRISE___mrv_calc.txt',
    bad: [/精度充分.*25\.55/, /（阈值10%）.*充分/],
    good: [/拒绝输出区间估计|闸门未通过|数据不足/] },
];

let pass = 0, fail = 0, miss = 0;
for (const c of checks) {
  const t = read(c.page);
  if (t === null) { console.log(`MISS  ${c.id}  落盘不存在（角色未跑完）：${c.page}`); miss++; continue; }
  const badHit = c.bad.filter((re) => re.test(t));
  const goodHit = c.good.filter((re) => re.test(t));
  const ok = badHit.length === 0 && (c.good.length === 0 || goodHit.length > 0);
  if (ok) { pass++; console.log(`PASS  ${c.id}`); }
  else { fail++; console.log(`FAIL  ${c.id}  bad命中:${JSON.stringify(badHit.map(String))} good命中:${goodHit.length}/${c.good.length}`); }
}
console.log(`\n════ ${pass} PASS · ${fail} FAIL · ${miss} MISS ════`);
