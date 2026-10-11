/**
 * data/bench.js —— 密码学与联盟链内核「真实基准」数据源（自动生成）
 * ==================================================================
 * ⚠ 本文件由 `node scripts/bench-crypto.js` 生成，请勿手工编辑。
 *   每次运行基准脚本会覆盖：数字来自对 server/blockchain/ 真实内核的实测，
 *   环境指纹与测量时间一并写入，供页面展示与评审复核。
 *
 * 生成时间：2026-10-11T04:53:56.395Z
 * 运行环境：Node v22.22.2 / OpenSSL 3.5.5
 *          13th Gen Intel(R) Core(TM) i7-13650HX ×20
 * 测量耗时：82.4s
 */
(function (global) {
  'use strict';
  global.App = global.App || {};
  global.App.Bench = {
  "meta": {
    "project": "碳链通 CarbonChain Hub",
    "title": "密码学与联盟链内核真实基准",
    "version": 1,
    "elapsedSec": 82.4,
    "method": "node scripts/bench-crypto.js（对 server/blockchain/ 真实内核施加负载并计时）"
  },
  "environment": {
    "measuredAt": "2026-10-11T04:53:56.395Z",
    "node": "v22.22.2",
    "v8": "12.4.254.21-node.39",
    "openssl": "3.5.5",
    "platform": "win32",
    "arch": "x64",
    "osRelease": "10.0.26200",
    "cpuModel": "13th Gen Intel(R) Core(TM) i7-13650HX",
    "cpuCount": 20,
    "cpuSpeedMHz": 2803,
    "totalMemGB": 23.7,
    "scale": 1,
    "runner": "本地开发机",
    "note": "本基准为**单进程、单线程**测量，未经集群/多核并行优化。数字与硬件、Node 版本、OpenSSL 版本强相关，跨环境不可直接比较绝对值，应比较同一环境下的**套件 A / 套件 B 相对差异**与**数量级**。"
  },
  "gm": {
    "available": true,
    "openssl": "3.5.5",
    "node": "v22.22.2",
    "sm3": true,
    "sm2": true,
    "curve": "SM2",
    "reason": null,
    "standard": "GB/T 32905-2016 / GM/T 0004-2012",
    "source": "GB/T 32905-2016 附录 A 标准测试向量",
    "cases": [
      {
        "msg": "abc",
        "msgBytes": 3,
        "expected": "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0",
        "actual": "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0",
        "pass": true
      },
      {
        "msg": "abcdabcdabcdabcdabcdabcd…",
        "msgBytes": 64,
        "expected": "debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732",
        "actual": "debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732",
        "pass": true
      }
    ],
    "pass": true,
    "checkedAt": "2026-10-11T04:55:18.835Z",
    "conclusion": "SM3 实现与 GB/T 32905-2016 附录 A 官方测试向量**逐位一致**，可判定本平台所用 SM3 为国标合规实现（由 OpenSSL 3.x 提供）。"
  },
  "digest": {
    "payloadBytes": 60,
    "largePayloadBytes": 1048576,
    "rows": [
      {
        "label": "SHA-256（套件 A）",
        "opsPerSec": 1306327,
        "nsPerOp": 765.5,
        "mbPerSec": 74.7
      },
      {
        "label": "SM3（套件 B · 国密）",
        "opsPerSec": 854209,
        "nsPerOp": 1170.7,
        "mbPerSec": 48.9
      }
    ],
    "largeRows": [
      {
        "label": "SHA-256（套件 A）",
        "opsPerSec": 2127,
        "nsPerOp": 470130.5,
        "mbPerSec": 2127.1
      },
      {
        "label": "SM3（套件 B · 国密）",
        "opsPerSec": 306,
        "nsPerOp": 3266642.5,
        "mbPerSec": 306.1
      }
    ]
  },
  "merkle": {
    "treeLeaves": 1000,
    "proofPathNodes": 10,
    "proofPathNodesSm3": 10,
    "roots": [
      {
        "size": 1,
        "sha256": {
          "size": 1,
          "rootMs": 0,
          "rootsPerSec": 12145749
        },
        "sm3": {
          "size": 1,
          "rootMs": 0,
          "rootsPerSec": 1564945
        }
      },
      {
        "size": 10,
        "sha256": {
          "size": 10,
          "rootMs": 0.01,
          "rootsPerSec": 99966
        },
        "sm3": {
          "size": 10,
          "rootMs": 0.03,
          "rootsPerSec": 31316
        }
      },
      {
        "size": 100,
        "sha256": {
          "size": 100,
          "rootMs": 0.08,
          "rootsPerSec": 12017
        },
        "sm3": {
          "size": 100,
          "rootMs": 0.2,
          "rootsPerSec": 5111
        }
      },
      {
        "size": 1000,
        "sha256": {
          "size": 1000,
          "rootMs": 0.79,
          "rootsPerSec": 1266
        },
        "sm3": {
          "size": 1000,
          "rootMs": 1.77,
          "rootsPerSec": 565
        }
      },
      {
        "size": 10000,
        "sha256": {
          "size": 10000,
          "rootMs": 8.49,
          "rootsPerSec": 118
        },
        "sm3": {
          "size": 10000,
          "rootMs": 18.17,
          "rootsPerSec": 55
        }
      }
    ],
    "proof": {
      "sha256": {
        "genMs": 1.54,
        "genPerSec": 650,
        "verifyMs": 0.01,
        "verifyPerSec": 135918,
        "selfCheck": true
      },
      "sm3": {
        "genMs": 3.41,
        "genPerSec": 293,
        "verifyMs": 0.02,
        "verifyPerSec": 56453,
        "selfCheck": true,
        "proofNodes": 10
      }
    },
    "theory": "Merkle 证明路径长度 = ⌈log₂(n)⌉；验证只需重算该路径（O(log n) 次杂凑），与区块内交易总数无关。这使得链下持有原始凭证的一方，可在**不下全链数据**的前提下向任意第三方证明\"这笔碳数据确实被某一区块收录\"，是穿透式验真的密码学基础。"
  },
  "signature": {
    "payloadBytes": 304,
    "suiteA": {
      "curve": "secp256k1",
      "signatureBytes": 71,
      "keygenPerSec": 2665,
      "keygenMs": 0.38,
      "signPerSec": 1889,
      "signMs": 0.53,
      "verifyPerSec": 3889,
      "verifyMs": 0.26,
      "selfCheck": true,
      "tamperRejected": true,
      "address": "0xe1a83a3c78ed3d1ee00b8bd2337333d0ff5906c7"
    },
    "suiteB": {
      "signatureBytes": 71,
      "keygenPerSec": 3066,
      "keygenMs": 0.33,
      "signPerSec": 2099,
      "signMs": 0.48,
      "verifyPerSec": 4189,
      "verifyMs": 0.24,
      "selfCheck": true,
      "tamperRejected": true,
      "address": "0x79605ffc2668157b90d6b7d1b1bb8fbf8f449f39"
    }
  },
  "blockProduction": {
    "txPerBlock": 10,
    "poa": {
      "blocksPerSec": 1823,
      "msPerBlock": 0.55,
      "tps": 18225,
      "verifyMsPerBlock": 0.26,
      "verifyPerSec": 3801,
      "note": "PoA 无挖矿，出块成本 = 1 次 Merkle 建根 + 1 次区块头哈希 + 1 次出块方签名；网络内其余节点各做 1 次签名验签即可确认。"
    },
    "powComparison": [
      {
        "difficulty": 1,
        "avgMineMs": 0.02,
        "avgAttempts": 18,
        "blocksPerSec": 51840.33
      },
      {
        "difficulty": 2,
        "avgMineMs": 0.25,
        "avgAttempts": 228,
        "blocksPerSec": 3929.74
      },
      {
        "difficulty": 3,
        "avgMineMs": 4.85,
        "avgAttempts": 4972,
        "blocksPerSec": 206.05
      },
      {
        "difficulty": 4,
        "avgMineMs": 85.6,
        "avgAttempts": 87518,
        "blocksPerSec": 11.68
      }
    ],
    "powNote": "PoW 即使只有 4 位十六进制前导零（难度 4，即 16⁴ ≈ 65 536 次期望尝试），单块耗时也已比 PoA 高出数个数量级；公有链的\"安全\"以吞吐为代价。联盟链被许可成员均为实名主体，作恶可追责（法律责任 + 成员资格撤销），故以 PoA 换取工业场景所需的吞吐与确定性时延。"
  },
  "chain": {
    "blocks": 1000,
    "txPerBlock": 10,
    "txTotal": 10000,
    "totalSizeBytes": 936890,
    "build": {
      "totalMs": 5959.5,
      "msPerBlock": 5.96,
      "blocksPerSec": 168,
      "tps": 1678
    },
    "verify": {
      "totalMs": 2933.2,
      "msPerBlock": 2.93,
      "blocksPerSec": 341,
      "merkleRecomputed": 1000,
      "proposerSigVerified": 1000,
      "txSigVerified": 10000,
      "txPayloadBindingChecked": 10000,
      "payloadBindingPerSec": 3409,
      "errorsFound": 0,
      "pass": true
    },
    "tamperDetection": {
      "offChainDataTampered": {
        "scenario": "仅改链下 payload 正文（kWh），payloadHash 与区块头均不动",
        "chainOnlyChecks": [],
        "chainOnlyCaught": false,
        "withBindingCheck": [
          "链下重算绑定失配（明文摘要 ≠ 链上锚定摘要）"
        ],
        "withBindingCaught": true,
        "verdict": "仅链上四道校验**全部通过**（漏检）；补上第五道「链下重算绑定」后立即检出。这一对照说明：链上存证必须配套链下重算，否则\"链上没被改\"会被误读为\"数据没被改\"。"
      },
      "blockHeaderTampered": {
        "scenario": "改区块头时间戳（+1 秒），交易与 Merkle 均不动",
        "detected": [
          "区块头哈希不匹配（时间戳被改）",
          "出块签名验签失败"
        ],
        "pass": true
      },
      "txSetTampered": {
        "scenario": "删除区块内一笔交易（试图让某笔存证\"从未发生\"）",
        "detected": [
          "Merkle 根不匹配（交易被删除）"
        ],
        "pass": true
      },
      "onChainAnchorTampered": {
        "scenario": "改链上锚定摘要 payloadHash（试图让链下假数据\"合法化\"）",
        "detected": [
          "交易签名验签失败（锚点被改）"
        ],
        "pass": true,
        "verdict": "改锚点会击穿交易签名 —— 签名内容里含 payloadHash，攻击者无法伪造发起方私钥，因而\"改链上以迁就链下\"这条路被签名封死。（注：txId 由 payloadHash 派生后**作为独立字段存储**，故单独改 payloadHash 不会牵连 txId／Merkle 叶；本基准实测只触发签名失配一项，已如实记录，未夸大为\"多重检出\"。）"
      },
      "conclusion": "四类篡改各自暴露在不同的密码学锚点上，且**互不覆盖**：链下正文 → 链下重算绑定（第五道）；链上锚点 → 交易签名；区块头 → 出块签名 + 区块头哈希；区块内交易集合增删 → Merkle 根。实测不存在\"改了两边都通过\"的组合，且每类均可定位到区块高度与交易序号。"
    }
  },
  "password": {
    "scrypt": {
      "params": "N=16384, r=8, p=1（内存硬，约 16 MiB / 次）",
      "msPerHash": 38.81,
      "hashesPerSec": 25.8,
      "offLineCostNote": "单次约十几到几十毫秒，对交互式登录无感；但对离线爆破，每次尝试都要付出同样的时间与内存代价，配合随机盐使彩虹表与批量字典攻击失效。"
    },
    "legacySha256": {
      "msPerHash": 0,
      "hashesPerSec": 1321926
    },
    "randomSalt": {
      "bytes": 16,
      "perSec": 718584
    },
    "upgradePolicy": "verifyPassword 对历史 SHA256 摘要返回 legacy=true，登录成功后自动升级为 scrypt，存量数据可无感迁移，无需停机改密。"
  }
};
})(typeof window !== 'undefined' ? window : globalThis);
