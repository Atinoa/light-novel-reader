// txt-decoder.js
// 主进程 TXT 编码检测与解码。
// 仅依赖 iconv-lite（纯 JS，可被 electron-builder 打入 asar），不依赖 Electron，
// 因此可以用 node 直接做单元测试。
//
// 检测策略：
//   1) 优先看 BOM：UTF-8(BOM) / UTF-16 LE(BOM) / UTF-16 BE(BOM)
//   2) 无 BOM 时：
//      - 先做“无 BOM UTF-16”启发式（大量 0x00 字节，判断奇偶位）
//      - 再用 TextDecoder 的 fatal 模式严格校验是否为合法 UTF-8
//      - 都不是则回退 GB18030（兼容 GBK），标记 uncertain
//   3) 手动指定编码时直接按指定编码解码（用于乱码重试）

import iconv from 'iconv-lite';

export const SUPPORTED_ENCODINGS = [
  { id: 'auto', label: '自动检测' },
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
  { id: 'gbk', label: 'GBK' },
  { id: 'gb18030', label: 'GB18030' },
  { id: 'big5', label: 'Big5' }
];

const VALID = new Set(SUPPORTED_ENCODINGS.map((e) => e.id));

// 无 BOM 时用严格 UTF-8 校验，避免把 GBK 误判为 UTF-8。
// 注意：调用方传进来的可能只是文件头部切片（64KB），最后 1~3 个字节
// 可能刚好把某个多字节字符切断，导致合法 UTF-8 被误判成 GB18030。
// 因此先最多回退 3 个字节再校验（GBK 的非法字节遍布全文，回退结尾无济于事，
// 不会把它误判成 UTF-8）。
function isStrictUtf8(buf) {
  for (let cut = 0; cut <= Math.min(3, buf.length); cut++) {
    const slice = cut ? buf.subarray(0, buf.length - cut) : buf;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(slice);
      return true;
    } catch (e) {
      // 继续回退重试
    }
  }
  return false;
}

// 无 BOM UTF-16 启发式：ASCII 字符的高字节为 0。
// LE 时 0 出现在奇数位，BE 时出现在偶数位。
function heuristicUtf16(buf) {
  const n = Math.min(buf.length, 4096);
  if (n < 16) return null;
  let evenNull = 0;
  let oddNull = 0;
  let nulls = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      nulls++;
      if (i % 2 === 0) evenNull++;
      else oddNull++;
    }
  }
  if (nulls / n < 0.15) return null;
  if (oddNull > evenNull * 2) return 'utf-16le';
  if (evenNull > oddNull * 2) return 'utf-16be';
  return null;
}

// 检测编码：返回 { encoding, bomLength, uncertain }
export function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', bomLength: 3, uncertain: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16le', bomLength: 2, uncertain: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', bomLength: 2, uncertain: false };
  }
  const u16 = heuristicUtf16(buf);
  if (u16) return { encoding: u16, bomLength: 0, uncertain: true };
  if (isStrictUtf8(buf)) return { encoding: 'utf-8', bomLength: 0, uncertain: false };
  // 中文 TXT 最常见的非 UTF-8 编码，GB18030 向下兼容 GBK
  return { encoding: 'gb18030', bomLength: 0, uncertain: true };
}

// 统一切换行、去掉 BOM 与开头空白
export function normalizeText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^[\s\u3000]+/, '');
}

// 解码：forcedEncoding 为空或 'auto' 时自动检测
export function decodeBuffer(buf, forcedEncoding) {
  let encoding = forcedEncoding;
  let bomLength = 0;
  let uncertain = false;

  if (!encoding || encoding === 'auto') {
    const d = detectEncoding(buf);
    encoding = d.encoding;
    bomLength = d.bomLength;
    uncertain = d.uncertain;
  } else {
    if (!VALID.has(encoding)) encoding = 'gb18030';
    // 手动指定编码时，若文件确实带对应 BOM，跳过 BOM
    if (encoding === 'utf-8' && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bomLength = 3;
    if (encoding === 'utf-16le' && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) bomLength = 2;
    if (encoding === 'utf-16be' && buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) bomLength = 2;
  }

  const body = bomLength ? buf.subarray(bomLength) : buf;
  let text;
  try {
    if (encoding === 'utf-8') {
      text = new TextDecoder('utf-8', { fatal: false }).decode(body);
    } else {
      text = iconv.decode(body, encoding);
    }
  } catch (e) {
    // 兜底：GB18030 解码，尽量避免直接失败
    text = iconv.decode(body, 'gb18030');
    encoding = 'gb18030';
    uncertain = true;
  }

  return { text: normalizeText(text), encoding, uncertain };
}
