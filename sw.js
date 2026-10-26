/* ========== Service Worker - 离线缓存 ========== */

const CACHE_NAME = 'novel-reader-v26';

// 全部资源均为本地自托管，无外网依赖
const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/shelf.css',
  './css/reader.css',
  './js/icons.js',
  './js/storage.js',
  './js/parser.js',
  './js/shelf.js',
  './js/reader.js',
  './js/app.js',
  './lib/jszip.min.js',
  './lib/pdf.min.js',
  './lib/pdf.worker.min.js',
  './lib/mammoth.browser.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// 安装：预缓存核心资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 逐个添加，避免 addAll 的原子性导致"一个失败全盘失效"
      const results = await Promise.allSettled(
        LOCAL_ASSETS.map(url => cache.add(url))
      );
      const failed = LOCAL_ASSETS.filter((_, i) => results[i].status === 'rejected');
      if (failed.length) {
        console.warn('SW: 以下资源缓存失败', failed);
      } else {
        console.log('SW: 全部资源已缓存，可离线使用');
      }
    }).then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// 请求拦截（仅处理 GET）
//
// 两种策略分开 —— 这是"改了代码要不要重新部署"的关键：
//   · 应用外壳（html / css / js）→ **网络优先**
//       改完代码刷新一次就是新版，不需要手动改缓存版本号，
//       也不会出现"明明改了却还是旧界面"。离线时自动回退到缓存。
//   · 其它（第三方库、图标）→ **缓存优先 + 后台更新**
//       这些基本不变，走缓存启动更快。
const SHELL_RE = /\.(html|css|js)$/i;

function isAppShell(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return SHELL_RE.test(u.pathname) || u.pathname.endsWith('/');
  } catch (e) {
    return false;
  }
}

function offlineResponse() {
  return new Response('离线且无缓存内容', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// 只缓存成功的完整响应（跳过 opaque / 206 / 错误响应）
function putInCache(req, response) {
  if (response && response.status === 200 && response.type !== 'opaque') {
    const clone = response.clone();
    caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET；其余（如 POST）直接放行
  if (req.method !== 'GET') return;
  if (!req.url.startsWith('http')) return;

  // PDF 读取会用到 Range 请求，交给网络处理，避免返回不完整内容
  if (req.headers.has('range')) return;

  // ---- 应用外壳：网络优先（保证改了代码刷新一次即生效）----
  if (isAppShell(req.url)) {
    event.respondWith(
      fetch(req)
        .then(res => putInCache(req, res))
        .catch(() => caches.match(req).then(c => c || offlineResponse()))
    );
    return;
  }

  // ---- 其它资源：缓存优先 + 后台更新 ----
  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req)
        .then(res => putInCache(req, res))
        .catch(() => null);

      if (cached) {
        networkFetch.catch(() => {});
        return cached;
      }
      return networkFetch.then(res => res || offlineResponse());
    })
  );
});