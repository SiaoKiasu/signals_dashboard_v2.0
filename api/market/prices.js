const { sendJson } = require("./_lib");

async function fetchBinancePrice(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`binance_failed:${r.status}:${t}`);
  }
  const j = await r.json();
  return Number(j.price);
}

module.exports = async (_req, res) => {
  try {
    const [btc, eth, usdc] = await Promise.all([
      fetchBinancePrice("BTCUSDT"),
      fetchBinancePrice("ETHUSDT"),
      fetchBinancePrice("USDCUSDT"),
    ]);
    sendJson(res, 200, { btc, eth, usdc });
  } catch (e) {
    sendJson(res, 500, { error: "prices_failed", detail: String(e && e.message ? e.message : e) });
  }
};
