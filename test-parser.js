/* 核心解析逻辑测试（Node 环境，模拟浏览器 API） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const parserSrc = fs.readFileSync(
  path.join(__dirname, 'js', 'parser.js'), 'utf8'
);
const shelfSrc = fs.readFileSync(
  path.join(__dirname, 'js', 'shelf.js'), 'utf8'
);

// 在沙箱中执行 parser.js + shelf.js，注入必要的桩
const sandbox = {
  console,
  JSZip: {},
  pdfjsLib: {},
  mammoth: {},
  window: {},
  URL,
  Blob: class {},
  File: class {},
  TextDecoder,
  // escapeHtml 需要的最小 document 桩
  document: {
    createElement: () => ({
      _t: '',
      set textContent(v) { this._t = v; },
      get textContent() { return this._t; },
      get innerHTML() {
        return String(this._t)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      },
    }),
  },
};
vm.createContext(sandbox);
vm.runInContext(parserSrc, sandbox);
vm.runInContext(shelfSrc, sandbox);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  [PASS] ${name}`); pass++; }
  else { console.log(`  [FAIL] ${name}${extra ? ' -> ' + extra : ''}`); fail++; }
}

console.log('\n=== 1. 文件格式识别 ===');
check('txt',   sandbox.getFileFormat('a.txt') === 'txt');
check('TXT大写', sandbox.getFileFormat('A.TXT') === 'txt');
check('epub',  sandbox.getFileFormat('a.epub') === 'epub');
check('pdf',   sandbox.getFileFormat('a.pdf') === 'pdf');
check('docx',  sandbox.getFileFormat('a.docx') === 'docx');
check('mobi',  sandbox.getFileFormat('a.mobi') === 'mobi');
check('azw3',  sandbox.getFileFormat('a.azw3') === 'mobi');
check('zip',   sandbox.getFileFormat('a.zip') === 'zip');
check('未知扩展名', sandbox.getFileFormat('a.xyz') === 'unknown');
check('无扩展名', sandbox.getFileFormat('README') === 'unknown');

console.log('\n=== 2. 是否可阅读 ===');
check('txt 可读',   sandbox.isSupportedFormat('a.txt') === true);
check('epub 可读',  sandbox.isSupportedFormat('a.epub') === true);
check('pdf 可读',   sandbox.isSupportedFormat('a.pdf') === true);
check('docx 可读',  sandbox.isSupportedFormat('a.docx') === true);
check('zip 不可直读', sandbox.isSupportedFormat('a.zip') === false);
check('mobi 当前不可读', sandbox.isSupportedFormat('a.mobi') === false);

console.log('\n=== 3. 书名提取 ===');
check('去扩展名', sandbox.extractTitle('三体.epub') === '三体', sandbox.extractTitle('三体.epub'));
check('去站点标记', sandbox.extractTitle('【精校版】三体.txt') === '三体', sandbox.extractTitle('【精校版】三体.txt'));
check('去括号', sandbox.extractTitle('三体（全集）.txt') === '三体', sandbox.extractTitle('三体（全集）.txt'));
check('去作者后缀', sandbox.extractTitle('三体_作者刘慈欣.txt') === '三体', sandbox.extractTitle('三体_作者刘慈欣.txt'));
check('普通名不变', sandbox.extractTitle('活着.txt') === '活着', sandbox.extractTitle('活着.txt'));

console.log('\n=== 4. TXT 分章（中文数字） ===');
const novel = [
  '第一章 初入江湖',
  '少年提剑出山，风雪漫天。',
  '他不知前路几何。',
  '第二章 客栈夜话',
  '灯下对饮，话说当年。',
  '第三章 别离',
  '长亭外，古道边。',
].join('\n');

const mockTxt = { text: async () => novel };

(async () => {
  const r = await sandbox.parseTxt(mockTxt);
  check('识别出 3 章', r.chapters.length === 3, `实际 ${r.chapters.length}`);
  check('第 1 章标题正确', /第一章/.test(r.chapters[0].title), r.chapters[0].title);
  check('第 2 章标题正确', /第二章/.test(r.chapters[1].title), r.chapters[1].title);
  check('第 3 章标题正确', /第三章/.test(r.chapters[2].title), r.chapters[2].title);
  check('第 1 章含正文', r.chapters[0].content.includes('少年提剑出山'));
  check('第 2 章含正文', r.chapters[1].content.includes('灯下对饮'));
  check('总字数统计', r.totalLength === novel.length, `${r.totalLength} vs ${novel.length}`);

  console.log('\n=== 5. 无章节的纯文本 ===');
  const plain = '这是一段没有任何章节标记的文字。\n第二行。\n第三行。';
  const r2 = await sandbox.parseTxt({ text: async () => plain });
  check('降级为单章', r2.chapters.length === 1, `实际 ${r2.chapters.length}`);
  check('单章标题为正文', r2.chapters[0].title === '正文', r2.chapters[0].title);
  check('内容完整保留', r2.chapters[0].content === plain);

  console.log('\n=== 6. 阿拉伯数字章节 + 英文章节 ===');
  const mixed = '第1章 起点\n内容甲\n第2章 转折\n内容乙';
  const r3 = await sandbox.parseTxt({ text: async () => mixed });
  check('阿拉伯数字分章', r3.chapters.length === 2, `实际 ${r3.chapters.length}`);

  const eng = 'Chapter 1\nHello world\nChapter 2\nGoodbye';
  const r4 = await sandbox.parseTxt({ text: async () => eng });
  check('英文章节分章', r4.chapters.length === 2, `实际 ${r4.chapters.length}`);

  console.log('\n=== 7. HTML 转义（XSS 防护） ===');
  const esc = sandbox.escapeHtml('<script>alert(1)</script>');
  check('尖括号被转义', !esc.includes('<script>'), esc);
  check('引号被转义', sandbox.escapeHtml('"a"').includes('&quot;'));
  check('单引号也转义', sandbox.escapeHtml("it's").includes('&#39;'));
  check('null 不抛异常', sandbox.escapeHtml(null) === '');
  check('数字输入可用', sandbox.escapeHtml(42) === '42');

  console.log('\n=== 8. 大文件无章节标记时的自动分块 ===');
  // 这是真实踩过的坑：一本 1.9MB、没有"第N章"标记的网文，
  // 旧实现把整本当成 1 章 → 渲染时生成 6 万个 <p> → 手机排版卡死。
  const bigPlain = Array(20000).fill('这是一段没有任何章节标记的正文内容。').join('\n');
  const rb = await sandbox.parseTxt({ text: async () => bigPlain });
  check('大文件被切成多块而不是单章', rb.chapters.length > 1, `实际 ${rb.chapters.length} 章`);
  check('每块都不超过单章上限',
    rb.chapters.every(c => c.content.length <= 30000 + 200),
    '最大 ' + Math.max(...rb.chapters.map(c => c.content.length)));
  check('分块后内容总长基本不丢',
    Math.abs(rb.chapters.reduce((s, c) => s + c.content.length, 0) - bigPlain.length) < 1000,
    `${rb.chapters.reduce((s, c) => s + c.content.length, 0)} vs ${bigPlain.length}`);
  check('分块标题可读', /部分/.test(rb.chapters[0].title), rb.chapters[0].title);
  check('分块索引连续', rb.chapters.every((c, i) => c.index === i));

  console.log('\n=== 9. 单章异常大时也会再切分 ===');
  // 全书只有一个章节标记，后面全是正文 → 那一章会非常大
  const oneMarker = '第一章 开始\n' + Array(20000).fill('正文内容正文内容正文内容。').join('\n');
  const r5 = await sandbox.parseTxt({ text: async () => oneMarker });
  check('超大章节被再切分', r5.chapters.length > 1, `实际 ${r5.chapters.length} 章`);
  check('后续块标题带"续"', /续/.test(r5.chapters[1].title), r5.chapters[1].title);

  console.log('\n=== 10. 文本编码自动识别（乱码问题） ===');
  // Node 没有 GBK 编码器，用 gb18030 解码器暴力反查出一张编码表
  function buildGbkEncoder() {
    const decoder = new TextDecoder('gb18030');
    const map = new Map();
    for (let b1 = 0x81; b1 <= 0xFE; b1++) {
      for (let b2 = 0x40; b2 <= 0xFE; b2++) {
        if (b2 === 0x7F) continue;
        let ch;
        try { ch = decoder.decode(new Uint8Array([b1, b2])); } catch (e) { continue; }
        if (ch.length === 1 && !map.has(ch)) map.set(ch, [b1, b2]);
      }
    }
    return map;
  }
  const GBK_ENCODE = buildGbkEncoder();
  const gbkBytes = (str) => {
    const out = [];
    for (const ch of str) {
      if (ch === '\n') { out.push(0x0A); continue; }
      if (ch.charCodeAt(0) < 128) { out.push(ch.charCodeAt(0)); continue; }
      const b = GBK_ENCODE.get(ch);
      if (!b) throw new Error('无法编码: ' + ch);
      out.push(b[0], b[1]);
    }
    return new Uint8Array(out).buffer;
  };

  const sentence = '第一章 中文测试\n这是一段正常的正文内容。';

  const rUtf8 = sandbox.decodeTextBuffer(new TextEncoder().encode(sentence).buffer);
  check('UTF-8 识别正确', rUtf8.encoding === 'utf-8', rUtf8.encoding);
  check('UTF-8 内容正确', rUtf8.text === sentence, JSON.stringify(rUtf8.text.slice(0, 12)));

  const rGbk = sandbox.decodeTextBuffer(gbkBytes(sentence));
  check('【核心】GBK 被识别为 gb18030', rGbk.encoding === 'gb18030', rGbk.encoding);
  check('【核心】GBK 解码为通顺中文', rGbk.text === sentence, JSON.stringify(rGbk.text.slice(0, 16)));
  check('GBK 解码无替换字符', !rGbk.text.includes('\uFFFD'));

  // 对照：老办法（一律 UTF-8）确实会乱码
  const naive = new TextDecoder('utf-8').decode(new Uint8Array(gbkBytes(sentence)));
  check('对照：同一份 GBK 按 UTF-8 解会乱码', naive.includes('\uFFFD'), JSON.stringify(naive.slice(0, 12)));

  // BOM
  const utf8Bom = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('第一章 带BOM')]).buffer;
  const rBom = sandbox.decodeTextBuffer(utf8Bom);
  check('UTF-8 BOM 被识别并剥离',
    rBom.encoding === 'utf-8(BOM)' && rBom.text === '第一章 带BOM' && !rBom.text.includes('\uFEFF'),
    rBom.encoding);

  const u16 = [0xFF, 0xFE];
  for (const ch of '第一章 中文') { const c = ch.charCodeAt(0); u16.push(c & 0xFF, c >> 8); }
  const r16 = sandbox.decodeTextBuffer(new Uint8Array(u16).buffer);
  check('UTF-16LE BOM 被识别', r16.encoding === 'utf-16le' && r16.text.includes('第一章 中文'), r16.encoding);

  const rAscii = sandbox.decodeTextBuffer(new TextEncoder().encode('Chapter 1\nHello').buffer);
  check('纯英文识别为 utf-8', rAscii.encoding === 'utf-8');

  console.log('\n=== 11. 编码识别接进 parseTxt ===');
  const gbkFile = {
    arrayBuffer: async () => gbkBytes('第一章 起点\n正文内容正常。\n第二章 转折\n继续正常。')
  };
  const rp = await sandbox.parseTxt(gbkFile);
  check('parseTxt 报出识别到的编码', rp.encoding === 'gb18030', rp.encoding);
  check('分章正确（2 章）', rp.chapters.length === 2, rp.chapters.length);
  check('章节标题是中文而非乱码', /起点/.test(rp.chapters[0].title), rp.chapters[0].title);
  check('正文无替换字符', !rp.chapters[0].content.includes('\uFFFD'));

  console.log(`\n========================================`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`========================================\n`);
  process.exit(fail === 0 ? 0 : 1);
})();