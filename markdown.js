/* ZennNyx AI — Markdown + LaTeX renderer (v9.2)
 *
 * Tidak menyentuh DOM, jadi gampang dites. Aturan penting:
 *   1. Rumus ( \( \) \[ \] $ $$ dan \begin{aligned}…) DIAMBIL DULU dan diganti penanda,
 *      supaya aturan Markdown (miring/tebal/list) tidak pernah merusak LaTeX seperti x_1, a*b, \\.
 *   2. Setelah HTML jadi, penanda diganti <span class="znx-math" data-tex="…"> dan
 *      hydrateMath() (di script.js) yang merender KaTeX-nya setelah masuk ke DOM.
 */

const ZNX_MATH_L = "", ZNX_MATH_R = "";
const ZNX_TOK_L = "", ZNX_TOK_R = "";
let ZNX_MATH_STORE = [];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}
function escapeAttr(value = "") { return escapeHtml(value).replace(/`/g, "&#96;"); }
function safeUrl(value = "") {
  try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) ? u.href : "#"; }
  catch { return "#"; }
}

/* ───────────── Math extraction ───────────── */

const ZNX_MATH_ENVS = /^\\begin\{(aligned|align\*?|alignat\*?|equation\*?|gather\*?|gathered|split|cases|array|[pbBvV]?matrix|multline\*?)\}/;

function findMathClose(text, from, closeChar, limit) {
  const max = Math.min(text.length, from + limit);
  for (let j = from; j < max; j++) {
    if (text[j] !== "\\") continue;
    if (text[j + 1] === closeChar) return { start: j, end: j + 2 };
    if (text[j + 1] === "\\" && text[j + 2] === closeChar) return { start: j, end: j + 3 };
    // lewati pasangan "\\" (pemisah baris) supaya "\\]" tidak salah baca
    if (text[j + 1] === "\\") j++;
  }
  return null;
}

function scanMath(text, store) {
  let out = "", i = 0;
  const n = text.length;
  const hold = (tex, display) => {
    store.push({ tex: tex.trim(), display });
    return ZNX_MATH_L + (store.length - 1) + ZNX_MATH_R;
  };
  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      const nx = text[i + 1];
      if (nx === "$") { out += "$"; i += 2; continue; }
      const k = nx === "\\" ? i + 2 : i + 1;       // dukung "\\[" (model yang double-escape)
      const kind = text[k];
      if (kind === "[" || kind === "(") {
        const m = findMathClose(text, k + 1, kind === "[" ? "]" : ")", kind === "[" ? 4000 : 1500);
        if (m) {
          const body = text.slice(k + 1, m.start);
          const crossesParagraph = kind === "(" && /\n[ \t]*\n/.test(body);
          if (body.trim() && !crossesParagraph) { out += hold(body, kind === "["); i = m.end; continue; }
        }
      } else if (nx === "b") {
        const env = text.slice(i).match(ZNX_MATH_ENVS);
        if (env) {
          const endTag = `\\end{${env[1]}}`;
          const e = text.indexOf(endTag, i + env[0].length);
          if (e > -1 && e - i < 4000) {
            out += hold(text.slice(i, e + endTag.length), true);
            i = e + endTag.length;
            continue;
          }
        }
      }
    } else if (c === "$") {
      if (text[i + 1] === "$") {
        const e = text.indexOf("$$", i + 2);
        if (e > i + 2 && e - i < 4000 && text.slice(i + 2, e).trim()) { out += hold(text.slice(i + 2, e), true); i = e + 2; continue; }
      } else {
        const prev = text[i - 1], next = text[i + 1];
        if (next && !/\s/.test(next) && !(prev && /[A-Za-z0-9]/.test(prev))) {
          let j = i + 1;
          while (j < n && text[j] !== "\n") {
            if (text[j] === "\\") { j += 2; continue; }
            if (text[j] === "$") break;
            j++;
          }
          if (j < n && text[j] === "$" && j > i + 1 && !/\s/.test(text[j - 1]) && !/[0-9]/.test(text[j + 1] || "")) {
            out += hold(text.slice(i + 1, j), false);
            i = j + 1;
            continue;
          }
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

function mathInChunk(text, store) {
  // Kurung siku polos yang jelas berisi LaTeX:  [ \frac{a}{b} ]  atau  [\n ... \n]
  text = text
    .replace(/^[ \t]*\[[ \t]*\n([\s\S]*?\\[a-zA-Z][\s\S]*?)\n[ \t]*\][ \t]*$/gm, (m, body) => `\\[${body}\\]`)
    .replace(/^[ \t]*\[[ \t]+(.*\\[a-zA-Z].*?)[ \t]+\][ \t]*$/gm, (m, body) => `\\[${body}\\]`);
  // jangan sentuh `kode inline`
  return text.split(/(`[^`\n]+`)/).map((part, idx) => idx % 2 ? part : scanMath(part, store)).join("");
}

function extractAllMath(markdown) {
  const store = [];
  const out = [];
  let buf = [], inFence = false, fenceChar = "", fenceLen = 0;
  const flush = () => { if (buf.length) { out.push(mathInChunk(buf.join("\n"), store)); buf = []; } };
  for (const line of markdown.split("\n")) {
    const fence = line.trim().match(/^(`{3,}|~{3,})(.*)$/);
    if (fence && !inFence) { flush(); inFence = true; fenceChar = fence[1][0]; fenceLen = fence[1].length; out.push(line); continue; }
    if (inFence) {
      out.push(line);
      if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLen && !fence[2].trim()) inFence = false;
      continue;
    }
    buf.push(line);
  }
  flush();
  return { text: out.join("\n"), store };
}

function mathToHtml(entry) {
  if (!entry) return "";
  const shown = entry.display ? `\\[${entry.tex}\\]` : `\\(${entry.tex}\\)`;
  return `<span class="znx-math${entry.display ? " znx-math-display" : ""}" data-display="${entry.display ? 1 : 0}" data-tex="${escapeAttr(entry.tex)}">${escapeHtml(shown)}</span>`;
}

/* ───────────── Inline ───────────── */

function renderEmphasis(s) {
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, "<strong>$1</strong>");
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![_\w])/g, "$1<em>$2</em>");
  return s;
}

function renderInline(raw) {
  const tokens = [];
  const hold = html => { tokens.push(html); return ZNX_TOK_L + (tokens.length - 1) + ZNX_TOK_R; };
  let s = String(raw);
  s = s.replace(/`([^`\n]+)`/g, (m, c) => hold(`<code class="inline-code">${escapeHtml(c)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) =>
    hold(`<a href="${escapeAttr(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${renderEmphasis(escapeHtml(label))}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>-]+)/g, (m, pre, url) => {
    const trail = (url.match(/[.,;:!?)\]]+$/) || [""])[0];
    const clean = trail ? url.slice(0, -trail.length) : url;
    return `${pre}${hold(`<a href="${escapeAttr(safeUrl(clean))}" target="_blank" rel="noopener noreferrer">${escapeHtml(clean)}</a>`)}${trail}`;
  });
  s = escapeHtml(s).replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  s = renderEmphasis(s);
  for (let pass = 0; pass < 3 && s.includes(ZNX_TOK_L); pass++) {
    s = s.replace(new RegExp(`${ZNX_TOK_L}(\\d+)${ZNX_TOK_R}`, "g"), (m, i) => tokens[+i] ?? "");
  }
  return s;
}

/* ───────────── Block ───────────── */

const ZNX_LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const znxIndent = s => String(s).replace(/\t/g, "    ").length;
const znxLeading = s => (String(s).match(/^[ \t]*/) || [""])[0];
const znxDedent = (line, n) => {
  const expanded = String(line).replace(/\t/g, "    ");
  let k = 0;
  while (k < n && expanded[k] === " ") k++;
  return expanded.slice(k);
};

function isBlockStart(line, next) {
  const t = line.trim();
  return /^(`{3,}|~{3,})/.test(t) || /^#{1,6}\s+\S/.test(t) || /^([-*_])(?:\s*\1){2,}$/.test(t) ||
    /^>/.test(t) || ZNX_LIST_RE.test(line) || (t.includes("|") && next !== undefined && isTableSeparator(next, t));
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
function isTableSeparator(sepLine, headLine) {
  if (!sepLine || !headLine || !headLine.includes("|") || !/-/.test(sepLine)) return false;
  const sep = splitRow(sepLine);
  const head = splitRow(headLine);
  return sep.length >= 2 && sep.length === head.length && sep.every(c => /^:?-+:?$/.test(c));
}
function parseTable(lines, start) {
  const head = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map(c => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !/^(`{3,}|~{3,})/.test(lines[i].trim()) && !/^#{1,6}\s/.test(lines[i].trim())) {
    const row = splitRow(lines[i]);
    rows.push(Array.from({ length: head.length }, (_, c) => row[c] ?? ""));
    i++;
  }
  const cell = (tag, text, c) => `<${tag}${align[c] ? ` style="text-align:${align[c]}"` : ""}>${renderInline(text)}</${tag}>`;
  const html = `<div class="table-wrap"><table><thead><tr>${head.map((h, c) => cell("th", h, c)).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((x, c) => cell("td", x, c)).join("")}</tr>`).join("")}</tbody></table></div>`;
  return { html, end: i };
}

function parseList(lines, start) {
  const first = lines[start].match(ZNX_LIST_RE);
  const baseIndent = znxIndent(first[1]);
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start, done = false;
  while (i < lines.length && !done) {
    const m = lines[i].match(ZNX_LIST_RE);
    if (!m) break;
    const ind = znxIndent(m[1]);
    if (ind > baseIndent + 1 || ind < baseIndent - 1) break;
    if (/\d/.test(m[2]) !== ordered) break;
    const contentIndent = ind + m[2].length + 1;
    const inner = [m[3]];
    i++;
    while (i < lines.length) {
      const ln = lines[i];
      if (!ln.trim()) {
        let k = i + 1;
        while (k < lines.length && !lines[k].trim()) k++;
        if (k >= lines.length) { i = k; done = true; break; }
        const nind = znxIndent(znxLeading(lines[k]));
        if (nind >= ind + 2) { inner.push(""); i++; continue; }          // blok lanjutan di dalam item
        const sibling = lines[k].match(ZNX_LIST_RE);
        if (sibling && Math.abs(nind - baseIndent) <= 1) { i = k; break; }  // item berikutnya (list renggang)
        i = k; done = true; break;                                        // list selesai
      }
      const lind = znxIndent(znxLeading(ln));
      if (lind >= ind + 2) { inner.push(znxDedent(ln, contentIndent)); i++; continue; }
      if (ZNX_LIST_RE.test(ln)) break;                                     // saudara / induk
      if (lind > ind) { inner.push(ln.trim()); i++; continue; }            // lanjutan malas
      done = true; break;
    }
    let body = renderBlocks(inner);
    body = body.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
    items.push(`<li>${body}</li>`);
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}${ordered && startNum !== 1 ? ` start="${startNum}"` : ""}>${items.join("")}</${tag}>`, end: i };
}

function renderBlocks(lines) {
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const t = line.trim();

    const fence = t.match(/^(`{3,}|~{3,})\s*([^\s`]*)/);
    if (fence) {
      const lang = (fence[2] || "").toLowerCase();
      let j = i + 1;
      while (j < lines.length) {
        const tj = lines[j].trim();
        if (tj.startsWith(fence[1][0].repeat(fence[1].length)) && !tj.replace(new RegExp(`^\\${fence[1][0]}+`), "").trim()) break;
        j++;
      }
      const code = lines.slice(i + 1, j).join("\n");
      html += `<div class="code-wrap" data-code-lang="${escapeAttr(lang)}"><div class="code-heading"><span>${escapeHtml(lang || "code")}</span><button class="code-copy" type="button" data-copy-code="${encodeURIComponent(code)}">Salin kode</button></div><pre class="code-block"><code>${escapeHtml(code)}</code></pre></div>`;
      i = j + 1;
      continue;
    }
    if (t.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1], t)) {
      const table = parseTable(lines, i);
      html += table.html; i = table.end; continue;
    }
    const h = t.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) { html += `<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^([-*_])(?:\s*\1){2,}$/.test(t)) { html += "<hr>"; i++; continue; }
    if (/^>/.test(t)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      html += `<blockquote>${renderBlocks(quote)}</blockquote>`;
      continue;
    }
    if (ZNX_LIST_RE.test(line)) {
      const list = parseList(lines, i);
      html += list.html; i = list.end; continue;
    }
    const para = [t];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    // Baris yang isinya hanya rumus blok jadi blok sendiri (tanpa <br> nyasar di atas/bawahnya).
    const onlyDisplay = new RegExp(`^${ZNX_MATH_L}(\\d+)${ZNX_MATH_R}$`);
    let group = [];
    const flushGroup = () => { if (group.length) { html += `<p>${group.map(renderInline).join("<br>")}</p>`; group = []; } };
    for (const piece of para) {
      const only = piece.match(onlyDisplay);
      if (only && ZNX_MATH_STORE[+only[1]]?.display) { flushGroup(); html += `<div class="math-block">${piece}</div>`; }
      else group.push(piece);
    }
    flushGroup();
  }
  return html;
}

function renderMarkdown(markdown = "") {
  const clean = String(markdown).replace(/\r/g, "").replace(/[-]/g, "");
  const { text, store } = extractAllMath(clean);
  ZNX_MATH_STORE = store;
  let html = renderBlocks(text.split("\n"));
  html = html.replace(new RegExp(`${ZNX_MATH_L}(\\d+)${ZNX_MATH_R}`, "g"), (m, idx) => mathToHtml(store[+idx]));
  ZNX_MATH_STORE = [];
  return `<div class="markdown">${html || "<p></p>"}</div>`;
}

/* Rumus blok yang lebih lebar dari layar dikecilkan dulu (maks. sampai 70%) supaya tidak terpotong;
   kalau masih terlalu lebar, tetap bisa digeser ke samping. */
function fitDisplayMath(el) {
  const box = el.querySelector(".katex-display");
  const tex = box && box.querySelector(".katex");
  if (!box || !tex) return;
  tex.style.fontSize = "";                       // ukur ulang dari ukuran asli (aman dipanggil berulang)
  if (box.scrollWidth <= box.clientWidth + 1) return;
  const base = parseFloat(getComputedStyle(tex).fontSize) || 16;
  const ratio = box.clientWidth / box.scrollWidth;
  tex.style.fontSize = `${Math.max(base * 0.7, base * ratio * 0.97).toFixed(2)}px`;
}
function refitAllMath(root = document) {
  root.querySelectorAll("span.znx-math-display[data-done='1']").forEach(fitDisplayMath);
}

/* Dipanggil setelah HTML masuk ke DOM. Aman dipanggil berulang. */
function hydrateMath(root) {
  if (!root || typeof document === "undefined" || !window.katex) return false;
  root.querySelectorAll("span.znx-math:not([data-done])").forEach(el => {
    try {
      window.katex.render(el.dataset.tex || "", el, { displayMode: el.dataset.display === "1", throwOnError: false, strict: "ignore", trust: false });
      el.dataset.done = "1";
      fitDisplayMath(el);
      // Font KaTeX dimuat belakangan dan mengubah lebar rumus, jadi ukur lagi setelah font siap.
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitDisplayMath(el));
    } catch (error) {
      el.dataset.done = "err";
      console.warn("KaTeX:", error);
    }
  });
  return true;
}

/* Project preview helpers (dipakai script.js) */
function extractProjectFiles(content) {
  const files = { html: "", css: "", js: "" };
  const text = String(content);
  const regex = /```([a-zA-Z0-9_#+.-]*)[ \t]*\n([\s\S]*?)(?:```|$)/g;   // blok terakhir yang terpotong tetap dibaca
  let match;
  while ((match = regex.exec(text))) {
    const label = match[1].toLowerCase();
    const body = match[2].trim();
    if (!body) continue;
    if (label === "html" || label === "htm") files.html = body;
    else if (label === "css" || label === "scss") files.css = body;
    else if (["js", "javascript", "mjs"].includes(label)) files.js = body;
  }
  if (!files.html) {
    const raw = text.trim();
    if (/^\s*(<!doctype html|<html[\s>])/i.test(raw)) files.html = raw;
  }
  return files.html ? files : null;
}

function buildSrcdoc(project) {
  let html = project.html || "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>";
  if (!/<html[\s>]/i.test(html)) html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`;
  if (!/<meta[^>]+viewport/i.test(html)) {
    const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';
    if (/<head[\s>]/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
    else html = html.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`);
  }
  const css = (project.css || "").replace(/<\/style/gi, "<\\/style");
  const js = (project.js || "").replace(/<\/script/gi, "<\\/script");
  const styleTag = css ? `<style>\n${css}\n</style>` : "";
  const scriptTag = js ? `<script>\n${js}\n<\/script>` : "";
  if (styleTag) {
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `${styleTag}</head>`);
    else if (/<head[\s>]/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1>${styleTag}`);
    else html = html.replace(/<html([^>]*)>/i, `<html$1><head>${styleTag}</head>`);
  }
  if (scriptTag) {
    if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${scriptTag}</body>`);
    else html += scriptTag;
  }
  return html;
}
