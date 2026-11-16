// txt-parser.js
// TXT 章节解析器（纯文本，无 DOM 依赖，可在 Node 中单元测试）。
//
// 目标：
//   1) 基于正则识别常见章节标题行（第X章/节/回/卷/话，Chapter X，序章/楔子/番外 等）
//   2) 用「整行较短、单独成行、不以标点结尾、章节标记后必须有分隔」约束避免误判正文
//   3) 记录每章起始字符偏移量，供目录跳转 / 进度 / 书签使用
//   4) 识别不到章节时，按固定字符数切分虚拟分节，保证目录与进度可用
//
// 挂载到 window.TxtParser（浏览器）或 globalThis.TxtParser（Node 测试）。

(function (root) {
  'use strict';

  // 中文数字 + 阿拉伯数字（含全角）
  const NUM = '0-9０-９一二三四五六七八九十百千万亿零〇两壹贰叁肆伍陆柒捌玖拾佰仟';
  // 章节标记之后必须是空白、冒号/顿号/分隔符或行尾，避免把「第三章开始了…」误判为标题
  const SEP = '(?:\\s|[:：、·\\-—]|$)';

  const RE_CN_CHAPTER = new RegExp(`^第[${NUM}]+[章节回卷话集部篇幕]${SEP}`);
  const RE_CN_VOLUME = new RegExp(`^卷[${NUM}]+${SEP}`);
  const RE_EN_CHAPTER = new RegExp(`^chapter\\s*[0-9ivxlcdm]+${SEP}`, 'i');
  const RE_SPECIAL = new RegExp(`^(序章|序言|楔子|前言|引子|后记|终章|尾声|番外|外传|附录|结局)${SEP}`);

  // 判断某一行是否像章节标题
  function isHeadingLine(line) {
    const t = String(line == null ? '' : line).trim();
    if (!t) return false;
    if (t.length > 40) return false;              // 标题应短小
    if (/[。！？；]/.test(t)) return false;         // 正文句式常见的终止标点
    if (/[，。！？；、：:;!?,]$/.test(t)) return false; // 不以标点结尾
    return RE_CN_CHAPTER.test(t) || RE_CN_VOLUME.test(t) || RE_EN_CHAPTER.test(t) || RE_SPECIAL.test(t);
  }

  // 解析全文，返回 { chapters, synthetic }
  // chapters: [{ title, offset, end, synthetic }]
  function parse(text, options) {
    const src = String(text || '');
    const len = src.length;
    const sectionSize = (options && options.sectionSize) || 5000;
    const chapters = [];
    let pos = 0;
    let firstHeadingAt = -1;

    // 逐行扫描（用 indexOf 而非 split，避免大文件产生大量临时数组）
    while (pos < len) {
      let nl = src.indexOf('\n', pos);
      if (nl === -1) nl = len;
      const line = src.slice(pos, nl);
      if (isHeadingLine(line)) {
        if (firstHeadingAt === -1) firstHeadingAt = pos;
        chapters.push({ title: line.trim(), offset: pos, end: len, synthetic: false });
      }
      pos = nl + 1;
      if (nl === len) break;
    }

    // 识别不到章节：按固定字符数切分虚拟分节
    if (!chapters.length) {
      for (let s = 0; s < len; s += sectionSize) {
        chapters.push({
          title: `分节 ${Math.floor(s / sectionSize) + 1}`,
          offset: s,
          end: Math.min(len, s + sectionSize),
          synthetic: true
        });
      }
      if (!chapters.length) {
        chapters.push({ title: '全文', offset: 0, end: len, synthetic: true });
      }
      return { chapters, synthetic: true };
    }

    // 首个标题之前若有正文，补一个「开篇」章节
    if (firstHeadingAt > 0 && src.slice(0, firstHeadingAt).trim()) {
      chapters.unshift({ title: '开篇', offset: 0, end: firstHeadingAt, synthetic: false });
    }

    // 计算每章结束位置（下一章起点或全文结尾）
    for (let i = 0; i < chapters.length; i++) {
      chapters[i].end = i + 1 < chapters.length ? chapters[i + 1].offset : len;
    }
    return { chapters, synthetic: false };
  }

  // 二分查找某个字符偏移量所属章节
  function findChapterIndex(chapters, offset) {
    if (!chapters || !chapters.length) return 0;
    let lo = 0;
    let hi = chapters.length - 1;
    let ans = 0;
    const target = Math.max(0, Number(offset) || 0);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chapters[mid].offset <= target) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  root.TxtParser = { isHeadingLine, parse, findChapterIndex };
})(typeof window !== 'undefined' ? window : globalThis);
