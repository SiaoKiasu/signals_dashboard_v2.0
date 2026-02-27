const fs = require("fs");
const path = require("path");

const { parseCookies } = require("../_lib/cookies");
const { SESSION_COOKIE, verifySessionToken } = require("../_lib/session");
const { getTier } = require("../_lib/tiers");
const { getMongoDb } = require("../_lib/mongo");

let kv = null;
try {
  ({ kv } = require("@vercel/kv"));
} catch {
  kv = null;
}

const CUTOFF = new Date("2022-11-11T00:00:00Z");
const FORCE_SIGNAL2_TO_5 = new Set(["2026-02-18", "2025-11-17", "2025-03-06"]);
const ALL_SIGNALS = ["signal2", "signal7", "signal9", "signal18"];
const HISTORY_KV_KEY = process.env.HISTORY_KV_KEY || "history:signal_data";
const HISTORY_COLLECTION = process.env.MONGODB_HISTORY_COLLECTION || "portal_data";
const HISTORY_DOC_ID = process.env.MONGODB_HISTORY_DOC_ID || "signal_history";

function parseBasicAllowedSignalsFromEnv() {
  const raw = String(process.env.BASIC_ALLOWED_SIGNALS || "").trim();
  if (!raw) return ["signal2"];

  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const uniq = [];
  const seen = new Set();
  for (const k of list) {
    if (!ALL_SIGNALS.includes(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(k);
  }
  return uniq.length ? uniq : ["signal2"];
}

function normalizeDateKey(dateStr) {
  if (!dateStr) return "";
  const s0 = String(dateStr).trim().split("T")[0].split(" ")[0];
  const s = s0.replaceAll("/", "-");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return s;
  const yyyy = m[1];
  const mm = m[2].padStart(2, "0");
  const dd = m[3].padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeSignalListShape(obj) {
  if (Array.isArray(obj)) return obj;
  const fromData = (((obj || {}).data || {}).signal_list) || null;
  if (Array.isArray(fromData)) return fromData;
  const fromRoot = (obj || {}).signal_list;
  if (Array.isArray(fromRoot)) return fromRoot;
  throw new Error("invalid signal_list");
}

async function loadSignalData() {
  // 1) 优先读 MongoDB Atlas（线上推荐）
  const db = await getMongoDb();
  if (db) {
    const doc = await db.collection(HISTORY_COLLECTION).findOne({ _id: HISTORY_DOC_ID });
    if (doc) {
      return normalizeSignalListShape(doc);
    }
  }

  // 2) 回退读 KV
  if (kv) {
    const kvObj = await kv.get(HISTORY_KV_KEY);
    if (kvObj) {
      return normalizeSignalListShape(kvObj);
    }
  }

  // 3) 回退本地文件（本地开发/应急）
  const p = path.join(process.cwd(), "v1.0", "signal_data.json");
  const raw = fs.readFileSync(p, "utf-8");
  const obj = JSON.parse(raw);
  return normalizeSignalListShape(obj);
}

function pickAllowedSignals(tier) {
  if (tier === "basic") return parseBasicAllowedSignalsFromEnv();
  return ALL_SIGNALS.slice();
}

function pickAllowedKeys(allowedSignals) {
  const out = new Set(["date", "price"]);
  for (const sig of allowedSignals) {
    out.add(sig);
    out.add(sig.replace("signal", "proba"));
  }
  return out;
}

module.exports = async (req, res) => {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "missing_env", need: ["SESSION_SECRET"] }));
    return;
  }

  const cookies = parseCookies(req.headers.cookie || "");
  const tok = cookies[SESSION_COOKIE];
  const payload = tok ? verifySessionToken(tok, sessionSecret) : null;
  if (!payload) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const tier = await getTier(payload.discord_user_id);
  const allowedSignals = pickAllowedSignals(tier);
  const allowed = pickAllowedKeys(allowedSignals);

  try {
    const list = await loadSignalData();

    // preprocess + cutoff
    const out = [];
    for (const item of list) {
      const dateKey = normalizeDateKey(item.date);
      const d = new Date(dateKey);
      if (Number.isNaN(d.getTime())) continue;
      if (d < CUTOFF) continue;

      const cloned = {};
      for (const k of allowed) {
        if (k in item) cloned[k] = item[k];
      }

      // force dates for signal2
      if ("signal2" in cloned && FORCE_SIGNAL2_TO_5.has(dateKey)) {
        cloned.signal2 = 5;
      }

      out.push(cloned);
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        tier,
        allowed_signals: allowedSignals,
        data: { signal_list: out },
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "load_failed", detail: String(e && e.message ? e.message : e) }));
  }
};

