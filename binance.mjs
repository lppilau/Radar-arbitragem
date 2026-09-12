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
    headers: { accept: "application/json", "user-agent": "RadarArbitragemBinance/7.3" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new FeedError(response.status, Number(response.headers.get("retry-after")) || 0);
  }
  return response.json();
}

async function timedRequestJson(url) {
  const startedWall = Date.now();
  const started = performance.now();
  const data = await requestJson(url);
  const endedWall = Date.now();
  const latencyMs = performance.now() - started;
  return { data, midpointMs: (startedWall + endedWall) / 2, latencyMs };
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

async function futuresTimedJson(path) {
  let lastError;
  for (const host of futuresHosts) {
    try {
      return await timedRequestJson(`${host}${path}`);
    } catch (error) {
      lastError = error;
      if (![418, 429].includes(error?.status)) throw error;
    }
  }
  throw lastError;
}

function bookSide(levels) {
  return (Array.isArray(levels) ? levels : []).flatMap((level) => {
    const price = Number(level?.[0]);
    const quantity = Number(level?.[1]);
    return price > 0 && quantity > 0 ? [{ price, quantity }] : [];
  });
}

function depthUsd(levels) {
  return levels.reduce((sum, level) => sum + level.price * level.quantity, 0);
}

function vwapForQuantity(levels, quantity) {
  let remaining = quantity;
  let value = 0;
  for (const level of levels) {
    const filled = Math.min(remaining, level.quantity);
    value += filled * level.price;
    remaining -= filled;
    if (remaining <= quantity * 1e-10) break;
  }
  if (remaining > quantity * 1e-10) throw new Error("profundidade insuficiente para VWAP");
  return value / quantity;
}

function quantityForQuote(asks, quoteNotional) {
  let remaining = quoteNotional;
  let quantity = 0;
  for (const level of asks) {
    const available = level.price * level.quantity;
    const spent = Math.min(remaining, available);
    quantity += spent / level.price;
    remaining -= spent;
    if (remaining <= quoteNotional * 1e-10) break;
  }
  if (remaining > quoteNotional * 1e-10 || !(quantity > 0)) throw new Error("profundidade insuficiente para a ordem Spot");
  return quantity;
}

async function fetchVerifiedBooks(request, baseQuotes) {
  if (!assets.includes(request.asset)) throw new Error("ativo fora da lista monitorada");
  const symbol = `${request.asset}USDT`;
  const [spotTimed, perpTimed] = await Promise.all([
    timedRequestJson(`https://data-api.binance.vision/api/v3/depth?symbol=${symbol}&limit=100`),
    futuresTimedJson(`/fapi/v1/depth?symbol=${symbol}&limit=100`),
  ]);
  const spotBids = bookSide(spotTimed.data?.bids);
  const spotAsks = bookSide(spotTimed.data?.asks);
  const perpBids = bookSide(perpTimed.data?.bids);
  const perpAsks = bookSide(perpTimed.data?.asks);
  if (![spotBids, spotAsks, perpBids, perpAsks].every((side) => side.length)) throw new Error("book detalhado vazio");
  const quantity = Number(request.quantity) > 0
    ? Number(request.quantity)
    : quantityForQuote(spotAsks, Number(request.orderNotionalUsd));
  if (!(quantity > 0)) throw new Error("quantidade de verificação inválida");
  const skewMs = Math.abs(spotTimed.midpointMs - perpTimed.midpointMs);
  const latencyMs = Math.max(spotTimed.latencyMs, perpTimed.latencyMs);
  const executionVerified = skewMs <= 500 && latencyMs <= 1_500;
  const capturedAt = new Date(Math.max(spotTimed.midpointMs, perpTimed.midpointMs)).toISOString();
  const baseSpot = baseQuotes.find((item) => item.asset === request.asset && item.market === "Spot") ?? {};
  const basePerp = baseQuotes.find((item) => item.asset === request.asset && item.market === "Futuro") ?? {};
  const common = { asset: request.asset, venue: "Binance", quoteCurrency: "USDT", capturedAt,
    executionVerified, bookSkewMs: skewMs, bookLatencyMs: latencyMs, orderQuantity: quantity, source: "live-depth-vwap" };
  return [
    { ...baseSpot, ...common, market: "Spot", bid: spotBids[0].price, ask: spotAsks[0].price,
      bidDepth: depthUsd(spotBids), askDepth: depthUsd(spotAsks),
      bidVwap: vwapForQuantity(spotBids, quantity), askVwap: vwapForQuantity(spotAsks, quantity) },
    { ...basePerp, ...common, market: "Futuro", bid: perpBids[0].price, ask: perpAsks[0].price,
      bidDepth: depthUsd(perpBids), askDepth: depthUsd(perpAsks),
      bidVwap: vwapForQuantity(perpBids, quantity), askVwap: vwapForQuantity(perpAsks, quantity) },
  ];
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
  version: "7.3", scans: 0, quoteSnapshots: 0, feedErrors: 0,
  sampleErrors: [], v7Opportunities: 0, v7Opened: 0, verifiedBooks: 0,
  rejectedBookSync: 0, deferred: false,
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
  const requests = Array.isArray(v7.verificationRequests) ? v7.verificationRequests.slice(0, 3) : [];
  if (requests.length) {
    const verifiedResults = await Promise.allSettled(requests.map((request) => fetchVerifiedBooks(request, quotes)));
    const verifiedQuotes = [];
    for (const result of verifiedResults) {
      if (result.status === "fulfilled") {
        verifiedQuotes.push(...result.value);
        if (result.value.every((item) => item.executionVerified)) summary.verifiedBooks += 1;
        else summary.rejectedBookSync += 1;
      } else if (summary.sampleErrors.length < 8) {
        summary.sampleErrors.push(`book detalhado: ${result.reason?.message ?? "falha"}`);
      }
    }
    if (verifiedQuotes.length >= 2) {
      const verified = await post(v7Url, { quotes: verifiedQuotes, fundingHistory: [], sampleHistory: false });
      summary.v7Opened += verified.opened ? 1 : 0;
    }
  }
  for (const error of errors) {
    if (summary.sampleErrors.length < 8 && !summary.sampleErrors.includes(error)) summary.sampleErrors.push(error);
  }
  summary.lastLegacyApproved = Boolean(legacy.approved);
  if (index < scansPerRun - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
console.log(JSON.stringify({ event: "binance_v7_burst_complete", ...summary }));
