let kv = null;
try {
  // Optional at runtime; requires Vercel KV to be connected
  ({ kv } = require("@vercel/kv"));
} catch {
  kv = null;
}
const { getMongoDb } = require("./mongo");

const MEMBERS_COLLECTION = process.env.MONGODB_MEMBERS_COLLECTION || "members";

function isValidTier(t) {
  return t === "pro" || t === "basic";
}

async function getTier(discord_user_id) {
  // 1) MongoDB Atlas (if configured)
  const db = await getMongoDb();
  if (db) {
    const doc = await db
      .collection(MEMBERS_COLLECTION)
      .findOne({ discord_user_id: String(discord_user_id) }, { projection: { tier: 1 } });
    if (doc && isValidTier(doc.tier)) return doc.tier;
  }

  // 2) KV (if available)
  if (kv) {
    const t = await kv.get(`tier:${discord_user_id}`);
    if (isValidTier(t)) return t;
  }

  // 3) Env allowlist (fallback)
  const proIds = (process.env.PRO_DISCORD_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (proIds.includes(String(discord_user_id))) return "pro";

  return "basic";
}

async function setTier(discord_user_id, tier) {
  if (!isValidTier(tier)) {
    throw new Error("tier 必须是 basic 或 pro");
  }

  const id = String(discord_user_id);
  let wrote = false;

  const db = await getMongoDb();
  if (db) {
    await db.collection(MEMBERS_COLLECTION).updateOne(
      { discord_user_id: id },
      {
        $set: {
          discord_user_id: id,
          tier,
          updated_at: new Date().toISOString(),
        },
      },
      { upsert: true }
    );
    wrote = true;
  }

  if (kv) {
    await kv.set(`tier:${id}`, tier);
    wrote = true;
  }

  if (!wrote) {
    throw new Error("未配置 MongoDB 或 Vercel KV，无法写入会员等级");
  }

  return { ok: true };
}

module.exports = { getTier, setTier };

