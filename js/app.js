/* ========== 应用主控制器 ========== */

let currentPage = 'shelf';

/* ========== 页面路由 ========== */
function navigateTo(page) {
  // 如果离开阅读器，保存进度
  if (currentPage === 'reader' && page !== 'reader' && currentBook) {
    // 进度平时是节流保存的（避免翻页时写库造成掉帧），
    // 离开阅读页要立刻落盘，否则节流中的那次会丢
    if (typeof flushSaveProgress === 'function') flushSaveProgress();
    else saveCurrentProgress();
  }
  
  // 切换页面
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) {
    pageEl.classList.add('active');
    currentPage = page;
  }
  
  // 页面特定的初始化
  if (page === 'shelf') {
    refreshShelf();
  } else if (page === 'reader') {
    // loadBook 由调用方（openBook 等）自行触发
    const book = window._currentBook;
    if (book && !window._readerLoaded) {
      loadBook(book);
    }
    window._readerLoaded = false;
  } else if (page === 'bookmarks') {
    showBookmarkList();
  }

  // 离开阅读页时清掉上下栏的"自动收起"计时器，
  // 免得它稍后突然触发、把用户刚回到阅读页时的界面弄乱
  if (page !== 'reader' && typeof cancelBarsAutoHide === 'function') {
    cancelBarsAutoHide();
  }
}

/* ========== PWA 注册 ========== */
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('SW registered'))
      .catch(err => console.log('SW registration failed:', err));
  }
}

/* ========== 第三方库配置 ========== */
function configureLibraries() {
  // pdf.js 必须显式指定 worker，否则渲染可能失败
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.js';
  }
}

/* ========== 让静默失败可见 ==========
   之前踩过的坑：点击书本时 openBook() 里的异步写入失败，异常没人接住，
   界面完全没反应，用户只能看到"点了没反应"，我们也没法定位。
   这里统一兜住未处理的异常，用 toast 显示出来（同一个错误只提示一次，避免刷屏）。 */
function installErrorSurface() {
  const shown = new Set();

  function report(label, err) {
    const msg = (err && (err.message || err.name)) ? (err.message || err.name) : String(err);
    const key = label + '|' + msg;
    console.error('[' + label + ']', err);
    if (shown.has(key)) return;
    shown.add(key);
    if (typeof showToast === 'function') {
      showToast('出错了：' + msg.slice(0, 60));
    }
  }

  window.addEventListener('error', (e) => report('运行时错误', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => {
    e.preventDefault();
    report('未处理的异步错误', e.reason);
  });
}

/* ========== 应用初始化 ========== */
async function initApp() {
  try {
    installErrorSurface();
    configureLibraries();

    // 阻止双指捏合缩放页面：iOS 忽略 viewport 的 user-scalable=no，
    // 只能在事件层面拦（gesturestart 是 iOS 的双指手势事件，双击不经过它）。
    // 已经处于放大状态时放行 —— 用户还需要捏合缩回去。
    document.addEventListener('gesturestart', (e) => {
      if (typeof isViewportZoomed === 'function' && isViewportZoomed()) return;
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    // 把 index.html 里 data-icon="名字" 的占位元素填成矢量图标。
    // 必须在其它初始化之前：后面的脚本会用到 icon()，而这里先保证静态部分已就位。
    initIcons();

    // 打开数据库
    await openDB();

    // 一次性迁移：把老版本内嵌在 books 记录里的文件搬到独立的 files 表。
    // 放在最前面且不阻塞界面：迁移前后都能正常阅读。
    migrateInlineFiles()
      .then(r => { if (r.total) console.log(`文件迁移完成：${r.moved}/${r.total}`); })
      .catch(e => console.warn('文件迁移出错（不影响使用）', e));

    // 初始化各个模块
    await initShelf();
    await initReader();
    
    // 默认显示书架
    navigateTo('shelf');
    
    // 注册 Service Worker
    registerSW();
    
    // 处理页面可见性变化（保存进度）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && currentPage === 'reader' && currentBook) {
        flushSaveProgress();
      }
    });

    // 处理 iOS Safari 的 pageshow/pagehide
    window.addEventListener('pagehide', () => {
      if (currentPage === 'reader' && currentBook) {
        flushSaveProgress();
      }
    });
    
    console.log('📚 纯净阅读已就绪');
  } catch (err) {
    console.error('初始化失败:', err);
    alert('初始化失败：' + err.message);
  }
}

// 启动
document.addEventListener('DOMContentLoaded', initApp);