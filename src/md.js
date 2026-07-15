// Hand-rolled, dependency-free markdown -> HTML for blog post preview.
// Supports: headings (#..######), paragraphs, bold, italic, links, line breaks.
// Not a full CommonMark implementation - just enough for a preview endpoint.

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text) {
  let out = escapeHtml(text);
  // links: [label](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safeUrl = /^https?:\/\//i.test(url) ? url : '#';
    return `<a href="${escapeHtml(safeUrl)}">${label}</a>`;
  });
  // bold: **text** or __text__
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // italic: *text* or _text_
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
  return out;
}

function markdownToHtml(md) {
  if (!md) return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [];
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length) {
      htmlParts.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
      paragraph = [];
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${inline(headingMatch[2])}</h${level}>`);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return htmlParts.join('\n');
}

export { markdownToHtml, escapeHtml, inline };
