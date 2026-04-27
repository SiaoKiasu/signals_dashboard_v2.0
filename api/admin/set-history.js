const { getMongoDb } = require("../_lib/mongo");
const { syncDiscordRolesForAllMembers, isSyncEnabled } = require("../_lib/discordRoles");

const HISTORY_COLLECTION = process.env.MONGODB_HISTORY_COLLECTION || "portal_data";
const HISTORY_DOC_ID = process.env.MONGODB_HISTORY_DOC_ID || "signal_history";

function normalizeSignalListShape(obj) {
  if (Array.isArray(obj)) return obj;
  const fromData = (((obj || {}).data || {}).signal_list) || null;
  if (Array.isArray(fromData)) return fromData;
  const fromRoot = (obj || {}).signal_list;
  if (Array.isArray(fromRoot)) return fromRoot;
  throw new Error("invalid_signal_list_shape");
}

module.exports = async (req, res) => {
  const db = await getMongoDb();
  if (!db) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "missing_storage", detail: "请配置 MongoDB Atlas" }));
    return;
  }

  if (req.method === "GET") {
    const cronSecret = process.env.CRON_SECRET || "";
    if (!cronSecret) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "missing_env", need: ["CRON_SECRET"] }));
      return;
    }
    const provided =
      String(req.headers["x-cron-secret"] || "").trim() ||
      String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (provided !== cronSecret) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    const tasks = {};
    if (!isSyncEnabled()) {
      tasks.discord_role_sync = { ok: true, skipped: "sync_disabled" };
    } else {
      const stats = await syncDiscordRolesForAllMembers(db, 0);
      tasks.discord_role_sync = { ok: true, stats };
    }
    tasks.binance_account_snapshot = { ok: true, skipped: "use_local_sync_script" };
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, task: "maintenance", tasks }));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return;
  }

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "missing_env", need: ["ADMIN_SECRET"] }));
    return;
  }
  const provided = (req.headers["x-admin-secret"] || "").toString();
  if (provided !== adminSecret) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let obj;
    try {
      obj = JSON.parse(body || "{}");
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }

    let list;
    try {
      list = normalizeSignalListShape(obj);
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "invalid_payload", detail: String(e && e.message ? e.message : e) }));
      return;
    }

    try {
      const payload = {
        data: { signal_list: list },
        updated_at: new Date().toISOString(),
      };

      await db
        .collection(HISTORY_COLLECTION)
        .updateOne({ _id: HISTORY_DOC_ID }, { $set: payload }, { upsert: true });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          rows: list.length,
          mongo: { collection: HISTORY_COLLECTION, doc_id: HISTORY_DOC_ID },
        })
      );
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "set_history_failed", detail: String(e && e.message ? e.message : e) }));
    }
  });
};

