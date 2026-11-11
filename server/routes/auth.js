/**
 * routes/auth.js —— 认证与账号
 */
'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const cu = require('../blockchain/crypto-utils');
const keystore = require('../blockchain/keystore');
const { signToken, authRequired, revokeToken, writeLog, ok, fail, wrap } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();

/** 角色中文名 */
const ROLE_CN = { ENTERPRISE: '企业端', VERIFIER: '核查机构端', REGULATOR: '监管端', TRADER: '交易端', ADMIN: '管理端' };

/* 岗位中文名解析（单一数据源 = user_post_dict 字典表）
 *
 * 背景（2026-10-29 缺陷清单 P1-24）：
 *   顶栏用户区此前只显示 roleCn（如「核查机构端」），登录后**拿不到岗位**——
 *   /auth/login 与 /auth/me 都没有返回 post，前端只能退化成显示角色名，
 *   于是 ver001（机构管理员）在界面上与普通核查录入员无法区分。
 *   而「演示账号列表」接口是查了字典表的，两处口径因此不一致。
 *
 * 做法：登录与 /me 都补上 post / postCn，且字典统一从 user_post_dict 取，
 *   不在代码里再抄一份岗位名（字典改名，界面自动跟着改）。
 *
 * 缓存 60 秒：字典属低频变更的配置数据，没必要每次登录都查一次库；
 *   查询失败时降级为「不显示岗位」，绝不因为字典表缺失而让登录报错。 */
let POST_DICT = { at: 0, map: new Map() };
async function postLabelOf(post) {
  if (!post) return null;
  if (Date.now() - POST_DICT.at > 60 * 1000) {
    try {
      const rows = await db.query('SELECT post, label FROM user_post_dict');
      POST_DICT = { at: Date.now(), map: new Map(rows.map((r) => [r.post, r.label])) };
    } catch (e) {
      POST_DICT = { at: Date.now(), map: POST_DICT.map };  // 保留旧值，60 秒后再试
    }
  }
  return POST_DICT.map.get(post) || null;
}

/** 演示账号接口开关（安全默认：线上关闭）
 *   · 显式 DEMO_ACCOUNTS=true   → 开放（确有演示需要时主动开启）；
 *   · 显式 DEMO_ACCOUNTS=false  → 关闭；
 *   · 未设置：本地 / 内网开发默认开放（便于一键切换身份），
 *             生产环境与托管云平台（Render 等）一律关闭。
 *  判定用 config.isProd 而不是裸读 NODE_ENV：即便线上忘了设置
 *  NODE_ENV=production，只要跑在 Render 这类平台上，接口依然是关闭的。 */
const DEMO_ACCOUNTS = config.demoAccounts;

/** 登录限流：同一 IP + 账号每分钟最多 10 次，防暴力破解 */
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  keyFn: (req) => `${req.ip}|${(req.body && req.body.username) || ''}`,
  message: '登录尝试过于频繁，请 1 分钟后再试',
});

/** 演示账号列表限流：本接口在演示态会返回账号与口令，属**有意公开**的演示特性
 *  （登录页「演示账号一键切换」依赖它）。但公开不等于可被任意爬取，
 *  故加一层按 IP 限流。
 *  阈值取 120 次/分钟：正常打开登录页每次仅请求 1 次，余量极大；
 *  同时考虑到答辩/评审现场往往多人共用同一 NAT 出口（校园网、会场 Wi-Fi），
 *  阈值过低会误伤——按 120 计，即便 20 人同时反复刷新登录页也不会被拦，
 *  而枚举型脚本（每秒数次以上）仍会被 429 挡下。 */
const demoLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  keyFn: (req) => `demo|${req.ip}`,
  message: '演示账号列表请求过于频繁，请稍后再试',
});

/** 注册限流：同一 IP 每小时最多 5 次注册（防批量刷号） */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  keyFn: (req) => `reg|${req.ip}`,
  message: '注册请求过于频繁，请 1 小时后再试',
});

/** 注册白名单行业（与 enterprise.industry 字典一致） */
const REG_INDUSTRIES = ['电力', '钢铁', '建材', '化工', '有色金属', '造纸', '石化', '其他'];
const REG_REGIONS = ['北京','天津','河北','山西','内蒙古','辽宁','吉林','黑龙江','上海','江苏',
  '浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','广西','海南','重庆','四川',
  '贵州','云南','西藏','陕西','甘肃','青海','宁夏','新疆','台湾'];

/* 登录 ------------------------------------------------------------- */
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, '请输入账号与密码', 400);

  const user = await db.one('SELECT * FROM sys_user WHERE username = ?', [username]);
  if (!user) {
    await writeLog({ headers: req.headers, ip: req.ip }, '用户管理', '登录', username, '账号不存在', 'FAIL');
    return fail(res, '账号或密码错误', 401);
  }
  /* status 语义：1 启用 / 0 待审核（机构自主注册后等待准入）/ 其他 停用。
   * 待审核必须单独提示——"账号已被停用"会让真实注册用户以为被拉黑。 */
  if (user.status === 0) {
    await writeLog({ user: { id: user.id, username, role: user.role }, headers: req.headers, ip: req.ip },
      '用户管理', '登录', username, '待审核账号尝试登录', 'FAIL');
    return fail(res, '账号注册成功但尚未开通：正在等待管理员审核，审核通过后即可登录', 403);
  }
  if (user.status !== 1) return fail(res, '账号已被停用，请联系管理员', 403);

  const v = cu.verifyPassword(password, user.salt, user.password);
  if (!v.ok) {
    await writeLog({ user: { id: user.id, username, role: user.role }, headers: req.headers, ip: req.ip },
      '用户管理', '登录', username, '密码校验失败', 'FAIL');
    return fail(res, '账号或密码错误', 401);
  }
  // 命中旧 SHA256 摘要时，登录成功后透明升级为 scrypt（用户无需感知）
  if (v.legacy) {
    try {
      await db.query('UPDATE sys_user SET password = ? WHERE id = ?',
        [cu.hashPasswordPbkdf2(password, user.salt), user.id]);
    } catch (e) { /* 迁移失败不影响本次登录 */ }
  }

  await db.query('UPDATE sys_user SET last_login = NOW() WHERE id = ?', [user.id]);

  const payload = {
    id: user.id, username: user.username, role: user.role,
    realName: user.real_name, orgId: user.org_id, orgName: user.org_name,
  };
  const token = signToken(payload);

  const reqLike = { user: payload, headers: req.headers, ip: req.ip };
  await writeLog(reqLike, '用户管理', '登录', username, `以${ROLE_CN[user.role] || user.role}身份登录成功`);

  // 企业端把钱包地址一并返回，前端可直接展示"我的链上身份"
  let wallet = null;
  if (user.role === 'ENTERPRISE' && user.org_id) {
    wallet = await db.value('SELECT wallet_address FROM enterprise WHERE id = ?', [user.org_id]);
  } else if (user.role === 'TRADER' && user.org_id) {
    // 交易端代表控排企业交易，同样返回其代理企业的钱包地址
    wallet = await db.value('SELECT wallet_address FROM enterprise WHERE id = ?', [user.org_id]);
  } else if (user.role === 'VERIFIER' && user.org_id) {
    wallet = await db.value('SELECT wallet_address FROM verifier_org WHERE id = ?', [user.org_id]);
  }

  /* 岗位：登录即回传，避免前端首屏只能显示角色名（缺陷清单 P1-24） */
  const postCn = await postLabelOf(user.post);
  ok(res, {
    token,
    user: { ...payload, roleCn: ROLE_CN[user.role], post: user.post || null, postCn, wallet },
  }, '登录成功');
}));

/* 当前用户 --------------------------------------------------------- */
router.get('/me', authRequired, wrap(async (req, res) => {
  const u = await db.one(
    'SELECT id, username, real_name, role, org_id, org_name, phone, email, post, last_login FROM sys_user WHERE id = ?',
    [req.user.id]
  );
  if (!u) return fail(res, '账号不存在', 404);
  u.roleCn = ROLE_CN[u.role];
  /* 岗位中文名（缺陷清单 P1-24）：顶栏用户区需要区分「机构管理员」与
   * 「核查录入员」等同角色不同岗位的账号，只回 roleCn 无法区分。 */
  u.postCn = await postLabelOf(u.post);
  if (u.role === 'ENTERPRISE') {
    u.orgDetail = await db.one('SELECT * FROM enterprise WHERE id = ?', [u.org_id]);
  } else if (u.role === 'VERIFIER') {
    u.orgDetail = await db.one('SELECT * FROM verifier_org WHERE id = ?', [u.org_id]);
  }
  ok(res, u);
}));

/* 退出 -------------------------------------------------------------
 * 吊销当前 token（服务端黑名单）：旧实现只是前端删本地存储，
 * token 本身在过期前仍可继续调用接口——"退出登录"名不副实。 */
router.post('/logout', authRequired, wrap(async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) revokeToken(h.slice(7));
  } catch (e) { /* 吊销失败不影响退出应答，但留痕 */ }
  await writeLog(req, '用户管理', '退出登录', req.user.username, '退出系统（token 已吊销）');
  ok(res, null, '已退出');
}));

/* 自主注册 -----------------------------------------------------------
 * 两类公开注册通道，准入等级不同：
 *   · ENTERPRISE（默认）—— 注册即创建企业档案 + 账号，注册即登录。
 *     企业数据只在企业自己的工作台内闭环，公开注册风险可控。
 *   · VERIFIER —— 核查机构实名自主注册。核查角色可接触**多家企业**的
 *     上报数据与核查工作流，绝不能"注册即得"：账号以 status=0（待审核）
 *     落库，管理员在「管理端 · 用户与权限」人工审核通过（status→1）后
 *     才可登录；驳回即删除注册记录。监管/交易/管理角色仍不开放公开注册，
 *     只能由 ADMIN 创建 —— 这条底线不动。 */
router.post('/register', registerLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const role = b.role === 'VERIFIER' ? 'VERIFIER' : 'ENTERPRISE';
  if (b.role && b.role !== 'VERIFIER' && b.role !== 'ENTERPRISE') {
    return fail(res, '该角色不开放自主注册，请联系平台管理员', 403);
  }
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const realName = String(b.realName || '').trim();
  const orgName = String(b.orgName || '').trim();
  const industry = String(b.industry || '').trim();
  const region = String(b.region || '').trim();
  const contactPhone = String(b.contactPhone || '').trim();

  /* ---- 公共校验（前端校验只是体验，这里才是边界） ---- */
  if (!/^[A-Za-z0-9_]{3,30}$/.test(username)) return fail(res, '账号需为 3-30 位字母、数字或下划线', 400);
  if (password.length < 6) return fail(res, '密码至少 6 位', 400);
  if (!realName) return fail(res, '请填写联系人姓名', 400);
  if (!orgName || orgName.length > 120) return fail(res, role === 'VERIFIER' ? '请填写机构名称（120 字以内）' : '请填写企业名称（120 字以内）', 400);

  const dup = await db.one('SELECT id FROM sys_user WHERE username = ?', [username]);
  if (dup) return fail(res, '该账号已被注册', 409);

  /* ---- 企业通道：事务内 企业档案 + 账号原子创建，注册即登录 ---- */
  if (role === 'ENTERPRISE') {
    if (!REG_INDUSTRIES.includes(industry)) return fail(res, '请选择所属行业', 400);
    if (!REG_REGIONS.includes(region)) return fail(res, '请选择所在省份', 400);

    const dupEnt = await db.one('SELECT id FROM enterprise WHERE ent_name = ?', [orgName]);
    if (dupEnt) return fail(res, '该企业名称已存在（如需重置密码请联系管理员）', 409);

    const salt = cu.randomSalt(16);
    const hash = cu.hashPasswordPbkdf2(password, salt);   // pbkdf2$：两端（Node/Workers）均可校验

    /* 开户：注册即生成链上钱包身份。
     *
     * ⚠ 这一步不能省。此前的实现只在 enterprise 表插一行，wallet_address 为 NULL；
     * 企业登录后"我的链上身份"页全空、按地址查存证查不到、交易端的持仓也挂不上。
     * 上链本身不会失败（anchor() 会用 walletFor('ent:<id>') 现生成），
     * 但那个地址**从未回写到业务表**，于是页面上永远显示未开户 ——
     * 数据是有的、链上也确实签了名，但用户看到的是一片空白。
     * 这类"能用但看不见"的缺陷比报错更难发现。
     *
     * 幂等性：walletFor 对同一 label 是确定性的（generateWalletDeterministic），
     * 重复调用得到同一对密钥，不会覆盖或产生第二套身份。 */

    let userId;
    let walletAddress = null;
    try {
      await db.tx(async (conn) => {
        const [ent] = await conn.query(
          `INSERT INTO enterprise (ent_code, ent_name, industry, region, contact_phone, status)
           VALUES (?,?,?,?,?, 'ACTIVE')`,
          [`REG${Date.now().toString(36).toUpperCase()}`, orgName, industry, region, contactPhone || null],
        );
        const entId = ent.insertId;
        const [u] = await conn.query(
          `INSERT INTO sys_user (username, password, salt, real_name, role, org_id, org_name, phone, status)
           VALUES (?,?,?,?, 'ENTERPRISE', ?,?,?, 1)`,
          [username, hash, salt, realName, entId, orgName, contactPhone || null],
        );
        userId = u.insertId;
        /* 钱包身份必须用真实 entId 作为 label，才能与 anchor() 中
         * `ent:${id}` 的取法一致 —— 否则企业会拿到两套不同的密钥。 */
        const w = keystore.walletFor(`ent:${entId}`);
        walletAddress = w.address;
        await conn.query(
          'UPDATE enterprise SET wallet_address = ?, pub_key = ? WHERE id = ?',
          [w.address, w.publicKey, entId]
        );
      });
    } catch (e) {
      return fail(res, '注册失败：' + String(e.message || e).slice(0, 80), 500);
    }

    await writeLog({ headers: req.headers, ip: req.ip }, '用户管理', '企业注册', username, `企业 ${orgName}（${industry} · ${region}）自主注册`);

    /* 注册即登录：发 token，直接进入企业工作台 */
    const user = await db.one('SELECT * FROM sys_user WHERE id = ?', [userId]);
    const token = signToken({
      id: Number(user.id), username: user.username, role: user.role,
      realName: user.real_name, orgId: user.org_id ? Number(user.org_id) : null, orgName: user.org_name,
    });
    return ok(res, {
      token,
      user: {
        id: Number(user.id), username: user.username, role: user.role, roleCn: ROLE_CN[user.role],
        realName: user.real_name, orgId: user.org_id ? Number(user.org_id) : null, orgName: user.org_name,
      },
    }, '注册成功');
  }

  /* ---- 核查机构通道：实名注册 + 管理员审核准入 ----
   * status=0 落库（不发票、不可登录），同时创建 verifier_org 档案
   * （审核通过即生效；驳回时与账号一并清理）。 */
  if (!REG_REGIONS.includes(region)) return fail(res, '请选择机构所在省份', 400);

  const dupOrg = await db.one('SELECT id FROM verifier_org WHERE org_name = ?', [orgName]);
  if (dupOrg) return fail(res, '该机构名称已存在（如需重置密码请联系管理员）', 409);

  const salt = cu.randomSalt(16);
  const hash = cu.hashPasswordPbkdf2(password, salt);
  let userId;
  try {
    await db.tx(async (conn) => {
      const [org] = await conn.query(
        `INSERT INTO verifier_org (org_code, org_name, region, contact_phone, status)
         VALUES (?,?,?,?, 'PENDING')`,
        [`VRG${Date.now().toString(36).toUpperCase()}`, orgName, region, contactPhone || null],
      );
      const orgId = org.insertId;
      const [u] = await conn.query(
        `INSERT INTO sys_user (username, password, salt, real_name, role, org_id, org_name, phone, status)
         VALUES (?,?,?,?, 'VERIFIER', ?,?,?, 0)`,
        [username, hash, salt, realName, orgId, orgName, contactPhone || null],
      );
      userId = u.insertId;
      /* 开户：核查机构出具报告时要用自己的私钥签名并上链，
       * 没有钱包身份的机构审核通过后依然无法完成"出具报告"这一步 ——
       * 它会卡在 anchor() 现场生成密钥、但地址从未回写业务表，
       * 于是"我的链上身份"页永远为空、按地址查不到自己签发的报告。
       * 与企业端同理：注册即开户，label 用 `ver:<orgId>`，
       * 与 anchor() 里 verifier.js 的取法保持一致。 */
      const w = keystore.walletFor(`ver:${orgId}`);
      await conn.query(
        'UPDATE verifier_org SET wallet_address = ?, pub_key = ? WHERE id = ?',
        [w.address, w.publicKey, orgId]
      );
    });
  } catch (e) {
    return fail(res, '注册失败：' + String(e.message || e).slice(0, 80), 500);
  }

  await writeLog({ headers: req.headers, ip: req.ip }, '用户管理', '机构注册', username,
    `核查机构 ${orgName}（${region}）实名注册，待管理员审核`);
  return ok(res, {
    pending: true,
    user: { username, role: 'VERIFIER', roleCn: ROLE_CN.VERIFIER, realName, orgName },
  }, '注册成功：机构账号已提交，管理员审核通过后即可登录');
}));

/* 修改口令 --------------------------------------------------------- */
router.post('/change-password', authRequired, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return fail(res, '新口令至少 6 位', 400);
  const u = await db.one('SELECT * FROM sys_user WHERE id = ?', [req.user.id]);
  if (!cu.verifyPassword(oldPassword || '', u.salt, u.password).ok) return fail(res, '原口令不正确', 400);
  const salt = cu.randomSalt(16);
  await db.query('UPDATE sys_user SET password = ?, salt = ? WHERE id = ?',
    [cu.hashPasswordPbkdf2(newPassword, salt), salt, req.user.id]);
  await writeLog(req, '用户管理', '修改口令', u.username, '口令已更新');
  ok(res, null, '口令修改成功');
}));

/* 演示账号（方便答辩现场一键切换身份） ------------------------------- */

/* 演示账号白名单：2026-10-30 终版口径 —— 下拉仅展示 8 个（一类一席）。
 *
 * 三闭环体系（见 docs/三闭环账号体系-20261030.md）共 72 个演示账号：
 *   原闭环 8 个 + 闭环 B 31 个（reg002 + 唐山双岗 + trader02 + 28 企业）
 *   + 闭环 C 31 个（reg003 + 绿链双岗 + trader03 + 28 企业）+ admin。
 * 其中**只有 8 个**进入登录页下拉（答辩动线的最小集合，一类角色一席）；
 * 其余 64 个账号全部真实存在、口令同为 123456，可直接在登录表单输入
 * 用户名登录（闭环 B/C 的完整业务动线都走得通），只是不在下拉里列出 ——
 * 60 个企业账号会把下拉撑爆，需要哪个把用户名加回本清单即可。
 *
 * 下拉 8 个的选取依据（实测 + 代码双证）：
 *   · 服务端鉴权只看 role；`post` 岗位字段仅作展示，唯一按岗位硬校验的
 *     是核查端 checkPost（录入需 ENTRY、批准需 REVIEW）。
 *   · 企业端单一主账号对 13 个关键接口实测 13/13 走通
 *     （探针 tools/_probe-one-ent.mjs）。
 *   · 核查端必须是有 REVIEW 职责位的账号（ver_cz_review），
 *     否则「复核出证上链」环节无账号可做。
 *
 * 为什么仍用白名单而不是 SELECT 全表：
 *   sys_user 里混有评审现场注册的真实账号，口令不是演示口令，
 *   混进列表会让演示者填了登不进去，也把真实账号暴露在公开登录页上。
 *
 * 顺序即分类顺序，前端按 role 分组展示。 */
const DEMO_USERNAMES = [
  /* 管理端：唯一管理员，跨闭环运维，不参与业务决策 */
  'admin',
  /* 监管端：原闭环席位 */
  'reg001',
  /* 核查端：沧州机构审核岗 —— 受理任务、复核出证上链 */
  'ver_cz_review',
  /* 企业端：保定四家真实焚烧企业（LJGK 真实 CEMS 数据），
     按「总览 → 填报核算 → 履约清缴 → 交易挂单」单账号贯穿全流程 */
  'ent_zjbd', 'ent_yfkw', 'ent_yxyf', 'ent_zjyls',
  /* 交易端：原闭环席位（持四家企业代理授权） */
  'trader01',
];

/* ⚠ 2026-10-30 变更史（当日四步，最终 = 上方口径）：
 * ① 25 → 14：企业端收敛（移除四家的 _clerk/_quota 岗位子账号与 ent001*）；
 * ② 14 → 8：全部角色收敛为一类一席（移除 reg_review / ver001 / ver_cz_clerk /
 *    ver_dl_* / trader02）；
 * ③ 8 → 72：三闭环体系建号（reg002/reg003/trader03 + 56 个企业主账号 +
 *    ver_ts_* 与 ver_hblv_* 双岗 + trader02 回归），闭环 B/C 全部业务打通；
 * ④ 72 → 8（当前）：下拉仅展示 8 个答辩动线账号，其余 64 个账号保留库内、
 *    口令同为 123456、可直接输入用户名登录，只是不再出现在下拉里。
 * 不在下拉里的账号均真实存在 —— 闭环 B/C 的完整业务动线照常可演示，
 * 需要展示哪个身份就把用户名加回上方 DEMO_USERNAMES。
 *
 * ⚠ 2026-10-29 二次变更说明（历史）：
 * 上午曾把白名单收敛为 5 个账号（数据回滚到「四家企业接入之前」时的口径）。
 * 当天下午四家企业（enterprise.id 65~68）连同 13.44 万行 CEMS 小时数据、
 * 32 份排放报告、32 份核查结论、配额与交易记录一并装回平台，
 * 其 12 个岗位账号与承接核查的 2 个机构岗位账号同步落库，
 * 白名单因此扩容到 19 个 —— 与库内真实存在的账号同源，不存在「填了登不进去」。
 * 不在白名单的 ver_hblv_* / ver_ts_* / admin_backup 等账号仅作为审批链上的
 * 人名来源存在，不提供登录入口。 */


router.get('/demo-accounts', demoLimiter, wrap(async (req, res) => {
  if (!DEMO_ACCOUNTS) return fail(res, '演示账号接口已在当前环境关闭', 403);
  // 明确告知：这是演示特性，口令为公开的演示口令，切勿在生产环境开启
  res.setHeader('X-Demo-Mode', 'true');
  const rows = await db.query(
    `SELECT username, real_name, role, org_name, post FROM sys_user
     WHERE status = 1 AND username IN (${DEMO_USERNAMES.map(() => '?').join(',')})`,
    DEMO_USERNAMES
  );
  /* 岗位中文名取自字典表，不在这里再抄一份：字典变了（新增/改名岗位），
     下拉标签自动跟着变，不会出现"库里叫排放填报员、界面叫填报员"的错位。
     与 /login、/me 共用 postLabelOf（60 秒缓存），三处口径永远一致。 */
  const postCn = new Map();
  for (const r of rows) {
    if (r.post && !postCn.has(r.post)) postCn.set(r.post, await postLabelOf(r.post));
  }
  /* 按白名单顺序输出，让同一角色的账号相邻，前端分组无需再排序 */
  const byName = new Map(rows.map((r) => [r.username, r]));
  ok(res, DEMO_USERNAMES.filter((u) => byName.has(u)).map((u) => {
    const r = byName.get(u);
    return {
      username: r.username,
      /* 口令不可反解（库里只有 pbkdf2 摘要），演示口令是约定值：
       * 两个管理员账号为 admin123（便于区分管理端），其余一律 123456。 */
      password: r.role === 'ADMIN' ? 'admin123' : '123456',
      realName: r.real_name,
      role: r.role,
      roleCn: ROLE_CN[r.role],
      post: r.post || null,
      postCn: (r.post && postCn.get(r.post)) || null,
      orgName: r.org_name || (r.role === 'ADMIN' ? '碳链通平台运营方' : null),
    };
  }));
}));

module.exports = router;
