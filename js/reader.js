/* ========== 阅读器核心 ========== */

let currentBook = null;
let currentChapters = [];
let currentChapterIndex = 0;

// 翻页状态
let pageIndex = 0;      // 当前章内的第几页（从 0 开始）
let totalPages = 1;       // 当前章共几页
let _paginateTimer = null;

// 单章最多渲染这么多段。解析时已按字数切分，这里只是最后一道保险，
// 避免任何意外输入让多列排版把手机卡死。
const MAX_RENDER_PARAGRAPHS = 6000;

/* 默认翻页动画：覆盖。
   原因：覆盖最接近"翻真书"——只有当前页在动，下一頁原地不动地被让出来，
   拖动时两页之间只留一条窄缝（约 16px），看起来像一张纸被抽走。
   平移则是整条横向带一起移动，两页会同时动、留白也更宽。 */
const DEFAULT_ANIM = 'cover';

let readerSettings = {
  fontSize: 18,
  lineHeight: 1.8,
  theme: 'warm',
  pageMode: 'paged',      // 'paged' = 左右翻页，'scroll' = 上下滚动
  anim: DEFAULT_ANIM,     // 'slide' 平移 / 'cover' 覆盖 / 'flip' 仿真 / 'none' 无
  lastLightTheme: 'warm'  // 「白天/夜间」切换时记住的浅色主题
};

/* 页面当前是否处于"被放大"状态（用户手动双击/捏合放大过）。
   iOS 13+ 才有 visualViewport；拿不到就按"未放大"处理（守卫照常拦截）。 */
function isViewportZoomed() {
  try {
    const vv = window.visualViewport;
    return !!(vv && vv.scale > 1.01);
  } catch (e) {
    return false;
  }
}

async function initReader() {
  // 加载阅读设置
  readerSettings.fontSize = await getSetting('fontSize', 18);
  readerSettings.lineHeight = await getSetting('lineHeight', 1.8);
  readerSettings.theme = await getSetting('theme', 'warm');
  readerSettings.pageMode = await getSetting('pageMode', 'paged');
  readerSettings.anim = normalizeAnimMode(await getSetting('anim', DEFAULT_ANIM));
  // 「白天/夜间」快捷切换要记住上次用的浅色主题，切回来时用
  readerSettings.lastLightTheme = await getSetting('lastLightTheme', 'warm');

  applyTheme(readerSettings.theme);
  applyPageModeUI();
  applyAnimUI();
  updateDayNightUI();
  
  // 绑定事件
  document.getElementById('btn-back').addEventListener('click', () => navigateTo('shelf'));
  document.getElementById('btn-bookmark').addEventListener('click', addBookmark);
  document.getElementById('btn-reader-menu').addEventListener('click', toggleReaderMenu);
  document.getElementById('btn-menu-close').addEventListener('click', () => hideReaderMenu());
  document.getElementById('btn-prev-chapter').addEventListener('click', prevChapter);
  document.getElementById('btn-next-chapter').addEventListener('click', nextChapter);
  // 书签页返回按钮：在这里只绑一次。
  // 注意：不要放进 showBookmarkList()，否则书签为空时会因提前 return 而漏绑。
  document.getElementById('btn-bookmarks-back').addEventListener('click', () => navigateTo('shelf'));

  // 点「阅读设置」弹窗之外的遮罩区域也能关闭
  document.querySelector('#reader-menu .menu-overlay')
    .addEventListener('click', () => hideReaderMenu());

  // 底部工具：目录 / 白天 / 阅读设置
  document.getElementById('btn-toc').addEventListener('click', () => openToc());
  document.getElementById('btn-daynight').addEventListener('click', () => toggleDayNight());
  document.getElementById('btn-reader-settings').addEventListener('click', () => toggleReaderMenu());

  // 目录弹窗
  document.getElementById('toc-overlay').addEventListener('click', () => closeToc());
  document.getElementById('toc-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.toc-tab');
    if (tab) setTocTab(tab.dataset.tab);
  });
  document.getElementById('btn-toc-order').addEventListener('click', () => toggleTocOrder());

  // 目录列表点击（事件委托，列表内容会重建）
  document.getElementById('toc-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.toc-item');
    if (!item) return;
    await jumpToChapter(parseInt(item.dataset.chapter) || 0);
    const p = parseInt(item.dataset.page) || 0;
    if (p > 0 && isPagedMode()) {
      pageIndex = Math.min(p, totalPages - 1);
      applyPageTransform();
      updateProgress();
    }
    closeToc();
  });

  // 章节进度条：拖动松手后跳章
  const chapterSlider = document.getElementById('chapter-slider');
  chapterSlider.addEventListener('change', (e) => {
    jumpToChapter(parseInt(e.target.value) || 0);
  });

  // 翻页方式切换
  document.getElementById('pagemode-options').addEventListener('click', async (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    await setPageMode(btn.dataset.mode);
  });

  // 翻页动画切换
  document.getElementById('anim-options').addEventListener('click', async (e) => {
    const btn = e.target.closest('.anim-btn');
    if (!btn) return;
    await setReaderAnim(btn.dataset.anim);
  });

  // 左右翻页的点击区域
  const tapZonesEl = document.getElementById('tap-zones');

  // 点击区域该做的事，抽出来是为了让下面的"连点兜底"也能复用
  function handleTapZone(zone) {
    if (!zone) return;
    const dir = parseInt(zone.dataset.dir, 10);
    if (dir === 0) {
      toggleReaderBars();           // 中间：显示/隐藏上下栏
    } else {
      turnPage(dir);                // 左/右：翻页
    }
  }

  tapZonesEl.addEventListener('click', (e) => {
    // 刚发生过滑动就不再当成点击，否则一次轻扫会翻两页
    if (swipeJustHandled()) return;
    handleTapZone(e.target.closest('.tap-zone'));
  });

  initSwipe();

  /* 阻止 iOS 的"连点放大"。
     iOS 10+ 会忽略 viewport 的 user-scalable=no。这个应用已经做到：
       · 全站  * { touch-action: manipulation }
       · 正文  .reader-content { touch-action: manipulation }
       · 翻页区 .tap-zones     { touch-action: none }   ← 理论上最严
     但用户实测仍然会放大。旧版兜底有两个洞：
       1) 判定窗口太窄：iOS 的双击间隔实测可达 500ms（还受"辅助功能"里的
          双击速度设置影响），原来 300ms 内才算双击 —— 节奏稍慢的连点
          就漏过去了，照样放大。
       2) 按住时长卡太死：原来按下超过 250ms 就不算"点"，而刻意的连点
          按下常常超过这个值，同样漏拦。
     更糟的是漏拦之后就被困住了：想"双击缩回"时，快节奏的双击恰好又被
     这道守卫拦下（preventDefault），捏合缩小又被 .tap-zones 的
     touch-action:none 挡死 —— 放大就再也回不来了。
     所以现在：
       · 窗口放宽到 500ms，比 iOS 的判定更宽，保证先拦住；
       · 页面已经处于放大状态时不再拦截，让原生的"双击缩回"生效；
       · 捏合缩放在 app.js 里统一拦（未放大时），放大后放行。

     坑：在 touchend 上 preventDefault() 会连带取消这次 tap 的 click。
     翻页区自己补调 handleTapZone；其它按钮手动补发一次 click，
     否则快速连点"下一章"这类操作会丢一次。

     挂在 initSwipe() **之后**：让滑动逻辑先跑、先把 swipeJustHandled() 立起来，
     免得把"滑动的收尾"误判成一次连点。 */
  const DOUBLE_TAP_MS = 500;   // 两次抬手间隔小于这个值算"连点"（取比 iOS 更宽，宁可多拦）
  const SHORT_TAP_MS = 500;    // 单次按住不超过这个值才算"点"；阅读页没有长按菜单，放宽无害
  const readerPageEl = document.getElementById('page-reader');
  let touchStartAt = 0;
  let lastTapEndAt = 0;

  readerPageEl.addEventListener('touchstart', () => {
    touchStartAt = Date.now();
  }, { passive: true });

  readerPageEl.addEventListener('touchend', (e) => {
    if (e.touches && e.touches.length) return;      // 还有手指没离开，不是"点"
    const now = Date.now();
    const wasShortTap = now - touchStartAt <= SHORT_TAP_MS;
    const isDoubleTap = wasShortTap && (now - lastTapEndAt <= DOUBLE_TAP_MS);
    // 只有"短点"才参与连点判定；长按/拖动之后不该和下一下凑成双击
    lastTapEndAt = wasShortTap ? now : 0;
    if (!isDoubleTap) return;

    // 已经处于放大状态就放行：让 iOS 原生的"双击缩回"生效，
    // 用户才能自己恢复。此时拦截只会把人困在放大的页面里。
    if (isViewportZoomed()) return;

    if (e.cancelable) e.preventDefault();           // 挡掉浏览器的双击缩放
    if (swipeJustHandled()) return;                 // 刚滑动过就不算点击
    const target = e.target;
    const zone = target && target.closest ? target.closest('.tap-zone') : null;
    if (zone) {
      handleTapZone(zone);                          // 翻页区：手动补上这次点击
      return;
    }
    // 其它目标：preventDefault 把原生 click 也取消了，手动补发一次，
    // 否则快速连点按钮（如"下一章"）会丢一次
    if (target && typeof target.click === 'function') target.click();
  }, { passive: false });

  initResizeRepaginate();
  
  // 字号
  const fontSizeSlider = document.getElementById('font-size-slider');
  fontSizeSlider.value = readerSettings.fontSize;
  fontSizeSlider.addEventListener('input', (e) => {
    readerSettings.fontSize = parseInt(e.target.value);
    document.getElementById('font-size-label').textContent = readerSettings.fontSize + 'px';
    applyReaderStyles();
    scheduleRepaginate();
    saveSetting('fontSize', readerSettings.fontSize);
  });
  
  // 行间距
  const lineHeightSlider = document.getElementById('line-height-slider');
  lineHeightSlider.value = readerSettings.lineHeight;
  lineHeightSlider.addEventListener('input', (e) => {
    readerSettings.lineHeight = parseFloat(e.target.value);
    document.getElementById('line-height-label').textContent = readerSettings.lineHeight;
    applyReaderStyles();
    scheduleRepaginate();
    saveSetting('lineHeight', readerSettings.lineHeight);
  });
  
  // 主题（只在自己的容器内高亮，避免误清掉"翻页方式/翻页动画"按钮的选中态）
  document.getElementById('theme-options').addEventListener('click', (e) => {
    if (e.target.classList.contains('theme-btn')) {
      e.currentTarget.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      readerSettings.theme = e.target.dataset.theme;
      applyTheme(readerSettings.theme);
      saveSetting('theme', readerSettings.theme);
    }
  });
  
  // 上下滚动模式下：点击正文任意位置切换上下栏
  // （左右翻页模式下由 .tap-zones 接管点击，不走这里）
  const readerContent = document.getElementById('reader-content');
  readerContent.addEventListener('click', (e) => {
    if (readerSettings.pageMode === 'paged') return;
    // 不响应文本选择
    if (window.getSelection().toString().length > 0) return;
    toggleReaderBars();
  });
  
  // 键盘翻页
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('page-reader').classList.contains('active')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') turnPage(-1);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') turnPage(1);
  });

  // 碰过上下栏就取消"自动收起"
  ['reader-header', 'reader-footer'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', cancelBarsAutoHide, { passive: true });
    el.addEventListener('mousedown', cancelBarsAutoHide);
  });
}

/* ========== 显示 / 隐藏上下栏 ========== */
// 上下栏是浮在正文之上的（position: absolute），显示与否都不改变正文区域大小，
// 所以这里只切换 class，不需要重新分页，也就不会出现"一点屏幕文字就被挤小"的跳动。
let _barsAutoHideTimer = null;

function setReaderBarsVisible(visible) {
  const header = document.getElementById('reader-header');
  const footer = document.getElementById('reader-footer');
  if (header) header.classList.toggle('hidden', !visible);
  if (footer) footer.classList.toggle('hidden', !visible);
}

// 用户一旦碰了上下栏，就不要再自动收起（否则正点着按钮它自己跑了）
function cancelBarsAutoHide() {
  clearTimeout(_barsAutoHideTimer);
  _barsAutoHideTimer = null;
}

// 收起上下栏，回到"沉浸阅读"。
// 翻页时会调用它 —— 用户明确要求：翻页就说明在读了，功能框让开。
function hideReaderBars() {
  cancelBarsAutoHide();
  setReaderBarsVisible(false);
}

// 显示上下栏并在一段时间后自动收起。
// 因为上下栏是浮层，会盖住一部分正文（顶部含安全区约 100px、底部约 140px），
// 打开书时先亮一下让用户看到进度，然后自动让开，避免长时间挡着文字。
function showReaderBarsTemporarily(delay = 3000) {
  cancelBarsAutoHide();
  setReaderBarsVisible(true);
  _barsAutoHideTimer = setTimeout(() => {
    _barsAutoHideTimer = null;
    setReaderBarsVisible(false);
  }, delay);
}

function toggleReaderBars() {
  cancelBarsAutoHide();           // 手动切换之后不再自动收起
  const header = document.getElementById('reader-header');
  setReaderBarsVisible(header.classList.contains('hidden'));
}

/* ========== 翻页方式 ========== */
function isPagedMode() {
  // PDF 是画布，不参与多列分页；它的"页"由章节索引承担
  return readerSettings.pageMode === 'paged' && !!currentBook && currentBook.format !== 'pdf';
}

// 是否启用左右点击区域（翻页模式下所有格式都启用；PDF 下左/右=上/下一页）
function tapZonesEnabled() {
  return readerSettings.pageMode === 'paged';
}

async function setPageMode(mode) {
  if (mode !== 'paged' && mode !== 'scroll') return;
  readerSettings.pageMode = mode;
  await saveSetting('pageMode', mode);
  applyPageModeUI();
  pageIndex = 0;
  paginate();
}

function applyPageModeUI() {
  const paged = readerSettings.pageMode === 'paged';

  // 菜单按钮高亮（限定在自己的容器内，避免影响"翻页动画"按钮）
  document.querySelectorAll('#pagemode-options .mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === readerSettings.pageMode);
  });

  // 点击区域
  document.getElementById('tap-zones').classList.toggle('active', tapZonesEnabled());

  // 上下滚动模式下，正文可滚动；翻页模式由 paginate() 接管
  const view = document.getElementById('reader-content');
  if (!paged) {
    // 滚动模式没有翻页动画，收掉可能残留的翻页层，并摘掉动画模式类
    finishPageFlip();
    view.classList.remove('paged');
    view.classList.remove('anim-slide', 'anim-flip', 'anim-none');
    view.scrollTop = 0;
    const inner = document.getElementById('paged-inner');
    if (inner) {
      inner.style.transform = '';
      inner.style.columnWidth = '';
      inner.style.columnGap = '';
      inner.style.height = '';
      inner.style.columnFill = '';
    }
    totalPages = 1;
  } else {
    // 切回左右翻页：把当前动画模式类补回去
    // （不能漏，否则 'none'/'flip' 会退化成基础规则的 0.2s 过渡）
    applyAnimUI();
  }
}

/* ========== 分页计算 ========== */
// 纯计算：由多列容器的总宽度推算页数。
// 抽成独立函数是为了能在没有真实布局的测试环境里验证这段数学。
function computePageCount(totalWidth, viewWidth, gap) {
  if (!viewWidth || viewWidth < 20) return 1;
  if (!totalWidth || totalWidth <= viewWidth) return 1;
  const step = viewWidth + gap;
  return Math.max(1, Math.round((totalWidth + gap) / step));
}

/* 分页几何：页宽 / 页间距 / 步长。
   这个公式原来在三处重复（paginate、applyPageTransform、翻页层），
   现在跟手拖动也要用同一套数值 —— 抽出来避免哪天改漏一处导致拖动手感错位。 */
const PAGE_GAP_MIN = 14;        // 最小页间距（同时用来吸收小数宽度的舍入误差）
const PAGE_GAP_RATIO = 0.04;    // 页间距占屏宽比例

function pageMetrics() {
  const view = document.getElementById('reader-content');
  const W = view ? view.clientWidth : 0;
  const GAP = Math.max(PAGE_GAP_MIN, Math.round(W * PAGE_GAP_RATIO));
  return { W, GAP, step: W + GAP };
}

function paginate(keepPage) {
  const view = document.getElementById('reader-content');
  const inner = document.getElementById('paged-inner');
  if (!view || !inner) return;

  if (!isPagedMode()) {
    applyPageModeUI();
    updateProgress();
    return;
  }

  view.classList.add('paged');

  const W = view.clientWidth;
  const H = view.clientHeight;
  if (W < 20 || H < 20) return;   // 还没布局好，稍后 resize 会再算

  const GAP = pageMetrics().GAP;

  // 先复位，才能量到真实总宽度
  inner.classList.add('no-anim');
  inner.style.transform = 'translateX(0)';
  inner.style.height = H + 'px';
  inner.style.columnWidth = W + 'px';
  inner.style.columnGap = GAP + 'px';
  inner.style.columnFill = 'auto';

  // 触发一次同步布局后再读取 scrollWidth
  const totalWidth = inner.scrollWidth;
  const pages = computePageCount(totalWidth, W, GAP);

  const prevPage = pageIndex;
  totalPages = pages;
  pageIndex = keepPage ? Math.min(prevPage, pages - 1) : 0;

  applyPageTransform();
  // 下一帧恢复过渡动画
  requestAnimationFrame(() => inner.classList.remove('no-anim'));
  updateProgress();
}

function applyPageTransform() {
  const inner = document.getElementById('paged-inner');
  if (!inner) return;
  const { step } = pageMetrics();
  inner.style.transform = `translateX(${-pageIndex * step}px)`;
}

/* ========== 翻页 ========== */
async function turnPage(dir) {
  if (!currentChapters.length) return;

  // 非分页模式（含 PDF）：左/右 = 上/下一章（PDF 即上/下一页）
  if (!isPagedMode()) {
    if (dir > 0) await nextChapter();
    else await prevChapter();
    return;
  }

  // 翻页 = 回到沉浸阅读：立刻收起上下栏。
  // 用户明确要求这个行为 —— 翻了页就说明在读正文，功能框让开别挡字。
  // 想再看到它们，点屏幕中间即可。
  hideReaderBars();

  const target = pageIndex + dir;

  // 越过本章开头 → 跳到上一章的最后一页
  if (target < 0) {
    if (currentChapterIndex > 0) {
      currentChapterIndex--;
      await renderCurrentChapter();
      pageIndex = Math.max(0, totalPages - 1);
      applyPageTransform();
      updateProgress();
      scheduleSaveProgress();
    }
    return;
  }

  // 越过本章结尾 → 跳到下一章第一页
  if (target >= totalPages) {
    if (currentChapterIndex < currentChapters.length - 1) {
      currentChapterIndex++;
      await renderCurrentChapter();
      pageIndex = 0;
      applyPageTransform();
      updateProgress();
      scheduleSaveProgress();
    }
    return;
  }

  // 同章内翻页：先让翻页层盖住当前页（只有 flip / cover 模式会真的盖），
  // 再瞬间把底层内容换到目标页，最后播放翻页动画。
  // 注意：换章时不播放翻页动画（正文要异步重新渲染，翻页层无法安全地盖住全过程）。
  startPageFlip(dir);   // 内部按当前页自行推算要展示哪一页

  pageIndex = target;
  applyPageTransform();
  updateProgress();
  // 关键：这里**不能** await 写数据库 —— 那会让事务在动画期间占用主线程造成掉帧。
  // 改为节流保存，连续翻页只在停下来之后写一次。
  scheduleSaveProgress();
}

/* ========== 翻页动画（'slide' 滑动 / 'flip' 仿真 / 'none' 无） ==========
   架构说明：正文是"单一多列元素"（#paged-inner），真正的书页卷曲（page curl）做不到。
   这里的"仿真"是：在 #reader-content 内动态插入一个翻页层 .page-flip-layer，
   它把当前要翻动的那一页 DOM 克隆一份（因此翻动时看到的是真实文字，而不是空白纸），
   再用 perspective + rotateY + 阴影渐变把它像纸一样翻过去。
   底层 #paged-inner 始终只做 translateX，因此 'slide' 的既有契约完全不变。 */

let _flipToken = 0;        // 每次翻页自增，用来丢弃过期的收尾回调
let _flipLayer = null;     // 动态创建的翻页层（不写进 index.html，故不缓存 id 查询）
let _flipEndHandler = null;

// 合法值只有四个；非法/缺失一律回落到默认（覆盖）
function normalizeAnimMode(mode) {
  return (mode === 'slide' || mode === 'cover' || mode === 'flip' || mode === 'none')
    ? mode
    : DEFAULT_ANIM;
}

// 高亮动画按钮 + 在正文容器上挂动画模式类 + 收掉残留的翻页层
function applyAnimUI() {
  const mode = normalizeAnimMode(readerSettings.anim);
  readerSettings.anim = mode;

  // 按钮高亮：与翻页方式无关，两种模式下都要正确显示当前选择
  document.querySelectorAll('#anim-options .anim-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.anim === mode);
  });

  // 动画模式类：只在「左右翻页」模式下挂。
  // 滚动模式挂上会残留（冷启动时 applyPageModeUI() 摘掉、紧接着本函数又加回去），
  // 虽然现有 CSS 都要求 .paged 所以无视觉影响，但会让
  // "scroll 模式下无 anim-* 类"这一不变式只在运行时切换路径成立。
  const view = document.getElementById('reader-content');
  if (view) {
    const paged = readerSettings.pageMode === 'paged';
    view.classList.toggle('anim-slide', paged && mode === 'slide');
    view.classList.toggle('anim-cover', paged && mode === 'cover');
    view.classList.toggle('anim-flip', paged && mode === 'flip');
    view.classList.toggle('anim-none', paged && mode === 'none');
  }

  // 只有会用到翻页层的模式才需要保留克隆，其它模式立刻收掉
  if (mode !== 'flip' && mode !== 'cover') finishPageFlip();
}

// 切换翻页动画设置（持久化到 IndexedDB settings 表）
async function setReaderAnim(mode) {
  if (mode !== 'slide' && mode !== 'cover' && mode !== 'flip' && mode !== 'none') return;
  readerSettings.anim = mode;
  await saveSetting('anim', mode);
  applyAnimUI();
}

// 懒创建翻页层：<div class="page-flip-layer"><div class="page-flip-shade"></div><div class="page-flip-page"></div></div>
function ensurePageFlipLayer() {
  const view = document.getElementById('reader-content');
  if (!view) return null;
  if (!_flipLayer || !_flipLayer.isConnected || _flipLayer.parentElement !== view) {
    _flipLayer = document.createElement('div');
    _flipLayer.className = 'page-flip-layer';
    const shade = document.createElement('div');
    shade.className = 'page-flip-shade';
    const page = document.createElement('div');
    page.className = 'page-flip-page';
    _flipLayer.appendChild(shade);
    _flipLayer.appendChild(page);
    view.appendChild(_flipLayer);
  }
  return _flipLayer;
}

/* 播放一次翻页层动画（'flip' 仿真 / 'cover' 覆盖）。

   语义：
     仿真 —— 克隆页绕 Y 轴翻转
     覆盖 —— **只有"当前页"一个元素在动**：
             前进时它向左滑出，露出已在底下就位的新页；
             后退时它向右滑回，露出底下的上一页。
             另一页全程原地不动 —— 这就是覆盖与平移（整条横向带一起动）的本质区别。

   实现要点：克隆的是整条 #paged-inner，所以只要平移它，
   相邻页自然出现在视口里——前进/后退可以共用同一个起点公式。 */
function startPageFlip(dir) {
  const mode = readerSettings.anim;
  if ((mode !== 'flip' && mode !== 'cover') || !isPagedMode()) return false;

  const view = document.getElementById('reader-content');
  const inner = document.getElementById('paged-inner');
  if (!view || !inner) return false;

  const layer = ensurePageFlipLayer();
  if (!layer) return false;

  const page = layer.querySelector('.page-flip-page');
  const shade = layer.querySelector('.page-flip-shade');
  if (!page || !shade) return false;

  const oldIndex = pageIndex;          // 此刻屏幕上显示的那一页（函数返回后调用方才切页）
  const newIndex = oldIndex + dir;
  // 仿真：前进展示"正在离开的页"，后退展示"即将到达的页"
  // 覆盖：两种方向都是"当前页在动"，所以固定展示旧页
  const snapIndex = mode === 'flip' ? (dir > 0 ? oldIndex : newIndex) : oldIndex;

  finishPageFlip();                    // 清掉上一场的残留（连点翻页时会重头播）
  const token = ++_flipToken;

  const { step } = pageMetrics();
  const clone = inner.cloneNode(true);
  clone.removeAttribute('id');
  clone.className = 'paged-inner no-anim';
  clone.style.transform = `translateX(${-snapIndex * step}px)`;

  if (mode === 'cover') {
    /* 坐标系要分清：克隆页本身已经把内容摆到"当前页"的位置了
       （clone.style.transform = -snapIndex * step，见上），
       所以外层包装只需要再做**一个页宽的相对位移**就够了。

       曾经这里写成了绝对位置（--cover-from = -snapIndex * step），
       于是和克隆的位移叠加、整体偏了一倍。第 1 页时序号为 0、两个值都是 0，
       歪打正着看不出问题 —— 页码越靠后偏得越离谱。 */
    page.style.setProperty('--cover-from', '0px');
    page.style.setProperty('--cover-to', `${-dir * step}px`);
  }

  page.textContent = '';
  page.appendChild(clone);

  // 复位 → 强制重排 → 再加动画类，保证动画一定会重新播放
  page.classList.remove('flip-forward', 'flip-backward', 'cover-anim', 'cover-drag');
  shade.classList.remove('flip-shade');
  layer.classList.add('active');
  page.classList.toggle('page-opaque', mode === 'cover');   // 覆盖必须不透明，否则底下的页会透出来
  void page.offsetWidth;

  if (mode === 'cover') {
    page.classList.add('cover-anim');
  } else {
    page.classList.add(dir > 0 ? 'flip-forward' : 'flip-backward');
    shade.classList.add('flip-shade');
  }

  _flipEndHandler = () => {
    if (token !== _flipToken) return;
    finishPageFlip();
  };
  page.addEventListener('animationend', _flipEndHandler);
  // 兜底：动画事件没来（例如系统开了"减少动态效果"）也要把层收掉
  setTimeout(() => {
    if (token === _flipToken) finishPageFlip();
  }, 700);

  return true;
}

// 收尾：隐藏翻页层、清空克隆内容、摘掉动画类（可重复调用）
function finishPageFlip() {
  _coverDrag = null;
  const inner = document.getElementById('paged-inner');
  if (inner) inner.classList.remove('no-anim');
  if (_flipLayer) {
    const page = _flipLayer.querySelector('.page-flip-page');
    const shade = _flipLayer.querySelector('.page-flip-shade');
    if (page && _flipEndHandler) {
      page.removeEventListener('animationend', _flipEndHandler);
      page.removeEventListener('transitionend', _flipEndHandler);
    }
    if (page) {
      page.classList.remove('flip-forward', 'flip-backward', 'cover-anim', 'cover-drag');
      page.style.removeProperty('--cover-from');
      page.style.removeProperty('--cover-to');
      page.textContent = '';
    }
    if (shade) shade.classList.remove('flip-shade');
    _flipLayer.classList.remove('active');
  }
  _flipEndHandler = null;
}

/* ========== 覆盖模式的跟手拖动 ==========
   和覆盖动画同一套模型：只有"当前页"在动，底下的相邻页原地不动。

   由于克隆的是整条横向带，一个公式就能同时覆盖两个方向：
       克隆页位移 = -当前页序号 × 步长 + 手指位移
   dx 为负 → 克隆页左移，露出底下的下一页；
   dx 为正 → 克隆页右移，露出底下的上一页。
   所以底层只需在拖动开始时切到"即将露出的那一页"即可。 */
let _coverDrag = null;   // { baseIndex, dir, step }

function coverLayerEls() {
  const layer = ensurePageFlipLayer();
  if (!layer) return null;
  const page = layer.querySelector('.page-flip-page');
  const clone = page && page.querySelector('.paged-inner');
  return (page && clone) ? { layer, page, clone } : null;
}

// 建立一次覆盖拖动（dir: 1 露出下一页 / -1 露出上一页）
function beginCoverDrag(dir) {
  const inner = document.getElementById('paged-inner');
  if (!inner) return false;

  const { step } = pageMetrics();
  const baseIndex = pageIndex;
  const neighbour = baseIndex + dir;
  if (neighbour < 0 || neighbour > totalPages - 1) return false;   // 到头了，不进入拖动

  const layer = ensurePageFlipLayer();
  if (!layer) return false;
  const page = layer.querySelector('.page-flip-page');
  if (!page) return false;

  // 克隆当前页放到覆盖层上（注意：克隆必须先建出来，
  // 后面的 coverLayerEls() 才有东西可查）
  const clone = inner.cloneNode(true);
  clone.removeAttribute('id');
  clone.className = 'paged-inner no-anim';
  clone.style.transition = 'none';
  clone.style.transform = `translateX(${-baseIndex * step}px)`;
  page.textContent = '';
  page.appendChild(clone);

  // 底层切到即将露出的那一页，并且全程不动
  inner.classList.add('no-anim');
  inner.style.transform = `translateX(${-neighbour * step}px)`;

  page.classList.remove('cover-anim', 'flip-forward', 'flip-backward', 'cover-drag');
  page.style.removeProperty('--cover-from');
  page.style.removeProperty('--cover-to');
  page.classList.add('page-opaque', 'cover-drag');
  layer.classList.add('active');

  _coverDrag = { baseIndex, dir, step };
  return true;
}

// 跟手更新：dx 为手指位移
function moveCoverDrag(dx) {
  if (!_coverDrag) return;
  const els = coverLayerEls();
  if (!els) return;
  const { baseIndex, step } = _coverDrag;
  els.clone.style.transform = `translateX(${-baseIndex * step + dx}px)`;
}

// 结束覆盖拖动：commit=true 顺势滑完并翻页，false 弹回原位
function endCoverDrag(commit) {
  const state = _coverDrag;
  _coverDrag = null;
  if (!state) return;

  const inner = document.getElementById('paged-inner');
  const els = coverLayerEls();
  const { baseIndex, dir, step } = state;
  const target = baseIndex + dir;

  if (els) {
    // 从"手指当前位置"平滑滑到终点（翻页）或滑回原位（取消）
    els.clone.style.transition = 'transform 0.24s cubic-bezier(0.22, 0.61, 0.36, 1)';
    els.clone.style.transform = `translateX(${-(commit ? target : baseIndex) * step}px)`;
  }
  if (inner) {
    inner.style.transform = `translateX(${-target * step}px)`;
  }

  const token = ++_flipToken;
  const finish = () => {
    if (token !== _flipToken) return;
    if (commit) pageIndex = target;
    finishPageFlip();                       // 会摘掉 no-anim 并清空克隆
    applyPageTransform();
    if (commit) { updateProgress(); scheduleSaveProgress(); }
  };
  // 用定时器收尾（而不是 transitionend）：克隆页可能被提前清掉，事件不一定来
  setTimeout(finish, 280);
}

/* ========== 滑动翻页 ========== */
// 刚处理过一次滑动时置位，短时间内忽略随后的 click。
// 原因：轻扫之后浏览器有时仍会补一个 click，若不管就会"一次滑动翻两页"。
// 用自失效标记而不是单纯比时间戳 —— 否则正常的快速点击也会被误伤。
let _suppressTapClick = false;
let _suppressTimer = null;

function suppressTapClick() {
  _suppressTapClick = true;
  clearTimeout(_suppressTimer);
  // 窗口取 250ms：浏览器在 touchend 之后补发的 click 通常只差几十毫秒，
  // 250ms 足够覆盖，又不至于把"滑动后马上点击"这种正常操作误伤掉。
  _suppressTimer = setTimeout(() => { _suppressTapClick = false; }, 250);
}

// 供点击区域使用：刚刚发生过滑动就不要再把这次手势当成点击
function swipeJustHandled() {
  return _suppressTapClick;
}

/* ========== 跟手拖动翻页 ==========
   效果：手指横向拖动时，当前页跟着手指走，相邻页从另一侧同步滑进来；
   松手后按"拖了多远 + 甩得多快"决定翻页还是弹回。

   为什么实现起来很自然：#paged-inner 是**一个超宽的多列元素**，
   所有页本来就在同一条横向带上并排躺着。所以只要在拖动时把
   translateX 加上手指位移，相邻页就自动露出来了 —— 不需要额外克隆或预渲染。
   这也是唯一能做出"跟手"手感的方式：动画必须由手指驱动，而不是松手后才播。 */

const DRAG_START_PX = 6;        // 超过这个位移才判定手势方向
const DRAG_SNAP_RATIO = 0.22;   // 拖过页宽的 22% 就翻页
const DRAG_FLICK_VELOCITY = 0.45;  // 快速轻甩的判定（px/ms）
const DRAG_FLICK_MIN_PX = 18;      // 甩动至少要走这么远，避免抖动误判
const DRAG_EDGE_DAMPING = 0.32;    // 到头了还硬拖时的阻尼

function initSwipe() {
  // 关键：不能在 #reader-content 上监听。
  // 翻页模式下载点击层 .tap-zones 覆盖在正文之上（z-index:5），
  // 真实触摸的 target 是 .tap-zones —— 它是 #reader-content 的**兄弟**而非子孙，
  // 事件不会冒泡到 #reader-content，监听器永远不会被触发（滑动翻页曾经因此完全失效）。
  // 改挂到它们的共同祖先 #page-reader 上。
  const page = document.getElementById('page-reader');
  let startX = 0, startY = 0, startT = 0;
  let tracking = false;     // 有一次可能是翻页手势的触摸
  let dragging = false;     // 已确认是横向拖动，正在跟手
  let dragMode = null;      // 'slide'（整条带一起动）或 'cover'（只有当前页动）
  let fallbackSwipe = false;// 覆盖模式下跨章拖动：不预铺相邻章，退化成"松手判定"
  let dx = 0;               // 当前手指位移
  let baseOffset = 0;       // 拖动开始时的基准位移
  let samples = [];         // 最近几次触摸的 {x, t}，用来算"甩"的瞬时速度

  /* 沿 dir 方向还有没有可去的页 —— 必须把"跨章"算进来。
     以前这里只判"本章内还有没有页"，于是漏掉两个真实场景：
       本章第 1 页往回翻 → 应该去**上一章的最后一页**；
       本章最后一页往前翻 → 应该去**下一章的下一页**（第 1 页）。
     漏掉时手势会被当成"到头了"直接弹回 / 整段手势作废，
     用户看到的就是「为什么我翻前一页，如果是上一章的内容翻不了」。 */
  function neighbourExists(dir) {
    if (!currentChapters.length) return false;
    if (dir > 0) return pageIndex < totalPages - 1 || currentChapterIndex < currentChapters.length - 1;
    return pageIndex > 0 || currentChapterIndex > 0;
  }

  // 从这些区域开始的触摸不算翻页手势
  function isUiTarget(el) {
    return !!(el && el.closest &&
      (el.closest('#reader-header') || el.closest('#reader-footer') ||
       el.closest('#reader-menu') || el.closest('.toc-panel')));
  }

  function endDrag() {
    const inner = document.getElementById('paged-inner');
    if (inner) inner.classList.remove('dragging');
    dragging = false;
    dragMode = null;
    fallbackSwipe = false;
    dx = 0;
  }

  page.addEventListener('touchstart', (e) => {
    tracking = false;
    dragging = false;
    dragMode = null;
    fallbackSwipe = false;
    samples = [];
    if (!tapZonesEnabled() || e.touches.length !== 1) return;
    if (isUiTarget(e.target)) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    startT = Date.now();
    samples.push({ x: t.clientX, t: startT });
    tracking = true;
  }, { passive: true });

  page.addEventListener('touchmove', (e) => {
    if (!tracking || e.touches.length !== 1) return;
    const t = e.touches[0];
    const curDx = t.clientX - startX;
    const curDy = t.clientY - startY;

    if (!dragging) {
      // 先判方向：位移太小先不表态；纵向为主就放弃（不干扰原生滚动）
      if (Math.abs(curDx) < DRAG_START_PX && Math.abs(curDy) < DRAG_START_PX) return;
      if (Math.abs(curDy) > Math.abs(curDx)) { tracking = false; return; }
      if (!currentChapters.length) { tracking = false; return; }

      // 确认是横向拖动 —— 开始跟手
      hideReaderBars();                  // 开始翻页就收起上下栏

      if (readerSettings.anim === 'cover') {
        // 覆盖：只有"当前页"在动，底下的相邻页原地不动
        const dir = curDx < 0 ? 1 : -1;
        if (!beginCoverDrag(dir)) {
          /* 覆盖层只能克隆"本章这一条横向带"，跨章时相邻章还没渲染、没法预铺在底下，
             所以这里进不了跟手拖动。但**不能因此把整段手势作废** ——
             那正是"往回翻到上一章没反应"的根源（连拖动反馈都没有）。
             退化成"轻扫翻章"：继续跟踪手势（不做跟手动画），松手时按位移/速度判定翻页。 */
          if (!neighbourExists(dir)) { tracking = false; return; }   // 真的到头了（全书首页/末页）
          fallbackSwipe = true;
          dragging = true;
          return;
        }
        dragMode = 'cover';
      } else {
        // 平移：整条横向带一起动
        const inner = document.getElementById('paged-inner');
        if (!inner) { tracking = false; return; }
        inner.classList.add('dragging');  // 关掉过渡，位移必须即时跟手
        baseOffset = -pageIndex * pageMetrics().step;
        dragMode = 'slide';
      }
      dragging = true;
    }

    dx = curDx;
    // 记录采样点（最多留 6 个，够算瞬时速度又不占内存）
    samples.push({ x: t.clientX, t: Date.now() });
    if (samples.length > 6) samples.shift();

    // 跨章覆盖拖动：不做跟手动画（相邻章还没预铺），只留采样点供松手判定
    if (fallbackSwipe) return;

    if (dragMode === 'cover') {
      moveCoverDrag(dx);
      return;
    }

    // 到头了还往外拖 → 加阻尼，给出"拉不动"的手感
    const { step } = pageMetrics();
    const minOffset = -(totalPages - 1) * step;
    let offset = baseOffset + dx;
    if (offset > 0) offset *= DRAG_EDGE_DAMPING;
    else if (offset < minOffset) offset = minOffset + (offset - minOffset) * DRAG_EDGE_DAMPING;

    const inner = document.getElementById('paged-inner');
    if (inner) inner.style.transform = `translateX(${offset}px)`;
  }, { passive: true });

  page.addEventListener('touchend', (e) => {
    const t = e.changedTouches && e.changedTouches[0];
    const wasDragging = dragging;
    const lastMoveDx = dx;
    const dt = Math.max(1, Date.now() - startT);

    // ---- 先处理"跟手拖动"的收尾 ----
    if (wasDragging) {
      // 必须在 endDrag() 之前取出模式：它会把 dragMode 清成 null，
      // 之后再判断 dragMode === 'cover' 就永远不成立了（覆盖层会一直留在屏幕上）。
      const mode = dragMode;
      tracking = false;
      endDrag();

      if (isUiTarget(e.target)) {
        if (mode === 'cover') endCoverDrag(false);
        else applyPageTransform();
        return;
      }

      // 以"抬手位置"为准。最后一次 touchmove 之后手指往往还会挪一点，
      // 只看 move 会误判翻不翻页（也会让"拖回来再松手"失效）。
      const dxEnd = t ? (t.clientX - startX) : lastMoveDx;
      const endX = t ? t.clientX : startX + lastMoveDx;

      const { W } = pageMetrics();

      /* 甩动速度只取**最后一段**的瞬时速度，不能用"总位移 ÷ 总时间"：
         后者会把"拖出去又拖回来"也当成甩动，于是松手时明明停在原地却翻了页。
         这里用最后两个采样点，并且要求甩动方向与抬手方向一致。 */
      samples.push({ x: endX, t: Date.now() });
      const n = samples.length;
      const a = n >= 2 ? samples[n - 2] : { x: startX, t: startT };
      const b = samples[n - 1];
      const segDt = Math.max(1, b.t - a.t);
      const velocity = (b.x - a.x) / segDt;              // px/ms，带方向

      const dir = dxEnd < 0 ? 1 : -1;                    // 向左拖 = 下一页
      const flickDir = velocity < 0 ? 1 : -1;
      const farEnough = Math.abs(dxEnd) > W * DRAG_SNAP_RATIO;
      const flicked = Math.abs(velocity) > DRAG_FLICK_VELOCITY &&
                      flickDir === dir &&                  // 甩的方向要和抬手方向一致
                      Math.abs(dxEnd) > DRAG_FLICK_MIN_PX;

      // 到头了就不翻。"头"是**全书**的边界，不是本章的边界：
      // 本章第 1 页往回 = 上一章最后一页，本章最后一页往前 = 下一章第 1 页。
      // （以前只看本章页码，章首往回拖会被误判成"到头"，直接弹回 —— 用户报的"翻不了"。）
      const canTurn = neighbourExists(dir);

      const commit = canTurn && (farEnough || flicked);

      if (mode === 'cover') {
        // 覆盖：让克隆的当前页顺势滑完（或弹回），底层相邻页全程没动过
        suppressTapClick();
        endCoverDrag(commit);
        return;
      }

      if (commit) {
        suppressTapClick();      // 别让这次拖动被当成点击
        turnPage(dir);
      } else {
        applyPageTransform();    // 没到阈值 → 弹回原位（.dragging 已移除，过渡生效）
      }
      return;
    }

    // ---- 没进入跟手：可能是轻扫或点击 ----
    if (!tracking) return;
    tracking = false;
    if (!t) return;
    if (isUiTarget(e.target)) return;

    const dxEnd = t.clientX - startX;
    const dyEnd = t.clientY - startY;

    // 横向位移要够明显，且明显大于纵向位移（避免和选择文字、纵向滚动冲突）
    // 快速轻扫（<300ms）放宽到 30px，慢拖仍要求 50px
    const minDist = dt < 300 ? 30 : 50;
    if (Math.abs(dxEnd) < minDist || Math.abs(dxEnd) < Math.abs(dyEnd) * 1.2) return;

    suppressTapClick();
    turnPage(dxEnd < 0 ? 1 : -1);   // 向左滑=下一页，向右滑=上一页
  }, { passive: true });

  // 手势被系统打断（来电、多指等）时要收回状态，否则会卡在拖动中
  page.addEventListener('touchcancel', () => {
    const wasCover = dragMode === 'cover';
    tracking = false;
    if (dragging) {
      endDrag();
      if (wasCover) endCoverDrag(false);   // 覆盖：让当前页滑回原位
      else applyPageTransform();
    }
  }, { passive: true });
}

/* ========== 窗口变化时重新分页 ========== */
function initResizeRepaginate() {
  const handler = () => {
    if (!isPagedMode()) return;
    clearTimeout(_paginateTimer);
    _paginateTimer = setTimeout(() => paginate(true), 150);
  };
  window.addEventListener('resize', handler);
  window.addEventListener('orientationchange', handler);
}

// 打开并加载书籍
async function loadBook(book) {
  currentBook = book;
  currentChapters = [];
  currentChapterIndex = book.currentChapter || 0;
  pageIndex = book.currentPage || 0;

  // 换书时收掉可能开着的目录弹窗，并回到目录页签
  closeToc();
  tocTab = 'chapters';
  tocOrderDesc = false;
  document.querySelectorAll('#toc-tabs .toc-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'chapters');
  });
  document.getElementById('toc-order-label').textContent = '倒序';

  document.getElementById('reader-title').textContent = book.title;
  getContentInner().innerHTML = '<div class="reader-loading">加载中...</div>';

  // 打开书时先亮出上下栏（让用户看到进度和章节），几秒后自动让开，
  // 因为上下栏是浮层，长时间显示会挡住正文
  showReaderBarsTemporarily();

  try {
    const parseResult = await parseBookWithRetry(book);
    currentChapters = parseResult.chapters;
    
    // 如果章节索引超出范围
    if (currentChapterIndex >= currentChapters.length) {
      currentChapterIndex = 0;
      pageIndex = 0;
    }
    
    // 渲染当前章节
    await renderCurrentChapter();
    // 恢复上次读到的页（等分页算完再定位）
    if (isPagedMode() && pageIndex > 0) {
      pageIndex = Math.min(pageIndex, totalPages - 1);
      applyPageTransform();
    }
    updateProgress();
  } catch (err) {
    console.error('加载书籍失败:', err);
    getContentInner().innerHTML =
      `<div class="loading-error">
        <p class="loading-error-title">加载失败</p>
        <p class="loading-error-msg">${escapeHtml(describeStorageError(err))}</p>
        <p class="loading-error-hint">可以试试：返回书架重新打开；或刷新页面。若一直失败，请重新导入这本书。</p>
      </div>`;
  }
}

/* 取书的原始文件。

   书架列表现在只带元数据（不含文件），所以文件要从 files 表里取。
   如果传进来的 book 自带 fileData（测试或旧路径），就直接用它。 */
async function resolveBookFile(book) {
  if (book.fileData) return book.fileData;
  if (typeof getBookFile !== 'function') return null;
  try {
    return await getBookFile(book.id);
  } catch (e) {
    console.warn('读取书籍文件失败', e);
    return null;
  }
}

/* 解析书籍内容，并在读取失败时重试一次。

   为什么要重试：Safari/WebKit 的 IndexedDB Blob 由临时文件支撑，
   在某些情况下会短暂读不出来（报 NotFoundError: The object can not be found here.），
   重新取一次文件往往就能恢复。这比直接告诉用户"加载失败"有用得多。 */
async function parseBookWithRetry(book) {
  const doParse = (file) => {
    switch (book.format) {
      case 'txt':  return parseTxt(file);
      case 'epub': return parseEpub(file, book.id);
      case 'pdf':  return parsePdf(file, book.id);
      case 'docx': return parseDocx(file);
      default:     throw new Error('不支持的格式：' + book.format);
    }
  };

  const file = await resolveBookFile(book);
  if (!file) {
    throw new Error('这本书的原始文件没找到（浏览器可能清理过本站存储）。请重新导入这本书。');
  }

  try {
    return await doParse(file);
  } catch (err) {
    console.warn('首次解析失败，重新取一次文件再试:', err);
    const fresh = await resolveBookFile(book);   // 从存储重新取
    if (!fresh || fresh === file) throw err;
    return await doParse(fresh);
  }
}

// 正文内层容器（所有正文都写进这里）
function getContentInner() {
  return document.getElementById('paged-inner') || document.getElementById('reader-content');
}

// 渲染当前章节
async function renderCurrentChapter() {
  const inner = getContentInner();

  // 换章会整体替换正文，收掉可能还在播的翻页层（换章本身不做翻页动画）
  finishPageFlip();

  if (!currentChapters.length || currentChapterIndex >= currentChapters.length) {
    inner.innerHTML = '<div class="reader-loading">无内容</div>';
    totalPages = 1;
    pageIndex = 0;
    return;
  }

  const chapter = currentChapters[currentChapterIndex];

  if (currentBook.format === 'pdf') {
    // PDF 渲染（画布不参与多列分页）
    await renderPdfPage(chapter.pageNum);
  } else {
    // 文本渲染
    let paras = chapter.content.split('\n').filter(p => p.trim());

    // 保险：极端情况下单章仍可能过长（解析时已按字数切分，这里再兜一层），
    // 宁可只渲染一部分并明确告知，也不要让手机长时间卡死。
    let truncated = 0;
    if (paras.length > MAX_RENDER_PARAGRAPHS) {
      truncated = paras.length - MAX_RENDER_PARAGRAPHS;
      paras = paras.slice(0, MAX_RENDER_PARAGRAPHS);
    }

    let html = paras.map(p => `<p>${escapeHtml(p.trim())}</p>`).join('');
    if (truncated > 0) {
      html += `<p class="render-notice">（本章内容过长，仅显示前 ${MAX_RENDER_PARAGRAPHS} 段，
        其余 ${truncated} 段未渲染。建议把该文件按章节拆分后重新导入。）</p>`;
    }

    inner.innerHTML = html || '<p>（空章节）</p>';
  }

  applyReaderStyles();

  // 换章后回到第一页并重新分页
  pageIndex = 0;
  paginate();
  // 布局可能还没稳定（图片/字体），下一帧再校准一次
  requestAnimationFrame(() => {
    if (isPagedMode()) paginate(true);
  });

  // 更新按钮状态
  document.getElementById('btn-prev-chapter').disabled = currentChapterIndex === 0;
  document.getElementById('btn-next-chapter').disabled = currentChapterIndex >= currentChapters.length - 1;
}

// PDF 页面渲染
let _renderToken = 0;

async function renderPdfPage(pageNum) {
  const contentEl = getContentInner();
  contentEl.innerHTML = '<div class="reader-loading">渲染中...</div>';

  // 防止快速翻页时旧渲染覆盖新页面
  const token = ++_renderToken;

  try {
    // 优先复用已解析的文档对象，避免每页重新解析整个 PDF
    let pdf = window._pdfDocs && window._pdfDocs[currentBook.id];

    if (!pdf) {
      const url = window._pdfBlobs && window._pdfBlobs[currentBook.id];
      if (!url) throw new Error('PDF 数据丢失');

      if (!window._pdfDocs) window._pdfDocs = {};
      const loadingTask = pdfjsLib.getDocument(url);
      pdf = await loadingTask.promise;
      window._pdfDocs[currentBook.id] = pdf;
    }

    const page = await pdf.getPage(pageNum);
    if (token !== _renderToken) return; // 已被更新的渲染取代

    const baseViewport = page.getViewport({ scale: 1 });

    // 适应屏幕宽度，并按设备像素比渲染以保证清晰度
    const maxWidth = Math.min(window.innerWidth - 32, 900);
    const cssScale = maxWidth / baseViewport.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    const renderViewport = page.getViewport({ scale: cssScale * dpr });
    const cssViewport = page.getViewport({ scale: cssScale });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    canvas.style.width = Math.floor(cssViewport.width) + 'px';
    canvas.style.height = 'auto';
    canvas.style.maxWidth = '100%';
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';

    await page.render({
      canvasContext: ctx,
      viewport: renderViewport
    }).promise;

    if (token !== _renderToken) return;

    contentEl.innerHTML = '';
    contentEl.appendChild(canvas);
  } catch (err) {
    if (token !== _renderToken) return;
    contentEl.innerHTML = `<div class="reader-loading">PDF 渲染失败：${escapeHtml(err.message)}</div>`;
  }
}

// 应用阅读样式
function applyReaderStyles() {
  const contentEl = document.getElementById('reader-content');
  contentEl.style.fontSize = readerSettings.fontSize + 'px';
  contentEl.style.lineHeight = readerSettings.lineHeight;
}

// 字号 / 行间距变化后，列宽不变但每页容纳的字数变了，需要重新分页
function scheduleRepaginate() {
  clearTimeout(_paginateTimer);
  _paginateTimer = setTimeout(() => {
    if (isPagedMode()) paginate(true);
  }, 160);
}

// 应用主题
function applyTheme(theme) {
  document.body.className = document.body.className
    .replace(/theme-\w+/g, '')
    .trim();
  if (theme) {
    document.body.classList.add('theme-' + theme);
  }
  
  // 更新主题按钮高亮（必须限定在 #theme-options 内：
  // .mode-btn / .anim-btn 也带 theme-btn 类且没有 data-theme，
  // 全文档查询会把它们的高亮一并清掉）
  document.querySelectorAll('#theme-options .theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
}

// 上一章
async function prevChapter() {
  if (currentChapterIndex > 0) {
    currentChapterIndex--;
    await renderCurrentChapter();
    updateProgress();
    scheduleSaveProgress();
  }
}

// 下一章
async function nextChapter() {
  if (currentChapterIndex < currentChapters.length - 1) {
    currentChapterIndex++;
    await renderCurrentChapter();
    updateProgress();
    scheduleSaveProgress();
  }
}

// 跳到指定章节（进度条、目录都用它）
async function jumpToChapter(idx) {
  if (!currentChapters.length) return;
  idx = Math.max(0, Math.min(currentChapters.length - 1, idx));
  if (idx === currentChapterIndex) {
    syncChapterSlider();
    return;
  }
  currentChapterIndex = idx;
  pageIndex = 0;
  await renderCurrentChapter();
  updateProgress();
  scheduleSaveProgress();
}

// 章节进度条与当前章节保持同步
function syncChapterSlider() {
  const slider = document.getElementById('chapter-slider');
  if (!slider) return;
  const max = Math.max(0, currentChapters.length - 1);
  const maxStr = String(max);
  const valStr = String(currentChapterIndex);
  const disabled = max === 0;

  // 只在值真的变了才写 DOM —— 每次翻页都无脑赋值会触发多余的样式重算
  if (slider.max !== maxStr) slider.max = maxStr;
  if (slider.disabled !== disabled) slider.disabled = disabled;
  if (slider.value !== valStr) slider.value = valStr;
}

/* 目录开着时，只更新"当前章"的选中态。

   以前是每次进度变化都重新 renderToc()，而这本书有 3013 章 ——
   等于每翻一页就把 3000 多个节点重建一遍，正文动画必然掉帧。
   现在只切换两个节点的 class。 */
function syncTocCurrent() {
  const listEl = document.getElementById('toc-list');
  if (!listEl) return;
  const cur = listEl.querySelector('.toc-item.current');
  const next = listEl.querySelector(`.toc-item[data-chapter="${currentChapterIndex}"]`);
  if (cur === next) return;
  if (cur) cur.classList.remove('current');
  if (next) next.classList.add('current');
}

// 计算全书进度（翻页模式下精确到页，比只按章算更准）
function calcProgress() {
  if (!currentChapters.length) return 0;
  let ratio = (currentChapterIndex + 1) / currentChapters.length;
  if (isPagedMode() && totalPages > 1) {
    ratio = (currentChapterIndex + (pageIndex + 1) / totalPages) / currentChapters.length;
  }
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

// 更新进度
function updateProgress() {
  if (!currentChapters.length) return;

  const title = currentChapters[currentChapterIndex]?.title || '';
  const pageInfo = (isPagedMode() && totalPages > 1)
    ? ` · ${pageIndex + 1}/${totalPages}页`
    : '';

  document.getElementById('progress-text-bottom').textContent =
    `${calcProgress()}% · ${title}${pageInfo}`;

  syncChapterSlider();

  // 目录开着时，只更新选中项（不重建整个列表，那样每翻一页要重建几千个节点）
  if (document.getElementById('toc-panel')?.style.display === 'block') {
    syncTocCurrent();
  }
}

/* ========== 白天 / 夜间快捷切换 ========== */
async function toggleDayNight() {
  const isDark = readerSettings.theme === 'dark';
  if (isDark) {
    // 回到上次用的浅色主题，默认暖黄
    readerSettings.theme = readerSettings.lastLightTheme || 'warm';
  } else {
    // 记住当前浅色主题，方便切回来
    readerSettings.lastLightTheme = readerSettings.theme;
    await saveSetting('lastLightTheme', readerSettings.theme);
    readerSettings.theme = 'dark';
  }
  applyTheme(readerSettings.theme);
  applyAnimUI();          // 与主题一起刷新底部工具高亮
  updateDayNightUI();
  await saveSetting('theme', readerSettings.theme);
}

// 底部「白天/夜间」按钮的图标与文案
// 文案表示"点它去哪里"（与参考 App 一致）：夜间时显示「白天」，白天时显示「夜间」
function updateDayNightUI() {
  const isDark = readerSettings.theme === 'dark';
  const label = document.getElementById('daynight-label');
  const btn = document.getElementById('btn-daynight');
  if (label) label.textContent = isDark ? '白天' : '夜间';
  if (btn) btn.classList.toggle('is-dark', isDark);
}

/* ========== 目录 / 书摘 弹窗 ========== */
let tocTab = 'chapters';      // 'chapters' | 'marks'
let tocOrderDesc = false;     // 目录是否倒序

function openToc() {
  if (!currentBook) return;
  const panel = document.getElementById('toc-panel');
  panel.style.display = 'block';

  document.getElementById('toc-book-title').textContent = currentBook.title || '未命名';
  // 按格式给图标上不同的颜色（CSS 里 .fmt-xxx 负责），保留格式提示又不花哨
  const fmt = currentBook.format || 'txt';
  document.getElementById('toc-cover').innerHTML =
    icon('book', { size: 28, class: 'fmt-' + fmt });

  setTocTab(tocTab);
}

function closeToc() {
  document.getElementById('toc-panel').style.display = 'none';
}

function setTocTab(tab) {
  tocTab = (tab === 'marks') ? 'marks' : 'chapters';
  document.querySelectorAll('#toc-tabs .toc-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tocTab);
  });
  // 「共 N 章 / 倒序」只在目录页有意义
  document.getElementById('toc-meta').style.display = (tocTab === 'chapters') ? 'flex' : 'none';
  renderToc();
}

function toggleTocOrder() {
  tocOrderDesc = !tocOrderDesc;
  document.getElementById('toc-order-label').textContent = tocOrderDesc ? '正序' : '倒序';
  renderToc();
}

// 渲染目录列表（章节来自解析器的自动分章结果）
async function renderToc() {
  const listEl = document.getElementById('toc-list');
  if (!listEl) return;

  // ---- 书摘页：本书的书签 ----
  if (tocTab === 'marks') {
    let marks = [];
    try {
      marks = (await getAllBookmarks())
        .filter(m => m.bookId === currentBook?.id)
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch (e) {
      console.warn('读取书摘失败', e);
    }

    if (!marks.length) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${icon('bookmark', { size: 52 })}</div>
          <p>本书暂无书摘</p>
          <p class="empty-hint">阅读时点右上角的书签按钮添加</p>
        </div>`;
      return;
    }

    listEl.innerHTML = marks.map(m => `
      <div class="toc-item" data-chapter="${m.chapterIndex}" data-page="${m.page || 0}">
        <span class="toc-item-title">${escapeHtml(m.chapterTitle || '')} · ${escapeHtml((m.preview || '').slice(0, 30))}</span>
      </div>`).join('');
    return;
  }

  // ---- 目录页：自动识别的章节 ----
  const total = currentChapters.length;
  document.getElementById('toc-count').textContent = `共 ${total} 章`;

  if (!total) {
    listEl.innerHTML = `<div class="empty-state"><p>没有识别到章节</p>
      <p class="empty-hint">本书可能没有章节标记，将作为单章显示</p></div>`;
    return;
  }

  const idxs = currentChapters.map((_, i) => i);
  if (tocOrderDesc) idxs.reverse();

  listEl.innerHTML = idxs.map(i => {
    const title = currentChapters[i].title || `第${i + 1}章`;
    return `<div class="toc-item${i === currentChapterIndex ? ' current' : ''}" data-chapter="${i}">
        <span class="toc-item-title">${escapeHtml(title)}</span>
      </div>`;
  }).join('');

  // 打开时把当前章滚到可见位置
  const cur = listEl.querySelector('.toc-item.current');
  if (cur && typeof cur.scrollIntoView === 'function') {
    requestAnimationFrame(() => {
      try { cur.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
    });
  }
}

/* ---------- 进度写入的节流 ----------
   翻页时不要每次都写数据库。一次 IndexedDB 事务（读取、结构化克隆、提交）
   全在主线程上执行，而它恰好落在 0.28s 的翻页动画播放期间 —— 这就是卡顿的根源。
   改成"停下来之后再写"：连续快速翻页只会写一次。
   离开阅读器、切后台、关页面时仍会立即落盘（见 flushSaveProgress）。 */
let _saveProgressTimer = null;
let _saveProgressPending = false;

function scheduleSaveProgress(delay = 900) {
  _saveProgressPending = true;
  clearTimeout(_saveProgressTimer);
  _saveProgressTimer = setTimeout(() => {
    _saveProgressTimer = null;
    if (!_saveProgressPending) return;
    _saveProgressPending = false;
    saveCurrentProgress();
  }, delay);
}

// 立即保存（离开阅读器 / 切后台时调用）
function flushSaveProgress() {
  if (_saveProgressTimer) {
    clearTimeout(_saveProgressTimer);
    _saveProgressTimer = null;
  }
  if (!_saveProgressPending) return Promise.resolve();
  _saveProgressPending = false;
  return saveCurrentProgress();
}

// 保存进度
async function saveCurrentProgress() {
  if (!currentBook || !currentChapters.length) return;

  // 合并成一次写入。
  // 以前是 4 次 updateBookField，而文档记录里带着 fileData（整本小说），
  // IndexedDB 又是整条读写 —— 等于每翻一页就把整本书重写 4 遍。
  try {
    await updateBookFields(currentBook.id, {
      progress: calcProgress(),
      currentChapter: currentChapterIndex,
      currentPage: pageIndex,
      lastReadAt: Date.now()
    });
    currentBook.progress = calcProgress();
    currentBook.currentChapter = currentChapterIndex;
    currentBook.currentPage = pageIndex;
    currentBook.lastReadAt = Date.now();
  } catch (err) {
    // 进度存不上不该影响阅读，更不该冒泡成未处理异常
    console.warn('保存阅读进度失败', err);
  }
}

/* ========== 书签 ========== */
async function addBookmark() {
  if (!currentBook || !currentChapters.length) return;

  const chapter = currentChapters[currentChapterIndex];
  const contentEl = document.getElementById('reader-content');
  const paged = isPagedMode();

  // 滚动模式记滚动位置；翻页模式记页码
  const scrollPos = paged ? 0 : contentEl.scrollTop;

  // 预览文字：翻页模式按当前页占比估算，滚动模式取已滚过的位置
  let preview = '';
  const text = chapter?.content || '';
  if (text) {
    let ratio = 0;
    if (paged && totalPages > 1) {
      ratio = pageIndex / totalPages;
    } else if (!paged) {
      const maxScroll = contentEl.scrollHeight - contentEl.clientHeight;
      ratio = maxScroll > 0 ? contentEl.scrollTop / maxScroll : 0;
    }
    const start = Math.floor(text.length * ratio);
    preview = text.slice(start, start + 50).replace(/\s+/g, ' ').trim();
  }

  const bookmark = {
    id: generateId(),
    bookId: currentBook.id,
    bookTitle: currentBook.title,
    chapterIndex: currentChapterIndex,
    chapterTitle: chapter?.title || '',
    scrollPosition: scrollPos,
    page: paged ? pageIndex : 0,
    preview: preview || (chapter?.title || ''),
    createdAt: Date.now()
  };

  await saveBookmark(bookmark);
  showToast('已添加书签');
}

async function showBookmarkList() {
  const listEl = document.getElementById('bookmark-list');
  const bookmarks = await getAllBookmarks();

  if (bookmarks.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${icon('bookmark', { size: 52 })}</div>
        <p>暂无书签</p>
        <p class="empty-hint">阅读时点右上角的书签按钮即可添加</p>
      </div>`;
    return;
  }
  
  listEl.innerHTML = bookmarks
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(bm => `
      <div class="bookmark-item" data-book-id="${bm.bookId}" data-chapter="${bm.chapterIndex}" data-scroll="${bm.scrollPosition || 0}" data-page="${bm.page || 0}">
        <div class="bookmark-info">
          <div class="bookmark-book">${escapeHtml(bm.bookTitle)}</div>
          <div class="bookmark-preview">${escapeHtml(bm.chapterTitle)} · ${escapeHtml(bm.preview)}</div>
        </div>
        <div class="bookmark-time">${formatTime(bm.createdAt)}</div>
        <button class="bookmark-delete" data-id="${bm.id}" aria-label="删除书签">${icon('close', { size: 15 })}</button>
      </div>
    `).join('');

  // 绑定点击事件
  listEl.querySelectorAll('.bookmark-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.classList.contains('bookmark-delete')) return;

      const bookId = item.dataset.bookId;
      const chapterIdx = parseInt(item.dataset.chapter) || 0;
      const scrollPos = parseInt(item.dataset.scroll) || 0;
      const pageIdx = parseInt(item.dataset.page) || 0;

      const book = await getBook(bookId);
      if (book) {
        window._currentBook = book;
        currentBook = book;
        currentChapterIndex = chapterIdx;
        pageIndex = pageIdx;
        await loadBook(book);

        // 恢复到书签保存的阅读位置
        requestAnimationFrame(() => {
          if (isPagedMode() && pageIdx > 0) {
            pageIndex = Math.min(pageIdx, totalPages - 1);
            applyPageTransform();
            updateProgress();
          } else if (scrollPos > 0) {
            document.getElementById('reader-content').scrollTop = scrollPos;
          }
        });

        window._readerLoaded = true; // 防止 navigateTo 重复加载
        navigateTo('reader');
      }
    });
  });
  
  // 绑定删除
  listEl.querySelectorAll('.bookmark-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await deleteBookmark(id);
      showBookmarkList();
    });
  });
}

/* ========== 阅读器菜单 ========== */
function toggleReaderMenu() {
  document.getElementById('reader-menu').style.display = 'block';
}

function hideReaderMenu() {
  document.getElementById('reader-menu').style.display = 'none';
}

/* ========== Toast 提示 ========== */
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// 格式化时间
function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  
  return `${d.getMonth() + 1}/${d.getDate()}`;
}