/* 检查跨文件顶层变量重名

   本项目的 JS 都是"经典脚本"（非 ES Module），共享同一个全局词法作用域。
   如果两个文件用 let/const/var 声明同名变量，后加载的那个文件会
   整份解析失败（SyntaxError: Identifier 'x' has already been declared），
   应用直接无法启动 —— 而且这个报错很隐蔽，表现为"白屏/没反应"。

   这个坑真实发生过：reader.js 里的 currentPage 与 app.js 的 currentPage 冲突，
   导致 app.js 整份失效、数据库连接为空。 */
const fs = require('fs');
const path = require('path');

// 必须与 index.html 里的 <script> 顺序一致
const ORDER = ['storage.js', 'parser.js', 'shelf.js', 'reader.js', 'app.js'];
const root = __dirname;

console.log('=== 跨文件顶层变量重名检查 ===');
console.log('加载顺序: ' + ORDER.join(' → '));

const decls = new Map();   // name -> [{file, kind, line}]

for (const file of ORDER) {
  const src = fs.readFileSync(path.join(root, 'js', file), 'utf8');
  src.split('\n').forEach((l, i) => {
    // 只取顶层声明（行首无缩进）
    const m = l.match(/^(let|const|var)\s+([A-Za-z_$][\w$]*)/);
    if (!m) return;
    const name = m[2];
    if (!decls.has(name)) decls.set(name, []);
    decls.get(name).push({ file, kind: m[1], line: i + 1 });
  });
}

console.log('顶层变量总数: ' + decls.size + '\n');

let varConflicts = 0;
for (const [name, list] of [...decls.entries()].sort()) {
  const fileSet = new Set(list.map(d => d.file));
  if (fileSet.size <= 1) continue;   // 同一文件内重复由 JS 引擎自己报错
  console.log(`  [冲突] "${name}" 在多个文件中声明:`);
  list.forEach(d => console.log(`         ${d.file}:${d.line}  (${d.kind})`));
  console.log('         → 后加载的文件会整份解析失败，应用无法启动！');
  varConflicts++;
}

console.log(varConflicts === 0
  ? '  ✓ 未发现跨文件顶层变量重名'
  : `  ✗ 发现 ${varConflicts} 处冲突，必须修复`);

// 附带检查：函数重名（会被静默覆盖，更不易察觉）
console.log('\n=== 跨文件函数重名检查 ===');
const fnDecls = new Map();
for (const file of ORDER) {
  const src = fs.readFileSync(path.join(root, 'js', file), 'utf8');
  src.split('\n').forEach((l, i) => {
    const m = l.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (!m) return;
    if (!fnDecls.has(m[1])) fnDecls.set(m[1], []);
    fnDecls.get(m[1]).push({ file, line: i + 1 });
  });
}

let fnConflicts = 0;
for (const [name, list] of [...fnDecls.entries()].sort()) {
  const fileSet = new Set(list.map(d => d.file));
  if (fileSet.size <= 1) continue;
  console.log(`  [重名] ${name}():`);
  list.forEach(d => console.log(`         ${d.file}:${d.line}`));
  console.log('         → 后者会静默覆盖前者');
  fnConflicts++;
}
console.log(fnConflicts === 0
  ? '  ✓ 未发现跨文件函数重名'
  : `  ✗ 发现 ${fnConflicts} 处重名`);

// 附带检查：**同一文件内**的函数重名
// 函数声明重复不会报错，后者静默覆盖前者，非常隐蔽（真实踩过：
// reader.js 里两次定义 swipeJustHandled()，一次改名只改了其中一处，
// 结果旧的实现一直生效，导致"滑动后点击被吞掉"）。
console.log('\n=== 同一文件内函数重名检查 ===');
let sameFileDup = 0;
for (const file of ORDER) {
  const src = fs.readFileSync(path.join(root, 'js', file), 'utf8');
  const seen = new Map();
  src.split('\n').forEach((l, i) => {
    const m = l.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (!m) return;
    const name = m[1];
    if (!seen.has(name)) seen.set(name, []);
    seen.get(name).push(i + 1);
  });
  for (const [name, linesAt] of seen) {
    if (linesAt.length > 1) {
      console.log(`  [重复] ${file} 里的 ${name}() 定义了 ${linesAt.length} 次，行号: ${linesAt.join(', ')}`);
      console.log('         → 只有最后一份生效，前面的被静默覆盖');
      sameFileDup++;
    }
  }
}
console.log(sameFileDup === 0
  ? '  ✓ 未发现同文件内函数重复定义'
  : `  ✗ 发现 ${sameFileDup} 处重复`);

// 附带检查：顶层变量与 function 同名（同样会互相干扰）
console.log('\n=== 顶层变量与函数同名检查 ===');
let mixed = 0;
for (const [name, list] of decls) {
  if (fnDecls.has(name)) {
    console.log(`  [冲突] "${name}" 既是变量又是函数:`);
    list.forEach(d => console.log(`         ${d.file}:${d.line} 变量`));
    fnDecls.get(name).forEach(d => console.log(`         ${d.file}:${d.line} 函数`));
    mixed++;
  }
}
console.log(mixed === 0 ? '  ✓ 无此情况' : `  ✗ 发现 ${mixed} 处`);

const bad = varConflicts + fnConflicts + mixed + sameFileDup;
process.exit(bad === 0 ? 0 : 1);