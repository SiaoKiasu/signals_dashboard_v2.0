const fs = require("fs");
const path = require("path");

const { parseCookies } = require("../_lib/cookies");
const { SESSION_COOKIE, verifySessionToken } = require("../_lib/session");
const { getTier } = require("../_lib/tiers");

const CUTOFF = new Date("2022-11-11T00:00:00Z");
const FORCE_SIGNAL2_TO_5 = new Set(["2026-02-18", "2025-11-17", "2025-03-06"]);

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

function loadSignalData() {
  const p = path.join(process.cwd(), "v1.0", "signal_data.json");
  const raw = fs.readFileSync(p, "utf-8");
  const obj = JSON.parse(raw);
  const lst = (((obj || {}).data || {}).signal_list) || [];
  if (!Array.isArray(lst)) throw new Error("invalid signal_list");
  return lst;
}

function pickAllowedKeys(tier) {
  // basic：只看 signal2（CrashRF_DOWN）
  if (tier === "basic") {
    return new Set(["date", "price", "signal2", "proba2"]);
  }
  // pro：全开
  return new Set(["date", "price", "signal2", "proba2", "signal7", "signal9", "signal18", "proba7", "proba9", "proba18"]);
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
  const allowed = pickAllowedKeys(tier);

  try {
    const list = loadSignalData();

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
        data: { signal_list: out },
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "load_failed", detail: String(e && e.message ? e.message : e) }));
  }
};

