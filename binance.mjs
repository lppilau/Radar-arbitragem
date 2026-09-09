const required = ["MONITOR_URL", "MONITOR_SECRET", "SITE_BYPASS_TOKEN"];
for (const key of required) if (!process.env[key]) throw new Error(`${key} não configurada`);

const assets = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "LINK", "AVAX", "BCH", "PAXG"];
const futuresAssets = assets.filter((asset) => asset !== "PAXG");
const scansPerRun = 8;
const intervalMs = 5_000;

async function json(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RadarArbitragemBinance/1.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`feed respondeu ${response.status}`);
  return response.json();
}

function levels(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((level) => [Number(level?.[0]), Number(level?.[1])])
    .filter(([price, size]) => Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0)
    .slice(0, 10);
}

function quote(asset, payload, market = "Spot", fundingRatePct) {
  const bids = levels(payload?.bids);
  const asks = levels(payload?.asks);
  if (!bids.length || !asks.length) throw new Error("livro vazio");
  return {
    asset, venue: "Binance", quoteCurrency: "USDT", market,
    bid: bids[0][0], ask: asks[0][0], bidSize: bids[0][1], askSize: asks[0][1],
    bidDepth: bids.reduce((sum, [price, size]) => sum + price * size, 0),
    askDepth: asks.reduce((sum, [price, size]) => sum + price * size, 0),
    ...(Number.isFinite(fundingRatePct) ? { fundingRatePct } : {}),
    source: "live",
  };
}

async function fetchScan() {
  const quotes = [];
  const errors = [];
  const tasks = [];
  for (const asset of assets) {
    tasks.push(
      json(`https://data-api.binance.vision/api/v3/depth?symbol=${asset}USDT&limit=10`)
        .then((book) => quotes.push(quote(asset, book)))
        .catch((error) => errors.push(`spot ${asset}: ${error.message}`)),
    );
    if (futuresAssets.includes(asset)) tasks.push(
      Promise.all([
        json(`https://fapi.binance.com/fapi/v1/depth?symbol=${asset}USDT&limit=10`),
        json(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${asset}USDT`),
      ])
        .then(([book, premium]) => quotes.push(quote(asset, book, "Futuro", Number(premium?.lastFundingRate ?? 0) * 100)))
        .catch((error) => errors.push(`futuro ${asset}: ${error.message}`)),
    );
  }
  await Promise.all(tasks);
  return { quotes, errors };
}

async function sendScan(quotes, recordHistory) {
  if (quotes.length < 2) throw new Error("dados Binance insuficientes");
  const response = await fetch(process.env.MONITOR_URL, {
    method: "POST",
    headers: {
      "OAI-Sites-Authorization": `Bearer ${process.env.SITE_BYPASS_TOKEN}`,
      "x-monitor-secret": process.env.MONITOR_SECRET,
      ...(recordHistory ? { "x-history-sample": "1" } : {}),
      "content-type": "application/json", accept: "application/json",
    },
    body: JSON.stringify({ quotes }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`monitor respondeu ${response.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

const summary = { scans: 0, quoteSnapshots: 0, feedErrors: 0, sampleErrors: [], approved: 0, lastResult: null };
for (let index = 0; index < scansPerRun; index += 1) {
  const { quotes, errors } = await fetchScan();
  const result = await sendScan(quotes, index === scansPerRun - 1);
  summary.scans += 1;
  summary.quoteSnapshots += quotes.length;
  summary.feedErrors += errors.length;
  for (const error of errors) if (summary.sampleErrors.length < 8 && !summary.sampleErrors.includes(error)) summary.sampleErrors.push(error);
  summary.approved += result.approved ? 1 : 0;
  summary.lastResult = result;
  if (index < scansPerRun - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

console.log(JSON.stringify({ event: "binance_futures_burst_complete", ...summary }));
