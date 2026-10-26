/* 校验所有交付文本文件是合法 UTF-8，且无 BOM */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const targets = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.npmcache') continue;
      walk(p);
    } else {
      targets.push(p);
    }
  }
}
walk(root);

const textExt = new Set(['.html', '.js', '.css', '.json', '.md', '.bat', '.txt']);
const decoder = new TextDecoder('utf-8', { fatal: true });

let bad = 0, bom = 0, okCount = 0;

console.log('=== UTF-8 与 BOM 校验 ===');
for (const p of targets.sort()) {
  const ext = path.extname(p).toLowerCase();
  if (!textExt.has(ext)) continue;

  const buf = fs.readFileSync(p);
  const rel = path.relative(root, p);

  let utf8ok = true;
  try {
    decoder.decode(buf);
  } catch (e) {
    utf8ok = false;
  }

  const hasBOM = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;

  if (!utf8ok) {
    console.log(`  [BAD-UTF8] ${rel}`);
    bad++;
  } else if (hasBOM) {
    console.log(`  [BOM]      ${rel}  (建议去除，部分解析器会出问题)`);
    bom++;
  } else {
    okCount++;
  }
}
console.log(`\n合法 UTF-8 且无 BOM: ${okCount} 个`);
if (bad) console.log(`非法 UTF-8: ${bad} 个`);
if (bom) console.log(`含 BOM: ${bom} 个`);

// 关键文件内容抽查
console.log('\n=== 关键内容抽查（中文是否正确） ===');
const samples = {
  'manifest.json': /"name":\s*"纯净阅读"/,
  'index.html': /<title>纯净阅读<\/title>/,
  'README.md': /纯净阅读/,
  'sw.js': /缓存/,
  'js/parser.js': /第一章|智能分章/,
  'start-server.bat': /纯净阅读/,
};
for (const [f, re] of Object.entries(samples)) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { console.log(`  [缺失] ${f}`); continue; }
  const s = fs.readFileSync(p, 'utf8');
  console.log(`  ${re.test(s) ? '[OK]  ' : '[WARN]'} ${f}`);
}

// ===== .bat 文件必须使用 CRLF 行尾 =====
// cmd.exe 无法正确解析 LF-only 的批处理文件，
// 典型症状是"双击后窗口闪一下就关闭"。写文件时务必保持 CRLF。
console.log('\n=== .bat 行尾格式（cmd.exe 要求 CRLF） ===');
const bats = targets.filter(p => path.extname(p).toLowerCase() === '.bat');
let batBad = 0;
for (const p of bats) {
  const b = fs.readFileSync(p);
  let crlfN = 0, lfOnly = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0D && b[i + 1] === 0x0A) crlfN++;
    else if (b[i] === 0x0A && b[i - 1] !== 0x0D) lfOnly++;
  }
  const rel = path.relative(root, p);
  if (lfOnly > 0) {
    console.log(`  [FAIL] ${rel}  有 ${lfOnly} 个 LF-only 换行 → cmd 会闪退！`);
    batBad++;
  } else {
    console.log(`  [OK]   ${rel}  CRLF=${crlfN}, LF-only=0`);
  }
}
if (bats.length === 0) console.log('  (未找到 .bat 文件)');

process.exit(bad === 0 && batBad === 0 ? 0 : 1);