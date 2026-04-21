const { getMongoDb } = require("../_lib/mongo");

const MEMBERS_COLLECTION = process.env.MONGODB_MEMBERS_COLLECTION || "members";
const PAYMENTS_COLLECTION = process.env.MONGODB_PAYMENTS_COLLECTION || "payments";

function isTrue(v) {
  if (typeof v === "boolean") return v;
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function normTxHash(v) {
  return String(v || "").trim().toLowerCase();
}

function normNetwork(v) {
  return String(v || "").trim().toLowerCase();
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildPaymentId(network, txHash) {
  return `${network}:${txHash}`;
}

module.exports = async (req, res) => {
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
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  const db = await getMongoDb();
  if (!db) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "missing_mongodb" }));
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

    const dryRun = isTrue(obj.dry_run);
    const nowIso = new Date().toISOString();
    const stats = {
      dry_run: dryRun,
      scanned_rows: 0,
      invalid_rows: 0,
      already_exists: 0,
      inserted: 0,
      ownership_conflicts: 0,
      errors: 0,
    };

    try {
      const cursor = db.collection(MEMBERS_COLLECTION).aggregate([
        { $match: { payment_history: { $type: "array", $ne: [] } } },
        { $unwind: "$payment_history" },
        { $project: { _id: 1, discord_user_id: 1, payment_history: 1 } },
      ]);

      for await (const row of cursor) {
        stats.scanned_rows += 1;
        const item = row && row.payment_history ? row.payment_history : null;
        const network = normNetwork(item && item.network);
        const txHash = normTxHash(item && item.tx_hash);
        if (!network || !/^0x[a-f0-9]{64}$/.test(txHash)) {
          stats.invalid_rows += 1;
          continue;
        }

        const memberId = String(row && (row._id || row.discord_user_id) ? row._id || row.discord_user_id : "");
        const paymentId = buildPaymentId(network, txHash);
        const baseDoc = {
          _id: paymentId,
          network,
          tx_hash: txHash,
          discord_user_id: memberId,
          plan: String(item && item.plan ? item.plan : "").trim(),
          tx_from: item && item.tx_from ? item.tx_from : null,
          tx_to: item && item.tx_to ? item.tx_to : null,
          token: item && item.token ? item.token : null,
          token_address: item && item.token_address ? item.token_address : null,
          amount: toNumber(item && item.amount),
          amount_usd: toNumber(item && item.amount_usd),
          price_usd: toNumber(item && item.price_usd),
          status: "completed",
          created_at: item && item.created_at ? String(item.created_at) : nowIso,
          completed_at: item && item.created_at ? String(item.created_at) : nowIso,
          backfilled_at: nowIso,
          source: "backfill_members_payment_history",
        };

        if (dryRun) {
          const existed = await db.collection(PAYMENTS_COLLECTION).findOne(
            { _id: paymentId },
            { projection: { _id: 1, discord_user_id: 1 } }
          );
          if (existed) {
            stats.already_exists += 1;
            if (String(existed.discord_user_id || "") !== memberId) {
              stats.ownership_conflicts += 1;
            }
          } else {
            stats.inserted += 1;
          }
          continue;
        }

        const result = await db.collection(PAYMENTS_COLLECTION).updateOne(
          { _id: paymentId },
          { $setOnInsert: baseDoc },
          { upsert: true }
        );
        if (result && result.upsertedCount === 1) {
          stats.inserted += 1;
        } else {
          stats.already_exists += 1;
          const existed = await db.collection(PAYMENTS_COLLECTION).findOne(
            { _id: paymentId },
            { projection: { _id: 1, discord_user_id: 1 } }
          );
          if (existed && String(existed.discord_user_id || "") !== memberId) {
            stats.ownership_conflicts += 1;
          }
        }
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          stats,
          mongo: {
            members_collection: MEMBERS_COLLECTION,
            payments_collection: PAYMENTS_COLLECTION,
          },
        })
      );
    } catch (e) {
      stats.errors += 1;
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "backfill_payments_failed",
          detail: String(e && e.message ? e.message : e),
          stats,
        })
      );
    }
  });
};
