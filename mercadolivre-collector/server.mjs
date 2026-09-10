import http from "node:http";

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.GECKO_API_KEY || "";
const ALLOWED_ORIGIN = process.env.RADAR_ALLOWED_ORIGIN || "https://radar-produtos-lppilau.lppilau.chatgpt.site";
const CACHE_HOURS = Number(process.env.CACHE_HOURS || 24);
const DAILY_LIMIT = Number(process.env.DAILY_CREDIT_LIMIT || 3);
const GECKO_URL = "https://api.geckoapi.com.br/v1/extract";

const searches = [
  { id: "pads", keyword: "pastilha de freio Renault Master", slug: "pastilha-de-freio-renault-master" },
  { id: "handle", keyword: "puxador interno Renault Master", slug: "puxador-interno-renault-master" },
  { id: "mirror", keyword: "retrovisor Renault Master 2014 2025", slug: "retrovisor-renault-master-2014-2025" },
];

const suppliers = [
  { part: "handle", name: "Interex Automotive", country: "Reino Unido / sourcing global", url: "https://www.interexautomotive.com/", status: "cotacao_pendente" },
  { part: "mirror", name: "Alibaba Renault mirror suppliers", country: "China", url: "https://www.alibaba.com/showroom/door-mirror-renault.html", status: "compatibilidade_pendente" },
  { part: "pads", name: "FrenoBrake", country: "China", url: "https://frenobrake.com/", status: "certificacao_pendente" },
  { part: "pads", name: "Moto-Dynamic", country: "Europa", url: "https://moto-dynamic.com/", status: "preco_publicado" },
];

let cache = { updatedAt: null, items: [], errors: [], callsToday: 0, day: "" };

function today() { return new Date().toISOString().slice(0, 10); }
function resetBudget() {
  if (cache.day !== today()) cache = { ...cache, day: today(), callsToday: 0 };
}
function isFresh() {
  if (!cache.updatedAt) return false;
  return Date.now() - Date.parse(cache.updatedAt) < CACHE_HOURS * 3600_000;
}
function productsFrom(payload) {
  const data = payload?.data ?? payload?.result ?? payload;
  const list = Array.isArray(data) ? data : data?.products ?? data?.items ?? data?.results ?? [];
  return Array.isArray(list) ? list : Object.values(list || {});
}
function normalize(id, item) {
  return {
    family: id,
    title: String(item?.name ?? item?.title ?? ""),
    price: Number(item?.price ?? item?.sale_price ?? 0),
    url: String(item?.url ?? item?.permalink ?? ""),
    seller: item?.sellerName ?? item?.seller?.name ?? null,
    rating: Number(item?.aggregateRating?.rating ?? item?.rating ?? 0) || null,
    sku: item?.sku ?? item?.id ?? null,
  };
}

async function scan(force = false) {
  resetBudget();
  if (!force && isFresh()) return cache;
  if (!API_KEY) throw new Error("GECKO_API_KEY_NOT_CONFIGURED");
  const available = Math.max(0, DAILY_LIMIT - cache.callsToday);
  if (available < searches.length) throw new Error("DAILY_CREDIT_LIMIT_REACHED");
  const items = [], errors = [];
  for (const search of searches) {
    try {
      const response = await fetch(GECKO_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "mercadolivre.com.br",
          type: "plp",
          url: `https://lista.mercadolivre.com.br/${search.slug}`,
          page: 1,
          keyword: search.keyword,
        }),
      });
      cache.callsToday += 1;
      if (!response.ok) throw new Error(`GeckoAPI HTTP ${response.status}`);
      const payload = await response.json();
      const normalized = productsFrom(payload).map((x) => normalize(search.id, x)).filter((x) => x.title && x.price > 0);
      items.push(...normalized);
    } catch (error) {
      errors.push({ family: search.id, message: error instanceof Error ? error.message : "unknown_error" });
    }
  }
  cache = { ...cache, updatedAt: new Date().toISOString(), items, errors };
  return cache;
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}
function send(res, status, body, origin = "") {
  res.writeHead(status, cors(origin));
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || "");
  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/health") return send(res, 200, { ok: true, keyConfigured: Boolean(API_KEY) }, origin);
  if (url.pathname === "/api/opportunities" && req.method === "GET") {
    try {
      const data = await scan(false);
      return send(res, 200, { ok: true, ...data, suppliers, dailyLimit: DAILY_LIMIT }, origin);
    } catch (error) {
      const code = error instanceof Error ? error.message : "scan_failed";
      return send(res, code === "GECKO_API_KEY_NOT_CONFIGURED" ? 503 : 429, { ok: false, code, ...cache, suppliers, dailyLimit: DAILY_LIMIT }, origin);
    }
  }
  if (url.pathname === "/api/refresh" && req.method === "POST") {
    try {
      const data = await scan(true);
      return send(res, 200, { ok: true, ...data, suppliers, dailyLimit: DAILY_LIMIT }, origin);
    } catch (error) {
      return send(res, 429, { ok: false, code: error instanceof Error ? error.message : "scan_failed", ...cache }, origin);
    }
  }
  return send(res, 404, { ok: false, code: "not_found" }, origin);
});

server.listen(PORT, "0.0.0.0", () => console.log(`radar_master_collector_listening:${PORT}`));
