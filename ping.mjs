const required = ["MONITOR_URL", "MONITOR_SECRET", "SITE_BYPASS_TOKEN"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} não configurada`);
}

const response = await fetch(process.env.MONITOR_URL, {
  method: "POST",
  headers: {
    "OAI-Sites-Authorization": `Bearer ${process.env.SITE_BYPASS_TOKEN}`,
    "x-monitor-secret": process.env.MONITOR_SECRET,
    accept: "application/json",
  },
  signal: AbortSignal.timeout(20_000),
});
const body = await response.text();
if (!response.ok) throw new Error(`monitor respondeu ${response.status}: ${body.slice(0, 300)}`);
console.log(body);
