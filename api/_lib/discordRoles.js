const MEMBERS_COLLECTION = process.env.MONGODB_MEMBERS_COLLECTION || "members";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const DISCORD_MEMBER_PRO_ID = process.env.DISCORD_MEMBER_PRO_ID || "";
const DISCORD_MEMBER_ULTRA_ID = process.env.DISCORD_MEMBER_ULTRA_ID || "";

function isSyncEnabled() {
  return true;
}

function hasDiscordRoleConfig() {
  return !!(DISCORD_BOT_TOKEN && DISCORD_GUILD_ID && DISCORD_MEMBER_PRO_ID && DISCORD_MEMBER_ULTRA_ID);
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ""));
  return Number.isFinite(ms) ? ms : null;
}

function effectiveTierFromMemberDoc(doc) {
  const tier = String(doc && doc.tier ? doc.tier : "basic").toLowerCase();
  if (tier !== "pro" && tier !== "ultra") return "basic";
  const expMs = parseIsoMs(doc && doc.expires_at ? doc.expires_at : "");
  if (!Number.isFinite(expMs) || expMs <= Date.now()) return "basic";
  return tier;
}

function headers() {
  return {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function fetchDiscordMember(uid) {
  const r = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${uid}`, {
    method: "GET",
    headers: headers(),
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`discord_get_member_failed:${r.status}:${t}`);
  }
  return r.json();
}

async function addRole(uid, roleId) {
  const r = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${uid}/roles/${roleId}`, {
    method: "PUT",
    headers: headers(),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`discord_add_role_failed:${r.status}:${t}`);
  }
}

async function removeRole(uid, roleId) {
  const r = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${uid}/roles/${roleId}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`discord_remove_role_failed:${r.status}:${t}`);
  }
}

async function syncDiscordRolesForMemberDoc(doc) {
  if (!isSyncEnabled()) return { ok: true, skipped: "disabled" };
  if (!hasDiscordRoleConfig()) return { ok: false, error: "missing_discord_role_env" };
  const uid = String((doc && (doc.discord_user_id || doc._id)) || "").trim();
  if (!uid || !/^\d{6,30}$/.test(uid)) return { ok: true, skipped: "invalid_uid" };

  const target = effectiveTierFromMemberDoc(doc);
  const member = await fetchDiscordMember(uid);
  if (!member) return { ok: true, skipped: "not_in_guild", uid, target };

  const roles = new Set(Array.isArray(member.roles) ? member.roles : []);
  const changed = [];
  if (target === "ultra") {
    if (!roles.has(DISCORD_MEMBER_ULTRA_ID)) {
      await addRole(uid, DISCORD_MEMBER_ULTRA_ID);
      changed.push("add_ultra");
    }
    if (roles.has(DISCORD_MEMBER_PRO_ID)) {
      await removeRole(uid, DISCORD_MEMBER_PRO_ID);
      changed.push("remove_pro");
    }
  } else if (target === "pro") {
    if (!roles.has(DISCORD_MEMBER_PRO_ID)) {
      await addRole(uid, DISCORD_MEMBER_PRO_ID);
      changed.push("add_pro");
    }
    if (roles.has(DISCORD_MEMBER_ULTRA_ID)) {
      await removeRole(uid, DISCORD_MEMBER_ULTRA_ID);
      changed.push("remove_ultra");
    }
  } else {
    if (roles.has(DISCORD_MEMBER_PRO_ID)) {
      await removeRole(uid, DISCORD_MEMBER_PRO_ID);
      changed.push("remove_pro");
    }
    if (roles.has(DISCORD_MEMBER_ULTRA_ID)) {
      await removeRole(uid, DISCORD_MEMBER_ULTRA_ID);
      changed.push("remove_ultra");
    }
  }
  return { ok: true, uid, target, changed };
}

async function syncDiscordRolesForUserId(db, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false, error: "missing_user_id" };
  const doc =
    (await db.collection(MEMBERS_COLLECTION).findOne({ _id: uid })) ||
    (await db.collection(MEMBERS_COLLECTION).findOne({ discord_user_id: uid }));
  if (!doc) return { ok: true, skipped: "member_not_found", uid };
  return syncDiscordRolesForMemberDoc(doc);
}

async function syncDiscordRolesForAllMembers(db, limit = 0) {
  const stats = { total: 0, synced: 0, skipped: 0, errors: 0 };
  const projection = { _id: 1, discord_user_id: 1, tier: 1, expires_at: 1 };
  const cursor = db.collection(MEMBERS_COLLECTION).find({}, { projection });
  if (limit > 0) cursor.limit(limit);
  for await (const doc of cursor) {
    stats.total += 1;
    try {
      const r = await syncDiscordRolesForMemberDoc(doc);
      if (r && r.ok && !r.skipped) stats.synced += 1;
      else stats.skipped += 1;
    } catch {
      stats.errors += 1;
    }
  }
  return stats;
}

module.exports = {
  isSyncEnabled,
  hasDiscordRoleConfig,
  syncDiscordRolesForUserId,
  syncDiscordRolesForAllMembers,
};
