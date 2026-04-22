function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function requireApiKey() {
  const key = process.env.COINGLASS_API_KEY || "";
  if (!key) throw new Error("missing_env:COINGLASS_API_KEY");
  return key;
}

function toDateKey(ts) {
  if (!ts) return "";
  let t = ts;
  if (typeof t === "string") t = Number(t);
  if (typeof t === "number" && t > 1e12) t = t / 1000;
  if (typeof t === "number" && Number.isFinite(t)) {
    const d = new Date(t * 1000);
    return d.toISOString().slice(0, 10);
  }
  return String(ts);
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`coinglass_failed:${r.status}:${t}`);
  }
  return await r.json();
}

module.exports = { sendJson, requireApiKey, toDateKey, fetchJson };
