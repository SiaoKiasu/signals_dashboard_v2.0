const { sendJson, requireApiKey, toDateKey, fetchJson } = require("./_lib");

module.exports = async (_req, res) => {
  try {
    const key = requireApiKey();
    const url =
      "https://open-api-v4.coinglass.com/api/futures/funding-rate/history?exchange=Binance&symbol=BTCUSDT&interval=1d";
    const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
    const list = Array.isArray(data && data.data) ? data.data : [];
    const dates = [];
    const values = [];
    for (const item of list) {
      if (!item) continue;
      const d = toDateKey(item.time || item.date || item.timestamp || item.t);
      if (!d) continue;
      const v = Number(
        item.fundingRate ??
          item.funding_rate ??
          item.rate ??
          item.value ??
          item.close ??
          item.open ??
          0
      );
      dates.push(d);
      values.push(Number.isFinite(v) ? v : 0);
    }
    sendJson(res, 200, { dates, values });
  } catch (e) {
    sendJson(res, 500, { error: "funding_failed", detail: String(e && e.message ? e.message : e) });
  }
};
