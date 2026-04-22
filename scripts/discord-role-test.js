const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "SL_Bro";
const MEMBERS_COLLECTION = process.env.MONGODB_MEMBERS_COLLECTION || "members";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const DISCORD_MEMBER_PRO_ID = process.env.DISCORD_MEMBER_PRO_ID || "";
const DISCORD_MEMBER_ULTRA_ID = process.env.DISCORD_MEMBER_ULTRA_ID || "";

const API_BASE = "https://discord.com/api/v10";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { userId: "", add: "", remove: "", sync: false, clear: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!out.userId && /^\d{6,30}$/.test(a)) {
      out.userId = a;
      continue;
    }
    if (a === "--add") {
      out.add = String(args[i + 1] || "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (a === "--remove") {
      out.remove = String(args[i + 1] || "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (a === "--sync") {
      out.sync = true;
    }
    if (a === "--clear") {
      out.clear = true;
    }
  }
  return out;
}

function roleIdByName(name) {
  if (name === "pro") return DISCORD_MEMBER_PRO_ID;
  if (name === "ultra") return DISCORD_MEMBER_ULTRA_ID;
  return "";
}

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ""));
  return Number.isFinite(ms) ? ms : null;
}

function effectiveTier(doc) {
  const tier = String(doc && doc.tier ? doc.tier : "basic").toLowerCase();
  if (tier !== "pro" && tier !== "ultra") return "basic";
  const expMs = parseIsoMs(doc && doc.expires_at);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) return "basic";
  return tier;
}

function discordHeaders() {
  return {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function getDiscordMember(userId) {
  const r = await fetch(`${API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${userId}`, {
    method: "GET",
    headers: discordHeaders(),
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`discord_get_member_failed:${r.status}:${t}`);
  }
  return r.json();
}

async function addRole(userId, roleId) {
  const r = await fetch(`${API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
    headers: discordHeaders(),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`discord_add_role_failed:${r.status}:${t}`);
  }
}

async function removeRole(userId, roleId) {
  const r = await fetch(`${API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`, {
    method: "DELETE",
    headers: discordHeaders(),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`discord_remove_role_failed:${r.status}:${t}`);
  }
}

async function run() {
  const { userId, add, remove, sync, clear } = parseArgs();
  if (!userId) {
    throw new Error(
      "usage: node scripts/discord-role-test.js <discord_user_id> [--add pro|ultra] [--remove pro|ultra] [--sync] [--clear]"
    );
  }
  if (!MONGODB_URI) throw new Error("missing_env:MONGODB_URI");
  if (!DISCORD_BOT_TOKEN) throw new Error("missing_env:DISCORD_BOT_TOKEN");
  if (!DISCORD_GUILD_ID) throw new Error("missing_env:DISCORD_GUILD_ID");
  if (!DISCORD_MEMBER_PRO_ID || !DISCORD_MEMBER_ULTRA_ID) {
    throw new Error("missing_env:DISCORD_MEMBER_PRO_ID or DISCORD_MEMBER_ULTRA_ID");
  }

  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 5, minPoolSize: 0 });
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const doc =
      (await db.collection(MEMBERS_COLLECTION).findOne({ _id: userId })) ||
      (await db.collection(MEMBERS_COLLECTION).findOne({ discord_user_id: userId }));
    const tier = effectiveTier(doc || {});

    const before = await getDiscordMember(userId);
    const beforeRoles = before && Array.isArray(before.roles) ? before.roles : [];
    const ops = [];

    if (add) {
      const roleId = roleIdByName(add);
      if (!roleId) throw new Error("invalid_add_role: use pro|ultra");
      await addRole(userId, roleId);
      ops.push({ action: "add", role: add, role_id: roleId, ok: true });
    }
    if (remove) {
      const roleId = roleIdByName(remove);
      if (!roleId) throw new Error("invalid_remove_role: use pro|ultra");
      await removeRole(userId, roleId);
      ops.push({ action: "remove", role: remove, role_id: roleId, ok: true });
    }
    if (sync) {
      if (tier === "ultra") {
        await addRole(userId, DISCORD_MEMBER_ULTRA_ID);
        await removeRole(userId, DISCORD_MEMBER_PRO_ID);
        ops.push({ action: "sync", target: "ultra", ok: true });
      } else if (tier === "pro") {
        await addRole(userId, DISCORD_MEMBER_PRO_ID);
        await removeRole(userId, DISCORD_MEMBER_ULTRA_ID);
        ops.push({ action: "sync", target: "pro", ok: true });
      } else {
        await removeRole(userId, DISCORD_MEMBER_PRO_ID);
        await removeRole(userId, DISCORD_MEMBER_ULTRA_ID);
        ops.push({ action: "sync", target: "basic", ok: true });
      }
    }
    if (clear) {
      await removeRole(userId, DISCORD_MEMBER_PRO_ID);
      await removeRole(userId, DISCORD_MEMBER_ULTRA_ID);
      ops.push({ action: "clear", target: "remove_pro_and_ultra", ok: true });
    }

    const after = await getDiscordMember(userId);
    const afterRoles = after && Array.isArray(after.roles) ? after.roles : [];

    const out = {
      ok: true,
      input: { user_id: userId, add: add || null, remove: remove || null, sync, clear },
      db_membership: doc
        ? {
            note: doc.note || null,
            tier_raw: doc.tier || "basic",
            expires_at: doc.expires_at || null,
            effective_tier: tier,
          }
        : null,
      discord: {
        in_guild: !!after,
        before: {
          has_pro: beforeRoles.includes(DISCORD_MEMBER_PRO_ID),
          has_ultra: beforeRoles.includes(DISCORD_MEMBER_ULTRA_ID),
          role_count: beforeRoles.length,
        },
        after: {
          has_pro: afterRoles.includes(DISCORD_MEMBER_PRO_ID),
          has_ultra: afterRoles.includes(DISCORD_MEMBER_ULTRA_ID),
          role_count: afterRoles.length,
        },
      },
      operations: ops,
    };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await client.close();
  }
}

run().catch((e) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(e && e.message ? e.message : e),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
