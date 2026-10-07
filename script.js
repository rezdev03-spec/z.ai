const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const thinkBtn = document.getElementById('thinkBtn');
const modeHint = document.getElementById('modeHint');

let messages = [];
let busy = false;
let thinkHarder = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}

function renderInline(source) {
  let text = escapeHtml(source);
  text = text.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text = text.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  text = text.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  text = text.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/(?<![_\w])_([^_\n]+)_(?!_)/g, '<em>$1</em>');
  return text;
}

function parseTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length) return null;
  const header = lines[startIndex];
  const separator = lines[startIndex + 1];
  if (!/^\s*\|?.+\|.+\|?\s*$/.test(header)) return null;
  if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)) return null;

  const splitRow = row => {
    let clean = row.trim();
    if (clean.startsWith('|')) clean = clean.slice(1);
    if (clean.endsWith('|')) clean = clean.slice(0, -1);
    return clean.split('|').map(cell => cell.trim());
  };

  const headers = splitRow(header);
  const alignments = splitRow(separator).map(cell => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  });

  const rows = [];
  let i = startIndex + 2;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || !line.includes('|')) break;
    rows.push(splitRow(line));
    i += 1;
  }

  const ths = headers.map((cell, idx) => {
    const align = alignments[idx] ? ` style="text-align:${alignments[idx]}"` : '';
    return `<th${align}>${renderInline(cell)}</th>`;
  }).join('');

  const body = rows.map(row => {
    const cells = headers.map((_, idx) => {
      const align = alignments[idx] ? ` style="text-align:${alignments[idx]}"` : '';
      return `<td${align}>${renderInline(row[idx] ?? '')}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return {
    html: `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table></div>`,
    nextIndex: i
  };
}

function renderMarkdown(source) {
  const normalized = String(source ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const out = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let blockquote = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const body = paragraph.join('\n');
    out.push(`<p>${renderInline(body).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listItems.length) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    out.push(`<${tag}>${listItems.map(item => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
    listItems = [];
    listType = null;
  };

  const flushQuote = () => {
    if (!blockquote.length) return;
    out.push(`<blockquote>${blockquote.map(line => renderInline(line)).join('<br>')}</blockquote>`);
    blockquote = [];
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const trimmed = line.trim();

    const fence = trimmed.match(/^```([\w.+#-]*)\s*$/);
    if (fence) {
      flushParagraph(); flushList(); flushQuote();
      const lang = fence[1];
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
      out.push(`<pre class="code-block"${langAttr}><code>${escapeHtml(code.join('\n'))}</code><button class="code-copy" type="button" data-copy-code="">Copy</button></pre>`);
      out[out.length - 1] = out[out.length - 1].replace('data-copy-code=""', `data-copy-code="${encodeURIComponent(code.join('\n'))}"`);
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      flushParagraph(); flushList(); flushQuote();
      out.push(table.html);
      i = table.nextIndex;
      continue;
    }

    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      flushParagraph(); flushList(); flushQuote();
      out.push('<hr>');
      i += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList(); flushQuote();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph(); flushList();
      blockquote.push(quote[1]);
      i += 1;
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph(); flushQuote();
      const nextType = ordered ? 'ol' : 'ul';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((ordered || unordered)[1]);
      i += 1;
      continue;
    }

    if (!trimmed) {
      flushParagraph(); flushList(); flushQuote();
      i += 1;
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  flushList();
  flushQuote();
  return `<div class="markdown">${out.join('')}</div>`;
}

function extractSources(text) {
  const urls = String(text ?? '').match(/https?:\/\/[^\s)<>\]]+/g) || [];
  return [...new Set(urls.map(url => url.replace(/[.,;]+$/, '')))];
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = old; }, 1100);
  } catch {
    button.textContent = 'Copy failed';
    setTimeout(() => { button.textContent = 'Copy'; }, 1100);
  }
}

function createIconButton(label, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action-btn';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = `<span class="action-icon" aria-hidden="true">${icon}</span><span class="action-label">${label}</span>`;
  return button;
}

function addAssistantActions(row, content, elapsedMs) {
  const wrap = document.createElement('div');
  wrap.className = 'assistant-actions';

  const copy = createIconButton('Copy', '⧉');
  copy.addEventListener('click', () => copyText(content, copy));

  const like = createIconButton('Like', '♡');
  like.addEventListener('click', () => {
    const active = like.classList.toggle('selected');
    like.querySelector('.action-icon').textContent = active ? '♥' : '♡';
    dislike.classList.remove('selected');
    dislike.querySelector('.action-icon').textContent = '♧';
  });

  const dislike = createIconButton('Dislike', '♧');
  dislike.addEventListener('click', () => {
    const active = dislike.classList.toggle('selected');
    dislike.querySelector('.action-icon').textContent = active ? '♣' : '♧';
    like.classList.remove('selected');
    like.querySelector('.action-icon').textContent = '♡';
  });

  const share = createIconButton('Share', '↗');
  share.addEventListener('click', async () => {
    const shareData = { title: 'ZennNyx AI', text: content };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch { /* cancelled */ }
    } else {
      await copyText(content, share);
    }
  });

  const sources = createIconButton('Sources', '↗');
  const urls = extractSources(content);
  if (!urls.length) sources.classList.add('disabled');
  sources.addEventListener('click', () => {
    document.querySelectorAll('.sources-popover').forEach(el => el.remove());
    const pop = document.createElement('div');
    pop.className = 'sources-popover';
    if (!urls.length) {
      pop.innerHTML = '<div class="sources-empty">No source links were included in this answer.</div>';
    } else {
      pop.innerHTML = `<div class="sources-title">Sources</div>${urls.map(url => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`).join('')}`;
    }
    row.appendChild(pop);
    requestAnimationFrame(() => pop.classList.add('open'));
  });

  wrap.append(copy, like, dislike, share, sources);
  row.appendChild(wrap);

  const meta = document.createElement('div');
  meta.className = 'answer-meta';
  meta.textContent = `${thinkHarder ? 'Worked for' : 'Generated in'} ${formatDuration(elapsedMs)}${thinkHarder ? ' · Think Harder' : ''}`;
  row.appendChild(meta);
}

function addMessage(role, content, isError = false, elapsedMs = 0) {
  const row = document.createElement('div');
  row.className = `message ${role}${isError ? ' error' : ''}`;

  const contentEl = document.createElement('div');
  contentEl.className = role === 'assistant' ? 'answer' : 'bubble';

  if (role === 'assistant' && !isError) {
    contentEl.innerHTML = renderMarkdown(content);
  } else {
    contentEl.textContent = content;
  }

  row.appendChild(contentEl);
  chat.appendChild(row);

  if (role === 'assistant' && !isError) {
    addAssistantActions(row, content, elapsedMs);
    row.querySelectorAll('.code-copy').forEach(button => {
      button.addEventListener('click', () => {
        const code = decodeURIComponent(button.dataset.copyCode || '');
        copyText(code, button);
      });
    });
  }

  return row;
}

function addTyping() {
  const row = document.createElement('div');
  row.className = 'message assistant';
  row.id = 'typing';
  row.innerHTML = '<div class="answer typing"><i></i><i></i><i></i></div>';
  chat.appendChild(row);
}

function removeTyping() { document.getElementById('typing')?.remove(); }

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

function showWelcome() {
  chat.innerHTML = `
    <div id="welcome" class="welcome">
      <div class="welcome-mark">Z</div>
      <h1>How can I help?</h1>
      <p>Ask anything, write something, or build an idea.</p>
      <div class="suggestions">
        <button type="button" data-prompt="Explain something interesting to me.">Explain something</button>
        <button type="button" data-prompt="Help me write a short paragraph.">Help me write</button>
        <button type="button" data-prompt="Give me a creative idea for a website.">Give me an idea</button>
      </div>
    </div>`;
  bindSuggestions();
}

function updateThinkMode() {
  thinkBtn.setAttribute('aria-pressed', String(thinkHarder));
  thinkBtn.classList.toggle('active', thinkHarder);
  modeHint.textContent = thinkHarder ? 'Structured, deeper answers' : 'Short, direct answers';
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || busy) return;

  busy = true;
  sendBtn.disabled = true;
  thinkBtn.disabled = true;
  document.getElementById('welcome')?.remove();

  addMessage('user', text);
  messages.push({ role: 'user', content: text });
  input.value = '';
  resizeInput();
  input.blur();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

  addTyping();
  const startedAt = performance.now();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, thinkHarder })
    });

    const data = await response.json().catch(() => ({}));
    removeTyping();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);

    const reply = data.reply || 'No response received.';
    const elapsed = performance.now() - startedAt;
    addMessage('assistant', reply, false, elapsed);
    messages.push({ role: 'assistant', content: reply });
  } catch (error) {
    removeTyping();
    addMessage('assistant', `Error: ${error.message}`, true);
    messages.pop();
  } finally {
    busy = false;
    sendBtn.disabled = false;
    thinkBtn.disabled = false;
  }
}

composer.addEventListener('submit', event => {
  event.preventDefault();
  sendMessage();
});

thinkBtn.addEventListener('click', () => {
  if (busy) return;
  thinkHarder = !thinkHarder;
  updateThinkMode();
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

document.addEventListener('click', event => {
  if (!event.target.closest('.sources-popover') && !event.target.closest('[aria-label="Sources"]')) {
    document.querySelectorAll('.sources-popover').forEach(el => el.remove());
  }
});

function bindSuggestions() {
  document.querySelectorAll('[data-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.prompt;
      resizeInput();
      input.focus();
    });
  });
}

bindSuggestions();
updateThinkMode();
resizeInput();
