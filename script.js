const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const welcome = document.getElementById('welcome');

let messages = [];
let busy = false;

function addMessage(role, content, isError = false) {
  if (welcome) welcome.remove();
  const row = document.createElement('div');
  row.className = `message ${role}${isError ? ' error' : ''}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  row.appendChild(bubble);
  chat.appendChild(row);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  return row;
}

function addTyping() {
  if (welcome) welcome.remove();
  const row = document.createElement('div');
  row.className = 'message assistant';
  row.id = 'typing';
  row.innerHTML = '<div class="bubble typing"><i></i><i></i><i></i></div>';
  chat.appendChild(row);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function removeTyping() { document.getElementById('typing')?.remove(); }

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || busy) return;

  busy = true;
  sendBtn.disabled = true;
  addMessage('user', text);
  messages.push({ role: 'user', content: text });
  input.value = '';
  resizeInput();
  addTyping();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });

    const data = await response.json().catch(() => ({}));
    removeTyping();

    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }

    const reply = data.reply || 'No response received.';
    addMessage('assistant', reply);
    messages.push({ role: 'assistant', content: reply });
  } catch (error) {
    removeTyping();
    addMessage('assistant', `Error: ${error.message}`, true);
    // Remove the failed user turn so a retry does not duplicate it.
    messages.pop();
  } finally {
    busy = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

composer.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
clearBtn.addEventListener('click', () => {
  messages = [];
  chat.innerHTML = `
    <div id="welcome" class="welcome">
      <div class="welcome-mark">Z</div>
      <h2>What can I help with?</h2>
      <p>Ask anything. ZennNyx AI will answer directly.</p>
      <div class="suggestions">
        <button type="button" data-prompt="Explain something interesting to me.">Explain something</button>
        <button type="button" data-prompt="Help me write a short paragraph.">Help me write</button>
        <button type="button" data-prompt="Give me a creative idea for a website.">Give me an idea</button>
      </div>
    </div>`;
  bindSuggestions();
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
