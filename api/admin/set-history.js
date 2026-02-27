let kv = null;
try {
  ({ kv } = require("@vercel/kv"));
} catch {
  kv = null;
}
const { getMongoDb } = require("../_lib/mongo");

const HISTORY_KV_KEY = process.env.HISTORY_KV_KEY || "history:signal_data";
const HISTORY_COLLECTION = process.env.MONGODB_HISTORY_COLLECTION || "portal_data";
const HISTORY_DOC_ID = process.env.MONGODB_HISTORY_DOC_ID || "signal_history";
const KV_ENABLED = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

function normalizeSignalListShape(obj) {
  if (Array.isArray(obj)) return obj;
  const fromData = (((obj || {}).data || {}).signal_list) || null;
  if (Array.isArray(fromData)) return fromData;
  const fromRoot = (obj || {}).signal_list;
  if (Array.isArray(fromRoot)) return fromRoot;
  throw new Error("invalid_signal_list_shape");
}

module.exports = async (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "missing_env", need: ["ADMIN_SECRET"] }));
    return;
  }
  const db = await getMongoDb();
  if (!db && !(kv && KV_ENABLED)) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "missing_storage", detail: "请配置 MongoDB Atlas 或连接 Vercel KV" }));
    return;
  }

  const provided = (req.headers["x-admin-secret"] || "").toString();
  if (provided !== adminSecret) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
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

      const targets = [];
      if (db) {
        await db
          .collection(HISTORY_COLLECTION)
          .updateOne({ _id: HISTORY_DOC_ID }, { $set: payload }, { upsert: true });
        targets.push("mongo");
      }
      if (kv && KV_ENABLED) {
        try {
          await kv.set(HISTORY_KV_KEY, payload);
          targets.push("kv");
        } catch {
          // Mongo is primary; ignore KV sync errors.
        }
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          rows: list.length,
          targets,
          mongo: { collection: HISTORY_COLLECTION, doc_id: HISTORY_DOC_ID },
          kv: { key: HISTORY_KV_KEY },
        })
      );
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "set_history_failed", detail: String(e && e.message ? e.message : e) }));
    }
  });
};

