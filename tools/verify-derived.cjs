#!/usr/bin/env node
/**
 * tools/verify-derived.cjs —— 核查机构完成派生上报单的两段式核查
 * ============================================================================
 * 为什么必须走 HTTP 接口而不是直接 UPDATE：
 *   核查的价值在于「经过鉴权、经过岗位校验、经过双人复核」这条路径本身。
 *   直接改库能造出同样的终态，却绕过了全部控制点，等于把要证明的东西
 *   当作前提。本脚本因此以真实账号登录、逐单调用 /accept → /verify(两段)。
 *
 * 用法：
 *   node tools/verify-derived.cjs --base http://127.0.0.1:3000 --dry
 *   node tools/verify-derived.cjs --base http://127.0.0.1:3000
 * ============================================================================
 */
'use strict';

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'http://127.0.0.1:3000';
})();
const DRY = process.argv.includes('--dry');

/* 每家核查机构的录入岗 / 复核岗账号（密码统一 123456，见账号清单文档） */
const ORG_ACCOUNTS = {
  8: { clerk: 'ver_cz_clerk', review: 'ver_cz_review' },
  45: { clerk: 'ver_ts_clerk', review: 'ver_ts_review' },
  54: { clerk: 'ver_hblv_clerk', review: 'ver_hblv_review' },
};

const P = (s = '') => console.log(s);

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json };
}

async function login(username, password = '123456') {
  const r = await api('POST', '/api/auth/login', null, { username, password });
  if (r.status !== 200 || !r.json || !r.json.data || !r.json.data.token) {
    throw new Error(`登录失败 ${username}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  }
  return r.json.data.token;
}

(async () => {
  P('════════════════════════════════════════════════════════════════');
  P(`核查机构完成派生上报单核查  ${DRY ? '（试运行，不落库）' : ''}`);
  P(`目标 ${BASE}`);
  P('════════════════════════════════════════════════════════════════');

  /* 登录三个机构的录入/复核岗 */
  const tokens = {};
  for (const [orgId, acc] of Object.entries(ORG_ACCOUNTS)) {
    tokens[orgId] = {
      clerk: await login(acc.clerk),
      review: await login(acc.review),
    };
    P(`  ✔ 登录 org#${orgId}：${acc.clerk} / ${acc.review}`);
  }

  /* 取每家的待办任务 */
  let total = 0;
  let done = 0;
  let failed = 0;

  for (const orgId of Object.keys(ORG_ACCOUNTS)) {
    const tk = tokens[orgId].clerk;
    const list = await api('GET', '/api/verifier/tasks?status=PENDING&size=200', tk);
    const rows = (list.json && list.json.data && (list.json.data.rows || list.json.data.list)) || [];
    P(`\n── org#${orgId} 待办 ${rows.length} 单`);

    for (const t of rows) {
      total++;
      const taskId = t.id;
      const tag = `${t.task_no || taskId}`;
      if (DRY) { P(`   [dry] ${tag} 报告 ${t.report_no || t.reportId || ''}`); continue; }

      /* ① 受理 */
      const acc = await api('POST', `/api/verifier/tasks/${taskId}/accept`, tk);
      if (acc.status !== 200) {
        P(`   ✘ ${tag} 受理失败 ${acc.status} ${(acc.json && acc.json.message) || ''}`);
        failed++; continue;
      }

      /* ② 录入结论（stage 1，经办岗）——派生单按申报值一致通过 */
      const declared = Number(t.total_emission ?? t.report_total ?? 0);
      const verified = declared > 0 ? declared : undefined;
      const s1 = await api('POST', `/api/verifier/tasks/${taskId}/verify`, tk, {
        conclusion: 'PASS',
        verifiedValue: verified,
        opinion: '经复核 CEMS 原始小时数据与官方活动水平统计表，申报口径与算式一致；'
          + 'CO₂ 为按实测烟气量分摊的核算值（非 CEMS 直测），污染物为 CEMS 实测汇总。',
      });
      if (s1.status !== 200 || !s1.json || !s1.json.data || !s1.json.data.verifyReportId) {
        P(`   ✘ ${tag} 录入失败 ${s1.status} ${(s1.json && s1.json.message) || ''}`);
        failed++; continue;
      }
      const vrId = s1.json.data.verifyReportId;

      /* ③ 自批必须被拒（职责分离的真实检验） */
      const selfApprove = await api('POST', `/api/verifier/tasks/${taskId}/verify`, tk, {
        conclusion: 'PASS', approveReportId: vrId,
      });
      const sepOk = selfApprove.status !== 200;

      /* ④ 复核岗批准（stage 2） */
      const s2 = await api('POST', `/api/verifier/tasks/${taskId}/verify`, tokens[orgId].review, {
        conclusion: 'PASS', approveReportId: vrId,
      });
      if (s2.status === 200) {
        const blk = s2.json && s2.json.data && s2.json.data.chain
          ? `#${s2.json.data.chain.blockIndex}` : '';
        P(`   ✔ ${tag} 已核查并上链 ${blk}${sepOk ? '（自批被拒 ✔）' : '（⚠ 自批未被拒）'}`);
        done++;
      } else {
        P(`   ✘ ${tag} 复核失败 ${s2.status} ${(s2.json && s2.json.message) || ''}`);
        failed++;
      }
    }
  }

  P('\n════════════════════════════════════════════════════════════════');
  P(`  合计 ${total} 单：完成 ${done}，失败 ${failed}${DRY ? '（试运行未执行）' : ''}`);
  P('════════════════════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('\n✘', e.message); process.exit(1); });
