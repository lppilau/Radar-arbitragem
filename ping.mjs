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

  }

  tasks.push(
    json("https://futures.kraken.com/derivatives/api/v3/tickers")
      .then((payload) => {
        for (const asset of futuresAssets) {
          const pair = `${krakenSymbols[asset] ?? asset}:USD`;
          const ticker = (payload.tickers ?? []).find((item) => item.tag === "perpetual" && item.pair === pair && !item.suspended);
          if (!ticker) {
            errors.push(`Kraken futuro ${asset}: contrato indisponível`);
            continue;
          }
          const book = { bids: [[ticker.bid, ticker.bidSize]], asks: [[ticker.ask, ticker.askSize]] };
          const referencePrice = (Number(ticker.bid) + Number(ticker.ask)) / 2;
          const fundingPerHour = Number(ticker.fundingRatePrediction ?? ticker.fundingRate ?? 0);
          const fundingEightHoursPct = referencePrice > 0 ? fundingPerHour / referencePrice * 100 * 8 : 0;
          try {
            quotes.push(quote(asset, "Kraken", "USD", book, "Futuro", fundingEightHoursPct));
          } catch (error) {
            errors.push(`Kraken futuro ${asset}: ${error.message}`);
          }
        }
      })
      .catch((error) => errors.push(`Kraken futuros: ${error.message}`)),
  );

  await Promise.all(tasks);
  return { quotes, errors };
}

async function sendScan(quotes, recordHistory = false) {
  const comparableAssets = assets.filter((asset) => quotes.filter((item) => item.asset === asset && item.market === "Spot").length >= 2);
  if (!comparableAssets.length) throw new Error("nenhum ativo comparável");
  const response = await fetch(process.env.MONITOR_URL, {
    method: "POST",
    headers: {
      "OAI-Sites-Authorization": `Bearer ${process.env.SITE_BYPASS_TOKEN}`,
      "x-monitor-secret": process.env.MONITOR_SECRET,
      ...(recordHistory ? { "x-history-sample": "1" } : {}),
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
  const result = await sendScan(quotes, index === scansPerRun - 1);
  summary.scans += 1;
  summary.quoteSnapshots += quotes.length;
  summary.feedErrors += errors.length;
  summary.approved += result.approved ? 1 : 0;
  summary.lastResult = result;
  if (index < scansPerRun - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

console.log(JSON.stringify({ event: "paper_burst_complete", ...summary }));
