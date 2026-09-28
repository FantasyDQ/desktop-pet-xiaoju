/* ============================================================
   markdown.js - 轻量 Markdown 渲染器（安全：先转义再解析）
   挂载到 window.PetApp.markdown
   支持：标题/粗体/斜体/行内代码/代码块/列表/链接/引用/分割线
   ============================================================ */
window.PetApp = window.PetApp || {};

(function (App) {
  'use strict';

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function render(text) {
    if (!text) return '';
    let src = text;

    // 1. 先提取代码块（占位，最后还原），防止内部内容被 markdown 解析
    const codeBlocks = [];
    src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || '', code: code.trim() });
      return `\x00CB${idx}\x00`;
    });

    // 2. 转义 HTML（防 XSS）
    src = escapeHtml(src);

    // 3. 标题
    src = src.replace(/^### (.+)$/gm, '<h5 class="md-h">$1</h5>');
    src = src.replace(/^## (.+)$/gm, '<h4 class="md-h">$1</h4>');
    src = src.replace(/^# (.+)$/gm, '<h3 class="md-h">$1</h3>');

    // 4. 分割线
    src = src.replace(/^(---|\*\*\*|___)$/gm, '<hr class="md-hr">');

    // 5. 引用块
    src = src.replace(/^(?:&gt; )(.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');
    // 合并连续 blockquote
    src = src.replace(/(<\/blockquote>)\n(<blockquote)/g, '$1$2');

    // 6. 列表
    // 无序列表
    src = src.replace(/(^|\n)((?:[-*] .+\n?)+)/g, (_m, pre, block) => {
      const items = block.trim().split('\n').map((l) => l.replace(/^[-*] /, '').trim());
      return `${pre}<ul class="md-list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
    });
    // 有序列表
    src = src.replace(/(^|\n)((?:\d+\. .+\n?)+)/g, (_m, pre, block) => {
      const items = block.trim().split('\n').map((l) => l.replace(/^\d+\. /, '').trim());
      return `${pre}<ol class="md-list">${items.map((i) => `<li>${i}</li>`).join('')}</ol>`;
    });

    // 6.5 表格（Markdown pipe table 语法）
    src = src.replace(/(^|\n)(\|.+\|\n\|[-: |]+\|.+\n(?:\|.+\|\n?)+)/g, (_m, pre, block) => {
      const lines = block.trim().split('\n');
      // 第二行是分隔行
      const separators = lines[1].split('|').map(s => s.trim()).filter(s => s);
      const aligns = separators.map(s => {
        if (s.startsWith(':') && s.endsWith(':')) return 'center';
        if (s.endsWith(':')) return 'right';
        return 'left';
      });
      // 表头
      const headers = lines[0].split('|').map(s => s.trim()).filter(s => s);
      // 表体
      const bodyLines = lines.slice(2);
      const rows = bodyLines.map(l => l.split('|').map(s => s.trim()).filter(s => s || true).slice(0, headers.length));
      // 去掉每行首尾空管道符产生的空元素
      const cleanRows = bodyLines.map(l => {
        const cells = l.split('|');
        // 去掉首尾空元素（管道符在行首尾时）
        if (cells[0].trim() === '') cells.shift();
        if (cells[cells.length - 1].trim() === '') cells.pop();
        return cells.map(c => c.trim());
      });

      let html = '<table class="md-table"><thead><tr>';
      headers.forEach((h, i) => {
        html += `<th style="text-align:${aligns[i] || 'left'}">${h}</th>`;
      });
      html += '</tr></thead><tbody>';
      cleanRows.forEach(row => {
        html += '<tr>';
        headers.forEach((_, i) => {
          html += `<td style="text-align:${aligns[i] || 'left'}">${row[i] || ''}</td>`;
        });
        html += '</tr>';
      });
      html += '</tbody></table>';
      return `${pre}${html}`;
    });

    // 7. 行内格式
    // 行内代码
    src = src.replace(/`([^`]+)`/g, '<code class="md-code-inline">$1</code>');
    // 粗体
    src = src.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    src = src.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    // 斜体（避免误匹配粗体的星号）
    src = src.replace(/(?<!\*)\*(?!\*)[^*]+\*(?!\*)/g, (m) => `<em>${m.slice(1, -1)}</em>`);
    // 链接
    src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
      '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // 8. 段落处理：连续两个换行分段，单个换行转 <br>
    const paragraphs = src.split(/\n{2,}/);
    src = paragraphs.map((p) => {
      const t = p.trim();
      if (!t) return '';
      // 块级元素不包 <p>
      if (/^<(h[3-5]|ul|ol|hr|blockquote|pre|table)/.test(t)) return t;
      return '<p class="md-p">' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');

    // 9. 还原代码块（HTML/Word/Excel/PPT 代码块折叠+预览，其他正常显示）
    src = src.replace(/\x00CB(\d+)\x00/g, (_m, idx) => {
      const b = codeBlocks[parseInt(idx, 10)];
      const lang = (b.lang || '').toLowerCase();
      // Word/Excel/PPT/HTML 代码块：折叠面板 + 浏览器预览 + 保存按钮
      if (['html', 'word', 'excel', 'ppt'].includes(lang) && b.code.length > 50) {
        const escaped = escapeHtml(b.code);
        const labels = { html: '📄 HTML 网页', word: '📄 Word 文档', excel: '📊 Excel 表格', ppt: '📽️ PPT 演示' };
        const saveLabels = { html: '💾 保存网页', word: '💾 保存Word', excel: '💾 保存Excel', ppt: '💾 保存PPT' };
        const label = labels[lang] || '📄 文档';
        const saveLabel = saveLabels[lang] || '💾 保存';
        return `<div class="md-html-collapse" data-html="${encodeURIComponent(b.code)}" data-doctype="${lang}">
          <div class="md-html-summary">${label}已生成</div>
          <div class="md-html-actions">
            <button class="md-html-btn md-html-preview">👁️ 预览</button>
            <button class="md-html-btn md-html-save" data-raw="${escaped}" data-doctype="${lang}">${saveLabel}</button>
          </div>
        </div>`;
      }
      return `<pre class="md-code-block"><code>${escapeHtml(b.code)}</code></pre>`;
    });

    return src;
  }

  App.markdown = { render, escapeHtml };
})(window.PetApp);
