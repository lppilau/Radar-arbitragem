const required = ["MONITOR_URL", "MONITOR_SECRET", "SITE_BYPASS_TOKEN"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} não configurada`);
}

const assets = ["BTC", "ETH", "SOL"];

async function json(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RadarArbitragemPaper/3.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`feed respondeu ${response.status}: ${url}`);
  return response.json();
}

const quotes = [];
await Promise.all(assets.flatMap((asset) => {
  const krakenPair = `${asset === "BTC" ? "XBT" : asset}USD`;
  return [
    json(`https://api.exchange.coinbase.com/products/${asset}-USD/book?level=1`).then((book) => {
      quotes.push({
        asset, venue: "Coinbase", market: "Spot",
        bid: Number(book.bids?.[0]?.[0]), ask: Number(book.asks?.[0]?.[0]),
        bidSize: Number(book.bids?.[0]?.[1]), askSize: Number(book.asks?.[0]?.[1]), source: "live",
      });
    }),
    json(`https://api.kraken.com/0/public/Depth?pair=${krakenPair}&count=1`).then((payload) => {
      const book = Object.values(payload.result ?? {})[0];
      if (!book?.bids?.[0] || !book?.asks?.[0]) throw new Error(`Kraken sem livro para ${asset}`);
      quotes.push({
        asset, venue: "Kraken", market: "Spot",
        bid: Number(book.bids[0][0]), ask: Number(book.asks[0][0]),
        bidSize: Number(book.bids[0][1]), askSize: Number(book.asks[0][1]), source: "live",
      });
    }),
  ];
}));

if (quotes.length !== assets.length * 2) throw new Error("cotações incompletas");

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
console.log(body);
