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

  // 2) Env allowlist (fallback)
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
  const db = await getMongoDb();
  if (!db) {
    throw new Error("未配置 MongoDB，无法写入会员等级");
  }
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

  return { ok: true };
}

module.exports = { getTier, setTier };

