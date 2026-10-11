# ZennNyx AI v9.18 — Workspace

Static HTML/CSS/JS client with Vercel serverless API. Crisp bordered UI, model picker, full-screen website preview, KaTeX math, real web sources, and a 20-message daily quota (WIB).

## Deploy
1. Replace the project files with this ZIP's files, keeping the folder structure (`api/`, `lib/`, plus `markdown.js` next to `script.js`).
2. Environment variables (Vercel → Settings → Environment Variables), then **Redeploy**.
3. Run `npm run check` locally if you want to syntax-check everything.

## Environment variables
- `DIAG_SECRET` (optional; kata sandi untuk halaman tes `/api/diag`, lihat v9.15)
- `MISTRAL_API_KEY` (optional; Mistral, paket gratis "Experiment": verifikasi nomor HP, tanpa kartu kredit; data bisa dipakai Mistral untuk training)
- `NVIDIA_API_KEY` (optional; NVIDIA NIM dari build.nvidia.com, gratis, verifikasi nomor HP, kira-kira 40 permintaan/menit per akun)
- `MISTRAL_MODELS`, `NVIDIA_MODELS` (optional; ganti daftar model, dipisah koma, tanpa edit kode)
- `GROQ_API_KEY` (needed for Groq models)
- `GEMINI_API_KEY` (optional; Gemini models)
- `OPENROUTER_API_KEY` (optional; the picker lists free **chat** models only)
- `TAVILY_API_KEY` (optional; live web search)
- `RATE_LIMIT_SECRET` (optional but recommended; stable cookie-signing secret)
- `GROQ_VISION_MODEL` (optional; defaults to `qwen/qwen3.8-27b`)
- `PUBLIC_APP_URL` (optional; OpenRouter attribution)

API keys stay on the server.

## v9.18 — what changed (logo bulat: `index.html`, `style.css`, file ikon)
- **Logo baru yang bulat**: cincin orbit dengan celah, bulan sabit di tengah (Nyx = dewi malam), dan satu titik yang mengorbit (simpul AI). Bukan lingkaran-tiga-bola ala Ubuntu. Dipakai di header (kini dalam lingkaran), semua ikon website (`favicon.svg/.ico/-32.png`, `apple-touch-icon.png`, `icon-192/512.png`), dan art ASCII di layar awal. Semuanya dari satu definisi bentuk yang sama, jadi selalu selaras.
- Art ASCII digambar ulang dari bentuk logo itu (bayangan lembut dengan karakter `. : - = + * # % @`), tulisan ZENN NYX dan garis `[ A I ]` tetap.

## v9.17 — what changed (`index.html`, `style.css`, `script.js`, + file ikon baru)
- **Font**: jawaban/pesan kini **Merriweather** (serif klasik dengan huruf lebar dan tinggi-x besar, paling terbaca di layar HP), ukuran 16.5px, jarak baris 1.85. Teks dark sedikit diredam (#f4f4f4) supaya tidak "menyilaukan" di latar hitam murni. Ganti font cukup di satu tempat: variabel `--font-read` di `style.css` dan tautan Google Fonts di `index.html`.
- **Panel Sumber ringkas**: satu baris per sumber (ikon situs, judul, tautan singkat), tanpa cuplikan teks dan tanpa judul panel. Tautan ditampilkan disingkat (mis. `kompas.com/bola/read/2026/10/11/12345…`) tapi tetap membuka alamat lengkapnya. Daftar bisa digulir kalau panjang.
- **Art ASCII di layar awal chat baru**: emblem heksagon (meniru logo) + tulisan ZENN NYX + garis `[ A I ]`, murni karakter ASCII supaya rata di semua HP. Muncul dengan efek "pindai" dari atas ke bawah (mati otomatis kalau HP diatur kurangi animasi).
- **Ikon website**: `favicon.svg`, `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, dan `site.webmanifest` (ikon saat "Tambahkan ke layar utama"). Semuanya logo ZennNyx putih di kotak hitam.

## v9.16 — what changed (`index.html`, `style.css`, `script.js`, `api/chat.js`, `lib/models.js`)
- **Warna hitam-putih**: dark = hitam murni + teks putih, light = putih + teks hitam. Warna merah/hijau diganti abu-abu, ikon logo model dibuat hitam-putih.
- **Font**: jawaban, pesan, dan judul memakai **Literata** (serif yang dirancang untuk dibaca di layar, tetap berkesan klasik), dimuat dari Google Fonts, dengan cadangan Georgia kalau gagal dimuat. Teks tombol/menu tetap sans-serif.
- **UI lebih simpel**: layar sambutan jadi satu judul + 4 tombol; kartu fitur, label kecil kapital, catatan "bisa keliru", "Dibuat X dtk", info WORKSPACE/versi, tombol Ctrl K, dan teks teknis (API key, TAVILY_API_KEY) dibuang; tab Obrolan/Pratinjau baru muncul kalau ada pratinjau; tombol di bawah jawaban jadi ikon saja; sisa jatah pesan baru tampil kalau tinggal 5 atau kurang; teks pop-up pengenalan dipersingkat.
- **Mode pengembang**: buka website dengan `?debug=1` sekali untuk menampilkan lagi detail teknis (waktu respons, "Penyebab:" pindah model). `?debug=0` mematikannya. Pengunjung biasa hanya melihat "X sedang sibuk, jadi dijawab oleh Y".
- **Kotak ketik vs keyboard**: meta viewport `interactive-widget=resizes-content` (layout ikut mengecil saat keyboard muncul), ditambah perhitungan jarak keyboard yang baru: memakai tinggi layout yang sebenarnya, mendengarkan `window.resize`/fokus/blur dengan pengecekan ulang, mengabaikan selisih kecil (<80px), nol saat tidak sedang mengetik, dan tidak menambah jarak gesture-bar saat keyboard terbuka.
- **Nada bicara**: "gue/lu" hanya dipakai kalau user sendiri memakainya; selain itu "aku/kamu" atau netral. Model kecil (mis. GPT-OSS 20B) jadi tidak memaksakan slang.
- **Model**: GLM-5.3 Flash jadi prioritas awal lebih tinggi di mode Otomatis (cepat dan enak diajak ngobrol); GPT-OSS 20B diturunkan. Deskripsi model dipersingkat.

## v9.15 — what changed (`lib/stream.js` baru, `api/diag.js` baru, `api/chat.js`, `vercel.json`)
- **Streaming ke Mistral/NVIDIA**: server kini membaca jawaban sambil mengalir, jadi tahu di tahap mana request macet. Catatan merah (Penyebab) sekarang membedakan: (a) "tidak ada respons sama sekali" = belum diterima/antre, (b) "request DITERIMA tapi belum ada token" = antre di provider, (c) "sudah mulai menjawab lalu berhenti", (d) "diproses tapi belum selesai saat batas waktu" lengkap dengan jumlah karakter yang sempat dipikirkan. Jawaban yang sudah sebagian ditampilkan (diberi catatan terpotong) alih-alih dibuang dan diganti model lain. Batas tunggu model besar naik ke 38 dtk.
- **`/api/diag` (tes langsung, tanpa kuota chat, tanpa fallback)**: aktif kalau env `DIAG_SECRET` diisi. Buka `/api/diag?key=<DIAG_SECRET>` untuk daftar model, lalu `/api/diag?key=<DIAG_SECRET>&model=nvidia::deepseek-ai/deepseek-v4.1-flash`. Hasilnya JSON: diterima atau tidak, waktu sampai header, waktu token pertama, total, dan jumlah karakter berpikir. Opsional: `&wait=50` (detik) `&tokens=512` `&prompt=teks`. Tanpa `DIAG_SECRET`, halaman ini mati (404).

## v9.14 — what changed (`lib/models.js`, `api/chat.js`)
- Model NVIDIA default diganti ke model yang BEDA dari Groq: **DeepSeek V4.1 Flash** (`deepseek-ai/deepseek-v4.1-flash`, bisa baca gambar), **GLM-5.3** (`z-ai/glm-5.3`), dan **GLM-5.3 Flash** (`z-ai/glm-5.3-flash`, bisa baca gambar). Id-nya dicocokkan dengan halaman build.nvidia.com.
- Model-model ini "berpikir" dulu sebelum menjawab, jadi diberi batas token lebih besar dan batas waktu tunggu lebih lama (32 dtk sebelum dianggap gagal). Kalau tetap kosong/terlalu lama, auto-switch ke model lain dan alasannya tampil di catatan merah.
- Di mode Otomatis, model NVIDIA hanya cadangan (nilai awal di bawah Groq/Gemini). Untuk memakainya, pilih manual di picker.

## v9.13 — what changed (`lib/models.js`, `api/chat.js`)
- NVIDIA: HTTP 410 = model sudah dihentikan (end of life). Nemotron Super 49B dan beberapa Llama/Nemotron lama sudah mati, jadi daftar default diganti ke `openai/gpt-oss-120b` dan `openai/gpt-oss-20b`. Pesan 410 sekarang menjelaskan itu. Katalog NVIDIA sering berganti; ganti lewat env `NVIDIA_MODELS` bila perlu, tanpa edit kode.
- Mistral: paket gratis API sudah tidak tersedia. Jangan pasang `MISTRAL_API_KEY` kalau tidak berbayar; tanpa key, providernya tidak muncul.

## v9.12 — what changed (`api/chat.js`, `script.js`)
- Catatan "X sedang bermasalah, jadi dijawab otomatis oleh Y" sekarang diikuti **Penyebab:** (mis. "API key ditolak", "limit tercapai", "model tidak ditemukan"), diambil dari error asli provider.
- API key Mistral/NVIDIA dibersihkan dulu sebelum dipakai (spasi, baris baru, tanda kutip, awalan "Bearer" dibuang), karena key yang ditempel dari HP sering membawanya dan membuat request gagal.

## v9.11 — what changed (Mistral + NVIDIA NIM, gratis)
- `lib/models.js`: `COMPAT_PROVIDERS` = daftar provider berformat OpenAI-compatible. Sekarang berisi Mistral (`mistral-small-latest`, `mistral-large-latest`) dan NVIDIA NIM (`meta/llama-3.3-70b-instruct`, `nvidia/llama-3.3-nemotron-super-49b-v1`). Muncul di picker begitu API key-nya ada. Tambah provider gratis lain yang OpenAI-compatible = tambah satu blok di sini.
- `api/chat.js`: satu fungsi `callCompat()` melayani semuanya. Error apa pun (limit, model tidak ada, key salah) -> auto-switch ke model lain seperti biasa.
- Nama model resmi bisa berubah. Kalau sebuah model 404, ganti lewat `MISTRAL_MODELS` / `NVIDIA_MODELS` di Vercel (daftar model ada di dashboard masing-masing).
- Tidak ada kode provider berbayar di versi ini.

## v9.9 — what changed (`api/chat.js` + `script.js`)
Masalah: di mode Otomatis, tiap pesan bisa dijawab model berbeda (mis. Gemini lalu GPT-OSS 20B). Model kecil sering salah menafsirkan pesan lanjutan yang berupa cerita/pendapat, mis. menjawab "teman atau saudara" padahal user menyebut Douyin dan nama orang.
- **Model lengket**: browser mengingat model yang menjawab giliran terakhir (`lastUsedModel`) dan mengirimnya sebagai `stickyModel`. Di mode Otomatis server memakai model itu lagi selama masih sehat, jadi gaya dan pemahaman konteks tidak berganti tiap pesan. Kalau model itu baru gagal/limit, ranking kelancaran biasa dan auto-switch tetap jalan. Chat baru mereset ini. Memilih model manual tidak berubah.
- **Blok "KESINAMBUNGAN PERCAKAPAN"** di system prompt (`buildContinuity`), dikirim ke SEMUA model mulai pesan kedua: topik awal, pesan user sebelumnya, inti jawaban terakhir, pesan sekarang, plus aturan: tanggapi detail spesifik user (platform, nama, produk), jangan mengganti dengan skenario generik, jangan menukar sudut pandang, sambungkan ke topik awal.
- **Web search tidak lagi dipicu cerita/pendapat lanjutan**: pesan lanjutan tanpa tanda tanya/kata tanya dan tanpa kata "terbaru/harga/hari ini" tidak memicu pencarian hanya karena ada kata seperti "hp", "juara", "iPhone". Hasil web yang melenceng sebelumnya bisa mengacaukan model kecil. Pertanyaan lanjutan ("berapa harga iQOO 15 sekarang?") tetap mencari.
- Batas: ini mengurangi, bukan menjamin nol salah tafsir. Model kecil tetap lebih sering meleset daripada model besar. Kalau ingin paling konsisten, pilih satu model manual di picker.

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
