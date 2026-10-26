/* ========== 书架管理 ========== */

/* 长按书籍卡片：多久算"长按"，以及移动多少像素就算"在滚动、不是长按"。
   原来写死 600ms，按住要等挺久才有反应，手感迟钝；这里调到 380ms。
   移动阈值是必须的：手指按住时几乎都有 1~2px 抖动，
   如果用"只要 touchmove 就取消"，长按会很难触发。 */
const LONG_PRESS_MS = 380;
const LONG_PRESS_MOVE_PX = 10;

// 当前状态
let currentCategory = 'all';
let searchQuery = '';
let books = [];

// 分类列表（持久化）
let customCategories = [];

// 当前排序方式（持久化到 settings.shelfSort）
// recent=最近阅读 / title=书名 / added=导入时间 / progress=阅读进度
let shelfSortMode = 'recent';

async function initShelf() {
  // 加载自定义分类
  customCategories = await getSetting('categories', []);
  renderCategoryTabs();

  // 读取上次选择的排序方式（损坏/越界时 updateSortTabsUI 会回退到 recent）
  shelfSortMode = await getSetting('shelfSort', 'recent');
  updateSortTabsUI();
  
  // 绑定事件
  document.getElementById('btn-import').addEventListener('click', toggleImportPanel);
  document.getElementById('btn-bookmarks').addEventListener('click', () => navigateTo('bookmarks'));
  document.getElementById('btn-import-close').addEventListener('click', () => hideImportPanel());
  
  // 导入：选择文件
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // 重置，允许重复选择同一文件
    await handleFileImport(files);
  });

  // 导入：压缩包
  const zipInput = document.getElementById('zip-input');
  zipInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // 重置，允许重复选择同一文件
    await handleZipImport(files);
  });
  
  // 搜索
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    document.getElementById('btn-search-clear').style.display = searchQuery ? 'block' : 'none';
    renderBooks();
  });
  
  document.getElementById('btn-search-clear').addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    document.getElementById('btn-search-clear').style.display = 'none';
    renderBooks();
  });
  
  // 分类切换
  document.getElementById('category-tabs').addEventListener('click', (e) => {
    if (e.target.classList.contains('cat-tab')) {
      document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      currentCategory = e.target.dataset.cat;
      renderBooks();
    }
  });

  // 排序方式切换（#sort-tabs 的按钮由 index.html 提供，用事件委托避免漏绑）
  const sortTabs = document.getElementById('sort-tabs');
  if (sortTabs) {
    sortTabs.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.sort-btn') : null;
      if (!btn || !sortTabs.contains(btn)) return;
      setShelfSort(btn.dataset.sort);
    });
  }
  
  // 点击遮罩关闭导入面板
  document.querySelector('.import-overlay')?.addEventListener('click', hideImportPanel);
  
  // 拖拽导入
  setupDragDrop();

  // 启动时刷新书签小红点。
  // 放在所有事件绑定之后：即使这里出意外也不会造成"漏绑"。
  await updateBookmarkBadge();
}

// 书签小红点：书架里存在书签时给 #btn-bookmarks 加 has-badge（样式见 css/shelf.css）。
// 幂等，可重复调用；任何异常只告警，绝不影响书架渲染与事件绑定。
async function updateBookmarkBadge() {
  const btn = document.getElementById('btn-bookmarks');
  if (!btn) return;

  btn.setAttribute('aria-label', '我的书签');
  if (!btn.getAttribute('title')) btn.setAttribute('title', '我的书签');

  let list = [];
  try {
    list = await getAllBookmarks();
  } catch (err) {
    console.warn('读取书签失败，书签小红点按无书签处理:', err);
    list = [];
  }

  const hasBookmarks = Array.isArray(list) && list.length > 0;
  // toggle 的第二个参数保证幂等：有则加、无则移除
  btn.classList.toggle('has-badge', hasBookmarks);
}

// 渲染分类标签
function renderCategoryTabs() {
  const container = document.getElementById('category-tabs');
  // 清空自定义标签
  container.querySelectorAll('.cat-tab.custom-cat').forEach(el => el.remove());
  
  // 添加自定义分类
  customCategories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'cat-tab custom-cat';
    btn.dataset.cat = cat;
    btn.textContent = cat;
    container.appendChild(btn);
  });
  
  // 添加"新建分类"按钮
  const addBtn = document.createElement('button');
  addBtn.className = 'cat-tab custom-cat add-cat';
  addBtn.textContent = '+ 分类';
  addBtn.addEventListener('click', async () => {
    const name = prompt('输入新分类名称：');
    if (name && name.trim()) {
      const catName = name.trim();
      if (!customCategories.includes(catName)) {
        customCategories.push(catName);
        await saveSetting('categories', customCategories);
        renderCategoryTabs();
      }
    }
  });
  container.appendChild(addBtn);
}

// 拖拽导入
function setupDragDrop() {
  const body = document.body;
  
  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  
  body.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    // handleFileImport 会自动识别 ZIP 并走解压流程
    await handleFileImport(files);
  });
}

// 加载并渲染书籍
async function refreshShelf() {
  books = await getAllBooks();
  renderBooks();
  // 先渲染书，再异步刷新书签小红点（不阻塞书架显示；内部自捕获异常）。
  // 从书签页返回书架、删光书签、或书籍被删（书签级联删除）后都会走到这里。
  updateBookmarkBadge();
}

async function renderBooks() {
  const grid = document.getElementById('book-grid');
  grid.innerHTML = '';
  
  let filtered = [...books];
  
  // 分类筛选
  if (currentCategory === 'favorites') {
    filtered = filtered.filter(b => b.favorite);
  } else if (currentCategory === 'uncategorized') {
    filtered = filtered.filter(b => !b.category);
  } else if (currentCategory !== 'all') {
    filtered = filtered.filter(b => b.category === currentCategory);
  }
  
  // 搜索
  if (searchQuery) {
    filtered = filtered.filter(b => 
      b.title.toLowerCase().includes(searchQuery) ||
      (b.author && b.author.toLowerCase().includes(searchQuery))
    );
  }
  
  // 排序：收藏永远优先，同收藏状态内按当前排序方式
  filtered.sort(compareShelfBooks);
  
  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${shelfFormatIconSvg('epub')}</div>
        <p>${searchQuery ? '没有找到匹配的书籍' : '书架空空如也'}</p>
        <p class="empty-hint">${searchQuery ? '换个关键词试试' : '点击右上角导入你的第一本书吧'}</p>
      </div>`;
    return;
  }
  
  for (const book of filtered) {
    const card = document.createElement('div');
    card.className = 'book-card';
    
    const formatClass = book.format || 'unknown';
    const progress = getShelfProgress(book);
    const isFinished = progress >= 100;
    const isUnread = progress <= 0;
    const progressClass = isFinished ? 'is-finished' : (isUnread ? 'is-unread' : 'is-reading');
    const progressLabel = isFinished ? '已读完' : (isUnread ? '未读' : `已读 ${progress}%`);
    const favoriteHtml = book.favorite
      ? `<span class="book-favorite" title="已收藏" aria-label="已收藏">${shelfStarIconSvg()}</span>`
      : '';
    
    card.innerHTML = `
      <div class="book-cover ${formatClass}" title="${formatClass.toUpperCase()}">${shelfFormatIconSvg(book.format)}</div>
      <div class="book-title">${escapeHtml(book.title)}</div>
      ${book.author ? `<div class="book-author">${escapeHtml(book.author)}</div>` : ''}
      ${favoriteHtml}
      <div class="book-progress ${progressClass}" title="${progressLabel}">
        <div class="book-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}" aria-label="阅读进度">
          <div class="book-progress-fill" style="width:${progress}%"></div>
        </div>
        <div class="book-progress-meta">
          <span class="book-progress-text">${progressLabel}</span>
          ${isFinished ? `<span class="book-progress-icon">${shelfCheckIconSvg()}</span>` : ''}
        </div>
      </div>
    `;
    
    // 点击打开书籍（openBook 现已同步；这里再兜一层，任何异常都要可见）
    card.addEventListener('click', (e) => {
      // 长按弹过菜单之后，抬手产生的这次 click 不能再去打开书。
      // 也不能让它冒泡到 document —— 那会把刚弹出来的菜单立刻关掉，
      // 表现就是"长按松手菜单就没了，根本来不及点菜单项"。
      // 这次 click 属于"打开菜单的那个手势"，必须就地吃掉。
      if (card.dataset.longPressed === '1') {
        delete card.dataset.longPressed;
        if (e && e.stopPropagation) e.stopPropagation();
        return;
      }
      try {
        openBook(book);
      } catch (err) {
        console.error('打开书籍失败', err);
        if (typeof showToast === 'function') showToast('打开失败：' + (err.message || err));
      }
    });
    
    // 桌面右键（顺便也给读屏/键盘用户留一条路径）
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showBookContextMenu(book, card);
    });

    // 长按（触摸）弹出操作菜单。
    // 时间从 600ms 降到 LONG_PRESS_MS：原来要按住挺久才有反应，手感迟钝。
    // 判"是否取消"用位移阈值而不是"有没有 touchmove" ——
    // 手指按住时几乎都会有 1~2px 抖动，按事件取消会导致长按很难触发。
    let longPressTimer = null;
    let pressStart = null;
    let longPressed = false;

    const cancelLongPress = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    };

    card.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      pressStart = { x: t.clientX, y: t.clientY };
      longPressed = false;
      cancelLongPress();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        longPressed = true;
        // 标记一下，抬手时那次 click 要吃掉（否则会顺带把书打开）
        card.dataset.longPressed = '1';
        if (navigator.vibrate) navigator.vibrate(8);
        showBookContextMenu(book, card);
      }, LONG_PRESS_MS);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!pressStart || !longPressTimer) return;
      const t = e.touches[0];
      if (!t) return;
      const moved = Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y);
      if (moved > LONG_PRESS_MOVE_PX) cancelLongPress();   // 在滚动，不是在长按
    }, { passive: true });

    const endPress = () => {
      cancelLongPress();
      pressStart = null;
      // 已经弹过菜单：把标记留给 click 处理；没弹过就清掉，避免影响下一次点击
      if (!longPressed) delete card.dataset.longPressed;
    };
    card.addEventListener('touchend', endPress, { passive: true });
    card.addEventListener('touchcancel', endPress, { passive: true });
    
    grid.appendChild(card);
  }
}

/* ========== 排序 ========== */

// 书架排序比较函数：收藏优先规则保持不变，其余按 shelfSortMode 分组排序
// - recent   : lastReadAt 降序（最近阅读在前），从未读过的排在最后
// - title    : 书名升序（A→Z，中文按拼音）
// - added    : addedAt 降序（新导入的在前）
// - progress : progress 降序（进度高的在前），同进度按最近阅读
function compareShelfBooks(a, b) {
  // 收藏优先（既有行为，任何排序方式下都保持）
  const favA = !!a.favorite;
  const favB = !!b.favorite;
  if (favA !== favB) return favA ? -1 : 1;

  if (shelfSortMode === 'title') {
    return compareBookTitles(a, b);
  }

  if (shelfSortMode === 'added') {
    const added = (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
    return added !== 0 ? added : compareBookTitles(a, b);
  }

  if (shelfSortMode === 'progress') {
    const byProgress = getShelfProgress(b) - getShelfProgress(a);
    if (byProgress !== 0) return byProgress;
    const byRecent = (Number(b.lastReadAt) || 0) - (Number(a.lastReadAt) || 0);
    return byRecent !== 0 ? byRecent : compareBookTitles(a, b);
  }

  // 默认：最近阅读
  const byRecent = (Number(b.lastReadAt) || 0) - (Number(a.lastReadAt) || 0);
  if (byRecent !== 0) return byRecent;
  const byAdded = (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0);
  return byAdded !== 0 ? byAdded : compareBookTitles(a, b);
}

// 书名排序：中文按拼音（localeCompare 走 ICU 排序规则），数字按数值（"第2章" < "第10章"）
function compareBookTitles(a, b) {
  const ta = String(a.title || '');
  const tb = String(b.title || '');
  try {
    return ta.localeCompare(tb, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  } catch (err) {
    return ta < tb ? -1 : (ta > tb ? 1 : 0);
  }
}

// 把 progress 规范成 0-100 的整数（undefined / 非法值当 0 处理）
function getShelfProgress(book) {
  const n = Number(book && book.progress);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// 同步排序按钮的高亮状态；shelfSortMode 非法时回退到 recent
function updateSortTabsUI() {
  const tabs = document.getElementById('sort-tabs');
  if (!tabs) return;

  const btns = tabs.querySelectorAll('.sort-btn');
  let matched = false;
  btns.forEach((btn) => {
    const on = btn.dataset.sort === shelfSortMode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) matched = true;
  });

  if (!matched && btns.length) {
    shelfSortMode = 'recent';
    btns.forEach((btn) => {
      const on = btn.dataset.sort === 'recent';
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
}

// 切换排序方式并持久化
async function setShelfSort(mode) {
  if (mode !== 'recent' && mode !== 'title' && mode !== 'added' && mode !== 'progress') return;

  shelfSortMode = mode;
  updateSortTabsUI();
  renderBooks();

  try {
    await saveSetting('shelfSort', mode);
  } catch (err) {
    console.warn('保存排序方式失败:', err);
  }
}

/* ========== 卡片 SVG 图标（统一 24x24 viewBox / currentColor / 圆角线帽）========== */

const SHELF_ICON_ATTRS = 'viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

// 封面图标：按格式给不同形状，颜色由 .book-cover.<format> 的渐变提供
function shelfFormatIconSvg(format) {
  const attrs = SHELF_ICON_ATTRS;
  if (format === 'txt') {
    // 文本文件：文档 + 文字行
    return `<svg ${attrs}><path d="M14 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7z"/><path d="M14 3v4h4"/><path d="M9.5 12.5h5"/><path d="M9.5 16h3"/></svg>`;
  }
  if (format === 'epub') {
    // 电子书：摊开的书
    return `<svg ${attrs}><path d="M12 6.4C10.4 4.9 8.5 4.4 6 4.4a1 1 0 0 0-1 1v10.8a1 1 0 0 0 1 1c2.5 0 4.4.5 6 2 1.6-1.5 3.5-2 6-2a1 1 0 0 0 1-1V5.4a1 1 0 0 0-1-1c-2.5 0-4.4.5-6 2z"/><path d="M12 6.4v12.8"/></svg>`;
  }
  if (format === 'pdf') {
    // PDF：文档 + 圆形印记
    return `<svg ${attrs}><path d="M14 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7z"/><path d="M14 3v4h4"/><circle cx="15" cy="16.4" r="2.6"/></svg>`;
  }
  if (format === 'docx') {
    // Word：文档 + 铅笔
    return `<svg ${attrs}><path d="M14 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7z"/><path d="M14 3v4h4"/><path d="M9.6 17.6l.9-2.7 3.7-3.7 1.7 1.7-3.7 3.7z"/></svg>`;
  }
  // 未知格式：合上的书
  return `<svg ${attrs}><rect x="6" y="3.6" width="12" height="16.8" rx="2"/><path d="M9.6 3.6v16.8"/></svg>`;
}

// 收藏星标
function shelfStarIconSvg() {
  return '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
}

// 已读完的对勾
function shelfCheckIconSvg() {
  return '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6.5L9 17.5l-5-5"/></svg>';
}

// 书籍右键菜单
/* 长按书籍卡片弹出操作菜单。

   两个参数说清楚：
     book   —— 要操作的书
     anchor —— 菜单贴着哪个元素显示（书籍卡片）。菜单出现在卡片**正下方**，
               放不下时翻到卡片上方，并始终夹在屏幕内。
               桌面右键也走这条路径，行为一致。

   定位必须在菜单插入 DOM **之后**再算：要先知道它实际多宽多高，
   否则贴边时会溢出屏幕。所以先隐藏着量尺寸，再显示。 */
/* 当前打开着的菜单的"关闭"函数。弹新菜单前先把它收掉 ——
   既保证同时只有一个菜单，也顺手摘掉旧菜单挂在 document 上的监听，
   否则每弹一次菜单都会在 document 上再漏一组监听。 */
let closeActiveBookMenu = null;

function showBookContextMenu(book, anchor) {
  // 同一时间只留一个菜单（连同上一个菜单挂在 document/window 上的关闭监听）
  if (closeActiveBookMenu) closeActiveBookMenu();
  document.querySelectorAll('.context-menu').forEach(m => m.remove());

  // 菜单文案必须跟着"当前"收藏状态走。
  // 卡片闭包里的 book 可能是旧对象（这张卡片是在上一次 refreshShelf 之前拿到的），
  // 以书架内存里的最新记录为准，否则会出现"已经收藏了却还显示收藏"的错动作。
  const live = books.find(b => b && b.id === book.id);
  if (live) book = live;

  /* 菜单项顺序 = actions 数组顺序，data-i 由 map 的下标生成，
     点击时再用 data-i 反查 actions[i] —— 所以这里插入/移动任何一项，
     下标都会自动跟着走，不需要手改任何硬编码数字。 */
  const actions = [
    { icon: 'star', label: book.favorite ? '取消收藏' : '收藏', action: () => toggleFavorite(book) },
    { icon: 'edit', label: '重命名', action: () => renameBook(book) },
    { icon: 'folder', label: '移动到分类', action: () => moveToCategory(book) },
    { icon: 'trash', label: '删除', action: () => confirmDeleteBook(book) },
  ];

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = actions.map((a, i) =>
    `<button class="context-menu-item" role="menuitem" data-i="${i}">${icon(a.icon, { size: 17 })}<span>${a.label}</span></button>`
  ).join('');

  menu.style.visibility = 'hidden';        // 先看不见地插进去，量完尺寸再摆位置
  document.body.appendChild(menu);

  const GAP = 8;                            // 菜单与卡片之间的空隙
  const EDGE = 8;                           // 距屏幕边缘至少留这么多
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    // 默认贴在卡片正下方，左边缘与卡片对齐
    let left = r.left;
    let top = r.bottom + GAP;
    let above = false;
    // 下方放不下就翻到卡片上方
    if (top + mh > window.innerHeight - EDGE) {
      top = r.top - mh - GAP;
      above = true;
    }
    // 无论怎样都夹在屏幕内
    left = Math.min(left, window.innerWidth - mw - EDGE);
    left = Math.max(EDGE, left);
    top = Math.min(top, window.innerHeight - mh - EDGE);
    top = Math.max(EDGE, top);

    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    // 小箭头指向卡片（CSS 用 --arrow-x 把它对准卡片中线）
    const arrowX = Math.round(Math.min(Math.max(r.left + r.width / 2 - left, 14), mw - 14));
    menu.style.setProperty('--arrow-x', arrowX + 'px');
    menu.classList.add('has-arrow');
    if (above) menu.classList.add('above');
  } else {
    menu.style.left = '50%';
    menu.style.top = '50%';
    menu.style.transform = 'translate(-50%, -50%)';
  }
  menu.style.visibility = '';

  // 这次事件是不是点在菜单的某个操作项上（含项里的图标/文字）。
  // 菜单自己的内边距不算，点在空白处仍然当"点别处"关掉。
  const inMenuAction = (target) => {
    if (!target || !menu.contains(target)) return false;
    return !!(target.closest && target.closest('.context-menu-item'));
  };

  const teardown = () => {
    menu.remove();
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('touchstart', onDocTouchStart);
    window.removeEventListener('scroll', onScroll, true);
    if (closeActiveBookMenu === teardown) closeActiveBookMenu = null;
  };
  const onDocClick = (ev) => { if (!inMenuAction(ev.target)) teardown(); };
  const onDocTouchStart = (ev) => { if (!inMenuAction(ev.target)) teardown(); };
  const onScroll = () => teardown();

  menu.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('.context-menu-item') : null;
    if (!btn) return;                 // 点在菜单内边距上：交给下面 document 的 click 关掉
    const i = parseInt(btn.dataset.i, 10);
    teardown();                       // 先收菜单再执行（动作里有 await，不能把菜单留在屏幕上）
    if (i >= 0 && i < actions.length) actions[i].action();
  });

  /* 点别处 / 滚动页面就关掉。

     这里踩过一个真实的坑：手机上点菜单项的事件顺序是 touchstart → touchend → click。
     如果在 document 的 touchstart 里就把菜单 remove 掉，真实浏览器接下来那次 click
     是按"抬手位置的命中测试"找目标的 —— 菜单已经不在文档里，命中到的是底下的卡片，
     菜单自己的 click 监听器根本收不到，表现就是所有菜单项都"点了没反应"。
     所以关闭逻辑必须放过"点在菜单操作项上"的这一次（inMenuAction）。

     监听延迟 100ms 再挂上：长按弹出菜单后，抬手那一下 click 会冒泡到 document，
     立刻挂监听会把刚弹出的菜单顺手关掉。 */
  closeActiveBookMenu = teardown;
  setTimeout(() => {
    // 这 100ms 内菜单可能已经被关掉，或者又被新菜单顶替了
    if (closeActiveBookMenu !== teardown) return;
    document.addEventListener('click', onDocClick);
    document.addEventListener('touchstart', onDocTouchStart, { passive: true });
    window.addEventListener('scroll', onScroll, true);
  }, 100);
}

async function toggleFavorite(book) {
  book.favorite = !book.favorite;
  // 只改 favorite 就用单字段更新，不要 saveBook(整本重写，含文件)
  await updateBookField(book.id, 'favorite', book.favorite);
  await refreshShelf();
}

// 重命名：只改书名
async function renameBook(book) {
  // 预填当前书名，用户可以在原名上改，而不是从空白开始
  const input = prompt('重命名', book.title);
  if (input === null) return;                 // 取消 → 什么都不做

  // '   ' 在 JS 里是真值，必须 trim 之后再判断，否则会写成空书名
  const title = String(input).trim();
  if (!title) return;                         // 空 / 纯空格 → 什么都不做

  // 只改 title 一个字段。绝对不要 saveBook(book)：
  // 那会把整本书（含几 MB 的 fileData）重写一遍，历史上导致过"打开第二本书失败"和卡顿。
  await updateBookField(book.id, 'title', title);
  await refreshShelf();                       // 卡片立刻显示新名字（转义仍由 renderBooks/escapeHtml 负责）
}

async function moveToCategory(book) {
  const allCats = ['未分类', ...customCategories];
  const input = prompt(`选择分类：\n${allCats.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n输入数字或新分类名：`);
  if (input === null) return;                 // 取消 → 什么都不做

  // 先 trim 再判断：修掉"只输入空格会创建空分类"的 bug
  // （原来 if (cat) 对 '   ' 为真 → parseInt 得 NaN → 走新分类分支 → push 了一个 ''）
  const raw = String(input).trim();
  if (!raw) return;                           // 空 / 纯空格 → 什么都不做

  const idx = parseInt(raw, 10) - 1;
  if (idx >= 0 && idx < allCats.length) {
    book.category = idx === 0 ? '' : allCats[idx];
  } else {
    book.category = raw;
    if (!customCategories.includes(raw)) {
      customCategories.push(raw);
      await saveSetting('categories', customCategories);
      renderCategoryTabs();
    }
  }
  // 只改 category 就单字段更新，避免整本（含文件）重写
  await updateBookField(book.id, 'category', book.category);
  await refreshShelf();
}

async function confirmDeleteBook(book) {
  if (confirm(`确定删除《${book.title}》吗？`)) {
    await deleteBook(book.id);
    await refreshShelf();
  }
}

// 打开书籍
function openBook(book) {
  // ⚠ 这里必须是同步的、先跳转。
  // 曾经的写法是：
  //     book.lastReadAt = Date.now();
  //     await saveBook(book);        // 把整本书（含几 MB 的 fileData）重写一遍
  //     navigateTo('reader');        // 只有写成功才会执行
  // 于是写入一慢或一失败（存储配额、事务中止），跳转就永远不会发生，
  // 而点击处理器没接住异常 → 完全静默，表现就是"点了没反应"。
  // 现在：先打开书，浏览记录的写入放到后台且失败不影响阅读。
  window._currentBook = book;
  book.lastReadAt = Date.now();   // 内存里同步一下，保持排序一致
  navigateTo('reader');

  // 后台更新"最近阅读时间"。用 try/catch + catch() 兜住，绝不冒泡成未处理异常。
  try {
    updateBookField(book.id, 'lastReadAt', Date.now())
      .catch(err => console.warn('更新最近阅读时间失败（不影响打开）', err));
  } catch (err) {
    console.warn('更新最近阅读时间失败（不影响打开）', err);
  }

  // 清理旧的 Blob URL（EPUB 阅读器用得到）
  if (window._epubBlobs && window._epubBlobs[book.id]) {
    try { URL.revokeObjectURL(window._epubBlobs[book.id]); } catch (e) {}
  }

  // EPUB：重建 Blob URL。注意此时可能还没来得及重新读文件，
  // 真正创建 URL 的时机在 loadBook 里（见 reader.js）。
}

/* ========== 导入处理 ========== */
function toggleImportPanel() {
  document.getElementById('import-panel').style.display = 'block';
}

function hideImportPanel() {
  document.getElementById('import-panel').style.display = 'none';
  document.getElementById('import-progress').style.display = 'none';
}

async function handleFileImport(fileList) {
  if (!fileList || fileList.length === 0) return;

  const all = Array.from(fileList);

  // 如果选中的全是压缩包，走解压流程
  const zips = all.filter(f => getFileFormat(f.name) === 'zip');
  const books = all.filter(f => isSupportedFormat(f.name));

  if (zips.length > 0) {
    await handleZipImport(zips);
    return;
  }

  const progressEl = document.getElementById('import-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  progressEl.style.display = 'block';

  let imported = 0;
  let skipped = 0;

  for (let i = 0; i < books.length; i++) {
    const file = books[i];
    const format = getFileFormat(file.name);

    progressFill.style.width = `${((i + 1) / books.length) * 100}%`;
    progressText.textContent = `导入中... ${i + 1}/${books.length}`;

    try {
      await importBook(file, format);
      imported++;
    } catch (err) {
      console.error('导入失败:', file.name, err);
      skipped++;
    }
  }

  // 统计被跳过的格式（如 mobi/azw3）
  const unsupported = all.length - books.length - zips.length;
  if (unsupported > 0) skipped += unsupported;

  progressText.textContent = imported > 0
    ? `完成！成功导入 ${imported} 本${skipped > 0 ? `，跳过 ${skipped} 个不支持的文件` : ''}`
    : `没有可导入的文件（MOBI/AZW3 请先转为 EPUB 或 TXT）`;

  setTimeout(() => {
    hideImportPanel();
    refreshShelf();
  }, 1600);
}

async function handleZipImport(fileList) {
  if (!fileList || fileList.length === 0) return;
  
  const progressEl = document.getElementById('import-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  progressEl.style.display = 'block';
  
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    progressText.textContent = `解压中...`;
    
    try {
      const files = await extractZip(file, (done, total) => {
        progressFill.style.width = `${(done / total) * 100}%`;
        progressText.textContent = `解压中... ${done}/${total}`;
      });
      
      progressText.textContent = `导入 ${files.length} 本书...`;
      
      let imported = 0;
      for (let j = 0; j < files.length; j++) {
        const f = files[j];
        const format = getFileFormat(f.name);
        progressFill.style.width = `${((j + 1) / files.length) * 100}%`;
        
        try {
          await importBook(f, format);
          imported++;
        } catch (err) {
          console.error('导入失败:', f.name, err);
        }
      }
      
      progressText.textContent = `完成！从压缩包导入 ${imported} 本书`;
    } catch (err) {
      console.error('解压失败:', err);
      progressText.textContent = '解压失败，请检查文件格式';
    }
  }
  
  setTimeout(() => {
    hideImportPanel();
    refreshShelf();
  }, 1500);
}

async function importBook(file, format) {
  const title = extractTitle(file.name);
  
  const book = {
    id: generateId(),
    title,
    author: '',
    format,
    fileData: file,  // 原始文件 Blob
    coverColor: '',
    favorite: false,
    category: '',
    addedAt: Date.now(),
    lastReadAt: null,
    progress: 0,
    currentChapter: 0,
  };
  
  await saveBook(book);
  
  return book;
}

// HTML 转义
// 用纯字符串替换实现，而不是"新建一个 div 取其 innerHTML"。
// 后者每调用一次就要创建一个 DOM 元素；渲染一章可能有上千段，开销很明显。
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}