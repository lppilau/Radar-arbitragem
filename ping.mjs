const required = ["MONITOR_URL", "MONITOR_SECRET", "SITE_BYPASS_TOKEN"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} não configurada`);
}

const assets = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "LINK", "AVAX", "BCH", "USDT", "USDC"];
const krakenSymbols = { BTC: "XBT", DOGE: "XDG" };

async function json(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RadarArbitragemPaper/4.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`feed respondeu ${response.status}`);
  return response.json();
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

function quote(asset, venue, quoteCurrency, payload) {
  const bids = levels(payload?.bids);
  const asks = levels(payload?.asks);
  if (!bids.length || !asks.length) throw new Error("livro vazio");
  return {
    asset,
    venue,
    quoteCurrency,
    market: "Spot",
    bid: bids[0][0],
    ask: asks[0][0],
    bidSize: bids[0][1],
    askSize: asks[0][1],
    bidDepth: bids.reduce((sum, [price, size]) => sum + price * size, 0),
    askDepth: asks.reduce((sum, [price, size]) => sum + price * size, 0),
    source: "live",
  };
}

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

await Promise.all(tasks);

const comparableAssets = assets.filter((asset) => quotes.filter((item) => item.asset === asset).length >= 2);
if (!comparableAssets.length) throw new Error(`nenhum ativo comparável: ${errors.slice(0, 4).join("; ")}`);

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
console.log(JSON.stringify({
  event: "paper_scan_complete",
  quotes: quotes.length,
  comparableAssets: comparableAssets.length,
  feedErrors: errors.length,
  result: JSON.parse(body),
}));
