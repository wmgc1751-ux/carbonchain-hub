/**
 * routes/twin.js —— 真实厂区数字孪生 API
 * ==================================================================================
 * 【当前状态：数据源已下线，接口返回明确空态】
 *
 * 历史上本路由的几何与数值全部来自境外数据集：
 *   · Climate TRACE —— 设施名、经纬度、装机容量、发电量、排放因子、所属集团
 *   · EPA GHGRP     —— 工艺段分解
 *
 * 2026-10-30 平台按"真实数据全部来源于国内"的要求清退了上述境外数据源，
 * 库内 real_facility / real_emission_year 两张表已清空并停止写入。
 * 国内不存在可公开获取的设施级排放台账，因此本路由无法再派生真实孪生。
 *
 * 【为什么不直接删掉路由】
 * 前端 /twin 页面仍在菜单里，直接 404 会表现为"页面坏了"，
 * 用户无法区分"功能被下架"与"服务出故障"。返回明确的空态 + 原因，
 * 比一个 404 或空白页诚实得多。
 *
 * 【为什么不用合成数据把这个页面填满】
 * "数字孪生"这个词要求对应真实对象。用行业典型值拼一座不存在的厂区，
 * 再把排放量标成 REAL，就是本平台此前被评审指出的"自举模拟"问题。
 * 宁可让这个功能空着，也不伪造它的真实性。
 *
 * 【恢复条件】
 * 若后续接入国内设施级数据（例如企业授权的 HJ 212 报文 + 排污许可台账，
 * 或省级平台开放接口），本路由可按原有几何派生逻辑恢复：
 *   · 几何 DERIVED（按行业工程量级派生）
 *   · 数值 REAL（绑定真实设施记录）
 * 两部分必须在返回体里分开标注，不合并成"全部真实"。
 *
 * @module routes/twin
 */
'use strict';

const express = require('express');
const { ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();

/** 统一的空态说明 —— 前端直接展示该文案，不需要自己硬编码 */
const OFFLINE = {
  available: false,
  reason: '设施级真实排放台账已下线',
  detail: '本功能的几何与数值原先取自境外数据集（Climate TRACE / US EPA GHGRP）。'
    + '平台已按要求清退全部境外数据源，国内暂无同等颗粒度的公开设施级排放数据，'
    + '因此数字孪生暂不可用。',
  notFaked: '平台不使用行业典型值拼凑厂区并标称真实 —— 那会把演示数据伪装成实测数据。',
  resumeWhen: '待接入国内企业授权的在线监测报文或省级平台开放接口后恢复。',
  removedAt: '2026-10-30',
};

/**
 * GET /candidates —— 可孪生的真实设施候选
 * 恒返回空数组 + available:false。前端据此显示说明页而非报错。
 */
router.get('/candidates', wrap(async (req, res) => {
  ok(res, [], OFFLINE);
}));

/**
 * GET /plant/:id —— 单厂区几何 + 数值
 * 保留 404 语义：既然没有设施台账，任何 id 都不存在。
 */
router.get('/plant/:id', wrap(async (req, res) => {
  return fail(res, OFFLINE.detail, 404);
}));

/**
 * GET /compare —— 跨设施并置对比
 */
router.get('/compare', wrap(async (req, res) => {
  ok(res, [], OFFLINE);
}));

module.exports = router;
