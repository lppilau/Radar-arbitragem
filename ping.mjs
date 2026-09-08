const required = ["MONITOR_URL", "MONITOR_SECRET", "SITE_BYPASS_TOKEN"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} não configurada`);
}

const assets = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "LINK", "AVAX", "BCH", "USDT", "USDC"];
const futuresAssets = assets.filter((asset) => !["USDT", "USDC"].includes(asset));
const krakenSymbols = { BTC: "XBT", DOGE: "XDG" };
const scansPerRun = 8;
const intervalMs = 5_000;

async function json(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RadarArbitragemPaper/5.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`feed respondeu ${response.status}`);
  const payload = await response.json();
  if (payload?.retCode && payload.retCode !== 0) throw new Error(payload.retMsg ?? `feed retornou ${payload.retCode}`);
  return payload;
}

function levels(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((level) => Array.isArray(level)
      ? [Number(level[0]), Number(level[1])]
      : [Number(level?.price ?? level?.unit_price), Number(level?.amount ?? level?.quantity)])
    .filter(([price, size]) => Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0)
    .slice(0, 10);
}

function quote(asset, venue, quoteCurrency, payload, market = "Spot", fundingRatePct) {
  const bids = levels(payload?.bids ?? payload?.b);
  const asks = levels(payload?.asks ?? payload?.a);
  if (!bids.length || !asks.length) throw new Error("livro vazio");
  return {
    asset,
    venue,
    quoteCurrency,
    market,
    bid: bids[0][0],
    ask: asks[0][0],
    bidSize: bids[0][1],
    askSize: asks[0][1],
    bidDepth: bids.reduce((sum, [price, size]) => sum + price * size, 0),
    askDepth: asks.reduce((sum, [price, size]) => sum + price * size, 0),
    ...(Number.isFinite(fundingRatePct) ? { fundingRatePct } : {}),
    source: "live",
  };
}

function normalizeBybit(quotes) {
  const anchors = quotes
    .filter((item) => item.asset === "USDT" && item.quoteCurrency === "USD" && item.market === "Spot")
    .map((item) => (item.bid + item.ask) / 2)
    .sort((a, b) => a - b);
  const usdtUsd = anchors.length ? anchors[Math.floor(anchors.length / 2)] : 1;
  for (const item of quotes.filter((entry) => entry.venue === "Bybit" && entry.quoteCurrency === "USDT")) {
    item.bid *= usdtUsd;
    item.ask *= usdtUsd;
    item.bidDepth *= usdtUsd;
    item.askDepth *= usdtUsd;
    item.quoteCurrency = "USD";
  }
}

async function fetchScan() {
  const quotes = [];
  const errors = [];
  const tasks = [];

  for (const asset of assets) {
    tasks.push(
      json(`https://api.exchange.coinbase.com/products/${asset}-USD/book?level=2`)
        .then((book) => quotes.push(quote(asset, "Coinbase", "USD", book)))
        .catch((error) => errors.push(`Coinbase ${asset}: ${error.message}`)),
    );

    const krakenPair = `${krakenSymbols[asset] ?? asset}USD`;
    tasks.push(
      json(`https://api.kraken.com/0/public/Depth?pair=${krakenPair}&count=10`)
        .then((payload) => {
          const book = Object.values(payload.result ?? {})[0];
          quotes.push(quote(asset, "Kraken", "USD", book));
        })
        .catch((error) => errors.push(`Kraken ${asset}: ${error.message}`)),
    );

    tasks.push(
      json(`https://api.mercadobitcoin.net/api/v4/${asset}-BRL/orderbook?limit=10`)
        .then((book) => quotes.push(quote(asset, "Mercado Bitcoin", "BRL", book)))
        .catch((error) => errors.push(`Mercado Bitcoin ${asset}: ${error.message}`)),
    );

    if (asset !== "USDT") {
      tasks.push(
        json(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${asset}USDT&limit=10`)
          .then((payload) => quotes.push(quote(asset, "Bybit", "USDT", payload.result)))
          .catch((error) => errors.push(`Bybit spot ${asset}: ${error.message}`)),
      );
    }
  }

  for (const asset of futuresAssets) {
    tasks.push((async () => {
      try {
        const [orderbook, ticker] = await Promise.all([
          json(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${asset}USDT&limit=10`),
          json(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${asset}USDT`),
        ]);
        const fundingRatePct = Number(ticker?.result?.list?.[0]?.fundingRate) * 100;
        quotes.push(quote(asset, "Bybit", "USDT", orderbook.result, "Futuro", fundingRatePct));
      } catch (error) {
        errors.push(`Bybit futuro ${asset}: ${error.message}`);
      }
    })());
  }

  await Promise.all(tasks);
  normalizeBybit(quotes);
  return { quotes, errors };
}

async function sendScan(quotes) {
  const comparableAssets = assets.filter((asset) => quotes.filter((item) => item.asset === asset && item.market === "Spot").length >= 2);
  if (!comparableAssets.length) throw new Error("nenhum ativo comparável");
  const response = await fetch(process.env.MONITOR_URL, {
    method: "POST",
    headers: {
      "OAI-Sites-Authorization": `Bearer ${process.env.SITE_BYPASS_TOKEN}`,
      "x-monitor-secret": process.env.MONITOR_SECRET,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ quotes }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`monitor respondeu ${response.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

const summary = { scans: 0, quoteSnapshots: 0, feedErrors: 0, approved: 0, lastResult: null };
for (let index = 0; index < scansPerRun; index += 1) {
  const { quotes, errors } = await fetchScan();
  const result = await sendScan(quotes);
  summary.scans += 1;
  summary.quoteSnapshots += quotes.length;
  summary.feedErrors += errors.length;
  summary.approved += result.approved ? 1 : 0;
  summary.lastResult = result;
  if (index < scansPerRun - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

console.log(JSON.stringify({ event: "paper_burst_complete", ...summary }));
