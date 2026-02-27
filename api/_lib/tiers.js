let kv = null;
try {
  // Optional at runtime; requires Vercel KV to be connected
  ({ kv } = require("@vercel/kv"));
} catch {
  kv = null;
}

async function getTier(discord_user_id) {
  // 1) KV (if available)
  if (kv) {
    const t = await kv.get(`tier:${discord_user_id}`);
    if (t === "pro" || t === "basic") return t;
  }

  // 2) Env allowlist (fallback)
  const proIds = (process.env.PRO_DISCORD_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (proIds.includes(String(discord_user_id))) return "pro";

  return "basic";
}

async function setTier(discord_user_id, tier) {
  if (!kv) {
    throw new Error("Vercel KV 未连接：请在 Vercel Dashboard 创建并连接 KV 后再使用 setTier");
  }
  if (tier !== "basic" && tier !== "pro") {
    throw new Error("tier 必须是 basic 或 pro");
  }
  await kv.set(`tier:${discord_user_id}`, tier);
  return { ok: true };
}

module.exports = { getTier, setTier };

