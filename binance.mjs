const required = ["MONITOR_URL", "MONITOR_SECRET", "SITE_BYPASS_TOKEN"];
for (const key of required) if (!process.env[key]) throw new Error(`${key} não configurada`);

const assets = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "LINK", "AVAX", "BCH"];
const scansPerRun = 4;
const intervalMs = 12_000;
const v7Url = new URL("/api/v7", process.env.MONITOR_URL).toString();

async function json(url, retry = true) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RadarArbitragemBinance/7.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429 && retry) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return json(url, false);
  }
  if (!response.ok) throw new Error(`feed respondeu ${response.status}`);
  return response.json();
}

function levels(values) {
  if (!Array.isArray(values)) return [];
  return values.map((level) => [Number(level?.[0]), Number(level?.[1])])
    .filter(([price, size]) => Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0)
    .slice(0, 100);
}

function quote(asset, payload, market, extra = {}) {
  const bids = levels(payload?.bids);
  const asks = levels(payload?.asks);
  if (!bids.length || !asks.length) throw new Error("livro vazio");
  return {
    asset, venue: "Binance", quoteCurrency: "USDT", market,
    bid: bids[0][0], ask: asks[0][0], bidSize: bids[0][1], askSize: asks[0][1],
    bidDepth: bids.reduce((sum, [price, size]) => sum + price * size, 0),
    askDepth: asks.reduce((sum, [price, size]) => sum + price * size, 0),
    capturedAt: new Date().toISOString(), source: "live", ...extra,
  };
}

function realizedVolatilityPct(klines) {
  const closes = Array.isArray(klines) ? klines.map((row) => Number(row?.[4])).filter((value) => value > 0) : [];
  if (closes.length < 3) return undefined;
  const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index]));
  const average = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(288) * 100;
}

async function referenceData() {
  const [tickers, ...perAsset] = await Promise.all([
    json("https://fapi.binance.com/fapi/v1/ticker/24hr"),
    ...assets.flatMap((asset) => [
      json(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${asset}USDT&limit=30`),
      json(`https://fapi.binance.com/fapi/v1/klines?symbol=${asset}USDT&interval=5m&limit=49`),
    ]),
  ]);
  const tickerMap = new Map(tickers.map((item) => [item.symbol, item]));
  const fundingHistory = [];
  const volatility = new Map();
  assets.forEach((asset, index) => {
    const funding = perAsset[index * 2] ?? [];
    const klines = perAsset[index * 2 + 1] ?? [];
    for (const event of funding) fundingHistory.push({
      asset,
      fundingRatePct: Number(event.fundingRate) * 100,
      fundingAt: new Date(Number(event.fundingTime)).toISOString(),
      markPrice: Number(event.markPrice) || undefined,
    });
    volatility.set(asset, realizedVolatilityPct(klines));
  });
  return { tickerMap, fundingHistory, volatility };
}

async function fetchScan(reference) {
  const quotes = [];
  const errors = [];
  const premiumList = await json("https://fapi.binance.com/fapi/v1/premiumIndex");
  const premiumMap = new Map(premiumList.map((item) => [item.symbol, item]));
  const tasks = assets.flatMap((asset) => {
    const symbol = `${asset}USDT`;
    const premium = premiumMap.get(symbol);
    const ticker = reference.tickerMap.get(symbol);
    const common = {
      volume24h: Number(ticker?.quoteVolume) || undefined,
      volatility24hPct: reference.volatility.get(asset),
    };
    return [
      json(`https://data-api.binance.vision/api/v3/depth?symbol=${symbol}&limit=100`)
        .then((book) => quotes.push(quote(asset, book, "Spot", common)))
        .catch((error) => errors.push(`spot ${asset}: ${error.message}`)),
      json(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`)
        .then((book) => quotes.push(quote(asset, book, "Futuro", {
          ...common,
          fundingRatePct: Number(premium?.lastFundingRate ?? 0) * 100,
          nextFundingAt: Number(premium?.nextFundingTime) > 0 ? new Date(Number(premium.nextFundingTime)).toISOString() : undefined,
        })))
        .catch((error) => errors.push(`futuro ${asset}: ${error.message}`)),
    ];
  });
  await Promise.all(tasks);
  return { quotes, errors };
}

async function post(url, body, historyHeader = false) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "OAI-Sites-Authorization": `Bearer ${process.env.SITE_BYPASS_TOKEN}`,
      "x-monitor-secret": process.env.MONITOR_SECRET,
      ...(historyHeader ? { "x-history-sample": "1" } : {}),
      "content-type": "application/json", accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`monitor respondeu ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const reference = await referenceData();
const summary = { version: 7, scans: 0, quoteSnapshots: 0, feedErrors: 0, sampleErrors: [], v7Opportunities: 0, v7Opened: 0 };
for (let index = 0; index < scansPerRun; index += 1) {
  const { quotes, errors } = await fetchScan(reference);
  if (quotes.length < assets.length * 2) throw new Error("dados Binance insuficientes");
  const sampleHistory = index === scansPerRun - 1;
  const [legacy, v7] = await Promise.all([
    post(process.env.MONITOR_URL, { quotes }, sampleHistory),
    post(v7Url, { quotes, fundingHistory: sampleHistory ? reference.fundingHistory : [], sampleHistory }),
  ]);
  summary.scans += 1;
  summary.quoteSnapshots += quotes.length;
  summary.feedErrors += errors.length;
  summary.v7Opportunities = v7.opportunities ?? 0;
  summary.v7Opened += v7.opened ? 1 : 0;
  for (const error of errors) if (summary.sampleErrors.length < 8 && !summary.sampleErrors.includes(error)) summary.sampleErrors.push(error);
  summary.lastLegacyApproved = Boolean(legacy.approved);
  if (index < scansPerRun - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
console.log(JSON.stringify({ event: "binance_v7_burst_complete", ...summary }));
