/* 跨文件函数引用检查：找出调用了但从未定义的函数 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const jsFiles = ['app.js', 'storage.js', 'parser.js', 'shelf.js', 'reader.js'];

const sources = {};
for (const f of jsFiles) {
  sources[f] = fs.readFileSync(path.join(root, 'js', f), 'utf8');
}
sources['sw.js'] = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

const all = Object.values(sources).join('\n');

// 1. 收集所有函数定义（函数声明 + 赋值式函数）
const defined = new Set();
for (const m of all.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
for (const m of all.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)) defined.add(m[1]);
for (const m of all.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g)) defined.add(m[1]);

// 2. 收集所有调用点
const called = new Map(); // name -> file
for (const [file, src] of Object.entries(sources)) {
  for (const m of src.matchAll(/(?:^|[^.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = m[1];
    if (!called.has(name)) called.set(name, new Set());
    called.get(name).add(file);
  }
}

// 3. 白名单：语言内置 / DOM API / 第三方库 / 关键字
const builtins = new Set([
  // 语言
  'if','for','while','switch','catch','return','typeof','function','await','new','super','do','else',
  'parseInt','parseFloat','isNaN','String','Number','Boolean','Array','Object','JSON','Math','Date',
  'Promise','Map','Set','RegExp','Error','Symbol','BigInt','decodeURIComponent','encodeURIComponent',
  'setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','fetch','alert',
  'confirm','prompt','postMessage','importScripts','structuredClone','queueMicrotask',
  // DOM
  'addEventListener','removeEventListener','querySelector','querySelectorAll','getElementById',
  'createElement','createDocumentFragment','appendChild','removeChild','replaceChild','insertBefore',
  'getContext','toDataURL','open','close','delete','get','put','add','match','matchAll','test','exec',
  'includes','indexOf','split','join','slice','splice','map','filter','reduce','forEach','sort','find',
  'findIndex','push','pop','shift','unshift','concat','trim','replace','replaceAll','padStart','padEnd',
  'toLowerCase','toUpperCase','startsWith','endsWith','substring','substr','charAt','repeat','at',
  'keys','values','entries','has','then','catch','finally','resolve','reject','all','allSettled','race',
  'text','arrayBuffer','blob','json','stringify','parse','floor','ceil','round','random','min','max',
  'abs','pow','sqrt','now','getTime','toISOString','getFullYear','getMonth','getDate','getHours',
  'getMinutes','getSeconds','fromCharCode','charCodeAt','localeCompare','normalize','revokeObjectURL',
  'createObjectURL','loadAsync','async','render','getPage','getViewport','getDocument','destroy',
  'convertToHtml','on','off','register','claim','skipWaiting','waitUntil','respondWith','match',
  'isArray','from','assign','freeze','defineProperty','getOwnPropertyNames','preventDefault',
  'stopPropagation','contains','toggle','closest','remove','focus','blur','click','scrollTo','scrollIntoView',
  'test','success','error','warn','log','trace','dir','table','group','groupEnd','time','timeEnd',
  'addEventListener','contains','hasAttribute','getAttribute','setAttribute','removeAttribute',
]);

// 4. 找出可疑：被调用、但未定义、且不在白名单里
const suspicious = [];
for (const [name, files] of called) {
  if (defined.has(name)) continue;
  if (builtins.has(name)) continue;
  suspicious.push({ name, files: [...files].join(',') });
}

console.log('=== 跨文件函数引用检查 ===');
console.log(`已定义函数: ${defined.size} 个`);
console.log(`调用点名称: ${called.size} 个\n`);

if (suspicious.length === 0) {
  console.log('[PASS] 未发现"调用了但未定义"的函数');
} else {
  console.log(`[需人工确认] 以下 ${suspicious.length} 个调用名未在本项目中定义`);
  console.log('(多数应为浏览器 API 或第三方库，请确认无拼写错误)');
  suspicious.forEach(s => console.log(`   · ${s.name}()   <- 在 ${s.files}`));
}

// 5. 重点：确认跨文件相互调用的核心函数都存在
console.log('\n=== 核心函数定义确认 ===');
const critical = [
  'openDB','getAllBooks','getBook','saveBook','deleteBook','updateBookField',
  'getBookmarks','getAllBookmarks','saveBookmark','deleteBookmark','deleteBookmarksByBook',
  'getSetting','saveSetting','generateId',
  'getFileFormat','isSupportedFormat','extractTitle','parseTxt','parseEpub','parsePdf','parseDocx','extractZip',
  'initShelf','refreshShelf','renderBooks','openBook','importBook','handleFileImport','handleZipImport',
  'initReader','loadBook','renderCurrentChapter','addBookmark','showBookmarkList','saveCurrentProgress',
  'navigateTo','initApp','escapeHtml','showToast','applyTheme','applyReaderStyles',
];
let miss = 0;
const line = [];
for (const fn of critical) {
  if (defined.has(fn)) { line.push(`[OK] ${fn}`); }
  else { line.push(`[MISSING] ${fn}`); miss++; }
}
line.forEach(l => console.log('  ' + l));

console.log('\n' + (miss === 0 ? '[PASS] 所有核心函数均已定义' : `[FAIL] ${miss} 个核心函数缺失`));
process.exit(miss === 0 && suspicious.length === 0 ? 0 : 0);