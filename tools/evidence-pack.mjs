#!/usr/bin/env node
/**
 * tools/evidence-pack.mjs —— 可自验证据包打包器
 * ==================================================================
 * 解决什么问题
 * ------------------------------------------------------------------
 * 参赛评审（含国赛现场问询）最尖锐的一句是：
 *
 *     "你说的这些，我凭什么信？"
 *
 * 现场演示能回答"它能跑"，但回答不了"我跑的这一份和你写进申报书的那一份
 * 是不是同一份"。中间隔着时间、机器、以及"你有没有改过"的猜疑。
 *
 * 本脚本把一次真实执行的全部产物打成一个**自带校验器的包**：
 * 评委拿到 U 盘里的这个目录，不需要装数据库、不需要起服务、不需要联网，
 * 一条命令就能判定「包内任何文件有没有被动过一个字节」。
 *
 * 包的诚实边界（必须写在包里，也必须写在答辩口径里）
 * ------------------------------------------------------------------
 * 本包证明的是：**平台的自证链路真实、可重跑、未被事后修饰**。
 * 本包不证明的是：**数据来自真实企业现场**（当前为自举登记的演示口径）。
 * 后者需要第三方采样与实测数据接入，属于下一阶段工作，不得在本包中被暗示为已完成。
 * 把这两件事分开写，是"验证等级"主张的成立前提 —— 混在一起讲，一条都站不住。
 *
 * 用法
 *   node tools/evidence-pack.mjs                  # 打到 tools/out/evidence-pack/
 *   node tools/evidence-pack.mjs --out D:/tmp/pack
 *   node tools/evidence-pack.mjs --no-chain       # 不含 940 KB 链导出（快速包）
 * ==================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tools', 'out');
const ARGV = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGV.indexOf(n);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d;
};

const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT = path.resolve(argOf('--out', path.join(OUT_DIR, `evidence-pack-${STAMP}`)));
const WITH_CHAIN = !ARGV.includes('--no-chain');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ==================================================================
 * 一、清单：文件 → 包内位置 → 用途说明
 * ------------------------------------------------------------------
 * 每一项都写清"这份文件回答哪个问题"，评审翻包时不必猜。
 * ================================================================== */

const MANIFEST_SPEC = [
  /* ---- 第一层：指标台账（数字从哪来） ---- */
  {
    src: 'metrics-ledger.json',
    dest: '01-指标溯源台账/指标台账.json',
    purpose: '每个对外数字 → 产生命令 + 证据文件 + 文件摘要 + 采集时间',
    layer: 1,
  },
  {
    src: 'metrics-ledger.md',
    dest: '01-指标溯源台账/指标台账-人读版.md',
    purpose: '同上，可直接贴进申报书附录',
    layer: 1,
  },

  /* ---- 第二层：链上事实（数据有没有被改） ---- */
  {
    src: 'chain-export.json',
    dest: '02-链上事实/链导出-哑管道.json',
    purpose: '区块/交易/节点原样导出；不含任何判定，供第三方独立复核',
    layer: 2,
    optional: true,
  },
  {
    src: 'data-provenance.json',
    dest: '02-链上事实/数据来源分级.json',
    purpose: '按来源可验证强度给每条读数分级（L0 自举 / L1 人工 / L2 设备 / L3 实测）',
    layer: 2,
  },

  /* ---- 第三层：性能与演练（凭什么说快、说防得住） ---- */
  {
    src: 'bench-consensus.json',
    dest: '03-性能与演练/共识性能基准.json',
    purpose: '同难度 PoW vs PoA，同机同实现，含硬件指纹',
    layer: 3,
  },
  {
    src: 'bench-crypto.json',
    dest: '03-性能与演练/密码学原语基准.json',
    purpose: 'SM3 / SM2 / Merkle 逐项速率，含 OpenSSL 版本',
    layer: 3,
  },
  {
    src: 'attack-same-db.json',
    dest: '03-性能与演练/同库同改攻击演练.json',
    purpose: '七组篡改用例的检出结果，含"还原后全绿"阴性对照',
    layer: 3,
  },
  {
    src: 'verify-all.json',
    dest: '03-性能与演练/全量回归汇总.json',
    purpose: '全量回归逐套件状态与断言计数（当前 24 套件，见文件内 totals）',
    layer: 3,
  },
  {
    src: 'iot-stats.json',
    dest: '03-性能与演练/设备接入统计.json',
    purpose: '设备台账与逐帧 CRC/SM3 校验计数（"132 台"的真实出处）',
    layer: 3,
  },

  /* ---- 第三层之补：真实数据检验（凭什么说核算实现对） ----
   * 这一组是本轮整改最关键的证据。此前平台所有"正确性"证明都是自证
   * （自己造数据、自己算、自己断言等于预期值），逻辑上是循环的。
   * 这三份文件把"正确"的依据换成了**外部独立观测**：
   *   · 交叉验证：用 Climate TRACE 的 (E, A, EF) 三元组检验 E = A×EF
   *   · ZK 真实数据：零知识协议在真实量级上可用，且阴性对照全部拦截
   * 任何人拿到这三个文件 + 对应工具，都能用公开 API 复算一遍。 */
  {
    src: 'crossvalidate-check.json',
    dest: '03-性能与演练/真实数据交叉验证.json',
    purpose: '用外部真实观测检验核算实现的量纲与口径（恒等式 E=A×EF）',
    layer: 3,
  },
  {
    src: 'zk-real-data-check.json',
    dest: '03-性能与演练/零知识协议-真实设施验证.json',
    purpose: 'ZK 公式证明在真实设施量级上端到端可用，含 3 类阴性对照',
    layer: 3,
  },
  {
    src: 'real-layer-check.json',
    dest: '03-性能与演练/真实数据层验收.json',
    purpose: '真实数据层 95 项断言（分页/筛选/基准/趋势/契约/实时/口径一致性）',
    layer: 3,
  },

  /* ---- 第四层：端云互认（硬件那半边是否成立） ---- */
  {
    src: 'sm2-verify-evidence.json',
    dest: '04-端云互认/SM2-端云验签.json',
    purpose: '设备侧签名 → 平台侧验签的逐条结果',
    layer: 4,
  },
  {
    src: 'firmware-compat-evidence.json',
    dest: '04-端云互认/固件自证.json',
    purpose: '固件侧 SM3 标准向量、密钥派生等断言',
    layer: 4,
  },
];

/* ==================================================================
 * 二、独立复核器（写入包内，零依赖、不 require 项目模块）
 * ================================================================== */

const VERIFY_PACK_SRC = `#!/usr/bin/env node
/**
 * verify-pack.mjs —— 证据包自带校验器
 * ==================================================================
 * 设计约束（这三条决定了它有没有说服力）
 *   ① **零依赖**：只用 Node 内置模块，不 require 平台的任何代码。
 *      评审不必 npm install，不必连数据库，不必理解本项目结构。
 *   ② **只信清单**：一切以同目录 manifest.json 为准，不接受命令行喂入的期望值。
 *   ③ **先校验后解释**：任一条摘要不符立即判 FAIL，不做"部分通过"的和稀泥。
 *
 * 用法
 *   node verify-pack.mjs                # 校验全部文件
 *   node verify-pack.mjs --json         # 输出机读结果
 *   node verify-pack.mjs --quiet        # 只打印结论行
 * ==================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const AS_JSON = ARGV.includes('--json');
const QUIET = ARGV.includes('--quiet');

const manifestPath = path.resolve(HERE, '..', 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('找不到 manifest.json —— 本脚本必须放在「复核工具/」子目录内运行');
  process.exit(2);
}
const mf = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const rows = [];
let ok = 0;
let bad = 0;
let miss = 0;

for (const f of mf.files) {
  const p = path.resolve(HERE, '..', f.path);
  if (!fs.existsSync(p)) {
    rows.push({ path: f.path, status: 'MISSING', expect: f.sha256, actual: null });
    miss++;
    continue;
  }
  const buf = fs.readFileSync(p);
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  const sizeOk = buf.length === f.bytes;
  const hashOk = actual === f.sha256;
  if (hashOk && sizeOk) {
    rows.push({ path: f.path, status: 'OK', expect: f.sha256, actual });
    ok++;
  } else {
    rows.push({
      path: f.path,
      status: hashOk ? 'SIZE_MISMATCH' : 'HASH_MISMATCH',
      expect: f.sha256,
      actual,
      bytesExpect: f.bytes,
      bytesActual: buf.length,
    });
    bad++;
  }
}

/* 清单自校验：manifest 自身也有摘要，写在 pack.summaryDigest 里 */
const body = JSON.stringify({ ...mf, summaryDigest: undefined });
const selfDigest = crypto.createHash('sha256').update(body).digest('hex');
const selfOk = !mf.summaryDigest || mf.summaryDigest === selfDigest;

const verdict = bad === 0 && miss === 0 && selfOk ? 'PACK_INTACT' : 'PACK_TAMPERED';

if (AS_JSON) {
  console.log(JSON.stringify({ verdict, ok, bad, miss, selfOk, rows }, null, 2));
} else {
  if (!QUIET) {
    console.log('');
    console.log('证据包完整性校验');
    console.log('  包标识  ' + mf.packId);
    console.log('  生成于  ' + mf.generatedAt);
    console.log('  文件数  ' + mf.files.length);
    console.log('');
    for (const r of rows) {
      const mark = r.status === 'OK' ? 'OK  ' : 'FAIL';
      console.log('  [' + mark + '] ' + r.path);
      if (r.status !== 'OK') {
        console.log('         期望 ' + String(r.expect).slice(0, 16) + '…');
        console.log('         实得 ' + String(r.actual).slice(0, 16) + '…');
        if (r.bytesExpect !== undefined) {
          console.log('         字节 ' + r.bytesActual + ' / 期望 ' + r.bytesExpect);
        }
      }
    }
    console.log('');
    console.log('  清单自摘要  ' + (selfOk ? '一致' : '不一致 —— manifest 自身被改过'));
  }
  console.log('');
  if (verdict === 'PACK_INTACT') {
    console.log('结论：PACK_INTACT —— 包内 ' + ok + ' 个文件与清单逐一相符，未发现事后修改。');
  } else {
    console.log('结论：PACK_TAMPERED —— ' + bad + ' 个文件摘要不符，' + miss + ' 个文件缺失。');
    console.log('      说明：这可能意味着文件被修改，也可能只是解压/复制过程损坏。');
    console.log('      请重新获取原始证据包后再判定。');
  }
  console.log('');
}

process.exit(verdict === 'PACK_INTACT' ? 0 : 1);
`;

/* ==================================================================
 * 三、打包
 * ================================================================== */

function copyIfExists(rel, destRel) {
  const src = path.join(OUT_DIR, rel);
  if (!fs.existsSync(src)) return null;
  const dest = path.join(OUT, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const buf = fs.readFileSync(dest);
  return {
    path: destRel.replace(/\\/g, '/'),
    bytes: buf.length,
    sha256: sha256(buf),
    origin: `tools/out/${rel}`,
  };
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const files = [];
const skipped = [];

for (const spec of MANIFEST_SPEC) {
  if (spec.src === 'chain-export.json' && !WITH_CHAIN) {
    skipped.push({ src: spec.src, why: '--no-chain 指定不含链导出' });
    continue;
  }
  const rec = copyIfExists(spec.src, spec.dest);
  if (!rec) {
    skipped.push({ src: spec.src, why: '源文件不存在，先跑对应生成命令' });
    continue;
  }
  files.push({ ...rec, purpose: spec.purpose, layer: spec.layer });
}

/* 独立复核链的脚本一并带走（verify-offline 本身已满足"不 require 项目模块"） */
const offlineSrc = path.join(ROOT, 'tools', 'verify-offline.mjs');
if (fs.existsSync(offlineSrc)) {
  const dest = path.join(OUT, '复核工具', 'verify-offline.mjs');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(offlineSrc, dest);
  const buf = fs.readFileSync(dest);
  files.push({
    path: '复核工具/verify-offline.mjs',
    bytes: buf.length,
    sha256: sha256(buf),
    origin: 'tools/verify-offline.mjs',
    purpose: '零信任离线复核器：独立重实现哈希/Merkle/验签，对链导出逐块重算',
    layer: 2,
  });
}

/* 自带校验器 */
const vp = path.join(OUT, '复核工具', 'verify-pack.mjs');
fs.mkdirSync(path.dirname(vp), { recursive: true });
fs.writeFileSync(vp, VERIFY_PACK_SRC);
{
  const buf = fs.readFileSync(vp);
  files.push({
    path: '复核工具/verify-pack.mjs',
    bytes: buf.length,
    sha256: sha256(buf),
    origin: '(generated) tools/evidence-pack.mjs',
    purpose: '本包完整性校验器：逐文件比对摘要，零依赖',
    layer: 0,
  });
}

/* ==================================================================
 * 四、manifest.json
 * ================================================================== */

let gitHead = '';
let gitDirty = false;
try {
  gitHead = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  gitDirty = execSync('git status --porcelain', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
} catch { /* 非 git 环境不阻塞 */ }

const ledger = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'metrics-ledger.json'), 'utf8'));
  } catch {
    return null;
  }
})();

const packId = `CCH-EVID-${STAMP}-${sha256(files.map((f) => f.sha256).join('')).slice(0, 8)}`;

/* 数据来源分级（若已审计过则引用其真实数字，未审计则为 null，不编造） */
const provenance = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'data-provenance.json'), 'utf8'));
  } catch {
    return null;
  }
})();

const manifest = {
  packId,
  generatedAt: new Date().toISOString(),
  generator: 'tools/evidence-pack.mjs',
  project: '碳链通 CarbonChain Hub —— 工业碳资产动态核算可信存证平台',
  env: {
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    cpuModel: (os.cpus()[0] || {}).model || 'unknown',
    cpuCount: os.cpus().length,
    hostname: os.hostname(),
    arch: process.arch,
  },
  code: { gitHead: gitHead || null, gitDirty },
  /* 证明边界：写进清单而不是只写在 README，避免"说过就忘" */
  proves: [
    '包内每个文件与清单摘要逐一相符，未在打包后被修改',
    '这些数字各自来自一条可重跑的命令，命令与证据文件名在指标台账中逐条给出',
    '链导出可被第三方用独立实现的复核器逐块重算，不依赖平台代码',
    '在给定硬件上，同难度 PoW 与 PoA 的耗时对比可复现',
    '数据来源分级已量化披露（见 02-链上事实/数据来源分级.json）',
  ],
  doesNotProve: [
    provenance
      ? `不证明监测数据来自真实企业现场：当前 L0 平台自举占 ${provenance.cems.selfBootstrapPct}%，设备直报占 ${provenance.cems.deviceDirectPct}%`
      : '不证明监测数据来自真实企业现场（当前为平台自举登记的演示口径）',
    '不证明已通过第三方检测机构计量认证或碳核查机构认可',
    '不证明在真实工业网络环境下的长期稳定性（当前无长跑记录）',
    '不证明经济性结论（未做现场部署成本核算）',
  ],
  provenance: provenance
    ? {
        total: provenance.cems.total,
        l0: provenance.cems.l0,
        l1: provenance.cems.l1,
        l2: provenance.cems.l2,
        l3: provenance.cems.l3,
        deviceDirectPct: provenance.cems.deviceDirectPct,
        crcPct: provenance.cems.crcPct,
        sm3Pct: provenance.cems.sm3Pct,
        verdicts: provenance.verdicts,
      }
    : null,
  totals: {
    files: files.length,
    bytes: files.reduce((a, f) => a + f.bytes, 0),
    metrics: ledger ? ledger.totals.metrics : null,
    metricsOk: ledger ? ledger.totals.OK || 0 : null,
  },
  skipped,
  files,
};

/* ⚠ manifest 的写盘必须放在 README 生成**之后**（见下方 §五.1）。
 * 早先的顺序是：先写 manifest → 再写 00-复核指南.md。
 * 后果：复核指南不在清单里，任何人改掉它记录的"结论"都不会被 verify-pack 发现 ——
 * 而它恰恰是评审最先读的一页。实测：往指南末尾追加一个空格，
 * verify-pack 仍输出 PACK_INTACT。这是证据包最致命的一个洞：
 * 包能被篡改而自验说"完好"，比没有自验更糟糕。
 *
 * 现在改成：
 *   ① 生成 README → ② 把 README 加入 files → ③ 重算 totals → ④ 写 manifest
 * 这样"包内每个文件"都在清单中，没有法外之地。 */

/* ==================================================================
 * 五、README（复核指南）
 * ================================================================== */

const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

const readme = `# 碳链通 · 可自验证据包

**包标识**　\`${packId}\`
**生成时间**　${manifest.generatedAt.replace('T', ' ').slice(0, 19)} UTC
**代码版本**　\`${gitHead || 'n/a'}\`${gitDirty ? '（工作区有未提交改动）' : ''}
**运行环境**　${manifest.env.cpuModel} / ${manifest.env.cpuCount} 核 / Node ${manifest.env.node}
**文件总数**　${files.length} 个，合计 ${fmtBytes(manifest.totals.bytes)}

---

## 一、这个包是什么

一次真实执行的全部产物，加一个自带校验器。

它要回答的是评审现场最难回答的那句话：**"我凭什么信你写进申报书的数字？"**

不给承诺，给可执行的东西 —— 见下面第三节，三条命令，五分钟。

## 二、包里有什么

| 层次 | 目录 | 回答什么问题 |
|---|---|---|
| 0 | \`复核工具/\` | 我怎么验这个包有没有被动过 |
| 1 | \`01-指标溯源台账/\` | 每个数字是哪条命令、哪次执行产生的 |
| 2 | \`02-链上事实/\` | 链上数据能不能被独立重算出来 |
| 3 | \`03-性能与演练/\` | 凭什么说快、凭什么说篡改能检出 |
| 4 | \`04-端云互认/\` | 硬件那一半是不是真的成立了 |

逐文件用途见 \`manifest.json\` 的 \`files[].purpose\`。

## 三、怎么验（评审可当场执行）

只需要一个 Node.js（v18+），**不需要数据库、不需要装依赖、不需要联网**。

### 第 1 步 · 包完整性

\`\`\`bash
cd 复核工具
node verify-pack.mjs
\`\`\`

期望输出最后一行：

\`\`\`
结论：PACK_INTACT —— 包内 ${files.length} 个文件与清单逐一相符，未发现事后修改。
\`\`\`

任一个字节被改过，都会变成 \`PACK_TAMPERED\` 并指名是哪个文件。

### 第 2 步 · 链上数据独立重算

\`\`\`bash
node verify-offline.mjs --input ../02-链上事实/链导出-哑管道.json
\`\`\`

这个脚本**没有引用本项目任何一行代码**：哈希、Merkle、稳定序列化、SM2 验签
全部按公开规范在脚本内独立重实现。也就是说，即使平台内核写错了，它也会当场暴露，
而不是跟着一起错。

### 第 3 步 · 数字对账

打开 \`01-指标溯源台账/指标台账-人读版.md\`，任选一行，
按该行给出的命令在项目里重跑，比对文件摘要前 12 位。

摘要一致 ⇒ 论文里的数字就是那次执行的结果。
摘要不一致 ⇒ 台账过期了，以重跑结果为准。

## 四、这个包**不**证明什么

这一段和上面同样重要。把边界讲清，结论才立得住。

${manifest.doesNotProve.map((s) => `- ${s}`).join('\n')}

对应的，本包**能**证明的是：

${manifest.proves.map((s) => `- ${s}`).join('\n')}

## 五、指标台账状态

${ledger ? `- 登记指标：**${ledger.totals.metrics}** 条
- 有效（✅）：**${ledger.totals.OK || 0}** 条
- 过期（🟡）：${ledger.totals.STALE || 0} 条
- 可疑（🟠）：${ledger.totals.SUSPECT || 0} 条
- 未取到（🔴）：${ledger.totals.UNVERIFIED || 0} 条
- 缺文件（⛔）：${ledger.totals.MISSING || 0} 条` : '- 台账未生成，请先运行 `npm run metrics:ledger`'}

${skipped.length ? `**打包时跳过的文件**：\n\n${skipped.map((s) => `- \`${s.src}\` —— ${s.why}`).join('\n')}` : ''}

---

*本包由 \`tools/evidence-pack.mjs\` 生成；台账由 \`tools/metrics-ledger.mjs\` 生成。*
*复核若发现任何不符，请以重跑结果为准，并视为台账已过期。*
`;

fs.writeFileSync(path.join(OUT, '00-复核指南.md'), readme);

/* §五.1 —— 把复核指南纳入清单（关键修补，见上方说明）
 * 这样 verify-pack 会像校验其他文件一样校验它，"改指南"不再能瞒过自验。 */
{
  const rel = '00-复核指南.md';
  const full = path.join(OUT, rel);
  const buf = fs.readFileSync(full);
  files.push({
    path: rel,
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    origin: 'tools/evidence-pack.mjs（生成）',
    purpose: '复核指南：告诉第三方从哪一步开始验、验什么、验不出什么',
    layer: 0,
  });
  manifest.files = files;
  manifest.totals.files = files.length;
  manifest.totals.bytes = files.reduce((a, f) => a + f.bytes, 0);
}

/* 最后写 manifest（此时 files 已完整） */
{
  const manifestBody = JSON.stringify(manifest);
  manifest.summaryDigest = crypto.createHash('sha256').update(manifestBody).digest('hex');
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

/* ==================================================================
 * 六、终端摘要
 * ================================================================== */

const relOut = path.relative(ROOT, OUT).replace(/\\/g, '/');
console.log('');
console.log('可自验证据包 —— 打包完毕');
console.log('');
console.log(`  包标识  ${packId}`);
console.log(`  目录    ${relOut}/`);
console.log(`  文件    ${files.length} 个 / ${fmtBytes(manifest.totals.bytes)}`);
for (const f of files) {
  const layerTag = `L${f.layer}`;
  console.log(`   ${layerTag}  ${f.path}`);
}
if (skipped.length) {
  console.log('');
  console.log('  跳过：');
  for (const s of skipped) console.log(`   - ${s.src}（${s.why}）`);
}
console.log('');
console.log('  自验命令：');
console.log(`   cd "${relOut}/复核工具" && node verify-pack.mjs`);
console.log('');
