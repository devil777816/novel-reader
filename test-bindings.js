/* 精确扫描：查找"绑定到已存在固定元素"且前面有提前 return 的隐患 */
const fs = require('fs');
const files = ['app.js', 'storage.js', 'parser.js', 'shelf.js', 'reader.js'];

let real = 0, checked = 0;

for (const f of files) {
  const lines = fs.readFileSync('js/' + f, 'utf8').split('\n');

  // 找出顶层函数定义（缩进为 0 的 function）
  const fns = [];
  lines.forEach((l, i) => {
    const m = l.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (m) fns.push({ name: m[1], line: i });
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) continue;

    // 只看"绑定到 document.getElementById(...) 这种固定元素"的写法
    const m = line.match(/document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*addEventListener/);
    if (!m) continue;

    // 属于哪个顶层函数
    let owner = null;
    for (const fn of fns) if (fn.line < i) owner = fn;
    if (!owner) continue;

    // 在函数开头到该绑定之间，找"顶层缩进"的 return（排除嵌套在回调里的）
    const ownerIndent = 0;
    let earlyReturn = null;
    for (let j = owner.line + 1; j < i; j++) {
      const l = lines[j];
      // 顶层 return：以 2 或 4 个空格缩进开头且直接是 return 语句
      const rm = l.match(/^(\s{2,4})return\b/);
      if (!rm) continue;
      // 判断它是否位于某个箭头函数/回调内部：粗略检查其前面最近的未闭合左括号
      const before = lines.slice(owner.line, j).join('\n');
      const depth = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
      if (depth <= 1) { earlyReturn = { line: j + 1, text: l.trim() }; break; }
    }

    checked++;
    const el = m[1];
    if (earlyReturn) {
      console.log(`  [隐患] ${f}  ${owner.name}()  第 ${i + 1} 行绑定 #${el}`);
      console.log(`         该函数在第 ${earlyReturn.line} 行有提前 return: ${earlyReturn.text}`);
      console.log(`         → 若走到 return，此元素将不会被绑定事件`);
      real++;
    }
  }
}

console.log(`\n共检查 ${checked} 处"绑定固定元素"的写法`);
console.log(real === 0
  ? '  ✓ 未发现同类隐患（不再有"提前 return 导致漏绑"的问题）'
  : `  ✗ 发现 ${real} 处隐患`);

process.exit(real === 0 ? 0 : 1);