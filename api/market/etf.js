const { sendJson, requireApiKey, toDateKey, fetchJson } = require("./_lib");

const SYMBOLS = {
  BTC: "https://open-api-v4.coinglass.com/api/etf/bitcoin/flow-history",
  ETH: "https://open-api-v4.coinglass.com/api/etf/ethereum/flow-history",
  SOL: "https://open-api-v4.coinglass.com/api/etf/solana/flow-history",
  XRP: "https://open-api-v4.coinglass.com/api/etf/xrp/flow-history",
};

const TICKERS = {
  BTC: ["IBIT", "FBTC", "ARKB", "GBTC"],
  ETH: ["ETHA", "FETH", "ETHW"],
  SOL: ["BSOL", "VSOL", "FSOL"],
  XRP: [],
};

module.exports = async (req, res) => {
  try {
    const key = requireApiKey();
    const urlObj = new URL(req.url, "http://localhost");
    const symbol = String(urlObj.searchParams.get("symbol") || "BTC").toUpperCase();
    const apiUrl = SYMBOLS[symbol] || SYMBOLS.BTC;
    const tickers = TICKERS[symbol] || [];

    const data = await fetchJson(apiUrl, { "CG-API-KEY": key, accept: "application/json" });
    const list = Array.isArray(data && data.data) ? data.data : [];
    const dates = [];
    const total = [];
    const detail = {};
    for (const t of tickers) detail[t] = [];
    const others = [];

    for (const item of list) {
      if (!item) continue;
      const d = toDateKey(item.timestamp);
      if (!d) continue;
      dates.push(d);
      const flows = Array.isArray(item.etf_flows) ? item.etf_flows : [];
      const map = {};
      for (const f of flows) {
        if (!f) continue;
        const tk = f.etf_ticker;
        if (!tk) continue;
        map[tk] = Number(f.flow_usd ?? 0);
      }
      const dayTotal = Object.values(map).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      let tracked = 0;
      for (const t of tickers) {
        const v = Number(map[t] ?? 0);
        detail[t].push(Number.isFinite(v) ? v : 0);
        tracked += Number.isFinite(v) ? v : 0;
      }
      total.push(dayTotal);
      others.push(dayTotal - tracked);
    }

    sendJson(res, 200, { symbol, dates, total, detail, others, tickers });
  } catch (e) {
    sendJson(res, 500, { error: "etf_failed", detail: String(e && e.message ? e.message : e) });
  }
};
