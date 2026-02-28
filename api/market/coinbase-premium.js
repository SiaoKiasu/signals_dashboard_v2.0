const { sendJson, requireApiKey, fetchJson } = require("./_lib");

module.exports = async (_req, res) => {
  try {
    const key = requireApiKey();
    const url = "https://open-api-v4.coinglass.com/api/coinbase-premium-index?interval=1d";
    const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
    const list = Array.isArray(data && data.data) ? data.data : [];
    if (!list.length) {
      sendJson(res, 200, { premium_rate: null });
      return;
    }
    list.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
    const latest = list[list.length - 1];
    sendJson(res, 200, { premium_rate: Number(latest.premium_rate) });
  } catch (e) {
    sendJson(res, 500, { error: "coinbase_premium_failed", detail: String(e && e.message ? e.message : e) });
  }
};
