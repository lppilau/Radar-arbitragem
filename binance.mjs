const required = ["MONITOR_URL", "MONITOR_SECRET", "SITE_BYPASS_TOKEN"];
for (const key of required) if (!process.env[key]) throw new Error(`${key} não configurada`);

const assets = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "LINK", "AVAX", "BCH"];
const scansPerRun = 2;
const intervalMs = 22_000;
const v7Url = new URL("/api/v7", process.env.MONITOR_URL).toString();
const futuresHosts = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://fapi4.binance.com",
];

class FeedError extends Error {
  constructor(status, retryAfter = 0) {
    super(`feed respondeu ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RadarArbitragemBinance/7.2" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new FeedError(response.status, Number(response.headers.get("retry-after")) || 0);
  }
  return response.json();
}

async function futuresJson(path) {
  let lastError;
  for (const host of futuresHosts) {
    try {
      return await requestJson(`${host}${path}`);
    } catch (error) {
      lastError = error;
      if (![418, 429].includes(error?.status)) throw error;
      const waitSeconds = Math.min(3, Math.max(1, error.retryAfter || 1));
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1_000));
    }
  }
  throw lastError;
}

function quote(asset, payload, market, extra = {}) {
  const bid = Number(payload?.bidPrice);
  const ask = Number(payload?.askPrice);
  const bidSize = Number(payload?.bidQty);
  const askSize = Number(payload?.askQty);
  if (!(bid > 0 && ask > 0 && bidSize > 0 && askSize > 0)) throw new Error("livro vazio");
  return {
    asset, venue: "Binance", quoteCurrency: "USDT", market,
    bid, ask, bidSize, askSize,
    bidDepth: bid * bidSize,
    askDepth: ask * askSize,
    capturedAt: new Date().toISOString(), source: "live", ...extra,
  };
}

async function referenceData() {
  const [tickersResult, fundingResult] = await Promise.allSettled([
    futuresJson("/fapi/v1/ticker/24hr"),
    // One aggregated request keeps the collector light while retaining the
    // settled events for all monitored assets, including their mark prices.
    futuresJson("/fapi/v1/fundingRate?limit=1000"),
  ]);
  const tickers = tickersResult.status === "fulfilled" ? tickersResult.value : [];
  const funding = fundingResult.status === "fulfilled" ? fundingResult.value : [];
  const tickerMap = new Map(tickers.map((item) => [item.symbol, item]));
  const wanted = new Set(assets);
  const fundingHistory = funding.flatMap((event) => {
    const symbol = String(event.symbol ?? "");
    const asset = symbol.endsWith("USDT") ? symbol.slice(0, -4) : "";
    if (!wanted.has(asset)) return [];
    return [{
      asset,
      fundingRatePct: Number(event.fundingRate) * 100,
      fundingAt: new Date(Number(event.fundingTime)).toISOString(),
      markPrice: Number(event.markPrice) || undefined,
    }];
  });
  return { tickerMap, fundingHistory };
}

function marketMetrics(ticker) {
  const weighted = Number(ticker?.weightedAvgPrice);
  const high = Number(ticker?.highPrice);
  const low = Number(ticker?.lowPrice);
  return {
    volume24h: Number(ticker?.quoteVolume) || undefined,
    volatility24hPct: weighted > 0 && high > low ? (high - low) / weighted * 100 : undefined,
  };
}

async function fetchScan(reference) {
  const [spotBooks, futuresBooks, premiumList] = await Promise.all([
    requestJson("https://data-api.binance.vision/api/v3/ticker/bookTicker"),
    futuresJson("/fapi/v1/ticker/bookTicker"),
    futuresJson("/fapi/v1/premiumIndex"),
  ]);
  const spotMap = new Map(spotBooks.map((item) => [item.symbol, item]));
  const futuresMap = new Map(futuresBooks.map((item) => [item.symbol, item]));
  const premiumMap = new Map(premiumList.map((item) => [item.symbol, item]));
  const quotes = [];
  const errors = [];
  for (const asset of assets) {
    const symbol = `${asset}USDT`;
    const premium = premiumMap.get(symbol);
    const metrics = marketMetrics(reference.tickerMap.get(symbol));
    try {
      quotes.push(quote(asset, spotMap.get(symbol), "Spot", metrics));
    } catch (error) {
      errors.push(`spot ${asset}: ${error.message}`);
    }
    try {
      quotes.push(quote(asset, futuresMap.get(symbol), "Futuro", {
        ...metrics,
        fundingRatePct: Number(premium?.lastFundingRate ?? 0) * 100,
        nextFundingAt: Number(premium?.nextFundingTime) > 0
          ? new Date(Number(premium.nextFundingTime)).toISOString()
          : undefined,
      }));
    } catch (error) {
      errors.push(`futuro ${asset}: ${error.message}`);
    }
  }
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
const summary = {
  version: "7.2", scans: 0, quoteSnapshots: 0, feedErrors: 0,
  sampleErrors: [], v7Opportunities: 0, v7Opened: 0, deferred: false,
};
for (let index = 0; index < scansPerRun; index += 1) {
  let scan;
  try {
    scan = await fetchScan(reference);
  } catch (error) {
    summary.deferred = true;
    summary.sampleErrors.push(error.message);
    break;
  }
  const { quotes, errors } = scan;
  if (quotes.length < 16) {
    summary.deferred = true;
    summary.sampleErrors.push("dados Binance insuficientes");
    break;
  }
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
  for (const error of errors) {
    if (summary.sampleErrors.length < 8 && !summary.sampleErrors.includes(error)) summary.sampleErrors.push(error);
  }
  summary.lastLegacyApproved = Boolean(legacy.approved);
  if (index < scansPerRun - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
console.log(JSON.stringify({ event: "binance_v7_burst_complete", ...summary }));
