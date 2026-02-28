const { sendJson, requireApiKey, toDateKey, fetchJson } = require("./_lib");

const ETF_SYMBOLS = {
  BTC: "https://open-api-v4.coinglass.com/api/etf/bitcoin/flow-history",
  ETH: "https://open-api-v4.coinglass.com/api/etf/ethereum/flow-history",
  SOL: "https://open-api-v4.coinglass.com/api/etf/solana/flow-history",
  XRP: "https://open-api-v4.coinglass.com/api/etf/xrp/flow-history",
};

const ETF_TICKERS = {
  BTC: ["IBIT", "FBTC", "ARKB", "GBTC"],
  ETH: ["ETHA", "FETH", "ETHW"],
  SOL: ["BSOL", "VSOL", "FSOL"],
  XRP: [],
};

function toDateTimeKey(ts) {
  if (!ts) return "";
  let t = ts;
  if (typeof t === "string") t = Number(t);
  if (typeof t === "number" && t > 1e12) t = t / 1000;
  if (typeof t === "number" && Number.isFinite(t)) {
    const d = new Date(t * 1000);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:00`;
  }
  return String(ts);
}

let cachedPrices = null;
let cachedPricesAt = 0;

async function getPrices() {
  try {
    const url =
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,dogecoin&vs_currencies=usd";
    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`coingecko_failed:${r.status}:${t}`);
    }
    const j = await r.json();
    const out = {
      btc: Number(j.bitcoin && j.bitcoin.usd),
      eth: Number(j.ethereum && j.ethereum.usd),
      doge: Number(j.dogecoin && j.dogecoin.usd),
    };
    if (Number.isFinite(out.btc) || Number.isFinite(out.eth) || Number.isFinite(out.doge)) {
      cachedPrices = out;
      cachedPricesAt = Date.now();
    }
    return out;
  } catch {
    if (cachedPrices && Date.now() - cachedPricesAt < 2 * 60 * 1000) {
      return cachedPrices;
    }
    return { btc: null, eth: null, doge: null };
  }
}

async function getCoinbasePremium(key) {
  const url = "https://open-api-v4.coinglass.com/api/coinbase-premium-index?interval=1d";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const list = Array.isArray(data && data.data) ? data.data : [];
  if (!list.length) return { premium_rate: null };
  list.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
  const latest = list[list.length - 1];
  const raw = Number(latest.premium_rate);
  const premiumRate = Number.isFinite(raw) ? raw / 100 : null;
  return { premium_rate: premiumRate };
}

async function getOi(key) {
  const url =
    "https://open-api-v4.coinglass.com/api/futures/open-interest/aggregated-history?symbol=BTC&interval=1d";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const list = Array.isArray(data && data.data) ? data.data : [];
  const dates = [];
  const values = [];
  for (const item of list) {
    if (!item) continue;
    const d = toDateTimeKey(item.time || item.date || item.timestamp || item.t);
    if (!d) continue;
    const v = Number(item.close ?? item.openInterest ?? item.value ?? item.oi ?? item.open ?? 0);
    dates.push(d);
    values.push(Number.isFinite(v) ? v : 0);
  }
  return { dates, values };
}

async function getFunding(key) {
  const url =
    "https://open-api-v4.coinglass.com/api/futures/funding-rate/history?exchange=Binance&symbol=BTCUSDT&interval=4h";
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
    const val = Number.isFinite(v) ? v / 100 : 0;
    dates.push(d);
    values.push(val);
  }
  return { dates, values };
}

async function getLiquidation(key) {
  const url = "https://open-api-v4.coinglass.com/api/futures/liquidation/exchange-list?range=1d";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const list = Array.isArray(data && data.data) ? data.data : [];
  const TARGETS = ["All", "Binance", "OKX", "Bybit", "Hyperliquid", "Bitget"];
  const rows = [];
  for (const item of list) {
    if (!item || !TARGETS.includes(item.exchange)) continue;
    const total = Number(item.liquidation_usd ?? 0);
    const long = Number(item.longLiquidation_usd ?? item.long_liquidation_usd ?? 0);
    const short = Number(item.shortLiquidation_usd ?? item.short_liquidation_usd ?? 0);
    rows.push({ exchange: item.exchange, total, long, short });
  }
  rows.sort((a, b) => b.total - a.total);
  return {
    exchanges: rows.map((r) => r.exchange),
    long: rows.map((r) => r.long),
    short: rows.map((r) => r.short),
  };
}

async function getEtf(key) {
  const out = {};
  for (const [symbol, url] of Object.entries(ETF_SYMBOLS)) {
    const tickers = ETF_TICKERS[symbol] || [];
    const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
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
    out[symbol] = { dates, total, detail, others, tickers };
  }
  return out;
}

async function getExchangeBalance(key) {
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
  return { dates, total, prices };
}

async function getFearGreed(key) {
  const url = "https://open-api-v4.coinglass.com/api/index/fear-greed-history";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const payload = data && data.data ? data.data : {};
  const times = Array.isArray(payload.time_list) ? payload.time_list : [];
  const values = Array.isArray(payload.data_list) ? payload.data_list : [];
  const prices = Array.isArray(payload.price_list) ? payload.price_list : [];
  const dates = [];
  const series = [];
  const priceSeries = [];
  let latest = null;
  let latestTime = null;
  for (let i = 0; i < times.length; i += 1) {
    const t = Number(times[i] || 0);
    const v = Number(values[i]);
    const p = Number(prices[i]);
    const d = toDateKey(t);
    if (d) {
      dates.push(d);
      series.push(Number.isFinite(v) ? v : 0);
      priceSeries.push(Number.isFinite(p) ? p : 0);
    }
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    if (latestTime == null || t > latestTime) {
      latestTime = t;
      latest = v;
    }
  }
  return { value: latest, time: latestTime, dates, values: series, prices: priceSeries };
}

async function getBtcDominance(key) {
  const url = "https://open-api-v4.coinglass.com/api/index/bitcoin-dominance";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const list = Array.isArray(data && data.data) ? data.data : [];
  let latest = null;
  let latestTime = null;
  for (const item of list) {
    if (!item) continue;
    const t = Number(item.timestamp || 0);
    const v = Number(item.bitcoin_dominance);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    if (latestTime == null || t > latestTime) {
      latestTime = t;
      latest = v;
    }
  }
  return { value: latest, time: latestTime };
}

module.exports = async (req, res) => {
  try {
    const key = requireApiKey();
    const urlObj = new URL(req.url, "http://localhost");
    const scope = String(urlObj.searchParams.get("scope") || "all");

    if (scope === "prices") {
      const [pricesRes, premiumRes] = await Promise.allSettled([getPrices(), getCoinbasePremium(key)]);
      const prices = pricesRes.status === "fulfilled" ? pricesRes.value : { btc: null, eth: null, doge: null };
      const premium = premiumRes.status === "fulfilled" ? premiumRes.value : { premium_rate: null };
      sendJson(res, 200, { prices, premium });
      return;
    }

    const results = await Promise.allSettled([
      getPrices(),
      getCoinbasePremium(key),
      getOi(key),
      getFunding(key),
      getLiquidation(key),
      getEtf(key),
      getExchangeBalance(key),
      getFearGreed(key),
      getBtcDominance(key),
    ]);

    const [
      pricesRes,
      premiumRes,
      oiRes,
      fundingRes,
      liquidationRes,
      etfRes,
      exchangeBalanceRes,
      fearGreedRes,
      btcDominanceRes,
    ] = results;

    const prices = pricesRes.status === "fulfilled" ? pricesRes.value : { btc: null, eth: null, doge: null };
    const premium = premiumRes.status === "fulfilled" ? premiumRes.value : { premium_rate: null };
    const oi = oiRes.status === "fulfilled" ? oiRes.value : { dates: [], values: [] };
    const funding = fundingRes.status === "fulfilled" ? fundingRes.value : { dates: [], values: [] };
    const liquidation =
      liquidationRes.status === "fulfilled" ? liquidationRes.value : { exchanges: [], long: [], short: [] };
    const etf = etfRes.status === "fulfilled" ? etfRes.value : {};
    const exchangeBalance =
      exchangeBalanceRes.status === "fulfilled" ? exchangeBalanceRes.value : { dates: [], total: [], prices: [] };
    const fearGreed = fearGreedRes.status === "fulfilled" ? fearGreedRes.value : { value: null, time: null };
    const btcDominance =
      btcDominanceRes.status === "fulfilled" ? btcDominanceRes.value : { value: null, time: null };

    sendJson(res, 200, { prices, premium, oi, funding, liquidation, etf, exchangeBalance, fearGreed, btcDominance });
  } catch (e) {
    sendJson(res, 500, { error: "market_summary_failed", detail: String(e && e.message ? e.message : e) });
  }
};
