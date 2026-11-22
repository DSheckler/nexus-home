// Fuera de casa: polen, calidad del aire y UV (Open-Meteo, gratis) y aurora boreal
// (índice Kp previsto de NOAA SWPC, gratis, más la nubosidad de esta noche).
// Los resultados se guardan 1 hora en KV para no consultar fuera en cada refresco.

import { config } from "./config.js";

const TZ = "Europe/Stockholm";
const fHourNum = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ });

async function cached(env, key, ttlSec, fn) {
  const hit = await env.NEXUS_KV.get(key, "json").catch(() => null);
  if (hit && Date.now() - hit.at < ttlSec * 1000) return hit.data;
  try {
    const data = await fn();
    await env.NEXUS_KV.put(key, JSON.stringify({ at: Date.now(), data }), { expirationTtl: Math.max(60, ttlSec * 3) });
    return data;
  } catch (e) {
    if (hit) return hit.data; // mejor un dato de hace un rato que nada
    throw e;
  }
}

// ---------- polen, aire y UV ----------
// Umbrales aproximados (granos/m³): abedul y aliso suben fuerte en primavera; hierbas en verano.
const POLLEN = [
  { key: "birch_pollen", name: "abedul", mid: 10, high: 100 },
  { key: "alder_pollen", name: "aliso", mid: 10, high: 100 },
  { key: "grass_pollen", name: "gramíneas", mid: 10, high: 50 },
  { key: "mugwort_pollen", name: "artemisa", mid: 10, high: 50 },
  { key: "ragweed_pollen", name: "ambrosía", mid: 10, high: 50 },
];

export function getAir(env) {
  return cached(env, "cache:air", 3600, async () => {
    const u = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
    u.search = new URLSearchParams({
      latitude: config().lat, longitude: config().lon, timezone: TZ, forecast_days: "1",
      current: "european_aqi",
      hourly: "uv_index," + POLLEN.map((p) => p.key).join(","),
    });
    const r = await fetch(u, { headers: { "User-Agent": "nexus-home-dashboard" } });
    if (!r.ok) throw new Error("Open-Meteo aire " + r.status);
    const j = await r.json();
    const h = j.hourly || {};
    const max = (arr) => Math.max(0, ...(arr || []).filter((x) => x != null));
    const pollen = POLLEN.map((p) => {
      const v = max(h[p.key]);
      return { name: p.name, value: Math.round(v), level: v >= p.high ? "alto" : v >= p.mid ? "moderado" : "bajo" };
    }).filter((p) => p.level !== "bajo").sort((a, b) => b.value - a.value);
    const aqi = j.current && j.current.european_aqi != null ? Math.round(j.current.european_aqi) : null;
    return {
      aqi, aqiText: aqi == null ? null : aqi <= 20 ? "buena" : aqi <= 40 ? "aceptable" : aqi <= 60 ? "moderada" : aqi <= 80 ? "mala" : "muy mala",
      uvMax: Math.round(max(h.uv_index) * 10) / 10,
      pollen,
    };
  });
}

// ---------- aurora boreal ----------
// En el sur de Suecia (~58° N) suele verse con Kp 5 o más; con Kp 4, a veces hacia el norte.
export function getAurora(env) {
  return cached(env, "cache:aurora", 3600, async () => {
    const [kpRes, wxRes] = await Promise.all([
      fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json", { headers: { "User-Agent": "nexus-home-dashboard" } }),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${config().lat}&longitude=${config().lon}&hourly=cloud_cover,is_day&timezone=UTC&forecast_days=2`),
    ]);
    if (!kpRes.ok) throw new Error("NOAA " + kpRes.status);
    const raw = await kpRes.json();
    // Formato antiguo: [["time_tag","kp",...], [...]]; formato nuevo: [{ time_tag, kp }]
    const rows = Array.isArray(raw[0]) ? raw.slice(1).map((r) => ({ t: r[0], kp: Number(r[1]) })) : raw.map((r) => ({ t: r.time_tag, kp: Number(r.kp ?? r.Kp) }));
    const now = Date.now();
    // "Esta noche": de las 18:00 de hoy a las 04:00 de mañana (hora sueca), aprox. en UTC
    const start = now - 3 * 3600000, end = now + 18 * 3600000;
    const tonight = rows.map((r) => ({ at: Date.parse(r.t.replace(" ", "T") + "Z"), kp: r.kp }))
      .filter((r) => r.at >= start && r.at <= end && Number.isFinite(r.kp))
      .filter((r) => { const h = Number(fHourNum.format(new Date(r.at))); return h >= 18 || h <= 3; });
    if (!tonight.length) return { kp: null, chance: null };
    const best = tonight.reduce((a, b) => (b.kp > a.kp ? b : a));
    let clouds = null;
    if (wxRes.ok) {
      const w = await wxRes.json();
      const t = (w.hourly && w.hourly.time) || [];
      const cc = t.map((x, i) => ({ at: Date.parse(x + "Z"), c: w.hourly.cloud_cover[i], day: w.hourly.is_day[i] }))
        .filter((x) => x.at >= best.at - 2 * 3600000 && x.at <= best.at + 4 * 3600000 && !x.day);
      if (cc.length) clouds = Math.round(cc.reduce((s, x) => s + x.c, 0) / cc.length);
    }
    const kp = Math.round(best.kp * 10) / 10;
    const chance = kp >= 5 ? "alta" : kp >= 4 ? "posible" : null;
    const hh = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(new Date(best.at));
    return { kp, chance: chance && (clouds == null || clouds < 70) ? chance : null, clouds, at: best.at, when: hh };
  });
}
