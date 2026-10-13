// Panggilan chat OpenAI-compatible dengan STREAMING, supaya kita tahu persis di tahap mana sebuah request macet:
//   no_headers : server provider tidak membalas sama sekali (belum diterima / antre / penuh)
//   no_tokens  : request DITERIMA (header sudah datang) tapi belum ada satu token pun
//   stalled    : sudah mulai mengirim token lalu diam terlalu lama
//   deadline   : batas waktu total tercapai (jawaban mungkin sudah sebagian)
// Dipakai oleh api/chat.js (jawaban) dan api/diag.js (tes langsung tanpa memotong kuota chat).

export async function streamChatCompletion({ url, headers, body, firstByteMs = 20000, firstTokenMs = 30000, idleMs = 15000, totalMs = 40000, signal, onText, onReasoning }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  // Pembatalan dari luar (user menekan Stop / model lain sudah menang balapan): hentikan request upstream juga.
  if (signal) {
    if (signal.aborted) { ctrl.abort(); }
    else signal.addEventListener("abort", () => { if (!out.abort) out.abort = "cancelled"; ctrl.abort(); }, { once: true });
  }
  const out = { ok: false, status: 0, text: "", reasoningChars: 0, headersMs: null, ttftMs: null, totalMs: 0, finish: "", errorData: null, abort: null, networkError: "" };
  let timer = null;
  let phase = "no_headers";
  const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => { out.abort = why; ctrl.abort(); }, ms); };
  const totalTimer = setTimeout(() => { out.abort = "deadline"; ctrl.abort(); }, totalMs);
  try {
    arm(firstByteMs, "no_headers");
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...headers },
      body: JSON.stringify({ ...body, stream: true }),
      signal: ctrl.signal
    });
    out.status = response.status;
    out.headersMs = Date.now() - t0;
    if (!response.ok) {
      out.errorData = await response.json().catch(() => ({}));
      return out;
    }
    phase = "no_tokens";
    arm(firstTokenMs, "no_tokens");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let started = false;
    const handleLine = line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let json;
      try { json = JSON.parse(payload); } catch { return; }
      if (json?.error) { out.errorData = { error: json.error }; return; }
      const choice = json?.choices?.[0];
      const delta = choice?.delta || {};
      const piece = typeof delta.content === "string" ? delta.content : "";
      const think = typeof delta.reasoning_content === "string" ? delta.reasoning_content : (typeof delta.reasoning === "string" ? delta.reasoning : "");
      if (piece || think) {
        if (out.ttftMs === null) out.ttftMs = Date.now() - t0;
        started = true;
      }
      if (piece) { out.text += piece; onText?.(piece); }
      if (think) { out.reasoningChars += think.length; onReasoning?.(); }
      if (choice?.finish_reason) out.finish = choice.finish_reason;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (started) { phase = "stalled"; arm(idleMs, "stalled"); }
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
      if (started) { phase = "stalled"; arm(idleMs, "stalled"); }
    }
    if (buffer) handleLine(buffer);
    out.ok = !out.errorData;
    return out;
  } catch (error) {
    if (!out.abort) out.networkError = error?.message || "network error";
    return out;
  } finally {
    clearTimeout(timer);
    clearTimeout(totalTimer);
    out.totalMs = Date.now() - t0;
    void phase;
  }
}

export function describeStall(label, r) {
  const s = ms => `${Math.round(ms / 1000)} dtk`;
  const thinking = r.reasoningChars ? ` Model sempat berpikir (${r.reasoningChars} karakter).` : "";
  if (r.abort === "cancelled") return `${label}: dibatalkan.`;
  if (r.abort === "no_headers") return `${label}: tidak ada respons sama sekali dalam ${s(r.totalMs)}. Request belum diterima (server antre atau penuh).`;
  if (r.abort === "no_tokens") return `${label}: request DITERIMA (koneksi terbuka dalam ${s(r.headersMs ?? 0)}) tapi belum ada token jawaban setelah ${s(r.totalMs)}. Kemungkinan antre di sisi provider.`;
  if (r.abort === "stalled") return `${label}: sudah mulai menjawab lalu berhenti mengirim data (total ${s(r.totalMs)}).${thinking}`;
  if (r.abort === "deadline") return `${label}: request diterima dan diproses, tapi belum selesai saat batas waktu server (${s(r.totalMs)}).${thinking}`;
  return `${label}: gagal tersambung ke server provider.`;
}
