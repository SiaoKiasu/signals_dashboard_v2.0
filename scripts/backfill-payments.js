const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "signals_dashboard";
const MEMBERS_COLLECTION = process.env.MONGODB_MEMBERS_COLLECTION || "members";
const PAYMENTS_COLLECTION = process.env.MONGODB_PAYMENTS_COLLECTION || "payments";

function isTrue(v) {
  if (typeof v === "boolean") return v;
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function getCliFlag(name) {
  const args = process.argv.slice(2);
  return args.includes(name);
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

async function run() {
  if (!MONGODB_URI) {
    throw new Error("missing_env:MONGODB_URI");
  }
  const dryRun = getCliFlag("--dry-run") || getCliFlag("-n") || isTrue(process.env.DRY_RUN);
  const nowIso = new Date().toISOString();
  const stats = {
    dry_run: dryRun,
    scanned_rows: 0,
    invalid_rows: 0,
    already_exists: 0,
    inserted: 0,
    ownership_conflicts: 0,
  };

  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 5, minPoolSize: 0 });
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
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

    console.log(
      JSON.stringify(
        {
          ok: true,
          stats,
          mongo: {
            db: MONGODB_DB,
            members_collection: MEMBERS_COLLECTION,
            payments_collection: PAYMENTS_COLLECTION,
          },
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
}

run().catch((e) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: "backfill_payments_failed",
        detail: String(e && e.message ? e.message : e),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
