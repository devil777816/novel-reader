/* DOM 集成检查：验证 JS 引用的元素 ID / class 是否都存在于 HTML */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const jsFiles = ['app.js', 'storage.js', 'parser.js', 'shelf.js', 'reader.js'];
const js = jsFiles
  .map(f => fs.readFileSync(path.join(root, 'js', f), 'utf8'))
  .join('\n');

// HTML 中定义的所有 id
const htmlIds = new Set(
  [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1])
);

// JS 中 getElementById 引用的所有 id
const usedIds = new Set(
  [...js.matchAll(/getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map(m => m[1])
);

// JS 中模板字符串动态生成的 id（跳过这些）
const dynamicPatterns = [/^`/, /\$\{/];

let missing = [];
for (const id of usedIds) {
  if (htmlIds.has(id)) continue;
  if (dynamicPatterns.some(re => re.test(id))) continue;
  missing.push(id);
}

console.log('=== 元素 ID 检查 ===');
console.log(`HTML 定义 id 数量: ${htmlIds.size}`);
console.log(`JS 引用 id 数量:   ${usedIds.size}`);

if (missing.length === 0) {
  console.log('[PASS] JS 引用的所有静态 ID 都存在于 HTML 中');
} else {
  console.log('[FAIL] 以下 ID 在 HTML 中不存在:');
  missing.forEach(id => console.log('   - ' + id));
}

// 反向检查：HTML 中定义了但从未被 JS 引用的 id（可能是死元素）
const unused = [...htmlIds].filter(id => !usedIds.has(id));
console.log(`\n=== 未被 JS 直接引用的 id (${unused.length} 个) ===`);
unused.forEach(id => console.log('   · ' + id));

// 检查 querySelector 用到的 class 是否在 CSS/HTML 中出现
const usedClasses = new Set(
  [...js.matchAll(/querySelector(?:All)?\(\s*['"`]\.([a-zA-Z0-9_-]+)/g)].map(m => m[1])
);
const css = ['style.css', 'shelf.css', 'reader.css']
  .map(f => fs.readFileSync(path.join(root, 'css', f), 'utf8'))
  .join('\n');

console.log('\n=== class 选择器检查 ===');
let clsMissing = [];
for (const c of usedClasses) {
  const inCss = css.includes('.' + c);
  const inHtml = html.includes('class="' + c) || html.includes(c + '"') || html.includes(c + ' ');
  if (!inCss && !inHtml) clsMissing.push(c);
}
if (clsMissing.length === 0) {
  console.log('[PASS] JS 使用的 class 选择器均有对应样式或元素');
} else {
  console.log('[WARN] 以下 class 在 CSS/HTML 中未找到: ' + clsMissing.join(', '));
}

// 检查 HTML 标签配对（粗粒度）
console.log('\n=== 页面结构检查 ===');
for (const p of ['page-shelf', 'page-reader', 'page-bookmarks']) {
  const has = htmlIds.has(p);
  console.log(`  ${has ? '[OK]  ' : '[FAIL]'} #${p}`);
}
const pageCount = [...html.matchAll(/class="page[^"]*"/g)].length;
console.log(`  页面元素总数: ${pageCount}`);

process.exit(missing.length === 0 ? 0 : 1);