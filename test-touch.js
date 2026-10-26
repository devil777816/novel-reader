/* iOS Safari 手势问题的静态检查

   真实报障：
   1) 翻页时连点 → 浏览器放大（双击缩放）
   2) 翻页/上滑时 → 触发浏览器下拉刷新

   这两条没法在 jsdom 里测（它不做手势也不做布局），所以这里做静态断言：
   把"修复所依赖的 CSS / meta 规则"钉住，防止将来被无意改掉。 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
const shelfCss = fs.readFileSync(path.join(root, 'css', 'shelf.css'), 'utf8');
const readerCss = fs.readFileSync(path.join(root, 'css', 'reader.css'), 'utf8');
const allCss = styleCss + '\n' + shelfCss + '\n' + readerCss;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? '  -> ' + extra : ''}`);
  cond ? pass++ : fail++;
}

// 粗暴但够用的规则提取：找到 "selector {" 后到匹配的 "}"
function ruleBody(css, selector) {
  const idx = css.indexOf(selector + ' {');
  if (idx === -1) return null;
  const start = css.indexOf('{', idx);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(start + 1, i); }
  }
  return null;
}
const has = (body, prop) => !!body && new RegExp(prop.replace(/[-]/g, '\\-') + '\\s*:', 'i').test(body);

console.log('=== 1. 防双击放大 ===');

// viewport：虽然 iOS 10+ 会忽略 user-scalable=no，但独立 App 模式仍然认
const vp = (html.match(/<meta name="viewport" content="([^"]+)"/) || [])[1] || '';
ok('viewport 声明了 user-scalable=no', /user-scalable=no/.test(vp), vp);
ok('viewport 声明了 maximum-scale=1.0', /maximum-scale=1\.0/.test(vp));

// 真正的解法：touch-action
const star = ruleBody(styleCss, '*');
ok('全局 * 设置了 touch-action: manipulation（关掉双击缩放）',
   has(star, 'touch-action') && /manipulation/.test(star), (star || '').match(/touch-action[^;]*/)?.[0]);

const tapZones = ruleBody(readerCss, '.tap-zones');
ok('翻页点击层 .tap-zones 设置为 touch-action: none（手势完全交给 JS）',
   has(tapZones, 'touch-action') && /none/.test(tapZones || ''),
   (tapZones || '').match(/touch-action[^;]*/)?.[0]);

const readerContent = ruleBody(readerCss, '.reader-content');
ok('.reader-content 保留纵向滚动但关掉双击缩放',
   has(readerContent, 'touch-action') && /manipulation/.test(readerContent || ''),
   (readerContent || '').match(/touch-action[^;]*/)?.[0]);

ok('禁止长按弹出拷贝菜单', has(star, '-webkit-touch-callout'));

console.log('\n=== 2. 防下拉刷新 ===');

const htmlRule = ruleBody(styleCss, 'html');
const bodyRule = ruleBody(styleCss, 'body');

ok('html 设置了 overscroll-behavior: none', has(htmlRule, 'overscroll-behavior'),
   (htmlRule || '').match(/overscroll-behavior[^;]*/)?.[0]);
ok('body 设置了 overscroll-behavior: none', has(bodyRule, 'overscroll-behavior'),
   (bodyRule || '').match(/overscroll-behavior[^;]*/)?.[0]);
ok('body 用 position: fixed 固定住（文档不可滚动，Safari 无法下拉刷新）',
   has(bodyRule, 'position') && /fixed/.test(bodyRule || ''),
   (bodyRule || '').match(/position[^;]*/)?.[0]);
ok('body 保持 overflow: hidden', has(bodyRule, 'overflow'));
ok('html 保持 overflow: hidden', has(htmlRule, 'overflow'));

// 关键：所有可滚动容器都要阻止过卷传递
const scrollables = [
  ['.reader-content', readerCss, '正文'],
  ['.book-grid', shelfCss, '书架网格'],
  ['.toc-list', readerCss, '目录列表'],
  ['.bookmark-list', readerCss, '书签列表'],
];
for (const [sel, css, label] of scrollables) {
  const body = ruleBody(css, sel);
  ok(`${label} ${sel} 设置了 overscroll-behavior: contain`,
     has(body, 'overscroll-behavior'), (body || '').match(/overscroll-behavior[^;]*/)?.[0]);
}

console.log('\n=== 3. 没有把滚动能力误伤 ===');
ok('body 之外仍有可滚动容器（正文/书架…）', /overflow-y:\s*auto/.test(allCss));
ok('正文仍然允许纵向滚动', /overflow-y:\s*auto/.test(readerContent || ''));

console.log('\n=== 4. 翻页/滑动手势代码仍在 ===');
const readerJs = fs.readFileSync(path.join(root, 'js', 'reader.js'), 'utf8');

// 精确检查：拿到 page-reader 的变量名，再看它是否绑定了 touchstart
const prVar = (readerJs.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\('page-reader'\)/) || [])[1];
ok('滑动监听用的是 #page-reader', !!prVar, prVar || '没找到');
ok('滑动监听确实绑定了 touchstart',
   !!prVar && new RegExp(prVar.replace(/\$/g, '\\$') + "\\.addEventListener\\('touchstart'").test(readerJs));

// 反向：不能又回到那个被 .tap-zones 挡住的元素上
const viewVar = (readerJs.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\('reader-content'\)/) || [])[1];
const badBinding = !!viewVar &&
  new RegExp(viewVar.replace(/\$/g, '\\$') + "\\.addEventListener\\('touch(start|end)'").test(readerJs);
ok('没有把滑动监听挂回被遮挡的 #reader-content（历史 bug）', !badBinding);

ok('有防重复守卫（滑动后紧跟的 click 不会翻两页）', /suppressTapClick/.test(readerJs));
ok('没有在 touchmove 上 preventDefault（否则会收不到 touchend / 吞掉点击）',
   !/touchmove[\s\S]{0,120}preventDefault/.test(readerJs));

console.log('\n=== 5. 上下栏是浮层，不挤压正文 ===');
// 需求：点屏幕中间时上下栏"浮"在文字上方，正文区域大小不变。
// jsdom 不做布局（clientHeight 恒为 0），所以这里直接断言 CSS 本身。
const headerBody = ruleBody(readerCss, '.reader-header');
const footerBody = ruleBody(readerCss, '.reader-footer');
const hiddenHeader = ruleBody(readerCss, '.reader-header.hidden');
const hiddenFooter = ruleBody(readerCss, '.reader-footer.hidden');

ok('顶部栏脱离文档流（position: absolute）',
   has(headerBody, 'position') && /absolute/.test(headerBody || ''),
   (headerBody || '').match(/position[^;]*/)?.[0]);
ok('底部栏脱离文档流（position: absolute）',
   has(footerBody, 'position') && /absolute/.test(footerBody || ''),
   (footerBody || '').match(/position[^;]*/)?.[0]);

// 收起态只做位移，不能又变回占用布局空间
ok('收起态只做 transform 位移（顶部栏）', /translateY\(-100%\)/.test(hiddenHeader || ''));
ok('收起态只做 transform 位移（底部栏）', /translateY\(100%\)/.test(hiddenFooter || ''));
ok('收起态不再重复声明 position: relative',
   !/position\s*:\s*relative/.test(hiddenFooter || '') && !/position\s*:\s*relative/.test(hiddenHeader || ''));

// 必须是"不透明"背景，否则文字会从栏下方透出来
const opaque = (b) => has(b, 'background') && !/background\s*:\s*inherit/.test(b || '');
ok('顶部栏有不透明背景（不能是 inherit，否则文字透出来）', opaque(headerBody),
   (headerBody || '').match(/background[^;]*/)?.[0]);
ok('底部栏有不透明背景', opaque(footerBody),
   (footerBody || '').match(/background[^;]*/)?.[0]);

// 浮层必须高于翻页点击层，否则按钮点不动
const zOf = (b) => { const m = (b || '').match(/z-index\s*:\s*(\d+)/); return m ? +m[1] : null; };
const tapZ = zOf(ruleBody(readerCss, '.tap-zones'));
ok('顶部栏 z-index 高于翻页点击层', (zOf(headerBody) ?? 0) > (tapZ ?? 0),
   `header=${zOf(headerBody)} tap-zones=${tapZ}`);
ok('底部栏 z-index 高于翻页点击层', (zOf(footerBody) ?? 0) > (tapZ ?? 0),
   `footer=${zOf(footerBody)} tap-zones=${tapZ}`);

// 正文必须是唯一的在流子元素，才能恒定占满（高度不随上下栏变化）
const pageBody = ruleBody(styleCss, '.page');
ok('页面容器是纵向 flex（正文靠 flex:1 占满）',
   has(pageBody, 'display') && /flex/.test(pageBody || ''));
ok('正文使用 flex: 1', has(readerContent, 'flex'));

// 代码里不应再有"切换上下栏时重新分页"的逻辑（那正是导致文字跳动的原因）
const rjs = fs.readFileSync(path.join(root, 'js', 'reader.js'), 'utf8');
const toggleFn = (rjs.match(/function toggleReaderBars\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
ok('toggleReaderBars() 不再触发重新分页', !/paginate/.test(toggleFn),
   toggleFn.split('\n').length + ' 行');

console.log('\n=== 6. 上下栏紧凑化（用户要求：矮一点、更简洁）===');
// jsdom 不做布局，高度测不了，所以直接断言 CSS / HTML 本身

// 返回键：只有一个图标，不再有"书架"文字。
// 注意图标是 initIcons() 注入的，所以标签内部是空的、图标写在 data-icon 上；
// aria-label 里的中文是给读屏软件用的，不算"可见文字"。
const backFull = (html.match(/<button id="btn-back"[\s\S]*?<\/button>/) || [])[0] || '';
const backInner = (backFull.match(/>([\s\S]*)<\/button>/) || [])[1] || '';
ok('返回键只有一个图标、没有可见文字（aria-label 仍保留给读屏）',
   /data-icon="chevronLeft"/.test(backFull) && backInner.trim() === '' && /aria-label="[^"]+"/.test(backFull),
   backInner.trim() === '' ? '图标占位、无可见文字' : JSON.stringify(backInner.trim()));

// 书名不再显示，但仍保留在 DOM 里（读屏软件 + 测试要用）
const titleTag = (html.match(/<span[^>]*id="reader-title"[^>]*>/) || [])[0] || '';
ok('书名标签仍在 DOM 中（供读屏/测试读取）', !!titleTag);
ok('书名带 sr-only（视觉不可见但读屏可读）', /sr-only/.test(titleTag), titleTag);
ok('没有对它用 display:none（那样读屏也读不到）',
   !/\.reader-title\s*\{[^}]*display\s*:\s*none/.test(readerCss));
ok('sr-only 用的是裁剪法而不是 display:none',
   has(ruleBody(readerCss, '.sr-only'), 'clip'));

// 进度文字行已从视觉上移除
ok('进度文字行 .progress-info 已从 HTML 移除', !/progress-info/.test(html));
ok('进度文字行 .progress-info 已从 CSS 移除', !/\.progress-info\s*\{/.test(readerCss));
ok('进度文字仍保留为读屏可读的状态区（不丢信息）',
   /aria-live/.test(html) && /id="progress-text-bottom"/.test(html));

// 三个工具按钮保留（用户明确要求保留）
ok('目录按钮仍在', /id="btn-toc"/.test(html));
ok('白天/夜间按钮仍在', /id="btn-daynight"/.test(html));
ok('阅读设置按钮仍在', /id="btn-reader-settings"/.test(html));
ok('工具按钮那一行仍在（.foot-tools）', ruleBody(readerCss, '.foot-tools') !== null);

// 高度相关的数值：检查"紧凑但舒适"的区间。
// 刻意不写死具体像素 —— 用户可能会反复要求高一点/矮一点，
// 写死的话每调一次都要改测试。这里只保证不回到"过高"或"过于局促"。
const cssVars = {};
for (const m of readerCss.matchAll(/--(bar-[\w-]+)\s*:\s*([^;]+);/g)) {
  cssVars['--' + m[1]] = m[2].trim();
}
const numVar = (name) => {
  const v = cssVars[name];
  if (!v) return NaN;
  const m = String(v).match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
};

ok('尺寸集中在 CSS 变量里（方便一处调高低）',
   Object.keys(cssVars).length >= 8, Object.keys(cssVars).length + ' 个变量');

const headerH = numVar('--bar-header-min-h');
ok('顶部栏高度在舒适区间 (36-56px)', headerH >= 36 && headerH <= 56, headerH + 'px');
const sliderH = numVar('--bar-slider-h');
ok('进度条高度在舒适区间 (16-28px)', sliderH >= 16 && sliderH <= 28, sliderH + 'px');
const toolIcon = numVar('--bar-tool-icon');
ok('工具图标在舒适区间 (16-24px)', toolIcon >= 16 && toolIcon <= 24, toolIcon + 'px');
const backSize = numVar('--bar-back-size');
ok('返回箭头足够大 (>=1.4rem)', backSize >= 1.4, backSize + 'rem');

// 各选择器确实在引用变量（而不是又写死像素）
const headerBody2 = ruleBody(readerCss, '.reader-header');
ok('顶部栏内边距走变量', /var\(--bar-header-pad-y\)/.test(headerBody2 || ''));
const footerBody2 = ruleBody(readerCss, '.reader-footer');
ok('底部栏内边距走变量', /var\(--bar-footer-pad-y\)/.test(footerBody2 || ''));
ok('进度条高度走变量', /var\(--bar-slider-h\)/.test(ruleBody(readerCss, '.chapter-slider') || ''));
ok('工具图标走变量', /var\(--bar-tool-icon\)/.test(ruleBody(readerCss, '.tool-icon') || ''));

// 但也不能回到"太占地方"的老样子
ok('顶部栏不高于 56px（防止又变得很占地方）', headerH <= 56, headerH + 'px');
const footerPad = numVar('--bar-footer-pad-y');
ok('底部栏内边距 <= 10px', footerPad <= 10, footerPad + 'px');

// 工具按钮横向排列（图标与文字同一行，省高度）
ok('工具按钮改为横向排列（省一行高度）',
   /flex-direction\s*:\s*row/.test(ruleBody(readerCss, '.tool-btn') || ''));

console.log('\n=== 7. 翻页动画只用合成器属性（保证流畅）===');
// 翻页卡顿的两大来源：动画期间写数据库、以及动画属性触发重排。
// 数据库那条由 e2e 的 18b 覆盖；这里锁住 CSS 这一半。
const pagedInner = ruleBody(readerCss, '.reader-content.paged .paged-inner');
ok('正文明文动画只走 transform（可交给 GPU）',
   /transition\s*:\s*transform/.test(pagedInner || ''),
   (pagedInner || '').match(/transition[^;]*/)?.[0]);
ok('没有对 left/top/width/height 做过渡（那些会触发重排）',
   !/transition\s*:[^;]*(left|top|width|height|margin|padding)/.test(pagedInner || ''));
ok('声明了 will-change: transform（提前建立合成层）',
   /will-change\s*:\s*transform/.test(pagedInner || ''));
ok('用 translate3d 提前提升为合成层', /translate3d/.test(pagedInner || ''));
ok('加了 backface-visibility（防动画边缘闪白）',
   /backface-visibility/.test(pagedInner || ''));

const slideRule = ruleBody(readerCss, '.reader-content.paged.anim-slide .paged-inner');
const slideTrans = ((slideRule || '').match(/transition\s*:\s*([^;]+)/) || [])[1] || '';
ok('滑动档只过渡 transform', /transform/.test(slideTrans), slideTrans.trim());
ok('滑动档用了缓出曲线（手感更顺）', /cubic-bezier/.test(slideTrans), slideTrans.trim());
const durMatch = slideTrans.match(/([\d.]+)s/);
const dur = durMatch ? parseFloat(durMatch[1]) : NaN;
ok('滑动时长在 0.15-0.35s 之间（够顺又不拖）',
   dur >= 0.15 && dur <= 0.35, dur + 's');

// no-anim 必须排在模式规则之后，否则重新分页时临时禁用会被覆盖
ok('.no-anim 出现在 .anim-slide 之后（覆盖顺序正确）',
   readerCss.indexOf('.paged-inner.no-anim') > readerCss.indexOf('.anim-slide'));

console.log('\n=== 8. 跟手拖动翻页的样式前提 ===');
const draggingRule = ruleBody(readerCss, '.reader-content.paged .paged-inner.dragging');
ok('拖动中关掉过渡（否则位移跟不上手指）',
   has(draggingRule, 'transition'), (draggingRule || '').match(/transition[^;]*/)?.[0]);
// 同样必须排在模式规则之后，否则会被 .anim-slide 的过渡盖住
ok('.dragging 出现在 .anim-slide 之后（覆盖顺序正确）',
   readerCss.indexOf('.paged-inner.dragging') > readerCss.indexOf('.anim-slide'));

// 分页几何只允许有一处定义（原来在三个地方重复，跟手拖动也要用它）
const rjs2 = fs.readFileSync(path.join(root, 'js', 'reader.js'), 'utf8');
ok('分页几何抽成了 pageMetrics()（避免多处重复导致手感错位）',
   /function pageMetrics\(\)/.test(rjs2));
const gapLiterals = (rjs2.match(/Math\.max\(24,\s*Math\.round\(W \* 0\.12\)\)/g) || []).length;
ok('旧的页间距公式已无残留重复', gapLiterals === 0, `残留 ${gapLiterals} 处`);
// 检查"绑定 #page-reader 的变量里，有挂 touchmove 的"。
// 意图是：拖动/滑动监听必须挂在 #page-reader 上（tap-zones 会挡住子元素，挂别处收不到事件）。
// 注意不要只取"第一个"绑定该元素的变量 —— 别处也可能绑定同一个元素（例如连点兜底），
// 那样会把断言误判成失败（曾经踩过）。
const prVars = [...rjs2.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\('page-reader'\)/g)]
  .map(m => m[1]);
ok('跟手拖动监听挂在 #page-reader 上（tap-zones 会挡住子元素，挂别处收不到事件）',
   prVars.some(v => new RegExp(v.replace(/\$/g, '\\$') + "\\.addEventListener\\('touchmove'").test(rjs2)),
   prVars.join(', ') || '没找到');
const rcVar2 = (rjs2.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\('reader-content'\)/) || [])[1];
ok('没有把拖动监听挂回被遮挡的 #reader-content',
   !(rcVar2 && new RegExp(rcVar2.replace(/\$/g, '\\$') + "\\.addEventListener\\('touch(move|start)'").test(rjs2)));
ok('有方向判定：纵向手势不进入拖动',
   /Math\.abs\(curDy\)\s*>\s*Math\.abs\(curDx\)/.test(rjs2));
ok('到头有阻尼', /DRAG_EDGE_DAMPING/.test(rjs2));
ok('甩动速度用最后一段而不是总位移（否则"拖回来"会误判成甩）',
   /samples\[n - 2\]/.test(rjs2));

console.log('\n=== 9. 「覆盖」动画的样式前提 ===');
// 覆盖的关键：底层瞬间就位后完全静止，位移全部由翻页层的克隆页完成
ok('覆盖模式下底层关掉过渡（否则它会跟着动，就不是"覆盖"了）',
   /\.reader-content\.paged\.anim-cover \.paged-inner\s*\{[^}]*transition\s*:\s*none/.test(readerCss));
ok('覆盖有关键帧 pageCover', /@keyframes\s+pageCover/.test(readerCss));
ok('覆盖的起止位置来自 CSS 变量（位置依赖页码，写不进静态 CSS）',
   /--cover-from/.test(readerCss) && /--cover-to/.test(readerCss));
ok('覆盖层不透明（否则底下那页的文字会透上来叠在一起）',
   /\.page-flip-page\.page-opaque\s*\{[^}]*background/.test(readerCss));
ok('拖动中不加动画（位移必须完全由手指驱动）',
   /\.page-flip-page\.cover-drag\s*\{[^}]*animation\s*:\s*none/.test(readerCss));

// HTML 里的四个选项
ok('设置里有 4 个翻页动画选项',
   (html.match(/class="theme-btn anim-btn/g) || []).length === 4,
   (html.match(/data-anim="([a-z]+)"/g) || []).join(' '));
ok('平移与覆盖是两个独立选项',
   /data-anim="slide">平移</.test(html) && /data-anim="cover">覆盖</.test(html));

// 默认档位：用户选定「覆盖」（最接近翻真书）。HTML 的初始高亮必须和 JS 的默认值一致，
// 否则设置面板刚打开时会显示错的选中项。
ok('默认翻页动画是「覆盖」（JS 常量与 HTML 初始高亮一致）',
   /const DEFAULT_ANIM = 'cover'/.test(rjs2) &&
   /class="theme-btn anim-btn active" data-anim="cover"/.test(html),
   'JS=' + (/const DEFAULT_ANIM = '(\w+)'/.exec(rjs2) || [])[1]);
ok('设置读取用的默认值与常量一致（不是又写死一个字符串）',
   /getSetting\('anim', DEFAULT_ANIM\)/.test(rjs2));

console.log('\n=== 10. Service Worker 的更新策略 ===');
const swJs = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
// 这一条直接决定"改了代码要不要重新部署 / 刷新几次才生效"
ok('应用外壳（html/css/js）走网络优先',
   /SHELL_RE/.test(swJs) && /isAppShell\(req\.url\)/.test(swJs) &&
   /fetch\(req\)\s*\n?\s*\.then\(res => putInCache/.test(swJs));
ok('网络失败时回退到缓存（仍能离线阅读）',
   /\.catch\(\(\) => caches\.match\(req\)\.then\(c => c \|\| offlineResponse\(\)\)\)/.test(swJs));
ok('库文件/图标仍是缓存优先（启动更快）',
   /其它资源：缓存优先/.test(swJs) && /caches\.match\(req\)\.then\(cached/.test(swJs));
ok('安装后立即接管（skipWaiting + clients.claim）',
   /self\.skipWaiting\(\)/.test(swJs) && /self\.clients\.claim\(\)/.test(swJs));
ok('激活时清理旧缓存', /caches\.keys\(\)/.test(swJs) && /caches\.delete/.test(swJs));
ok('Range 请求交给网络（否则 PDF 会拿到不完整内容）',
   /headers\.has\('range'\)/.test(swJs));
ok('预缓存清单与页面实际依赖一致（六个 js + 三个 css）',
   /'\.\/js\/reader\.js'/.test(swJs) && /'\.\/js\/app\.js'/.test(swJs) &&
   /'\.\/css\/reader\.css'/.test(swJs));

console.log('\n=== 11. 图标系统（统一矢量图标，替换 emoji）===');
const iconsJs = fs.readFileSync(path.join(root, 'js', 'icons.js'), 'utf8');
const shelfJsForIcons = fs.readFileSync(path.join(root, 'js', 'shelf.js'), 'utf8');

// 1) 不能再有 emoji 当图标：这些码位就是原来那批「丑图标」
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2B00}-\u{2BFF}\u{2600}-\u{27BF}]/u;
function emojiIn(src, label) {
  const hits = [];
  src.split('\n').forEach((line, i) => {
    // 注释里的说明文字不算（比如 "⚠ 这里必须..."）
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = code.match(new RegExp(EMOJI_RE.source, 'gu'));
    if (m) hits.push(`${label}:${i + 1} ${[...new Set(m)].join('')}`);
  });
  return hits;
}
const htmlEmoji = emojiIn(html, 'index.html');
ok('index.html 里已经没有 emoji 图标', htmlEmoji.length === 0, htmlEmoji.slice(0, 4).join(' | '));
const readerEmoji = emojiIn(rjs2, 'reader.js');
ok('reader.js 里已经没有 emoji 图标', readerEmoji.length === 0, readerEmoji.slice(0, 4).join(' | '));
const shelfEmoji = emojiIn(shelfJsForIcons, 'shelf.js');
ok('shelf.js 里已经没有 emoji 图标', shelfEmoji.length === 0, shelfEmoji.slice(0, 4).join(' | '));

// 2) HTML / JS 里引用的每个图标名都必须在图标库里真实存在
//    只在 ICON_PATHS 这个对象里找，避免把别的键名也当成图标名
const pathsBlock = (iconsJs.match(/const ICON_PATHS = \{([\s\S]*?)\n\};/) || [])[1] || '';
const defined = new Set(
  [...pathsBlock.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(m => m[1])
);
ok('图标库里有图标定义', defined.size >= 15, defined.size + ' 个: ' + [...defined].join(','));

const used = new Set();
for (const m of html.matchAll(/data-icon="([^"]+)"/g)) used.add(m[1]);
for (const m of rjs2.matchAll(/icon\('([^']+)'/g)) used.add(m[1]);
for (const m of shelfJsForIcons.matchAll(/icon\(['"]([^'"]+)['"]/g)) used.add(m[1]);
const missing = [...used].filter(n => !defined.has(n));
ok('页面和脚本引用的图标名全部存在（不会渲染成空白）',
   missing.length === 0, missing.length ? '缺失: ' + missing.join(', ') : `${used.size} 个引用全部有效`);

// 3) 图标必须是 currentColor 描边 —— 这样才能跟随主题自动变色
ok('图标统一用 currentColor 描边（跟随主题变色）',
   /stroke="currentColor"/.test(iconsJs) && /fill="none"/.test(iconsJs));
ok('图标统一圆头圆角，视觉重量一致',
   /stroke-linecap="round"/.test(iconsJs) && /stroke-linejoin="round"/.test(iconsJs));
ok('图标带 aria-hidden（纯装饰，不干扰读屏）', /aria-hidden="true"/.test(iconsJs));

// 4) icons.js 必须最先加载：其它脚本运行时会用到 icon()
const scriptOrder = [...html.matchAll(/<script src="\.\/js\/([a-z]+)\.js">/g)].map(m => m[1]);
ok('icons.js 是第一个加载的应用脚本（其它脚本依赖它）',
   scriptOrder[0] === 'icons',
   scriptOrder.join(' → '));
ok('图标库已加入离线缓存清单', /'\.\/js\/icons\.js'/.test(fs.readFileSync(path.join(root, 'sw.js'), 'utf8')));

// 5) 尺寸策略：用 em 跟随 font-size，避免每个位置重复写像素
ok('图标尺寸用 em 跟随所在元素的 font-size（不逐个写死像素）',
   /\.btn-icon svg\s*\{[^}]*width:\s*1em/.test(styleCss));

console.log(`\n========================================`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log(`========================================\n`);
process.exit(fail === 0 ? 0 : 1);