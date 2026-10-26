/* ========== IndexedDB 存储层 ==========
   两个仓库分工明确：
     books  —— 只放元数据（书名/作者/进度…），记录很小
     files  —— 只放原始文件本体（可能几 MB 的 Blob），导入时写一次，之后永不重写

   为什么必须分开（真实踩过的坑）：
   以前文件本体内嵌在 books 记录里，而 IndexedDB 只能整条读写，
   于是"更新阅读进度"这种小事会连带把整本书重写一遍——
   每翻一页、每次返回书架都在重写；刷新书架时 getAll() 还会把所有书的
   文件全部读进内存。Safari/WebKit 的 IndexedDB Blob 是由临时文件支撑的，
   在这种反复重写 + 内存压力下，Blob 会在会话中途变得读不出来，
   报错正是：NotFoundError: The object can not be found here.
   表现就是"刚进网站第一次打开正常，之后打开任何书都失败"。
   分开存储后，文件写入一次就不再被触碰，元数据更新也只有几百字节。 */
const DB_NAME = 'NovelReader';
const DB_VERSION = 2;

// 需要的对象仓库，openDB 之后会逐个核对
const REQUIRED_STORES = ['books', 'bookmarks', 'settings', 'files'];

let db = null;

/* 把晦涩的 DOMException 翻译成用户能看懂、也知道该怎么办的话。
   Safari 无痕模式下 indexedDB.open() 看起来是成功的，但仓库是空的，
   之后任何事务都会抛 "The object can not be found here."（NotFoundError）。 */
function describeStorageError(err) {
  const name = err && err.name;
  const raw = (err && err.message) || String(err);

  if (name === 'NotFoundError' || /can not be found|not be found here/i.test(raw)) {
    return '浏览器本地存储不可用或为空。最常见的原因是用「无痕/隐私浏览」打开了页面 —— '
         + '无痕模式下数据不会被保存。请用普通标签页打开；如果本来就是普通模式，'
         + '请在 Safari「设置 → 高级 → 网站数据」里确认没有禁用本站存储。';
  }
  if (name === 'QuotaExceededError' || /quota/i.test(raw)) {
    return '本地存储空间已满。请删除几本书，或在 Safari 设置里清理本站数据后重新导入。';
  }
  if (name === 'InvalidStateError') {
    return '本地数据库连接已失效（可能在其他标签页改动过）。刷新页面即可恢复。';
  }
  if (name === 'SecurityError' || name === 'UnknownError') {
    return '浏览器拒绝访问本地存储。通常是隐私设置或「阻止所有 Cookie」导致的。';
  }
  if (name === 'VersionError') {
    return '本地数据库版本不匹配（可能同时开着旧版本的页面）。关掉其它标签页后刷新重试。';
  }
  return raw;
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      const e = new Error('浏览器不支持 IndexedDB');
      e.name = 'SecurityError';
      return reject(e);
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('books')) {
        const booksStore = idb.createObjectStore('books', { keyPath: 'id' });
        booksStore.createIndex('category', 'category', { unique: false });
        booksStore.createIndex('favorite', 'favorite', { unique: false });
        booksStore.createIndex('title', 'title', { unique: false });
      }
      if (!idb.objectStoreNames.contains('bookmarks')) {
        const bmStore = idb.createObjectStore('bookmarks', { keyPath: 'id' });
        bmStore.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!idb.objectStoreNames.contains('settings')) {
        idb.createObjectStore('settings', { keyPath: 'key' });
      }
      // v2 新增：文件本体单独存，避免每次更新进度都重写整本书
      if (!idb.objectStoreNames.contains('files')) {
        idb.createObjectStore('files', { keyPath: 'id' });
      }
    };

    req.onblocked = () => {
      console.warn('IndexedDB 升级被阻塞：可能有其它标签页正开着旧版本');
    };

    req.onsuccess = (e) => {
      db = e.target.result;

      // 关键校验：仓库必须齐全。
      // Safari 无痕模式会"打开成功"但没有任何仓库，后续事务才报
      // NotFoundError（The object can not be found here.）。
      // 在这里当场查出来，就能给出明确的提示，而不是让用户看到天书。
      const missing = REQUIRED_STORES.filter(s => !db.objectStoreNames.contains(s));
      if (missing.length) {
        const err = new Error('本地数据库缺少数据表：' + missing.join(', '));
        err.name = 'NotFoundError';
        try { db.close(); } catch (_) {}
        db = null;
        return reject(err);
      }
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

/* 便宜的存活探测：只取数量，不读文件本体。
   用来在启动时判断"存储到底能不能用、里面有几本书"。 */
function countBooks() {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('数据库未打开'));
    const tx = db.transaction('books', 'readonly');
    const req = tx.objectStore('books').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 存储自检：返回 { ok, count, message }
async function checkStorage() {
  try {
    if (!db) await openDB();
    // 真正发一次事务，才能暴露"仓库读不到"这类问题
    const n = await countBooks();
    return { ok: true, count: n, message: '' };
  } catch (err) {
    return { ok: false, count: 0, message: describeStorageError(err) };
  }
}

/* ========== 文件本体（单独存放，写入一次后不再触碰） ========== */

function putBookFile(id, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put({ id, data, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('写入文件被中止'));
  });
}

/* 取书的原始文件。
   优先读 files 表；老数据（文件还内嵌在 books 记录里）则回退读 books，
   并顺手迁移到 files 表。迁移时是"先复制到 files，再从 books 摘掉"，
   顺序很重要：万一摘除那一步出问题，files 里已经有安全副本。 */
async function getBookFile(id) {
  const got = await new Promise((resolve, reject) => {
    const tx = db.transaction(['files', 'books'], 'readonly');
    const fileReq = tx.objectStore('files').get(id);
    const bookReq = tx.objectStore('books').get(id);
    tx.oncomplete = () => {
      const f = fileReq.result;
      const b = bookReq.result;
      resolve({
        file: (f && f.data) ? f.data : null,
        legacy: (b && b.fileData) ? b.fileData : null
      });
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  if (got.file) return got.file;
  if (!got.legacy) return null;

  // 老数据迁移（失败不影响本次阅读）
  try {
    await putBookFile(id, got.legacy);
    await stripInlineFile(id);
    console.log('已把内嵌文件迁移到独立存储:', id);
  } catch (e) {
    console.warn('迁移内嵌文件失败（不影响阅读）', e);
  }
  return got.legacy;
}

// 把文件本体从 books 记录里摘掉（迁移的最后一步）
function stripInlineFile(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite');
    const store = tx.objectStore('books');
    const req = store.get(id);
    req.onsuccess = () => {
      const b = req.result;
      if (b && 'fileData' in b) {
        delete b.fileData;
        store.put(b);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* 一次性迁移：把所有还内嵌着文件的老书搬到 files 表。
   返回迁移了几本。 */
async function migrateInlineFiles() {
  const all = await getAllBooks();
  const legacy = all.filter(b => b.fileData);
  let moved = 0;
  for (const b of legacy) {
    try {
      await putBookFile(b.id, b.fileData);
      await stripInlineFile(b.id);
      moved++;
    } catch (e) {
      console.warn('迁移失败:', b.id, e);
    }
  }
  return { total: legacy.length, moved };
}

/* ========== 书籍操作 ========== */
function getAllBooks() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readonly');
    const store = tx.objectStore('books');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getBook(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readonly');
    const store = tx.objectStore('books');
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* 保存书籍：元数据进 books，文件本体进 files。
   这样 books 记录保持很小，"更新进度"就不会再连带重写整本书。 */
async function saveBook(book) {
  if (!book) throw new Error('saveBook: book 为空');
  const meta = Object.assign({}, book);
  const fileData = meta.fileData;
  delete meta.fileData;

  await putBookMeta(meta);

  if (fileData) {
    // 文件写失败不应让整次导入失败（元数据已经写好了）
    try {
      await putBookFile(meta.id, fileData);
    } catch (e) {
      console.warn('保存书籍文件失败', e);
    }
  }
}

// 只写元数据（对外保持 saveBook 的语义，但记录里不含文件）
function putBookMeta(meta) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite');
    const store = tx.objectStore('books');
    const req = store.put(meta);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteBook(id) {
  return new Promise((resolve, reject) => {
    // 元数据和文件一起删，别留下孤儿文件占空间
    const tx = db.transaction(['books', 'files'], 'readwrite');
    tx.objectStore('books').delete(id);
    tx.objectStore('files').delete(id);
    tx.oncomplete = () => {
      // 同时删除该书签
      deleteBookmarksByBook(id);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

function updateBookField(id, field, value) {
  const patch = {};
  patch[field] = value;
  return updateBookFields(id, patch);
}

/* 一次事务里更新多个字段。

   重要：书本记录里含有 fileData（整本小说，可能几 MB）。
   IndexedDB 只能整条读写，所以"读一条 → 改一个字段 → 写回"会连带把
   整个文件重写一遍。以前保存进度要调 4 次 updateBookField，
   等于每翻一页就把整本书写 4 遍 —— 又慢又容易触发存储配额失败，
   失败时 openBook() 会静默中断，用户看到的就是"点击没反应"。
   合并成一次事务至少把开销降到 1/4。 */
function updateBookFields(id, patch) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite');
    const store = tx.objectStore('books');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const book = getReq.result;
      if (book) {
        Object.assign(book, patch);
        store.put(book);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ========== 书签操作 ========== */
function getBookmarks(bookId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readonly');
    const store = tx.objectStore('bookmarks');
    const index = store.index('bookId');
    const req = index.getAll(bookId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllBookmarks() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readonly');
    const store = tx.objectStore('bookmarks');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function saveBookmark(bookmark) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readwrite');
    const store = tx.objectStore('bookmarks');
    const req = store.put(bookmark);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteBookmark(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('bookmarks', 'readwrite');
    const store = tx.objectStore('bookmarks');
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteBookmarksByBook(bookId) {
  const tx = db.transaction('bookmarks', 'readwrite');
  const store = tx.objectStore('bookmarks');
  const index = store.index('bookId');
  const cursorReq = index.openCursor(IDBKeyRange.only(bookId));
  cursorReq.onsuccess = (e) => {
    const cursor = e.target.result;
    if (cursor) {
      store.delete(cursor.primaryKey);
    }
  };
}

/* ========== 设置操作 ========== */
function getSetting(key, defaultValue) {
  return new Promise((resolve) => {
    const tx = db.transaction('settings', 'readonly');
    const store = tx.objectStore('settings');
    const req = store.get(key);
    req.onsuccess = () => {
      resolve(req.result ? req.result.value : defaultValue);
    };
    req.onerror = () => resolve(defaultValue);
  });
}

function saveSetting(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    store.put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ========== 生成 ID ========== */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}