const { sendJson, requireApiKey, toDateKey, fetchJson } = require("./_lib");

module.exports = async (_req, res) => {
  try {
    const key = requireApiKey();
    const url = "https://open-api-v4.coinglass.com/api/exchange/balance/chart?symbol=BTC";
    const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
    const payload = data && data.data ? data.data : {};
    const timeList = Array.isArray(payload.time_list) ? payload.time_list : [];
    const priceList = Array.isArray(payload.price_list) ? payload.price_list : [];
    const dataMap = payload.data_map || {};

    const dates = timeList.map((t) => toDateKey(t));
    const total = new Array(dates.length).fill(0);
    for (const arr of Object.values(dataMap)) {
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < total.length; i += 1) {
        const v = Number(arr[i] ?? 0);
        total[i] += Number.isFinite(v) ? v : 0;
      }
    }
    const prices = priceList.map((p) => (Number.isFinite(Number(p)) ? Number(p) : 0));
    if (prices.length < total.length) {
      prices.push(...new Array(total.length - prices.length).fill(0));
    }
    sendJson(res, 200, { dates, total, prices });
  } catch (e) {
    sendJson(res, 500, { error: "exchange_balance_failed", detail: String(e && e.message ? e.message : e) });
  }
};
