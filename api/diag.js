// Tes langsung ke provider (NVIDIA/Mistral/...) TANPA memotong kuota chat dan tanpa fallback ke model lain.
// Aktif hanya kalau env DIAG_SECRET diisi. Pakai di browser:
//   /api/diag?key=<DIAG_SECRET>                              -> daftar model per tingkat Effort (fast/low/medium/high)
//   /api/diag?key=<DIAG_SECRET>&model=nvidia::meta/llama-3.3-70b-instruct
//   tambahan opsional: &wait=50 (batas tunggu detik, 5-55)  &tokens=256 (16-2048)  &prompt=teks
import { timingSafeEqual } from "node:crypto";
import { TIER_IDS, PROVIDERS, providerBaseUrl, modelsForTier, cleanKey } from "../lib/models.js";
import { streamChatCompletion, describeStall } from "../lib/stream.js";

const clamp = (v, min, max, fallback) => Math.min(max, Math.max(min, Number(v) || fallback));

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const secret = process.env.DIAG_SECRET;
  if (!secret) return res.status(404).json({ error: "Diagnostik nonaktif. Isi env DIAG_SECRET di Vercel (lalu Redeploy) untuk mengaktifkan." });
  const q = req.query || {};
  if (!sameSecret(q.key, secret)) return res.status(401).json({ error: "key salah." });

  const byTier = {};
  const testable = new Set();
  for (const t of TIER_IDS) {
    byTier[t] = (await modelsForTier(t)).map(m => m.value);
    byTier[t].forEach(v => testable.add(v));
  }
  const choice = String(q.model || "");
  if (!choice) return res.status(200).json({ info: "Tambahkan &model=<salah satu di bawah>", tiers: byTier });
  if (!testable.has(choice)) return res.status(400).json({ error: "Model tidak ada / API key provider-nya belum dipasang.", tiers: byTier });

  const sep = choice.indexOf("::");
  const provider = choice.slice(0, sep);
  const model = choice.slice(sep + 2);
  const cfg = PROVIDERS[provider];
  const waitMs = clamp(q.wait, 5, 55, 45) * 1000;
  const key = cleanKey(process.env[cfg.env]);

  const r = await streamChatCompletion({
    url: `${providerBaseUrl(provider)}/chat/completions`,
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model,
      messages: [{ role: "user", content: String(q.prompt || "Balas dengan satu kata saja: oke").slice(0, 400) }],
      max_tokens: clamp(q.tokens, 16, 2048, 256)
    },
    firstByteMs: Math.min(20000, waitMs),
    firstTokenMs: Math.min(30000, waitMs),
    idleMs: 15000,
    totalMs: waitMs
  });

  let verdict;
  if (r.errorData) verdict = `DITOLAK provider (HTTP ${r.status}): ${JSON.stringify(r.errorData).slice(0, 300)}`;
  else if (r.abort || r.networkError) verdict = describeStall(cfg.label, r);
  else if (!r.text.trim()) verdict = `Request diterima dan selesai (${Math.round(r.totalMs / 100) / 10} dtk) tapi isi jawaban kosong${r.finish === "length" ? " (token habis dipakai untuk berpikir; naikkan &tokens=)" : ""}.`;
  else verdict = `OK. Diterima dalam ${r.headersMs} ms, token pertama ${r.ttftMs} ms, selesai ${r.totalMs} ms.`;

  return res.status(200).json({
    model: choice,
    ok: Boolean(r.ok && !r.abort && !r.networkError && r.text.trim()),
    verdict,
    accepted: r.headersMs !== null && r.status > 0 && r.status < 400,
    httpStatus: r.status || null,
    headersMs: r.headersMs,
    firstTokenMs: r.ttftMs,
    totalMs: r.totalMs,
    thinkingChars: r.reasoningChars,
    finishReason: r.finish || null,
    answerPreview: r.text.slice(0, 200)
  });
}
