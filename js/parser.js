/* ========== 文件格式解析器 ========== */

/* ---------- 统一的文件读取（带旧浏览器兜底） ----------
   Blob.text() / Blob.arrayBuffer() 是 Safari 14+ 才有的 API，
   老版本 iOS 上不存在。这里回退到 FileReader，保证都能读。
   readAsText 定义在下面（带编码识别），此处不再重复定义。 */

function readAsArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

/* ---------- 文本编码识别 ----------
   中文小说站下载的 txt 很多是 GBK / GB18030 编码，
   若一律按 UTF-8 解码，整篇会变成乱码（满屏 "" 和 "?"）。

   判断顺序：
     1. BOM（UTF-8 / UTF-16LE / UTF-16BE）—— 有 BOM 就是铁证
     2. 严格按 UTF-8 解码：成功即为 UTF-8（非法字节序列会抛错）
     3. 否则按 GB18030 解码（GBK / GB2312 的超集，覆盖绝大多数简体中文站）
     4. 若 GB18030 的结果里"常用汉字"占比极低，再试 Big5（繁体）
     5. 都不理想则退回 UTF-8 宽松解码

   注：TextDecoder 只接受 WHATWG 编码标准的标签，
   gb18030 / big5 / utf-16le 都在标准内，Safari 也支持。 */
const COMMON_CN =
  '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里' +
  '后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样';

// 解码后"常用汉字"占正文的比例，用来判断这次解码是否像人话
function commonCharRatio(text) {
  if (!text) return 0;
  let hit = 0;
  const n = Math.min(text.length, 20000);   // 只抽样前 2 万字，够用且快
  for (let i = 0; i < n; i++) {
    if (COMMON_CN.indexOf(text[i]) !== -1) hit++;
  }
  return hit / Math.max(1, n);
}

function tryDecode(label, buffer) {
  try {
    return new TextDecoder(label).decode(buffer);
  } catch (e) {
    return null;
  }
}

function decodeTextBuffer(buffer) {
  const bytes = new Uint8Array(buffer);

  // 1. BOM
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: tryDecode('utf-8', buffer.slice(3)) || '', encoding: 'utf-8(BOM)' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return { text: tryDecode('utf-16le', buffer.slice(2)) || '', encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return { text: tryDecode('utf-16be', buffer.slice(2)) || '', encoding: 'utf-16be' };
  }

  // 2. 严格 UTF-8：不合法会抛错，因此这是一次可靠的判定
  let utf8 = null;
  try {
    utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (e) { utf8 = null; }
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };

  // 3. GB18030
  const gb = tryDecode('gb18030', buffer);
  const gbScore = gb === null ? -1 : commonCharRatio(gb);

  // 4. Big5（仅在 GB18030 明显不像中文时才考虑，避免把简体误判成繁体）
  const big5 = tryDecode('big5', buffer);
  const big5Score = big5 === null ? -1 : commonCharRatio(big5);

  if (big5 !== null && big5Score > gbScore * 1.3 && big5Score > 0.05) {
    return { text: big5, encoding: 'big5' };
  }
  if (gb !== null && gbScore >= 0) {
    return { text: gb, encoding: 'gb18030' };
  }
  if (big5 !== null) return { text: big5, encoding: 'big5' };

  // 5. 兜底
  const loose = tryDecode('utf-8', buffer) || '';
  return { text: loose, encoding: 'utf-8(宽松)' };
}

// 读取文本文件，自动识别编码。返回 { text, encoding }
async function readTextFile(file) {
  // 能拿到原始字节才能做编码识别。
  // 真实浏览器里 Blob 一定有 arrayBuffer()（Safari 14+）或 FileReader 兜底。
  if (typeof file.arrayBuffer === 'function' || typeof FileReader !== 'undefined') {
    try {
      return decodeTextBuffer(await readAsArrayBuffer(file));
    } catch (e) {
      console.warn('按字节读取失败，退回按文本读取', e);
    }
  }

  // 退路：只拿得到已解码的文本。此时无法识别编码，
  // 但至少比直接失败好（也兼容只提供 .text() 的测试夹具）。
  if (typeof file.text === 'function') {
    return { text: await file.text(), encoding: 'utf-8(未识别)' };
  }

  throw new Error('无法读取文件内容');
}

/* 统一的文本读取（对外保持原签名）。
   注意：不再直接用 Blob.text()，因为它固定按 UTF-8 解码，
   GBK 的小说会整个变成乱码。 */
async function readAsText(file) {
  const { text } = await readTextFile(file);
  return text;
}

// 获取文件格式
function getFileFormat(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const formats = {
    'txt': 'txt', 'text': 'txt',
    'epub': 'epub',
    'pdf': 'pdf',
    'docx': 'docx', 'doc': 'docx',
    'mobi': 'mobi', 'azw3': 'mobi', 'azw': 'mobi',
    'zip': 'zip'
  };
  return formats[ext] || 'unknown';
}

// 判断是否为支持的阅读格式
function isSupportedFormat(filename) {
  const fmt = getFileFormat(filename);
  return ['txt', 'epub', 'pdf', 'docx'].includes(fmt);
}

// 从文件名提取书名
function extractTitle(filename) {
  let name = filename.replace(/\.[^.]+$/, ''); // 去扩展名
  // 去掉常见的站点标记
  name = name.replace(/[【\[].*?[】\]]/g, '');
  name = name.replace(/[（\(].*?[）\)]/g, '');
  name = name.replace(/[_\-\s]+作者.*$/i, '');
  name = name.replace(/^[_\-\s]+/, '');
  name = name.replace(/[_\-\s]+$/, '');
  return name.trim() || filename;
}

/* ========== TXT 解析 ========== */
/* ---------- 分块上限（防止"一章几十万字"把手机卡死） ----------
   多列分页会把一章的所有段落一次性排进 DOM。
   如果整本书被当成一章（网文站下载的 txt 常常没有章节标记），
   就会生成几万个 <p>，手机端排版会长时间占满主线程——
   表现就是"一直显示加载中、点什么都没反应"。 */
const MAX_CHARS_PER_CHAPTER = 120000;   // 单章上限：超过就再切分
const PLAIN_CHUNK_CHARS = 30000;        // 无章节标记时，按这个字数切成"第N部分"

// 把长文本按行切成若干块（只在行边界断开，不会切断一行文字）
function chunkPlainText(text, maxChars) {
  const lines = text.split('\n');
  const pieces = [];
  let buf = [];
  let size = 0;

  for (const ln of lines) {
    buf.push(ln);
    size += ln.length + 1;
    if (size >= maxChars) {
      pieces.push(buf.join('\n'));
      buf = [];
      size = 0;
    }
  }
  if (buf.length) pieces.push(buf.join('\n'));
  return pieces.length ? pieces : [text];
}

// 保险：任何一章超过上限都再切分，避免极端输入把渲染卡死
function splitOversizedChapters(chapters, maxChars) {
  const out = [];
  for (const ch of chapters) {
    const content = ch.content || '';
    if (content.length <= maxChars) {
      out.push(ch);
      continue;
    }
    const parts = chunkPlainText(content, maxChars);
    parts.forEach((piece, i) => {
      out.push({
        title: i === 0 ? ch.title : `${ch.title}（续${i}）`,
        content: piece
      });
    });
  }
  return out.map((ch, i) => ({ index: i, title: ch.title, content: ch.content }));
}

async function parseTxt(file) {
  // 自动识别编码：中文站的 txt 很多是 GBK，一律按 UTF-8 读会整个变乱码
  const { text, encoding } = await readTextFile(file);
  console.log(`TXT 编码识别为 ${encoding}，正文 ${text.length} 字`);
  
  // 智能分章
  const chapterPatterns = [
    /(?:^|\n)\s*第[零一二三四五六七八九十百千万0-9]+[章节回卷集篇部].*/g,
    /(?:^|\n)\s*[Cc][Hh][Aa][Pp][Tt][Ee][Rr]\s+\d+.*/g,
    /(?:^|\n)\s*[第]?\d+[\.、\s]+.*/g,
    /(?:^|\n)\s*[卷集篇部]\s*[零一二三四五六七八九十百千万0-9]+.*/g,
  ];
  
  let chapters = [];
  let allMatches = [];
  
  for (const pattern of chapterPatterns) {
    let match;
    const regex = new RegExp(pattern.source, 'g');
    while ((match = regex.exec(text)) !== null) {
      allMatches.push({ index: match.index, title: match[0].trim().replace(/^\n+/, '') });
    }
  }
  
  // 去重并排序
  allMatches.sort((a, b) => a.index - b.index);
  const seen = new Set();
  allMatches = allMatches.filter(m => {
    const key = `${m.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  if (allMatches.length === 0) {
    // 没有任何章节标记。
    // 不能整本塞成一章：那样会生成几万个段落，手机排版时直接卡死。
    // 按字数切成"第N部分"，既保证渲染可行，也让目录和进度有意义。
    const parts = chunkPlainText(text, PLAIN_CHUNK_CHARS);
    chapters = parts.map((content, i) => ({
      index: i,
      title: parts.length === 1 ? '正文' : `第${i + 1}部分`,
      content
    }));
  } else {
    for (let i = 0; i < allMatches.length; i++) {
      const start = allMatches[i].index;
      const end = i + 1 < allMatches.length ? allMatches[i + 1].index : text.length;
      chapters.push({
        index: i,
        title: allMatches[i].title,
        content: text.slice(start, end)
      });
    }
    // 保险：个别章节异常大（例如全书只有一个章节标记）时再切分
    chapters = splitOversizedChapters(chapters, MAX_CHARS_PER_CHAPTER);
  }
  
  return {
    chapters,
    totalLength: text.length,
    encoding   // 识别到的编码，便于排查乱码问题
  };
}

/* ========== EPUB 解析 ========== */
async function parseEpub(file, bookId) {
  // 使用 epub.js 的简易解析（加载文件到内存）
  const arrayBuffer = await readAsArrayBuffer(file);
  
  // 保存原始文件到 IndexedDB 供 epub.js 使用
  // epub.js 需要 URL，我们用 Blob URL
  if (window._epubBlobs === undefined) {
    window._epubBlobs = {};
  }
  
  const blob = new Blob([arrayBuffer], { type: 'application/epub+zip' });
  const url = URL.createObjectURL(blob);
  window._epubBlobs[bookId] = url;
  
  // 用 JSZip 快速提取目录信息
  const zip = await JSZip.loadAsync(arrayBuffer);
  
  // 查找 toc 或 spine
  let chapters = [];
  let chapterIndex = 0;
  
  // 尝试解析 container.xml 找到 opf
  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const containerText = await containerFile.async('text');
    const opfMatch = containerText.match(/full-path="([^"]+)"/);
    if (opfMatch) {
      const opfPath = opfMatch[1];
      const opfFile = zip.file(opfPath);
      if (opfFile) {
        const opfText = await opfFile.async('text');
        
        // 提取 spine 中的 itemref
        const spineMatch = opfText.match(/<spine[^>]*>([\s\S]*?)<\/spine>/);
        if (spineMatch) {
          const idrefs = [...spineMatch[1].matchAll(/idref="([^"]+)"/g)].map(m => m[1]);
          
          // 解析 manifest
          const manifestMatch = opfText.match(/<manifest>([\s\S]*?)<\/manifest>/);
          if (manifestMatch) {
            const items = {};
            for (const m of manifestMatch[1].matchAll(/<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*\/?>/g)) {
              items[m[1]] = m[2];
            }
            
            // 提取书名
            const titleMatch = opfText.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/);
            if (titleMatch) {
              window._epubTitle = titleMatch[1];
            }
            
            const opfDir = opfPath.split('/').slice(0, -1).join('/');
            
            for (const idref of idrefs) {
              const href = items[idref];
              if (href) {
                const fullPath = opfDir ? `${opfDir}/${href}` : href;
                const contentFile = zip.file(fullPath);
                if (contentFile) {
                  const htmlContent = await contentFile.async('text');
                  // 简单提取文本
                  const textContent = htmlContent
                    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
                    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&')
                    .replace(/&quot;/g, '"')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                  
                  chapters.push({
                    index: chapterIndex++,
                    title: `第${chapterIndex}章`,
                    content: textContent
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  
  if (chapters.length === 0) {
    chapters.push({
      index: 0,
      title: '正文',
      content: 'EPUB 文件，点击开始阅读...'
    });
  }
  
  return {
    chapters,
    totalLength: chapters.reduce((sum, c) => sum + c.content.length, 0)
  };
}

/* ========== PDF 解析 ========== */
async function parsePdf(file, bookId) {
  const arrayBuffer = await readAsArrayBuffer(file);
  const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  if (window._pdfBlobs === undefined) window._pdfBlobs = {};
  if (window._pdfDocs === undefined) window._pdfDocs = {};

  // 释放上一本书缓存的 PDF 文档，避免内存堆积
  for (const key of Object.keys(window._pdfDocs)) {
    if (window._pdfDocs[key] && typeof window._pdfDocs[key].destroy === 'function') {
      try { window._pdfDocs[key].destroy(); } catch (e) {}
    }
    delete window._pdfDocs[key];
  }
  for (const key of Object.keys(window._pdfBlobs)) {
    try { URL.revokeObjectURL(window._pdfBlobs[key]); } catch (e) {}
    delete window._pdfBlobs[key];
  }

  window._pdfBlobs[bookId] = url;

  // 打开一次并缓存文档对象（翻页时复用，避免重复解析整个 PDF）
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  window._pdfDocs[bookId] = pdf;
  const numPages = pdf.numPages;

  let chapters = [];
  for (let i = 1; i <= numPages; i++) {
    chapters.push({
      index: i - 1,
      title: `第${i}页`,
      pageNum: i,
      content: '' // PDF 页面通过 pdf.js 渲染
    });
  }

  return {
    chapters,
    totalLength: numPages,
    numPages
  };
}

/* ========== DOCX 解析 ========== */
async function parseDocx(file) {
  const arrayBuffer = await readAsArrayBuffer(file);
  
  // 使用 mammoth.js 转换
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const html = result.value;
  
  // HTML 转纯文本并分章
  const text = html
    .replace(/<h1[^>]*>/gi, '\n## ')
    .replace(/<h2[^>]*>/gi, '\n### ')
    .replace(/<h3[^>]*>/gi, '\n#### ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  // 按标题分章
  const sections = text.split(/\n(?=#{2,4}\s)/);
  let chapters = [];
  let chapterIndex = 0;
  
  if (sections.length <= 1) {
    chapters.push({
      index: 0,
      title: '正文',
      content: text
    });
  } else {
    for (const section of sections) {
      const lines = section.split('\n');
      const title = lines[0].replace(/^#+\s*/, '').trim() || `第${chapterIndex + 1}章`;
      const content = lines.slice(1).join('\n').trim();
      if (content || sections.length <= 2) {
        chapters.push({
          index: chapterIndex++,
          title,
          content
        });
      }
    }
  }
  
  return {
    chapters,
    totalLength: text.length
  };
}

/* ========== ZIP 解压 ========== */
async function extractZip(file, progressCallback) {
  const arrayBuffer = await readAsArrayBuffer(file);
  const zip = await JSZip.loadAsync(arrayBuffer);
  
  const files = [];
  const entries = Object.values(zip.files).filter(f => !f.dir);
  let processed = 0;
  
  for (const entry of entries) {
    const filename = entry.name.split('/').pop();
    if (!filename || filename.startsWith('.')) continue;
    
    const format = getFileFormat(filename);
    if (isSupportedFormat(filename)) {
      const blob = await entry.async('blob');
      const bookFile = new File([blob], filename, { type: blob.type });
      files.push(bookFile);
    }
    
    processed++;
    if (progressCallback) {
      progressCallback(processed, entries.length);
    }
  }
  
  return files;
}