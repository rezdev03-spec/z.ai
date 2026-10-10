# ZennNyx AI v9.8 — Workspace

Static HTML/CSS/JS client with Vercel serverless API. Crisp bordered UI, model picker, full-screen website preview, KaTeX math, real web sources, and a 20-message daily quota (WIB).

## Deploy
1. Replace the project files with this ZIP's files, keeping the folder structure (`api/`, `lib/`, plus `markdown.js` next to `script.js`).
2. Environment variables (Vercel → Settings → Environment Variables), then **Redeploy**.
3. Run `npm run check` locally if you want to syntax-check everything.

## Environment variables
- `GROQ_API_KEY` (needed for Groq models)
- `GEMINI_API_KEY` (optional; Gemini models)
- `OPENROUTER_API_KEY` (optional; the picker lists free **chat** models only)
- `TAVILY_API_KEY` (optional; live web search)
- `RATE_LIMIT_SECRET` (optional but recommended; stable cookie-signing secret)
- `GROQ_VISION_MODEL` (optional; defaults to `qwen/qwen3.8-27b`)
- `PUBLIC_APP_URL` (optional; OpenRouter attribution)

API keys stay on the server.

## v9.8 — what changed (client only: `index.html`, `style.css`, `script.js`)
- Saat AI loading, di samping animasi titik kini ada teks status: **"Searching the web…"** (±3,5 dtk pertama, hanya bila web search diperkirakan dipakai), lalu **"Thinking…"**, dan **"Still thinking…"** kalau jawaban butuh >12 dtk. Mode Think Harder menampilkan "Thinking harder…". Teksnya ada di konstanta `STATUS_LABEL` di `script.js`. Server membalas sekali jadi (tanpa streaming), jadi fase ini perkiraan di sisi browser.
- Pop-up pengenalan project saat website dibuka: tombol close (×, tombol Tutup, klik latar, atau Esc) dan checkbox **Jangan tampilkan lagi** (disimpan di `localStorage` kunci `zennnyx_intro_hidden_v1`). Tanpa dicentang, pop-up muncul lagi di kunjungan berikutnya. Mau reset: hapus kunci itu lewat DevTools.
- Edit isi pop-up di `index.html` (blok `#introModal`).

## v9.7 — what changed (client only, `markdown.js` + `script.js`)
- Tautan `<https://…>` (autolink Markdown) sekarang bisa diklik; sebelumnya tampil sebagai teks mentah.
- URL polos tidak lagi terpotong di tanda hubung (`…/nuts-feat-rainy-bear/123`), dan URL bertanda kurung seperti `Nuts_(song)` utuh, baik di `[teks](url)` maupun polos.
- Tautan yang teksnya berupa URL panjang ditampilkan sebagai tombol kecil: ikon situs + domain (alamat penuh di tooltip dan href).

## v9.6 — what changed (client only)
- Tautan gaya referensi dari model ("[link Spotify][3]" + baris "[3]: https://…") kini diubah jadi tautan sungguhan, bukan teks mati dengan daftar URL di bawah. Tautan bertuliskan "link …"/"tautan …" tampil sebagai tombol kecil dengan ikon situs. "[link Spotify]" tanpa alamat dicocokkan ke sumber hasil pencarian berdasarkan nama situs.
- Animasi mengetik: layar berhenti di pesan user dan tidak ikut turun; tinggi jawaban dikunci dulu supaya halaman tidak melompat.

## v9.5 — what changed
- Sitasi bawaan GPT-OSS `【1†L1-L2】` selalu dibuang dari tampilan.
- Web search untuk pertanyaan lanjutan: kueri kini membawa pertanyaan sebelumnya kapan pun pesan baru tidak berdiri sendiri (ada kata seperti "-nya", "itu", "tadi", "kira-kira" atau terlalu pendek), bukan hanya kalau < 32 huruf. Prompt juga menyuruh model mengabaikan hasil yang tidak nyambung dengan topik.

## v9.4 — what changed (client only, API untouched)
- Penanda sitasi `[1][2]` dan baris "Referensi: …" disembunyikan dari jawaban yang memakai web search (kode tidak disentuh); sumber hanya lewat tombol Sources.
- Placeholder kotak ketik lebih pendek/kecil, satu baris.
- Tombol ikon *Chat baru* di kanan atas.
- Jawaban baru muncul dengan animasi mengetik (ketuk jawaban untuk langsung menampilkan semuanya; mati otomatis bila perangkat memakai "reduce motion").

## v9.3 — what changed
- **Sources**: tombol *Sources* sekarang membuka daftar tautan. Penyebabnya bug klik: popover dibuat lalu langsung dihapus handler klik dokumen. Tiap sumber kini punya ikon situs (favicon) + judul + domain; tombolnya menampilkan tumpukan favicon.
- **Model otomatis**: default baru = *Otomatis*. Server memilih model dari semua provider berdasarkan kelancaran (gagal baru-baru ini = turun, lambat = turun, sering sukses = naik). Nilai awal ada di `lib/models.js` (`prior`). Catatan kelancaran disimpan di browser (`zennnyx_model_health_v1`) dan dikirim ke server.
- **Auto-switch**: error apa pun (limit, 5xx, timeout, jawaban kosong, key salah di satu provider) -> otomatis coba model lain lintas Groq/Gemini/OpenRouter, maksimal 4 percobaan dalam batas waktu 55 dtk. Berlaku juga kalau user memilih model manual.
- **Enter** = baris baru. Kirim lewat tombol panah atau Ctrl/Cmd+Enter.
- **Ikon merek** (OpenAI, Gemini, NVIDIA, Qwen, DeepSeek, Meta, Mistral, dll.) dimuat dari CDN Lobe Icons; ada ikon cadangan kalau gagal dimuat. Mau self-host: unduh SVG-nya ke `/icons` dan ubah `ICON_BASE` di `script.js`.
- **Composer** lebih membulat dan diberi jarak dari tepi layar. **Teks** jawaban AI dan pesan user diperbesar.

## v9.2 — what changed
**Errors / OpenRouter**
- Non-chat models (e.g. *NVIDIA Nemotron Content Safety*, which only answers "User Safety: safe", plus embedding/moderation models) are removed from the list and rejected by the server.
- If an OpenRouter free model is busy/offline (429, 404, 5xx, empty answer), the server automatically tries up to 2 other free models. The answer shows which model actually replied.
- Models that refuse a system prompt (e.g. Gemma) are retried automatically with the instructions folded into the user message. `<think>…</think>` blocks are stripped.
- Real error reasons are shown (invalid key, daily free limit, 1-minute limit, timeout…) instead of one generic message. OpenRouter's account-wide limits (`free-models-per-day` / `-per-min`) get their own explanation, because trying another free model cannot help there.
- A failed request no longer costs one of the 20 daily messages (the server and the client both give it back).
- **Kirim ulang** button on every error: your message (text + image) is kept, you can switch model first and resend.

**Web search (Tavily)**
- Auto mode is much broader than the old keyword list (questions, news, prices, "cari…", follow-ups such as "dan harganya?" use the previous question as context). Coding, math and chit-chat are skipped.
- New **Web Search** switch in the `+` menu: *Otomatis* (default) or *Selalu cari*.
- If Tavily fails, the answer now says why (invalid key, plan limit reached, timeout…). `country` is sent in the lowercase form Tavily expects, and a rejected optional parameter triggers a plain retry.

**Markdown & math** (`markdown.js`)
- LaTeX is extracted *before* Markdown runs, so `x_1`, `a*b` and `\\` are no longer turned into italics. Supports `\( \)`, `\[ \]`, `$ $`, `$$ $$`, bare `\begin{aligned}…`, double-escaped `\\(`, and `[ … ]` blocks.
- Real nested lists (numbering no longer restarts), code blocks inside list items, `[text](url)` links, table alignment, rows with missing cells.
- Wide formulas scroll sideways instead of being clipped on the left.

**Layout**
- Side menu now reaches the bottom of the screen on phones.
- **Obrolan** (left) and **Pratinjau** (right) sit on the same row.
- When the AI writes a website, the Pratinjau tab turns on immediately (pulsing dot + "Buka pratinjau layar penuh" button). The preview fills the whole screen area with no box around it, the composer is hidden while previewing, and there is a fullscreen button. Truncated code (cut off at the token limit) still renders.
- Website requests get a larger output budget and a prompt that asks for one complete, self-contained HTML file.

## Quota notes
A signed cookie with the Jakarta-local date allows 20 requests/day per browser. Without a database/login, clearing site data resets it.
