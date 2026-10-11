/* =====================================================================
   sm3.js —— 国密 SM3 杂凑算法（纯 JS · 浏览器侧 · GB/T 32905-2016）
   ---------------------------------------------------------------------
   背景：Node 端的 SM3 由 OpenSSL 3.x 内置提供（见 server/blockchain/gm-crypto.js
   与 public/js/data/bench.js 的官方测试向量复测），但浏览器没有原生 SM3。
   本文件为前端提供一个**合规的纯 JS SM3 实现**，使 CEMS 报文指纹能在浏览器侧
   现场计算并展示（与链上锚定时用的服务端 SM3 同算法、同口径）。

   实现严格按 GB/T 32905-2016：
     · 报文按 512-bit 分组，末段补 1 + 0 串 + 64-bit 长度
     · 初始值 IV = 7380166F 4914B2B9 172442D7 DA8A0600 A96F30BC 163138AA E38DEE4D B0FB0E4E
     · 常量 T_j：j<16 用 79CC4519，j≥16 用 7A879D8A
     · 压缩函数 CF，输出 256-bit（32 字节）
   自测：SM3('abc') 必须等于 66c7f0f4 62eeedd9 d1f2d46b dc10e4e2 4167c487 5cf2f7a2 297da02b 8f4ba8e0
   （GB/T 32905-2016 附录 A 官方向量，与 server 端 OpenSSL SM3 逐位一致）
   ===================================================================== */
(function (global) {
  'use strict';

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }

  // 初始值
  const IV = [0x7380166F, 0x4914B2B9, 0x172442D7, 0xDA8A0600,
              0xA96F30BC, 0x163138AA, 0xE38DEE4D, 0xB0FB0E4E];
  function Tj(j) { return j < 16 ? 0x79CC4519 : 0x7A879D8A; }
  function FF(j, x, y, z) { return j < 16 ? (x ^ y ^ z) : ((x & y) | (x & z) | (y & z)); }
  function GG(j, x, y, z) { return j < 16 ? (x ^ y ^ z) : ((x & y) | (~x & z)); }
  function P0(x) { return x ^ rotl(x, 9) ^ rotl(x, 17); }
  function P1(x) { return x ^ rotl(x, 15) ^ rotl(x, 23); }

  // UTF-8 编码（浏览器 TextEncoder 优先）
  function utf8(str) {
    if (global.TextEncoder) return new TextEncoder().encode(str);
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
    }
    return Uint8Array.from(out);
  }

  // 填充：1 比特 + 0 串 + 64-bit 长度（bit 数）
  function pad(msg) {
    const len = msg.length;
    const bitLen = len * 8;
    const groups = Math.floor((len + 9) / 64) + 1; // 至少补 1 组
    const buf = new Uint8Array(groups * 64);
    buf.set(msg);
    buf[len] = 0x80;
    // 64-bit 大端长度（仅低 32 位有效，报文 < 512MB）
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    buf[buf.length - 8] = (hi >>> 24) & 0xFF;
    buf[buf.length - 7] = (hi >>> 16) & 0xFF;
    buf[buf.length - 6] = (hi >>> 8) & 0xFF;
    buf[buf.length - 5] = hi & 0xFF;
    buf[buf.length - 4] = (lo >>> 24) & 0xFF;
    buf[buf.length - 3] = (lo >>> 16) & 0xFF;
    buf[buf.length - 2] = (lo >>> 8) & 0xFF;
    buf[buf.length - 1] = lo & 0xFF;
    return buf;
  }

  // 消息扩展 + 压缩（单组 512-bit）
  function cf(V, blk) {
    const W = new Uint32Array(68);
    const Wp = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      W[i] = (blk[i * 4] << 24) | (blk[i * 4 + 1] << 16) | (blk[i * 4 + 2] << 8) | blk[i * 4 + 3];
    }
    for (let j = 16; j < 68; j++) {
      W[j] = (P1(W[j - 16] ^ W[j - 9] ^ rotl(W[j - 3], 15)) ^ rotl(W[j - 13], 7) ^ W[j - 6]) >>> 0;
    }
    for (let j = 0; j < 64; j++) Wp[j] = (W[j] ^ W[j + 4]) >>> 0;

    let A = V[0], B = V[1], C = V[2], D = V[3];
    let E = V[4], F = V[5], G = V[6], H = V[7];
    for (let j = 0; j < 64; j++) {
      const ss1 = rotl(((rotl(A, 12) + E + rotl(Tj(j), j % 32)) >>> 0), 7);
      const ss2 = (ss1 ^ rotl(A, 12)) >>> 0;
      const tt1 = (FF(j, A, B, C) + D + ss2 + Wp[j]) >>> 0;
      const tt2 = (GG(j, E, F, G) + H + ss1 + W[j]) >>> 0;
      D = C; C = rotl(B, 9); B = A; A = tt1;
      H = G; G = rotl(F, 19); F = E; E = P0(tt2);
      A >>>= 0; B >>>= 0; C >>>= 0; D >>>= 0; E >>>= 0; F >>>= 0; G >>>= 0; H >>>= 0;
    }
    return [A ^ V[0], B ^ V[1], C ^ V[2], D ^ V[3],
            E ^ V[4], F ^ V[5], G ^ V[6], H ^ V[7]];
  }

  function toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  /** SM3(msg) → 64 位小写十六进制摘要 */
  function sm3(msg) {
    const data = typeof msg === 'string' ? utf8(msg) : msg;
    const buf = pad(data);
    let V = IV.slice();
    for (let off = 0; off < buf.length; off += 64) {
      V = cf(V, buf.subarray(off, off + 64));
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (V[i] >>> 24) & 0xFF;
      out[i * 4 + 1] = (V[i] >>> 16) & 0xFF;
      out[i * 4 + 2] = (V[i] >>> 8) & 0xFF;
      out[i * 4 + 3] = V[i] & 0xFF;
    }
    return toHex(out);
  }

  /** SM3(msg) → 32 字节 Uint8Array（供 HMAC 等场景使用） */
  function sm3Bytes(msg) {
    const hex = sm3(msg);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // 自测：GB/T 32905-2016 附录 A 官方向量
  const _VEC_ABC = '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0';
  const _selfOk = sm3('abc') === _VEC_ABC;

  global.App = global.App || {};
  global.App.SM3 = { sm3, sm3Bytes, selfTest: _selfOk, vector: _VEC_ABC };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.App.SM3;
})(typeof window !== 'undefined' ? window : globalThis);
