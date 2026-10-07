const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');

let messages = [];
let busy = false;

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}

// Small, safe Markdown renderer for normal chat formatting.
function renderMarkdown(source) {
  const blocks = [];
  let text = String(source ?? '').replace(/\r\n/g, '\n');

  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const index = blocks.length;
    blocks.push(`<pre class="code-block"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\n@@CODE${index}@@\n`;
  });

  text = escapeHtml(text);
  text = text.replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^\* (.+)$/gm, '<li>$1</li>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li class="ordered"><span>$1.</span> $2</li>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');

  text = text.replace(/(?:<li(?: class="ordered")?[^>]*>.*?<\/li>)(?:<br>)?(?=(?:<li|$))/g, m => m);
  text = text.replace(/((?:<li>.*?<\/li>(?:<br>)?)+)/g, '<ul>$1</ul>');
  text = text.replace(/((?:<li class="ordered">.*?<\/li>(?:<br>)?)+)/g, '<ol>$1</ol>');
  text = text.replace(/@@CODE(\d+)@@/g, (_, i) => blocks[Number(i)]);

  return `<div class="markdown"><p>${text}</p></div>`
    .replace(/<p><\/p>/g, '')
    .replace(/<p>(\s*<h[1-6]>)/g, '$1')
    .replace(/(<\/h[1-6]>)<\/p>/g, '$1')
    .replace(/<p>(\s*<hr>)<\/p>/g, '$1')
    .replace(/<p>(\s*<ul>)/g, '$1')
    .replace(/(<\/ul>)<\/p>/g, '$1')
    .replace(/<p>(\s*<ol>)/g, '$1')
    .replace(/(<\/ol>)<\/p>/g, '$1');
}

function addMessage(role, content, isError = false) {
  const row = document.createElement('div');
  row.className = `message ${role}${isError ? ' error' : ''}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (role === 'assistant' && !isError) {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }

  row.appendChild(bubble);
  chat.appendChild(row);
  return row;
}

function addTyping() {
  const row = document.createElement('div');
  row.className = 'message assistant';
  row.id = 'typing';
  row.innerHTML = '<div class="bubble typing"><i></i><i></i><i></i></div>';
  chat.appendChild(row);
}

function removeTyping() {
  document.getElementById('typing')?.remove();
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

function showWelcome() {
  chat.innerHTML = `
    <div id="welcome" class="welcome">
      <div class="welcome-mark">Z</div>
      <h2>How can I help?</h2>
      <p>A simple AI assistant powered by Groq.</p>
      <div class="suggestions">
        <button type="button" data-prompt="Explain something interesting to me.">Explain something</button>
        <button type="button" data-prompt="Help me write a short paragraph.">Help me write</button>
        <button type="button" data-prompt="Give me a creative idea for a website.">Give me an idea</button>
      </div>
    </div>`;
  bindSuggestions();
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || busy) return;

  busy = true;
  sendBtn.disabled = true;
  document.getElementById('welcome')?.remove();

  addMessage('user', text);
  messages.push({ role: 'user', content: text });
  input.value = '';
  resizeInput();

  // Close the mobile keyboard immediately after sending. Do not focus the textarea again
  // when the response arrives; otherwise Android will reopen the keyboard.
  input.blur();
  addTyping();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });

    const data = await response.json().catch(() => ({}));
    removeTyping();

    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);

    const reply = data.reply || 'No response received.';
    addMessage('assistant', reply);
    messages.push({ role: 'assistant', content: reply });
    // Deliberately do not scroll. The reader keeps their current position.
  } catch (error) {
    removeTyping();
    addMessage('assistant', `Error: ${error.message}`, true);
    messages.pop();
  } finally {
    busy = false;
    sendBtn.disabled = false;
    // Intentionally do not call input.focus() here.
    // Keeping focus would make the Android keyboard pop back up after every response.
  }
}

composer.addEventListener('submit', e => {
  e.preventDefault();
  sendMessage();
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
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
resizeInput();
