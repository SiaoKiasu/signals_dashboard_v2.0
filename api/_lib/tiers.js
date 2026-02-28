const { getMongoDb } = require("./mongo");

const MEMBERS_COLLECTION = process.env.MONGODB_MEMBERS_COLLECTION || "members";

function isValidTier(t) {
  return t === "basic" || t === "pro" || t === "ultra";
}

function toInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function durationToMs({ days = 0, hours = 0, minutes = 0 }) {
  const d = toInt(days);
  const h = toInt(hours);
  const m = toInt(minutes);
  const ms = (((d * 24 + h) * 60 + m) * 60) * 1000;
  return { days: d, hours: h, minutes: m, ms };
}

function parseBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

async function getMemberRecord(discord_user_id) {
  const db = await getMongoDb();
  if (!db) return null;
  const doc = await db.collection(MEMBERS_COLLECTION).findOne({ discord_user_id: String(discord_user_id) });
  return doc || null;
}

async function getTier(discord_user_id) {
  // 1) MongoDB Atlas (if configured)
  const db = await getMongoDb();
  if (db) {
    const doc = await db
      .collection(MEMBERS_COLLECTION)
      .findOne({ discord_user_id: String(discord_user_id) }, { projection: { tier: 1, expires_at: 1 } });
    if (doc && isValidTier(doc.tier)) {
      if (doc.tier === "basic") return "basic";
      const expMs = Date.parse(String(doc.expires_at || ""));
      if (Number.isFinite(expMs) && expMs > Date.now()) return doc.tier;
      return "basic";
    }
  }

  // 2) Env allowlist (fallback)
  const ultraIds = (process.env.ULTRA_DISCORD_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ultraIds.includes(String(discord_user_id))) return "ultra";

  const proIds = (process.env.PRO_DISCORD_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (proIds.includes(String(discord_user_id))) return "pro";

  return "basic";
}

async function setTier(discord_user_id, tier) {
  if (!isValidTier(tier)) {
    throw new Error("tier 必须是 basic / pro / ultra");
  }

  const id = String(discord_user_id);
  const db = await getMongoDb();
  if (!db) {
    throw new Error("未配置 MongoDB，无法写入会员等级");
  }
  const nowIso = new Date().toISOString();
  const setObj = {
    discord_user_id: id,
    tier,
    updated_at: nowIso,
  };
  if (tier === "basic") {
    setObj.expires_at = nowIso;
  }
  await db.collection(MEMBERS_COLLECTION).updateOne(
    { discord_user_id: id },
    {
      $set: setObj,
      $setOnInsert: { created_at: nowIso, first_opened_at: nowIso },
      $push: {
        membership_history: {
          action: "admin_set",
          tier,
          created_at: nowIso,
          source: "admin_set_tier",
        },
      },
    },
    { upsert: true }
  );

  return { ok: true };
}

async function applyMembershipChange(discord_user_id, input) {
  const tier = String(input && input.tier ? input.tier : "").trim();
  if (!isValidTier(tier)) {
    throw new Error("tier 必须是 basic / pro / ultra");
  }

  const isUpgrade = parseBool(input && input.is_upgrade);
  const dur = durationToMs({
    days: input && input.days,
    hours: input && input.hours,
    minutes: input && input.minutes,
  });
  if (dur.ms <= 0) {
    throw new Error("续费时长必须大于 0（days/hours/minutes）");
  }

  const id = String(discord_user_id);
  const db = await getMongoDb();
  if (!db) {
    throw new Error("未配置 MongoDB，无法写入会员等级");
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const existing = await db.collection(MEMBERS_COLLECTION).findOne({ discord_user_id: id });
  const firstOpenedAt = existing && existing.first_opened_at ? existing.first_opened_at : nowIso;
  const existingExpMs = Date.parse(String(existing && existing.expires_at ? existing.expires_at : ""));
  const baseMs = isUpgrade
    ? now
    : Number.isFinite(existingExpMs) && existingExpMs > now
      ? existingExpMs
      : now;
  const newExpMs = baseMs + dur.ms;
  const expiresAt = new Date(newExpMs).toISOString();

  const action = isUpgrade ? "upgrade" : (Number.isFinite(existingExpMs) && existingExpMs > now ? "renew" : "first");
  const update = {
    discord_user_id: id,
    tier,
    first_opened_at: firstOpenedAt,
    expires_at: expiresAt,
    updated_at: nowIso,
    last_recharge_at: nowIso,
    last_recharge_duration: {
      days: dur.days,
      hours: dur.hours,
      minutes: dur.minutes,
      total_minutes: Math.floor(dur.ms / 60000),
    },
    last_operation: action,
  };

  await db.collection(MEMBERS_COLLECTION).updateOne(
    { discord_user_id: id },
    {
      $set: update,
      $setOnInsert: { created_at: nowIso },
      $push: {
        membership_history: {
          action,
          tier,
          previous_tier: existing && existing.tier ? existing.tier : "basic",
          previous_expires_at: existing && existing.expires_at ? existing.expires_at : null,
          new_expires_at: expiresAt,
          duration: {
            days: dur.days,
            hours: dur.hours,
            minutes: dur.minutes,
            total_minutes: Math.floor(dur.ms / 60000),
          },
          is_upgrade: isUpgrade,
          created_at: nowIso,
          source: "membership_change",
        },
      },
    },
    { upsert: true }
  );

  return { ok: true, membership: update };
}

module.exports = { getTier, setTier, getMemberRecord, applyMembershipChange };

