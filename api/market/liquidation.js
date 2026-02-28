const { sendJson, requireApiKey, fetchJson } = require("./_lib");

const TARGETS = ["All", "Binance", "OKX", "Bybit", "Hyperliquid", "Bitget"];

module.exports = async (_req, res) => {
  try {
    const key = requireApiKey();
    const url = "https://open-api-v4.coinglass.com/api/futures/liquidation/exchange-list?range=1d";
    const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
    const list = Array.isArray(data && data.data) ? data.data : [];
    const rows = [];
    for (const item of list) {
      if (!item || !TARGETS.includes(item.exchange)) continue;
      const total = Number(item.liquidation_usd ?? 0);
      const long = Number(item.longLiquidation_usd ?? item.long_liquidation_usd ?? 0);
      const short = Number(item.shortLiquidation_usd ?? item.short_liquidation_usd ?? 0);
      rows.push({ exchange: item.exchange, total, long, short });
    }
    rows.sort((a, b) => b.total - a.total);
    sendJson(res, 200, {
      exchanges: rows.map((r) => r.exchange),
      long: rows.map((r) => r.long),
      short: rows.map((r) => r.short),
    });
  } catch (e) {
    sendJson(res, 500, { error: "liquidation_failed", detail: String(e && e.message ? e.message : e) });
  }
};
