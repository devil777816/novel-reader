/* ========== 图标库 ==========
   为什么要统一到这里：
   原来界面上的图标大多是 emoji（📚🔖📥⭐📖📄📦📂🗑⚠📘📕📝），
   emoji 在不同系统/机型上由各自的字体渲染，形状、粗细、配色都不一致，
   还会带表情化的观感 —— 这是"图标丑"的主因。

   这里改成统一的矢量线性图标：
     · 24×24 网格，只用描边（stroke），不填色
     · 颜色一律 currentColor → 跟着主题色/上下文自动变
     · 圆头圆角，粗细 1.8，视觉重量一致
   全部由本文件提供，页面和脚本都从这里取，避免各写一份。

   用法：
     · 静态 HTML：给元素加 data-icon="名字"，initIcons() 会填进去
     · 动态拼接：icon('名字')   → 返回 <svg> 字符串
     · 需要额外 class：icon('名字', { class: 'xx' })
*/

const ICON_PATHS = {
  /* --- 书 / 阅读 --- */
  library:
    '<path d="M4 4.5h3.6v15H4z"/><path d="M9.2 4.5h3.6v15H9.2z"/>' +
    '<path d="M15.2 5.05l3.5.94-3.32 13.46-3.5-.94z"/>',
  book:
    '<path d="M5 4.5h9.5A2.5 2.5 0 0 1 17 7v12.5H7.5A2.5 2.5 0 0 1 5 17z"/>' +
    '<path d="M5 17a2.5 2.5 0 0 1 2.5-2.5H17"/>',
  openBook:
    '<path d="M12 6.6C10.4 5.4 8.3 4.8 5.5 4.8h-2v12.4h2c2.8 0 4.9.6 6.5 1.8 1.6-1.2 3.7-1.8 6.5-1.8h2V4.8h-2c-2.8 0-4.9.6-6.5 1.8z"/>' +
    '<path d="M12 6.6v12.4"/>',
  bookmark:
    '<path d="M6.5 3.75h11a1 1 0 0 1 1 1V21l-6.5-3.9L5.5 21V4.75a1 1 0 0 1 1-1z"/>',

  /* --- 操作 --- */
  import:
    '<path d="M12 3.5V15"/><path d="M7.5 10.5 12 15l4.5-4.5"/>' +
    '<path d="M4.5 16.5v2.5A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5"/>',
  file:
    '<path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z"/>' +
    '<path d="M14 3.5V7.5H18"/>',
  archive:
    '<path d="M3.75 4.5h16.5a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-.75.75H3.75A.75.75 0 0 1 3 8.25v-3a.75.75 0 0 1 .75-.75z"/>' +
    '<path d="M5.25 9v9.75A1.5 1.5 0 0 0 6.75 20.25h10.5A1.5 1.5 0 0 0 18.75 18.75V9"/>' +
    '<path d="M10 12.75h4"/>',
  close: '<path d="M6.5 6.5 17.5 17.5"/><path d="M17.5 6.5 6.5 17.5"/>',
  /* 铅笔：用于「重命名」 */
  edit:
    '<path d="M16.5 4.5l3 3-11 11-3.5.5.5-3.5z"/>' +
    '<path d="M14.5 6.5l3 3"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  sort:
    '<path d="M8 4.5v15"/><path d="M5.2 7.3 8 4.5l2.8 2.8"/>' +
    '<path d="M16 19.5v-15"/><path d="M13.2 16.7 16 19.5l2.8-2.8"/>',

  /* --- 分类与维护 --- */
  star: '<path d="M12 3.5 14.7 9l6 .9-4.35 4.25 1.03 6L12 17.32l-5.38 2.83 1.03-6L3.3 9.9l6-.9z"/>',
  folder:
    '<path d="M3.5 7.25A1.5 1.5 0 0 1 5 5.75h3.6a1 1 0 0 1 .8.4l1.2 1.6H19a1.5 1.5 0 0 1 1.5 1.5v7.5A1.5 1.5 0 0 1 19 18.25H5A1.5 1.5 0 0 1 3.5 16.75z"/>',
  trash:
    '<path d="M5 6.5h14"/>' +
    '<path d="M9.5 6.5V4.9a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.6"/>' +
    '<path d="M6.8 6.5l.85 12.35A1.5 1.5 0 0 0 9.15 20.25h5.7a1.5 1.5 0 0 0 1.5-1.4L17.2 6.5"/>' +
    '<path d="M10.4 10.2v6"/><path d="M13.6 10.2v6"/>',
  warning:
    '<path d="M12 4.2 21.2 19.8H2.8z"/>' +
    '<path d="M12 9.6v4.6"/><path d="M12 17.2h.01"/>',

  /* --- 导航 --- */
  arrowLeft: '<path d="M19 12H5"/><path d="M11 6 5 12l6 6"/>',
  chevronLeft: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevronRight: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',

  /* --- 阅读器底部（原来就是内联 SVG，一并收进来统一维护） --- */
  toc:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/>' +
    '<path d="M8 10h8.5"/><path d="M8 14.5h5.5"/>',
  settings:
    '<path d="M12 3.6l7.3 4.2v8.4L12 20.4l-7.3-4.2V7.8z"/>' +
    '<circle cx="12" cy="12" r="2.6"/>',
  sun:
    '<circle cx="12" cy="12" r="4.2"/>' +
    '<path d="M12 2.2v2.2"/><path d="M12 19.6v2.2"/>' +
    '<path d="M2.2 12h2.2"/><path d="M19.6 12h2.2"/>' +
    '<path d="M5.1 5.1 6.7 6.7"/><path d="M17.3 17.3l1.6 1.6"/>' +
    '<path d="M18.9 5.1 17.3 6.7"/><path d="M6.7 17.3l-1.6 1.6"/>',
  moon: '<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z"/>',
};

/**
 * 生成一个图标的 SVG 字符串。
 * @param {string} name  ICON_PATHS 里的键
 * @param {object} [opts] { size, class, strokeWidth }
 */
function icon(name, opts) {
  const body = ICON_PATHS[name];
  if (!body) {
    console.warn('icon(): 没有这个图标', name);
    return '';
  }
  const o = opts || {};
  const size = o.size || 24;
  const sw = o.strokeWidth || 1.8;
  const cls = o.class ? ` class="${o.class}"` : '';
  return `<svg${cls} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
         `stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" ` +
         `stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * 把页面上所有 data-icon="名字" 的元素填成对应图标。
 * 这样静态 HTML 里不用内联一大段 <svg>，图标仍然只有一个来源。
 * 元素上加 data-icon-size / data-icon-class 可覆盖尺寸与 class。
 */
function initIcons(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    const size = parseInt(el.getAttribute('data-icon-size'), 10) || 0;
    const cls = el.getAttribute('data-icon-class') || '';
    el.innerHTML = icon(name, { size: size || undefined, class: cls || undefined });
  });
}