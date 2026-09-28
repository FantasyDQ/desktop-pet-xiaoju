/* ============================================================
   chat.js - AI 对话功能（对话气泡窗 + 接入主进程 chat 接口）
   挂载到 window.PetApp.chat
   ============================================================ */
window.PetApp = window.PetApp || {};

(function (App) {
  'use strict';

  const state = App.state;
  let pet;
  let boxEl, messagesEl, inputEl, sendBtn;
  let isOpen = false;
  // 记住用户调整的窗口大小和位置（内存级，重启重置）
  let savedWidth = null, savedHeight = null, savedLeft = null, savedTop = null, savedExpanded = null;
  let chatHistoryPanel = null;

  // 聊天记录持久化存储（保存到本地文件，通过 IPC 读写）
  async function loadChatHistory() {
    try { return await window.pet.loadChatHistory(); }
    catch (e) { return []; }
  }
  async function saveChatHistory(history) {
    try { await window.pet.saveChatHistory(history); } catch (e) {}
  }
  async function addChatRecord(role, text) {
    const history = await loadChatHistory();
    const time = Date.now();
    history.push({ role, text, time });
    await saveChatHistory(history.slice(-200));
    return time;
  }

  // markdown 转纯文本（去掉标记符号，保留换行和内容）
  function mdToPlainText(md) {
    if (!md) return '';
    let t = md;
    t = t.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1'); // 代码块去围栏
    t = t.replace(/`([^`]+)`/g, '$1');                 // 行内代码
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');          // 粗体
    t = t.replace(/__([^_]+)__/g, '$1');              // 粗体_
    t = t.replace(/(?<!\*)\*(?!\*)[^*]+\*(?!\*)/g, (m) => m.slice(1, -1)); // 斜体
    t = t.replace(/^###\s+/gm, '');                    // 标题
    t = t.replace(/^##\s+/gm, '');
    t = t.replace(/^#\s+/gm, '');
    t = t.replace(/^[-*]\s+/gm, '• ');                 // 无序列表 → 圆点
    t = t.replace(/^\d+\.\s+/gm, '');                   // 有序列表
    t = t.replace(/^>\s+/gm, '');                      // 引用
    t = t.replace(/^---+$/gm, '────────');             // 分割线
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）'); // 链接
    return t.trim();
  }

  // 给 pet 消息加复制按钮（纯文本 + Markdown 两个选项）
  // 绑定 HTML 折叠面板的预览/保存按钮
  function bindHtmlButtons(container) {
    // 预览：保存到临时文件后用默认浏览器打开
    const previewBtns = container.querySelectorAll('.md-html-preview');
    previewBtns.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const wrap = btn.closest('.md-html-collapse');
        const rawHtml = wrap ? wrap.getAttribute('data-html') : '';
        if (!rawHtml) return;
        const html = decodeURIComponent(rawHtml);
        btn.textContent = '打开中…';
        try {
          // 保存到临时文件，用默认浏览器打开
          const ts = Date.now();
          const fname = `小橘预览_${ts}.html`;
          const res = await window.pet.saveFile(html, fname);
          if (res && res.success) {
            await window.pet.openFile(res.path);
            btn.textContent = '✓ 已打开';
            setTimeout(() => { btn.textContent = '👁️ 预览'; }, 2000);
          } else {
            btn.textContent = '✗ 失败';
            setTimeout(() => { btn.textContent = '👁️ 预览'; }, 2000);
          }
        } catch (err) {
          btn.textContent = '✗ 失败';
          setTimeout(() => { btn.textContent = '👁️ 预览'; }, 2000);
        }
      });
    });
    // 保存文档到配置文件夹（支持 html/word/excel/ppt）
    const saveBtns = container.querySelectorAll('.md-html-save');
    saveBtns.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const docType = btn.getAttribute('data-doctype') || 'html';
        const raw = btn.getAttribute('data-raw') || '';
        const html = decodeHtmlEntities(raw);
        btn.textContent = '保存中…';
        try {
          const ts = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const dateStr = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}`;
          // 根据文档类型确定扩展名和包装
          let ext = 'html', wrapped = html, fname = '';
          if (docType === 'word') {
            ext = 'doc';
            wrapped = wrapAsWord(html);
            fname = `小橘文档_${dateStr}.doc`;
          } else if (docType === 'excel') {
            ext = 'xls';
            wrapped = wrapAsExcel(html);
            fname = `小橘表格_${dateStr}.xls`;
          } else if (docType === 'ppt') {
            ext = 'ppt';
            wrapped = wrapAsPPT(html);
            fname = `小橘演示_${dateStr}.ppt`;
          } else {
            fname = `小橘生成_${dateStr}.html`;
          }
          const res = await window.pet.saveFile(wrapped, fname);
          if (res && res.success) {
            const shortPath = res.path ? res.path.replace(/^.*[\\/]/, '') : fname;
            btn.textContent = '✓ ' + shortPath;
            btn.title = '已保存到：' + (res.path || '');
            setTimeout(() => {
              btn.textContent = { html: '💾 保存网页', word: '💾 保存Word', excel: '💾 保存Excel', ppt: '💾 保存PPT' }[docType] || '💾 保存';
            }, 3000);
          } else {
            btn.textContent = '✗ 失败';
            setTimeout(() => {
              btn.textContent = { html: '💾 保存网页', word: '💾 保存Word', excel: '💾 保存Excel', ppt: '💾 保存PPT' }[docType] || '💾 保存';
            }, 2000);
          }
        } catch (err) {
          btn.textContent = '✗ 失败';
          setTimeout(() => {
            btn.textContent = { html: '💾 保存网页', word: '💾 保存Word', excel: '💾 保存Excel', ppt: '💾 保存PPT' }[docType] || '💾 保存';
          }, 2000);
        }
      });
    });
  }

  // Word 文档 HTML 包装（Word 可直接打开 .doc 格式的 HTML）
  function wrapAsWord(content) {
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>文档</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page WordSection1 { size: A4; margin: 2.54cm 3.18cm 2.54cm 3.18cm; }
div.WordSection1 { page: WordSection1; }
body { font-family: '宋体', SimSun, serif; font-size: 12pt; line-height: 1.5; }
h1 { font-size: 18pt; text-align: center; font-weight: bold; margin: 12pt 0; }
h2 { font-size: 15pt; font-weight: bold; margin: 10pt 0; }
h3 { font-size: 13pt; font-weight: bold; margin: 8pt 0; }
p { text-indent: 2em; margin: 4pt 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
td, th { border: 1pt solid #000; padding: 5pt 8pt; font-size: 11pt; }
th { background: #f0f0f0; font-weight: bold; text-align: center; }
ul, ol { margin: 4pt 0; padding-left: 2em; }
</style>
</head>
<body><div class="WordSection1">
${content}
</div></body>
</html>`;
  }

  // Excel 表格 HTML 包装（Excel 可直接打开 .xls 格式的 HTML）
  function wrapAsExcel(content) {
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Sheet1</x:Name></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
table { border-collapse: collapse; }
td, th { border: 1px solid #000; padding: 4px 8px; font-family: '宋体', SimSun; font-size: 11pt; white-space: nowrap; }
th { background: #d9e1f2; font-weight: bold; }
</style>
</head>
<body>
${content}
</body>
</html>`;
  }

  // PPT 演示 HTML 包装（PowerPoint 可导入 .ppt 格式的 HTML）
  function wrapAsPPT(content) {
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:p="urn:schemas-microsoft-com:office:powerpoint" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<style>
body { margin: 0; }
.slide { width: 960px; height: 540px; margin: 0 auto 20px; padding: 40px; box-sizing: border-box; page-break-after: always; font-family: '微软雅黑', sans-serif; }
.slide h1 { font-size: 32pt; margin-bottom: 20pt; }
.slide h2 { font-size: 24pt; margin-bottom: 16pt; }
.slide p { font-size: 18pt; line-height: 1.6; }
.slide ul { font-size: 18pt; line-height: 1.8; }
</style>
</head>
<body>
${content}
</body>
</html>`;
  }

  function decodeHtmlEntities(s) {
    const t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }

  // 流式渲染 Markdown：未闭合的 HTML/Word/Excel/PPT 代码块显示"正在生成"+ 可折叠代码
  function renderStreamMarkdown(text) {
    // 检测是否有未闭合的代码块（html/word/excel/ppt）
    const docTypes = ['```html', '```word', '```excel', '```ppt'];
    for (const startTag of docTypes) {
      const startIdx = text.indexOf(startTag);
      if (startIdx >= 0) {
        const afterStart = text.substring(startIdx + startTag.length);
        const endIdx = afterStart.indexOf('```');
        if (endIdx < 0) {
          // 还没闭合 → 显示前面的文字 + "正在生成"折叠面板
          const before = text.substring(0, startIdx);
          const beforeHtml = App.markdown.render(before);
          const rawCode = afterStart;
          const escapedCode = App.markdown.escapeHtml ? App.markdown.escapeHtml(rawCode) : rawCode.replace(/</g, '&lt;');
          const typeLabel = startTag.replace('```', '').toUpperCase();
          return beforeHtml +
            '<details class="md-html-gen-collapse">' +
              '<summary class="md-html-gen-summary">🔨 正在生成 ' + typeLabel + '…</summary>' +
              '<pre class="md-html-gen-code"><code>' + escapedCode + '</code></pre>' +
            '</details>';
        }
      }
    }
    return App.markdown.render(text);
  }

  function addCopyButton(div, rawText) {
    const bar = document.createElement('div');
    bar.className = 'chat-copy-bar';

    // 复制按钮（图标 + 文字胶囊）
    const copyBtn = document.createElement('button');
    copyBtn.className = 'chat-copy-btn';
    copyBtn.innerHTML = '<span class="ic">📋</span>复制';
    copyBtn.title = '复制 Markdown 原文';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = rawText || div.textContent || '';
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML = '<span class="ic">✓</span>已复制';
        setTimeout(() => { copyBtn.innerHTML = '<span class="ic">📋</span>复制'; }, 1200);
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); copyBtn.innerHTML = '<span class="ic">✓</span>已复制'; setTimeout(() => { copyBtn.innerHTML = '<span class="ic">📋</span>复制'; }, 1200); } catch (e2) {}
        document.body.removeChild(ta);
      });
    });
    bar.appendChild(copyBtn);

    // 下载 Markdown 按钮
    const dlBtn = document.createElement('button');
    dlBtn.className = 'chat-copy-btn';
    dlBtn.innerHTML = '<span class="ic">📥</span>Markdown';
    dlBtn.title = '下载为 Markdown 文件';
    dlBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = rawText || div.textContent || '';
      dlBtn.innerHTML = '<span class="ic">⋯</span>保存中';
      try {
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const fname = `小橘回复_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.md`;
        const res = await window.pet.saveFile(text, fname);
        if (res && res.success) {
          dlBtn.innerHTML = '<span class="ic">✓</span>已保存';
          dlBtn.title = '已保存到：' + (res.path || '');
          setTimeout(() => { dlBtn.innerHTML = '<span class="ic">📥</span>Markdown'; }, 1500);
        } else {
          dlBtn.innerHTML = '<span class="ic">✗</span>失败';
          setTimeout(() => { dlBtn.innerHTML = '<span class="ic">📥</span>Markdown'; }, 1500);
        }
      } catch (err) {
        dlBtn.innerHTML = '<span class="ic">✗</span>失败';
        setTimeout(() => { dlBtn.innerHTML = '<span class="ic">📥</span>Markdown'; }, 1500);
      }
    });
    bar.appendChild(dlBtn);
    div.appendChild(bar);

    // 检测 HTML 代码块，加"保存网页"按钮
    if (rawText && /```html/i.test(rawText)) {
      const htmlMatch = rawText.match(/```html?\s*\n([\s\S]*?)```/i);
      if (htmlMatch && htmlMatch[1] && htmlMatch[1].trim().length > 50) {
        const saveBtn = document.createElement('button');
        saveBtn.className = 'chat-copy-btn chat-save-btn';
        saveBtn.innerHTML = '<span class="ic">💾</span>保存网页';
        saveBtn.title = '保存网页到配置文件夹';
        saveBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          saveBtn.innerHTML = '<span class="ic">⋯</span>保存中';
          try {
            const html = htmlMatch[1].trim();
            const ts = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const fname = `小橘生成_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.html`;
            const res = await window.pet.saveFile(html, fname);
            if (res && res.success) {
              saveBtn.innerHTML = '<span class="ic">✓</span>已保存';
              setTimeout(() => { saveBtn.innerHTML = '<span class="ic">💾</span>保存网页'; }, 2000);
            } else {
              saveBtn.innerHTML = '<span class="ic">✗</span>失败';
              setTimeout(() => { saveBtn.innerHTML = '<span class="ic">💾</span>保存网页'; }, 1500);
            }
          } catch (err) {
            saveBtn.innerHTML = '<span class="ic">✗</span>失败';
            setTimeout(() => { saveBtn.innerHTML = '<span class="ic">💾</span>保存网页'; }, 1500);
          }
        });
        bar.appendChild(saveBtn);
      }
    }
  }

  // 给消息气泡附加删除按钮（实时聊天消息也支持）
  function attachDelBtn(div, role, text) {
    const delBtn = document.createElement('button');
    delBtn.className = 'chat-msg-del';
    delBtn.textContent = '🗑';
    delBtn.title = '删除这条消息';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 先按精确匹配删，失败再按前缀匹配（兼容图片/文件场景存储文本带后缀）
      let res = await window.pet.chatDeleteByContent(role, text);
      if (!res || !res.success) {
        res = await window.pet.chatDeleteByContent(role, text + ' [图片]');
      }
      if (res && res.success) {
        // 找到所属行并淡出移除
        const row = div.closest('.chat-msg-row');
        if (row) {
          row.style.transition = 'opacity 0.2s';
          row.style.opacity = '0';
          setTimeout(() => row.remove(), 200);
        }
      }
    });
    div.appendChild(delBtn);
  }

  // 创建头像元素（支持自定义图片）
  function createAvatarEl(role) {
    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar ' + role;
    const custom = role === 'pet' ? (App.avatar && App.avatar.getPetAvatar()) : (App.avatar && App.avatar.getUserAvatar());
    if (custom && custom.src) {
      avatar.innerHTML = `<img src="${custom.src}" alt="${role}" />`;
    } else {
      avatar.textContent = role === 'pet' ? '🐱' : '我';
    }
    return avatar;
  }

  function addMessage(text, role) {
    // 隐藏空状态引导
    const emptyState = document.getElementById('chatEmptyState');
    if (emptyState) emptyState.style.display = 'none';
    // 消息行：头像 + 气泡
    const row = document.createElement('div');
    row.className = 'chat-msg-row ' + role;
    const avatar = createAvatarEl(role);
    // 气泡容器
    const wrap = document.createElement('div');
    wrap.className = 'chat-bubble-wrap';
    // 气泡
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    if (role === 'pet' && App.markdown) {
      div.innerHTML = App.markdown.render(text);
      addCopyButton(div, text);
      // 绑定 HTML 折叠面板的保存/复制按钮
      bindHtmlButtons(div);
    } else {
      div.textContent = text;
      // 用户消息也加复制按钮（纯文本）
      addCopyButton(div, text);
    }
    attachDelBtn(div, role, text);
    wrap.appendChild(div);
    row.appendChild(avatar);
    row.appendChild(wrap);
    messagesEl.appendChild(row);
    fitHeight();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // 显示空状态引导界面（清屏/清除历史时回到初始化界面）
  function showEmptyState() {
    messagesEl.innerHTML = '';
    // 重建空状态引导
    const empty = document.createElement('div');
    empty.className = 'chat-empty-state';
    empty.id = 'chatEmptyState';
    empty.innerHTML = `
      <div class="empty-icon">🐱</div>
      <div class="empty-title">和小橘聊点什么吧～</div>
      <div class="empty-hint">我会写代码、操作电脑、生成文档、接入外部工具…远不止聊天</div>
      <div class="empty-tags">
        <span class="empty-tag"><span class="tag-emoji">🐍</span>写代码</span>
        <span class="empty-tag"><span class="tag-emoji">📄</span>生成文档</span>
        <span class="empty-tag"><span class="tag-emoji">🔌</span>MCP工具</span>
        <span class="empty-tag"><span class="tag-emoji">💻</span>操作电脑</span>
        <span class="empty-tag"><span class="tag-emoji">🔄</span>定时任务</span>
        <span class="empty-tag"><span class="tag-emoji">🔍</span>联网搜索</span>
      </div>`;
    messagesEl.appendChild(empty);
    fitHeight();
  }

  // 创建流式消息行（头像 + 气泡），返回 { row, bubble } 供流式更新
  function createStreamRow() {
    const row = document.createElement('div');
    row.className = 'chat-msg-row pet';
    const avatar = createAvatarEl('pet');
    const wrap = document.createElement('div');
    wrap.className = 'chat-bubble-wrap';
    const bubble = document.createElement('div');
    bubble.className = 'chat-msg pet thinking';
    wrap.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(wrap);
    messagesEl.appendChild(row);
    fitHeight();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return { row, bubble };
  }

  // 添加提示气泡（如"已拖入文件"等），带头像行结构，返回 bubble 元素
  function addTipBubble(role, html, extraClass) {
    const row = document.createElement('div');
    row.className = 'chat-msg-row ' + role;
    const avatar = createAvatarEl(role);
    const wrap = document.createElement('div');
    wrap.className = 'chat-bubble-wrap';
    const bubble = document.createElement('div');
    bubble.className = 'chat-msg ' + role + (extraClass ? ' ' + extraClass : '');
    bubble.innerHTML = html;
    wrap.appendChild(bubble);
    row.appendChild(avatar);
    row.appendChild(wrap);
    messagesEl.appendChild(row);
    fitHeight();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  // 消息区高度自适应：内容少时收窄，内容多时撑高（跟随窗口大小）
  function fitHeight() {
    if (!messagesEl) return;
    messagesEl.style.height = 'auto';
    const h = messagesEl.scrollHeight;
    // 根据聊天框实际高度动态计算上限（窗口放大时消息区也放大）
    const boxH = boxEl ? boxEl.offsetHeight : 400;
    const maxH = Math.max(380, boxH - 160); // 减去标题栏+工具栏+输入栏的高度
    const target = Math.min(Math.max(h + 4, 150), maxH);
    messagesEl.style.height = target + 'px';
    // 高度变化后重新定位，防止超出屏幕
    if (isOpen) position();
  }

  let isWaiting = false; // 是否正在等待 AI 回复
  let isExpanded = true; // 聊天框是否处于放大状态（默认放大）

  async function send() {
    // 等待中点击发送按钮 → 停止生成（文本/图片都适用）
    if (isWaiting) {
      if (window.pet.chatStop) window.pet.chatStop();
      return;
    }
    let text = inputEl.value.trim();
    // 支持注入拖拽文件内容（发送给 AI 但不在聊天框显示文件内容）
    let hiddenContext = '';
    if (window._pendingFileContent) {
      hiddenContext = window._pendingFileContent;
      window._pendingFileContent = null;
      inputEl.value = '';
      inputEl.placeholder = '对小橘说点什么…';
    }
    // 检查是否有待发送的图片（截屏/上传/粘贴，支持多张）
    const pendingImages = App.chat._getPendingImages ? App.chat._getPendingImages() : [];

    // 有图片 → 走 vision 模型（不要求文字，空文字也行）
    if (pendingImages && pendingImages.length > 0) {
      // 图片+文件同时存在时，把文件内容附加到问题中一起发给 vision 模型
      const displayText = text || '请描述这些图片的内容。'; // 聊天框只显示提问，不显示文件内容
      let q = displayText;
      if (hiddenContext) {
        q = q + '\n\n【以下是用户提供的文件内容，请作为参考信息使用，不要原样输出或复述文件内容】' + hiddenContext;
        hiddenContext = ''; // 已附加到问题中，不再走文本路径
      }
      if (!isWaiting) {
        inputEl.value = '';
        inputEl.placeholder = '输入消息…';
        addMessage(displayText, 'user');
        addChatRecord('user', displayText + (pendingImages.length > 1 ? ` [${pendingImages.length}张图片]` : ' [图片]'));
        isWaiting = true;
        sendBtn.disabled = false;
        inputEl.disabled = true;
        sendBtn.textContent = '⏹ 停止';
        const { row: _vrow, bubble: streamEl } = createStreamRow();
        streamEl.textContent = pendingImages.length > 1 ? `👁️ 正在看图（${pendingImages.length}张）…` : '👁️ 正在看图…';
        messagesEl.scrollTop = messagesEl.scrollHeight;
        fitHeight();

        // 监听 skill 激活标记
        const onSkill = (data) => {
          if (data && data.name) {
            streamEl.textContent = `🧩 正在执行技能：${data.name}…`;
          }
        };
        const removeSkillListener = window.pet.onChatSkill ? window.pet.onChatSkill(onSkill) : null;

        // 流式输出
        let firstChunk = true;
        let streamText = '';
        const onChunk = (delta) => {
          if (firstChunk) { streamEl.classList.remove('thinking'); firstChunk = false; }
          streamText += delta;
          if (App.markdown) {
            streamEl.innerHTML = renderStreamMarkdown(streamText);
          } else {
            streamEl.textContent = streamText;
          }
          fitHeight();
          messagesEl.scrollTop = messagesEl.scrollHeight;
        };
        const removeChunkListener = window.pet.onChatChunk(onChunk);

        try {
          const res = await window.pet.chatVision(pendingImages, q);
          removeChunkListener();
          if (removeSkillListener) removeSkillListener();
          streamEl.classList.remove('thinking');
          // 用户停止生成
          if (res && res.stopped) {
            if (streamText) {
              if (App.markdown) {
                const contentEl = ensureAgentContentEl();
                contentEl.innerHTML = App.markdown.render(streamText) + '<span class="chat-stopped-tag">⏹ 已停止</span>';
                addCopyButton(contentEl, streamText);
                bindHtmlButtons(contentEl);
              } else {
                const contentEl = ensureAgentContentEl();
                contentEl.textContent = streamText + ' ⏹ 已停止';
              }
              addChatRecord('pet', streamText);
              attachDelBtn(streamEl, 'pet', streamText);
            } else {
              streamEl.textContent = '⏹ 已停止';
            }
          } else if (res && res.reply) {
            // 流式已推送的不再重复渲染；非流式则整体渲染
            if (!res.streamed) {
              if (App.markdown) {
                const contentEl = ensureAgentContentEl();
                contentEl.innerHTML = App.markdown.render(res.reply);
              } else {
                const contentEl = ensureAgentContentEl();
                contentEl.textContent = res.reply;
              }
            }
            if (App.markdown) {
              const contentEl = ensureAgentContentEl();
              addCopyButton(contentEl, res.reply);
              bindHtmlButtons(contentEl);
            }
            addChatRecord('pet', res.reply);
            attachDelBtn(streamEl, 'pet', res.reply);
          } else {
            streamEl.textContent = '喵…图片理解失败了';
          }
        } catch (e) {
          removeChunkListener();
          if (removeSkillListener) removeSkillListener();
          streamEl.classList.remove('thinking');
          streamEl.textContent = '喵…出错了：' + e.message;
        }
        isWaiting = false;
        sendBtn.disabled = false;
        inputEl.disabled = false;
        sendBtn.textContent = '发送';
        fitHeight();
        messagesEl.scrollTop = messagesEl.scrollHeight;
        inputEl.focus();
      }
      return;
    }

    if (!text) return;
    inputEl.value = '';
    // 聊天框只显示用户的提问文字，不显示文件内容
    addMessage(text, 'user');
    addChatRecord('user', text);
    // 实际发给 AI 的是提问 + 隐藏的文件内容（用标记包裹，告诉 LLM 不要原样输出）
    const sendText = hiddenContext ? '__SKIP_INTENT__' + text + '\n\n【以下是用户提供的文件内容，请作为参考信息使用，不要原样输出或复述文件内容】' + hiddenContext : text;
    isWaiting = true;
    sendBtn.disabled = false;
    inputEl.disabled = true;
    sendBtn.textContent = '⏹ 停止';

    // 创建流式消息元素，先显示"思考中"
    const { row: streamRow, bubble: streamEl } = createStreamRow();
    streamEl.textContent = '';

    // 链路步骤和正文交错排列：步骤直接 append 到 streamEl，流式正文在独立容器内更新
    let agentContentEl = null;
    let thinkingAdded = false; // 防止重复追加"思考中"步骤
    // 追加一条步骤（创建独立 div，不被后续覆盖）
    function appendAgentStep(text) {
      // 第一次追加步骤时移除 thinking 动画
      streamEl.classList.remove('thinking');
      // 如果已有正文容器，步骤插到正文前面（交错效果）
      const step = document.createElement('div');
      step.className = 'agent-step-line';
      step.innerHTML = `<span class="step-spinner"></span><span class="step-text">${(data => { const d = document.createElement('div'); d.textContent = data; return d.innerHTML; })(text)}</span>`;
      if (agentContentEl) {
        streamEl.insertBefore(step, agentContentEl);
      } else {
        streamEl.appendChild(step);
      }
      // 更新进度条
      updateProgress();
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return step;
    }
    // 标记步骤完成（移除 spinner）
    function completeAgentStep(stepEl) {
      if (stepEl) stepEl.classList.add('done');
    }
    // 进度条
    let progressBar = null;
    let stepCount = 0;
    function updateProgress() {
      stepCount++;
      if (!progressBar) {
        progressBar = document.createElement('div');
        progressBar.className = 'agent-progress-bar';
        progressBar.innerHTML = '<div class="agent-progress-fill"></div>';
        streamEl.insertBefore(progressBar, agentContentEl || null);
      }
      const fill = progressBar.querySelector('.agent-progress-fill');
      if (fill) {
        // 进度估算：每步增长，上限 90%（完成时填满）
        const pct = Math.min(90, stepCount * 12);
        fill.style.width = pct + '%';
      }
    }
    // 获取/创建正文容器
    function ensureAgentContentEl() {
      if (agentContentEl) return agentContentEl;
      agentContentEl = document.createElement('div');
      agentContentEl.className = 'agent-content';
      streamEl.appendChild(agentContentEl);
      return agentContentEl;
    }
    // 开始新一轮正文：重置正文容器，让下一轮正文在新容器显示
    function startNewRoundContent() {
      agentContentEl = null;
      streamText = '';
      // 不重置 firstChunk，避免 onStatus 重复追加步骤
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;

    let firstChunk = true;
    let streamText = '';
    let allStreamText = ''; // 跨轮次累积所有正文（用于聊天记录/删除按钮）
    let wasStopped = false;
    const onChunk = (delta) => {
      if (firstChunk) {
        streamEl.classList.remove('thinking');
        firstChunk = false;
      }
      streamText += delta;
      allStreamText += delta;
      const contentEl = ensureAgentContentEl();
      // 流式过程中渲染：HTML 代码块折叠显示，不铺满屏幕
      if (App.markdown) {
        contentEl.innerHTML = renderStreamMarkdown(streamText);
      } else {
        contentEl.textContent = streamText;
      }
      fitHeight();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    };
    const removeChunkListener = window.pet.onChatChunk(onChunk);

    // 监听 skill 激活标记
    const onSkill = (data) => {
      if (data && data.name) {
        // 技能激活也作为一条步骤插入
        appendAgentStep(`🧩 正在执行技能：${data.name}…`);
        streamEl.classList.remove('thinking');
      }
    };
    const removeSkillListener = window.pet.onChatSkill ? window.pet.onChatSkill(onSkill) : null;

    // 监听搜索状态（联网搜索时显示提示）— 非工具步骤也沉淀到链路区
    const onStatus = (data) => {
      if (data.status === 'searching') {
        if (firstChunk) appendAgentStep('🔍 正在搜索网络…');
      } else if (data.status === 'searching_done') {
        if (firstChunk) appendAgentStep('✅ 搜索完成，整理答案中…');
      } else if (data.status === 'file_searching') {
        if (firstChunk) appendAgentStep('📁 正在搜索文件…');
      } else if (data.status === 'file_searching_done') {
        if (firstChunk) appendAgentStep('📋 整理结果中…');
      } else if (data.status === 'reading') {
        if (firstChunk) appendAgentStep('📖 正在读取文件…');
      } else if (data.status === 'reading_done') {
        if (firstChunk) appendAgentStep('📝 分析文件内容中…');
      } else if (data.status === 'thinking') {
        // 首次思考提示（不重复）
        if (firstChunk && !thinkingAdded) { appendAgentStep('🐱 喵…让我想想…'); thinkingAdded = true; }
      } else if (data.status === 'agent_step') {
        // Agent Loop 每一步沉淀到链路区（不覆盖）
        if (data.done) {
          // 工具执行完成，标记最后一步为 done
          const steps = streamEl.querySelectorAll('.agent-step-line:not(.done)');
          if (steps.length) completeAgentStep(steps[steps.length - 1]);
          startNewRoundContent();
        } else {
          appendAgentStep(data.text || '🐱 喵…让我想想…');
        }
      } else if (data.status === 'plan_show') {
        // Claude 风格内联计划卡片（带确认/取消按钮）
        const steps = data.steps || [];
        const choiceId = data.choiceId;
        const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
        const planHtml = `<div class="plan-card">` +
          `<div class="plan-card-header"><span class="plan-card-icon">📋</span><span class="plan-card-title">${esc(data.title || '执行计划')}</span></div>` +
          `<div class="plan-card-steps">${steps.map((s, i) => `<div class="plan-card-step"><span class="plan-step-num">${i + 1}</span><span class="plan-step-text">${esc(s)}</span></div>`).join('')}</div>` +
          `<div class="plan-card-actions">` +
            `<button class="plan-card-btn plan-card-confirm" data-choice-id="${choiceId}" data-choice-index="0">✓ 确认执行</button>` +
            `<button class="plan-card-btn plan-card-cancel" data-choice-id="${choiceId}" data-choice-index="1">取消</button>` +
          `</div>` +
          `</div>`;
        const planDiv = document.createElement('div');
        planDiv.innerHTML = planHtml;
        const planEl = planDiv.firstChild;
        if (agentContentEl) {
          streamEl.insertBefore(planEl, agentContentEl);
        } else {
          streamEl.appendChild(planEl);
        }
        // 绑定确认/取消按钮
        planEl.querySelectorAll('.plan-card-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const cid = parseInt(btn.dataset.choiceId);
            const cidx = parseInt(btn.dataset.choiceIndex);
            // 移除按钮区
            const actions = planEl.querySelector('.plan-card-actions');
            if (actions) actions.remove();
            // 发送选择结果到主进程
            if (window.pet && window.pet.choiceResult) {
              window.pet.choiceResult({ id: cid, index: cidx });
            }
          });
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (data.status && data.status.startsWith('tool:')) {
        // 兼容旧状态（不应到达，agent_step 已替代）
        const toolNames = {
          open_app: '打开应用', search_file: '搜索文件', read_file: '读取文件',
          open_file: '打开文件', copy_file: '复制文件', move_file: '移动文件',
          delete_file: '删除文件', system_op: '系统操作', search_web: '搜索网络',
          fetch_webpage: '读取网页', get_weather: '查询天气', set_reminder: '设置提醒',
          set_recurring_reminder: '设置循环提醒', query_knowledge_base: '查询知识库',
          list_directory: '浏览文件夹',
        };
        const label = toolNames[data.tool] || data.tool || '工具';
        streamEl.textContent = `🔧 正在调用工具：${label}…`;
      } else if (data.status === 'tool_done') {
        streamEl.textContent = '📝 整理结果中…';
      }
    };
    const removeStatusListener = window.pet.onChatStatus(onStatus);

    try {
      const res = await window.pet.chat(sendText);
      removeChunkListener();
      removeStatusListener();
      if (removeSkillListener) removeSkillListener();

      // 完成进度条，标记所有步骤为 done
      if (progressBar) { const f = progressBar.querySelector('.agent-progress-fill'); if (f) f.style.width = '100%'; }
      streamEl.querySelectorAll('.agent-step-line:not(.done)').forEach(s => s.classList.add('done'));

      // 文件操作场景：匹配到多个文件，弹出选择框，不显示 AI 回复
      if (res.reply === '__FILE_CHOOSE__') {
        streamRow.remove();
        const actionText = { copy: '复制', move: '移动', delete: '删除' }[res.action] || '操作';
        pet.showBubble(`喵～找到多个文件，请选择要${actionText}的文件！`, 4000);
        return;
      }

      // 用户手动停止时，保留已生成的部分文本
      if (res.stopped) {
        wasStopped = true;
        if (!streamText && res.reply) { streamText = res.reply; allStreamText = res.reply; }
      }

      // 若全程未收到流式 chunk（兜底场景），用返回结果填充
      if (firstChunk && res.reply && res.reply !== '__FILE_CHOOSE__') {
        streamEl.classList.remove('thinking');
        streamText = res.reply;
        allStreamText = res.reply;
      }
      // 流式结束后最终渲染一次 Markdown（确保完整）—— 只更新正文容器，不覆盖链路步骤
      if (App.markdown && streamText) {
        const contentEl = ensureAgentContentEl();
        contentEl.innerHTML = App.markdown.render(streamText) + (wasStopped ? '<span class="chat-stopped-tag">⏹ 已停止</span>' : '');
        addCopyButton(contentEl, streamText);
        bindHtmlButtons(contentEl);
      } else if (streamText) {
        const contentEl = ensureAgentContentEl();
        contentEl.textContent = streamText + (wasStopped ? ' ⏹ 已停止' : '');
      }
      streamEl.classList.remove('thinking');
      fitHeight();
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // 聊天记录/删除按钮用累积的全部正文（跨轮次）
      if (allStreamText) addChatRecord('pet', allStreamText);
      if (allStreamText) attachDelBtn(streamEl, 'pet', allStreamText);
      if (!wasStopped && allStreamText) {
        pet.showBubble(allStreamText.slice(0, 60), 3000);
        pet.setMood('happy');
        state.adjust({ happiness: 1 });
        setTimeout(() => { if (!state.runtime.isDragging) pet.setMood(state.computeMood()); }, 1600);
      }
    } catch (err) {
      removeChunkListener();
      removeStatusListener();
      streamEl.classList.remove('thinking');
      streamEl.textContent = '喵？信号不太好，等会儿再聊…';
    } finally {
      isWaiting = false;
      sendBtn.disabled = false;
      inputEl.disabled = false;
      sendBtn.textContent = '发送';
      inputEl.focus();
    }
  }

  function position() {
    const r = state.runtime;
    let x = r.x + 180;
    let y = r.y - 20;
    // 先显示才能测量
    boxEl.style.left = x + 'px';
    boxEl.style.top = y + 'px';
    // 测量实际高度后修正，确保不超出屏幕
    const bw = boxEl.offsetWidth || 300;
    const bh = boxEl.offsetHeight || 400;
    if (x + bw > window.innerWidth - 8) x = r.x - bw - 20;
    if (x < 8) x = 8;
    if (y < 8) y = r.y + 176 + 8;
    if (y + bh > window.innerHeight - 8) y = window.innerHeight - bh - 8;
    if (y < 8) y = 8;
    boxEl.style.left = x + 'px';
    boxEl.style.top = y + 'px';
  }

  App.chat = {
    init() {
      pet = App.pet;
      boxEl = document.getElementById('chatbox');
      messagesEl = document.getElementById('chatMessages');
      inputEl = document.getElementById('chatInput');
      sendBtn = document.getElementById('chatSend');
      const closeBtn = document.querySelector('.chatbox-close');

      sendBtn.addEventListener('click', send);
      inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      closeBtn.addEventListener('click', () => App.chat.close());

      // 监听注入消息（定时面板等外部调用发消息）
      if (window.pet.onInjectMessage) {
        window.pet.onInjectMessage((msg) => {
          if (!App.chat.isOpen()) App.chat.open();
          inputEl.value = msg;
          send();
        });
      }

      // 清屏按钮
      const clearBtn = document.getElementById('chatClearBtn');
      clearBtn.addEventListener('click', () => {
        showEmptyState();
        clearBtn.textContent = '✓';
        setTimeout(() => { clearBtn.textContent = '🧹'; }, 1000);
      });

      // 导出对话按钮
      const exportBtn = document.getElementById('chatExportBtn');
      if (exportBtn) {
        exportBtn.addEventListener('click', () => {
          const msgs = messagesEl.querySelectorAll('.chat-msg');
          if (msgs.length === 0) return;
          let md = `# 🐱 小橘猫缘缘 · 对话记录\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;
          msgs.forEach((m) => {
            const isUser = m.classList.contains('user');
            const role = isUser ? '🙋 主人' : '🐱 小橘';
            md += `### ${role}\n\n${m.textContent.trim()}\n\n`;
          });
          const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `小橘对话_${new Date().toISOString().slice(0, 10)}.md`;
          a.click();
          URL.revokeObjectURL(url);
          exportBtn.textContent = '✓';
          setTimeout(() => { exportBtn.textContent = '📤'; }, 1000);
        });
      }

      // 清除聊天历史按钮（删除存储的聊天记录 + 对话记忆，保留用户画像）
      const clearHistoryBtn = document.getElementById('chatClearHistoryBtn');
      clearHistoryBtn.addEventListener('click', async () => {
        // 用自定义确认弹窗（避免原生 confirm 在透明窗口中的焦点/穿透问题）
        const ok = await App.chat.confirm('确定要清除全部聊天历史吗？', '这会删除所有保存的聊天记录，但会保留小橘对你的记忆（用户画像）和对话摘要。\n\n此操作不可撤销！');
        if (!ok) return;
        const res = await window.pet.chatClearHistory();
        if (res && res.success) {
          showEmptyState();
          clearHistoryBtn.textContent = '✓';
          setTimeout(() => { clearHistoryBtn.textContent = '🗑'; }, 1500);
        } else {
          addMessage('喵…清除历史时出了点问题，等会儿再试试？', 'pet');
        }
      });

      // 聊天记录按钮 → 直接在当前聊天框载入历史记录
      const historyBtn = document.getElementById('chatHistoryBtn');
      historyBtn.addEventListener('click', () => App.chat.loadHistory());

      // 放大/缩小按钮（快速切换宽度）
      const expandBtn = document.getElementById('chatExpandBtn');
      expandBtn.textContent = '⤡';
      expandBtn.addEventListener('click', () => {
        if (isExpanded) {
          boxEl.style.width = '380px';
          boxEl.style.height = '';
          expandBtn.textContent = '⤢';
        } else {
          boxEl.style.width = '600px';
          boxEl.style.height = '70vh';
          expandBtn.textContent = '⤡';
        }
        isExpanded = !isExpanded;
        position();
        // 延迟一帧等 CSS 应用后再调整高度
        requestAnimationFrame(() => { fitHeight(); messagesEl.scrollTop = messagesEl.scrollHeight; });
      });


      // 左上角拖拽缩放（保持右下角不动）
      const MIN_W = 340, MIN_H = 360;
      boxEl.addEventListener('mousedown', (e) => {
        // 只在左上角 18×18 区域响应
        if (e.offsetX > 18 || e.offsetY > 18) return;
        e.preventDefault();
        e.stopPropagation();
        const startRect = boxEl.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const fixedRight = startRect.right;
        const fixedBottom = startRect.bottom;
        let isResizing = true;
        const onMove = (ev) => {
          if (!isResizing) return;
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          let newL = startRect.left + dx;
          let newT = startRect.top + dy;
          let newW = fixedRight - newL;
          let newH = fixedBottom - newT;
          // 最小尺寸约束：保持右下角不动，只限制左/上
          if (newW < MIN_W) { newL = fixedRight - MIN_W; newW = MIN_W; }
          if (newH < MIN_H) { newT = fixedBottom - MIN_H; newH = MIN_H; }
          // 屏幕边界
          if (newL < 8) { newL = 8; newW = fixedRight - newL; }
          if (newT < 8) { newT = 8; newH = fixedBottom - newT; }
          boxEl.style.left = newL + 'px';
          boxEl.style.top = newT + 'px';
          boxEl.style.width = newW + 'px';
          boxEl.style.height = newH + 'px';
          fitHeight();
          // 记住用户调整的大小和位置
          savedWidth = newW;
          savedHeight = newH;
          savedLeft = newL;
          savedTop = newT;
          isExpanded = true; // 手动调整后标记为已展开
        };
        const onUp = () => {
          isResizing = false;
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      // 拖拽标题栏移动聊天框
      const header = boxEl.querySelector('.chatbox-header');
      let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return; // 点按钮不拖拽
        isDragging = true;
        dragOffsetX = e.clientX - boxEl.offsetLeft;
        dragOffsetY = e.clientY - boxEl.offsetTop;
        header.style.cursor = 'grabbing';
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        let x = e.clientX - dragOffsetX;
        let y = e.clientY - dragOffsetY;
        x = Math.max(0, Math.min(window.innerWidth - boxEl.offsetWidth, x));
        y = Math.max(0, Math.min(window.innerHeight - 40, y));
        boxEl.style.left = x + 'px';
        boxEl.style.top = y + 'px';
        // 记住拖动位置
        savedLeft = x;
        savedTop = y;
      });
      document.addEventListener('mouseup', () => {
        if (isDragging) { isDragging = false; header.style.cursor = ''; }
      });

      // 拖拽文件到聊天框 → 读取内容并缓存，等用户提问后再一起发送
      boxEl.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
      boxEl.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        const file = files[0];
        let filePath = file.path || '';
        if (!filePath && window.pet.getPathForFile) {
          filePath = window.pet.getPathForFile(file);
        }
        if (!filePath) { addMessage('（无法获取文件路径喵，试试直接跟我说文件名）', 'pet'); return; }
        const fileName = file.name;
        if (!isOpen) App.chat.open();
        try {
          // 只显示"已拖入"提示，不自动分析
          const tip = addTipBubble('user', `📎 已拖入文件：<b>${fileName}</b><br><span style="opacity:0.7;font-size:12px">正在读取内容…</span>`, 'file-attached-tip');

          const result = await window.pet.readFileContent(filePath);
          if (result.ok) {
            const content = result.content.slice(0, 8000);
            const existing = window._pendingFileContent || '';
            window._pendingFileContent = existing + `\n\n【拖拽文件内容：${fileName}】\n${content}`;
            // docx 含图片 → 自动加入待发送图片列表
            if (result.images && result.images.length > 0) {
              result.images.forEach(img => addImage(img.base64));
              tip.innerHTML = `📎 已拖入文件：<b>${fileName}</b>${result.images && result.images.length ? `（${result.images.length} 张图片）` : ''}`;
            } else {
              tip.innerHTML = `📎 已拖入文件：<b>${fileName}</b>`;
            }
            inputEl.placeholder = `已加载文件，输入你的问题…`;
            inputEl.focus();
          } else {
            tip.innerHTML = `📎 已拖入文件：<b>${fileName}</b><br><span style="color:#e84040;font-size:12px">读取失败：${result.error}</span>`;
          }
        } catch (err) {
          addMessage('读取文件出错了喵：' + err.message, 'pet');
        }
      });

      // 待发送的图片 base64 缓存（支持多张）
      let pendingImages = [];
      const previewStrip = document.getElementById('chatPreviewStrip');
      const uploadImageBtn = document.getElementById('chatUploadImageBtn');
      const uploadFileBtn = document.getElementById('chatUploadFileBtn');
      const imageInput = document.getElementById('chatImageInput');
      const docInput = document.getElementById('chatDocInput');

      // 📚 知识库按钮 → 直接查询 IMA 知识库
      const kbBtn = document.getElementById('chatKbBtn');
      if (kbBtn) {
        kbBtn.addEventListener('click', async () => {
          // 先检查是否已配置知识库
          const cfg = await window.pet.imaLoadConfig();
          if (!cfg.clientId || !cfg.hasApiKey || !cfg.kbId) {
            // 未配置 → 打开知识库配置面板
            addMessage('喵～知识库还没配置好呢！先帮我配置一下嘛～', 'pet');
            if (App.ima) App.ima.open();
            return;
          }
          const text = inputEl.value.trim();
          if (!text) {
            // 没有输入文字 → 打开知识库面板
            if (App.ima) App.ima.open();
            return;
          }
          // 有输入文字 → 直接查询知识库
          await App.chat.askKnowledgeBase(text);
        });
      }

      const DEFAULT_PLACEHOLDER = '对小橘说点什么…';

      // 更新图片预览条（支持多张）
      function updatePreview() {
        previewStrip.innerHTML = '';
        pendingImages.forEach((img, idx) => {
          const thumb = document.createElement('div');
          thumb.className = 'chat-preview-thumb';
          thumb.innerHTML = `<img src="data:image/png;base64,${img}"><div class="remove-btn">✕</div>`;
          thumb.querySelector('.remove-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            pendingImages.splice(idx, 1);
            updatePreview();
            // 恢复 placeholder（只有文件也没加载时才恢复）
            if (!pendingImages.length && !window._pendingFileContent) {
              inputEl.placeholder = DEFAULT_PLACEHOLDER;
            }
          });
          previewStrip.appendChild(thumb);
        });
        if (pendingImages.length > 1) {
          const cnt = document.createElement('span');
          cnt.style.cssText = 'font-size:11px;color:#999;align-self:center;padding:0 4px;';
          cnt.textContent = `${pendingImages.length} 张图片`;
          previewStrip.appendChild(cnt);
        }
      }

      // 添加一张图片到待发送列表
      function addImage(b64) {
        pendingImages.push(b64);
        updatePreview();
        inputEl.placeholder = `🖼️ ${pendingImages.length} 张图片已就绪，输入你想问的，或直接发送…`;
        inputEl.focus();
      }

      // 上传图片按钮
      uploadImageBtn.addEventListener('click', () => imageInput.click());
      imageInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        files.forEach(file => {
          const reader = new FileReader();
          reader.onload = (ev) => {
            const b64 = ev.target.result.split(',')[1];
            addImage(b64);
          };
          reader.readAsDataURL(file);
        });
        imageInput.value = '';
      });

      // 上传文件按钮（读取文件内容，走文本分析）
      uploadFileBtn.addEventListener('click', () => docInput.click());
      docInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        for (const file of files) {
          const fileName = file.name;
          let filePath = '';
          if (window.pet.getPathForFile) {
            filePath = window.pet.getPathForFile(file);
          }
          if (!filePath) { addMessage(`无法获取文件路径喵：${fileName}`, 'pet'); continue; }
          try {
            const tip = addTipBubble('user', `📄 已上传文件：<b>${fileName}</b><br><span style="opacity:0.7;font-size:12px">正在读取内容…</span>`, 'file-attached-tip');
            const result = await window.pet.readFileContent(filePath);
            if (result.ok) {
              const content = result.content.slice(0, 8000);
              const existing = window._pendingFileContent || '';
              window._pendingFileContent = existing + `\n\n【上传文件内容：${fileName}】\n${content}`;
              // docx 含图片 → 自动加入待发送图片列表
              if (result.images && result.images.length > 0) {
                result.images.forEach(img => addImage(img.base64));
                tip.innerHTML = `📄 已上传文件：<b>${fileName}</b>${result.images && result.images.length ? `（${result.images.length} 张图片）` : ''}`;
              } else {
                tip.innerHTML = `📄 已上传文件：<b>${fileName}</b>`;
              }
              inputEl.placeholder = `已加载文件，输入你的问题…`;
              inputEl.focus();
            } else {
              tip.innerHTML = `📄 已上传文件：<b>${fileName}</b><br><span style="color:#e84040;font-size:12px">读取失败：${result.error}</span>`;
            }
          } catch (err) {
            addMessage('读取文件出错了喵：' + err.message, 'pet');
          }
        }
        docInput.value = '';
      });

      // Ctrl+V 粘贴图片/文件（支持多个，累积）
      boxEl.addEventListener('paste', async (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const itemArr = Array.from(items);
        if (!itemArr.some(i => i.kind === 'file' || i.type.startsWith('image/'))) return;
        e.preventDefault();

        for (const item of itemArr) {
          // 粘贴的图片
          if (item.type && item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            if (!blob) continue;
            const reader = new FileReader();
            reader.onload = (ev) => { addImage(ev.target.result.split(',')[1]); };
            reader.readAsDataURL(blob);
            continue;
          }
          if (item.kind !== 'file') continue;
          const file = item.getAsFile();
          if (!file) continue;
          // 文件管理器复制的图片
          if (file.type && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (ev) => { addImage(ev.target.result.split(',')[1]); };
            reader.readAsDataURL(file);
            continue;
          }
          // 非图片文件 → 走文件读取流程
          const fileName = file.name;
          let filePath = file.path || '';
          if (!filePath && window.pet.getPathForFile) {
            try { filePath = window.pet.getPathForFile(file); } catch (err) {}
          }
          const tip = addTipBubble('user', `📎 已粘贴文件：<b>${fileName}</b><br><span style="opacity:0.7;font-size:12px">正在读取内容…</span>`, 'file-attached-tip');
          try {
            let result;
            if (filePath) {
              result = await window.pet.readFileContent(filePath);
            } else {
              // 没有 path → 先保存到临时文件，再用 IPC 读取
              const arrayBuffer = await file.arrayBuffer();
              const tmpRes = await window.pet.saveFile(new Uint8Array(arrayBuffer), `_tmp_paste_${Date.now()}_${fileName}`);
              if (tmpRes && tmpRes.success) {
                result = await window.pet.readFileContent(tmpRes.path);
              }
            }
            if (result && result.ok) {
              const content = result.content.slice(0, 8000);
              const existing = window._pendingFileContent || '';
              window._pendingFileContent = existing + `\n\n【粘贴文件内容：${fileName}】\n${content}`;
              // docx 含图片 → 自动加入待发送图片列表
              if (result.images && result.images.length > 0) {
                result.images.forEach(img => addImage(img.base64));
                tip.innerHTML = `📎 已粘贴文件：<b>${fileName}</b>${result.images && result.images.length ? `（${result.images.length} 张图片）` : ''}`;
              } else {
                tip.innerHTML = `📎 已粘贴文件：<b>${fileName}</b>`;
              }
              inputEl.placeholder = `已加载文件，输入你的问题…`;
              inputEl.focus();
            } else {
              tip.innerHTML = `📎 已粘贴文件：<b>${fileName}</b><br><span style="color:#e84040;font-size:12px">读取失败：${result?.error || '未知错误'}</span>`;
            }
          } catch (err2) {
            tip.innerHTML = `📎 已粘贴文件：<b>${fileName}</b><br><span style="color:#e84040;font-size:12px">读取失败：${err2.message}</span>`;
          }
        }
      });

      // 暴露 pendingImages 给 send 函数（返回数组）
      App.chat._getPendingImages = () => {
        const imgs = pendingImages.slice();
        pendingImages = [];
        updatePreview();
        if (!window._pendingFileContent) inputEl.placeholder = DEFAULT_PLACEHOLDER;
        return imgs;
      };
      // 兼容旧接口
      App.chat._getPendingImage = () => {
        const imgs = App.chat._getPendingImages();
        return imgs.length ? imgs : null;
      };

      // 不再加欢迎语，用空状态引导代替（HTML 中已有 #chatEmptyState）

      // ESC 键关闭弹窗（confirmModal + choiceModal + avatarCropModal）
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const modals = ['#confirmModal', '#choiceModal', '#avatarCropModal'];
        for (const sel of modals) {
          const m = document.querySelector(sel);
          if (m && !m.classList.contains('hidden')) {
            // 模拟点击取消按钮
            const cancelBtn = m.querySelector('.confirm-cancel, .avatar-crop-cancel');
            if (cancelBtn) cancelBtn.click();
            else m.classList.add('hidden');
            e.preventDefault();
            break;
          }
        }
      });

      // 初始化通用选择弹窗监听
      App.chat.initChoiceModal();

      // 窗口失焦时收起聊天框（避免挡住其他应用）
      if (window.pet && window.pet.onChatBlurHide) {
        window.pet.onChatBlurHide(() => {
          if (isOpen && !isWaiting) App.chat.close();
        });
      }
    },

    open() {
      isOpen = true;
      boxEl.classList.remove('hidden');
      // 恢复用户上次调整的大小，没有则用默认
      if (savedWidth) { boxEl.style.width = savedWidth + 'px'; }
      else { boxEl.style.width = '600px'; }
      if (savedHeight) { boxEl.style.height = savedHeight + 'px'; }
      else { boxEl.style.height = '70vh'; }
      isExpanded = savedExpanded !== null ? savedExpanded : true;
      const expandBtn = document.getElementById('chatExpandBtn');
      if (expandBtn) expandBtn.textContent = isExpanded ? '⤡' : '⤢';
      // 恢复用户上次拖动的位置，没有则用默认 position()
      if (savedLeft !== null && savedTop !== null) {
        boxEl.style.left = savedLeft + 'px';
        boxEl.style.top = savedTop + 'px';
      } else {
        position();
      }
      App.uiOpen = (App.uiOpen || 0) + 1;
      setTimeout(() => { fitHeight(); messagesEl.scrollTop = messagesEl.scrollHeight; inputEl.focus(); }, 100);
    },

    close() {
      if (!isOpen) return;
      // 保存用户调整的大小和位置
      const rect = boxEl.getBoundingClientRect();
      savedWidth = rect.width;
      savedHeight = rect.height;
      savedLeft = rect.left;
      savedTop = rect.top;
      savedExpanded = isExpanded;
      isOpen = false;
      boxEl.classList.add('hidden');
      if (App.uiOpen) App.uiOpen = Math.max(0, App.uiOpen - 1);
      if (!App.uiOpen) window.pet.setIgnoreMouse(true); // 恢复穿透
    },

    toggle() { isOpen ? App.chat.close() : App.chat.open(); },
    addPetMessage(text) { addMessage(text, 'pet'); },
    addUserMessage(text) { addMessage(text, 'user'); },
    _addChatRecord: addChatRecord,
    send,

    // 通用选择弹窗初始化（监听主进程 choice:show 事件）
    initChoiceModal() {
      if (window.pet && window.pet.onChoiceShow) {
        window.pet.onChoiceShow((data) => {
          const modal = document.getElementById('choiceModal');
          const titleEl = document.getElementById('choiceTitle');
          const msgEl = document.getElementById('choiceMsg');
          const listEl = document.getElementById('choiceList');
          const customWrap = document.getElementById('choiceCustomWrap');
          const customInput = document.getElementById('choiceCustomInput');
          const customBtn = document.getElementById('choiceCustomBtn');
          if (!modal) return;
          const choiceId = data.id; // 跟踪本次选择的 ID
          titleEl.textContent = data.title || '请选择';
          msgEl.textContent = data.msg || '';
          listEl.innerHTML = '';
          (data.options || []).forEach((opt, i) => {
            const item = document.createElement('div');
            item.className = 'choice-item';
            item.innerHTML = `<span class="choice-item-icon">${opt.icon || '📄'}</span>` +
              `<div class="choice-item-info"><div class="choice-item-name">${opt.name || ''}</div>` +
              `${opt.sub ? `<div class="choice-item-sub">${opt.sub}</div>` : ''}</div>`;
            item.addEventListener('click', () => {
              modal.classList.add('hidden');
              if (customWrap) customWrap.style.display = 'none';
              if (App.uiOpen) App.uiOpen = Math.max(0, App.uiOpen - 1);
              if (!App.uiOpen && window.pet) window.pet.setIgnoreMouse(true);
              if (window.pet && window.pet.choiceResult) window.pet.choiceResult({ id: choiceId, index: i });
            });
            listEl.appendChild(item);
          });
          // 显示/隐藏自定义输入区
          if (customWrap) {
            customWrap.style.display = data.allowCustom ? 'flex' : 'none';
            if (customInput) customInput.value = '';
          }
          // 自定义输入确认
          const submitCustom = () => {
            const text = (customInput && customInput.value || '').trim();
            if (!text) return;
            modal.classList.add('hidden');
            customWrap.style.display = 'none';
            if (App.uiOpen) App.uiOpen = Math.max(0, App.uiOpen - 1);
            if (!App.uiOpen && window.pet) window.pet.setIgnoreMouse(true);
            if (window.pet && window.pet.choiceResult) window.pet.choiceResult({ id: choiceId, index: -2, customText: text });
          };
          if (customBtn) customBtn.onclick = submitCustom;
          if (customInput) {
            customInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } };
          }
          modal.classList.remove('hidden');
          App.uiOpen = (App.uiOpen || 0) + 1;
          if (window.pet) window.pet.setIgnoreMouse(false);
          if (data.allowCustom && customInput) setTimeout(() => customInput.focus(), 100);
          // 取消按钮
          const cancelBtn = document.getElementById('choiceCancel');
          if (cancelBtn) {
            cancelBtn.onclick = () => {
              modal.classList.add('hidden');
              if (customWrap) customWrap.style.display = 'none';
              if (App.uiOpen) App.uiOpen = Math.max(0, App.uiOpen - 1);
              if (!App.uiOpen && window.pet) window.pet.setIgnoreMouse(true);
              if (window.pet && window.pet.choiceResult) window.pet.choiceResult({ id: choiceId, index: -1 });
            };
          }
        });
      }
    },

    // 自定义确认弹窗（返回 Promise<boolean>）
    confirm(title, msg) {
      return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const msgEl = document.getElementById('confirmMsg');
        const okBtn = document.getElementById('confirmOk');
        const cancelBtn = document.getElementById('confirmCancel');
        if (!modal) { resolve(false); return; }
        titleEl.textContent = title || '';
        msgEl.textContent = msg || '';
        modal.classList.remove('hidden');
        if (window.pet && window.pet.setIgnoreMouse) window.pet.setIgnoreMouse(false);
        const cleanup = (val) => {
          modal.classList.add('hidden');
          okBtn.onclick = null;
          cancelBtn.onclick = null;
          if (App.uiOpen) App.uiOpen = Math.max(0, App.uiOpen - 1);
          if (!App.uiOpen && window.pet) window.pet.setIgnoreMouse(true);
          resolve(val);
        };
        App.uiOpen = (App.uiOpen || 0) + 1;
        okBtn.onclick = () => cleanup(true);
        cancelBtn.onclick = () => cleanup(false);
      });
    },

    // 查询 IMA 知识库（流式输出）
    async askKnowledgeBase(query) {
      if (!isOpen) App.chat.open();
      inputEl.value = '';
      addMessage(query, 'user');
      addChatRecord('user', query);
      isWaiting = true;
      sendBtn.disabled = true;
      inputEl.disabled = true;
      sendBtn.textContent = '查库中…';

      const { row: _krow, bubble: streamEl } = createStreamRow();
      streamEl.textContent = '📚 正在查询知识库…';
      messagesEl.scrollTop = messagesEl.scrollHeight;
      fitHeight();

      // 监听 skill 标记
      const onSkill = (data) => {
        if (data && data.name) {
          streamEl.textContent = `🧩 ${data.name}…`;
        }
      };
      const removeSkillListener = window.pet.onChatSkill ? window.pet.onChatSkill(onSkill) : null;

      // 流式输出
      let firstChunk = true;
      let streamText = '';
      const onChunk = (delta) => {
        if (firstChunk) { streamEl.classList.remove('thinking'); firstChunk = false; }
        streamText += delta;
        if (App.markdown) {
          streamEl.innerHTML = renderStreamMarkdown(streamText);
        } else {
          streamEl.textContent = streamText;
        }
        fitHeight();
        messagesEl.scrollTop = messagesEl.scrollHeight;
      };
      const removeChunkListener = window.pet.onChatChunk(onChunk);

      try {
        const res = await window.pet.imaAsk(query);
        removeChunkListener();
        if (removeSkillListener) removeSkillListener();
        if (res.success && res.streamed) {
          if (App.markdown) {
            streamEl.innerHTML = renderStreamMarkdown(streamText);
            addCopyButton(streamEl, streamText);
            bindHtmlButtons(streamEl);
          } else {
            streamEl.textContent = streamText;
          }
          streamEl.classList.remove('thinking');
          addChatRecord('pet', streamText);
        } else {
          streamEl.classList.remove('thinking');
          streamEl.textContent = '喵…知识库查询失败了：' + (res.error || '未知错误');
          streamEl.style.color = '#999';
        }
      } catch (err) {
        removeChunkListener();
        if (removeSkillListener) removeSkillListener();
        streamEl.classList.remove('thinking');
        streamEl.textContent = '喵…查询出错了：' + err.message;
        streamEl.style.color = '#999';
      } finally {
        isWaiting = false;
        sendBtn.disabled = false;
        inputEl.disabled = false;
        sendBtn.textContent = '发送';
        inputEl.focus();
      }
    },

    // 载入聊天记录到当前聊天框
    async loadHistory() {
      await this.renderHistory();
    },

    // 渲染聊天记录（可被删除操作复用）
    async renderHistory() {
      const history = await loadChatHistory();
      if (!history.length) {
        messagesEl.innerHTML = '';
        addMessage('还没有聊天记录喵～', 'pet');
        return;
      }
      messagesEl.innerHTML = '';
      // 分隔标题（独立样式，不用 chat-msg）
      const sep = document.createElement('div');
      sep.className = 'chat-history-sep';
      sep.textContent = `📜 聊天记录（共 ${history.length} 条）`;
      messagesEl.appendChild(sep);
      // 逐条渲染（用行结构：头像+气泡，加时间前缀 + 删除按钮）
      history.forEach((r, idx) => {
        const t = new Date(r.time);
        const pad = (n) => String(n).padStart(2, '0');
        const timeStr = `${pad(t.getMonth()+1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
        const text = r.text;
        // 行结构
        const row = document.createElement('div');
        row.className = 'chat-msg-row ' + r.role;
        const avatar = createAvatarEl(r.role);
        const wrap = document.createElement('div');
        wrap.className = 'chat-bubble-wrap';
        const div = document.createElement('div');
        div.className = 'chat-msg ' + r.role;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'chat-msg-time';
        timeSpan.textContent = timeStr;
        div.appendChild(timeSpan);
        if (r.role === 'pet' && App.markdown) {
          const contentDiv = document.createElement('div');
          contentDiv.innerHTML = App.markdown.render(text);
          div.appendChild(contentDiv);
          addCopyButton(div, text);
          bindHtmlButtons(div);
        } else {
          const contentDiv = document.createElement('div');
          contentDiv.textContent = text;
          div.appendChild(contentDiv);
          addCopyButton(div, text);
        }
        // 删除按钮
        const delBtn = document.createElement('button');
        delBtn.className = 'chat-msg-del';
        delBtn.textContent = '🗑';
        delBtn.title = '删除这条记录';
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const res = await window.pet.chatDeleteRecord(idx);
          if (res && res.success) {
            row.style.transition = 'opacity 0.2s';
            row.style.opacity = '0';
            setTimeout(() => App.chat.renderHistory(), 200);
          }
        });
        div.appendChild(delBtn);
        wrap.appendChild(div);
        row.appendChild(avatar);
        row.appendChild(wrap);
        messagesEl.appendChild(row);
      });
      fitHeight();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },

    // 展示小橘记住的关于主人的信息
    async showMemory() {
      if (!isOpen) App.chat.open();
      const mem = await window.pet.getMemory();
      if (!mem || !mem.facts || !mem.facts.length) {
        addMessage('（小橘还没记住关于你的信息呢～跟我聊聊你自己吧，比如"我叫小王""我是程序员"）', 'pet');
        return;
      }
      let text = '🧠 小橘记得关于你的信息：\n\n';
      mem.facts.forEach((f, i) => {
        text += `${i + 1}. ${f.text}\n`;
      });
      const div = document.createElement('div');
      div.className = 'chat-msg pet';
      div.innerHTML = App.markdown ? App.markdown.render(text) : text;
      // 包装到行结构
      const row = document.createElement('div');
      row.className = 'chat-msg-row pet';
      const avatar = createAvatarEl('pet');
      const wrap = document.createElement('div');
      wrap.className = 'chat-bubble-wrap';
      wrap.appendChild(div);
      row.appendChild(avatar);
      row.appendChild(wrap);
      messagesEl.appendChild(row);
      fitHeight();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },

    // 展示当前所有循环提醒，并支持一键取消
    async showReminders() {
      if (!isOpen) App.chat.open();
      const list = await window.pet.listReminders();
      if (!list || !list.length) {
        addMessage('（目前没有循环提醒～可以跟我说"每隔30分钟提醒我喝水"来设置，或者说"开启久坐提醒"）', 'pet');
        return;
      }
      let text = '⏰ 当前的循环提醒：\n\n';
      list.forEach((r, i) => {
        text += `${i + 1}. ${r.intervalText} → ${r.text}\n`;
      });
      text += `\n💡 跟我说"取消提醒"可停止全部循环提醒`;
      const div = document.createElement('div');
      div.className = 'chat-msg pet';
      div.innerHTML = App.markdown ? App.markdown.render(text) : text;
      // 包装到行结构
      const row = document.createElement('div');
      row.className = 'chat-msg-row pet';
      const avatar = createAvatarEl('pet');
      const wrap = document.createElement('div');
      wrap.className = 'chat-bubble-wrap';
      wrap.appendChild(div);
      row.appendChild(avatar);
      row.appendChild(wrap);
      messagesEl.appendChild(row);
      fitHeight();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
  };
})(window.PetApp);
