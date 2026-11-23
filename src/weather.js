// Clima de la ciudad configurada (src/config.js) desde Open-Meteo (gratis, sin API key, uso no comercial).
// https://open-meteo.com/en/docs

import { config } from "./config.js";

const TZ = "Europe/Stockholm";
const CACHE_MS = 10 * 60 * 1000; // 10 minutos

// Códigos WMO -> icono propio + texto en español
const WMO = {
  0: ["sun", "Despejado"],
  1: ["partly", "Mayormente despejado"],
  2: ["partly", "Parcialmente nublado"],
  3: ["cloudy", "Nublado"],
  45: ["fog", "Niebla"],
  48: ["fog", "Niebla con escarcha"],
  51: ["rain", "Llovizna ligera"],
  53: ["rain", "Llovizna"],
  55: ["rain", "Llovizna intensa"],
  56: ["rain", "Llovizna helada"],
  57: ["rain", "Llovizna helada"],
  61: ["rain", "Lluvia ligera"],
  63: ["rain", "Lluvia"],
  65: ["rain", "Lluvia intensa"],
  66: ["rain", "Lluvia helada"],
  67: ["rain", "Lluvia helada"],
  71: ["snow", "Nevada ligera"],
  73: ["snow", "Nieve"],
  75: ["snow", "Nevada intensa"],
  77: ["snow", "Nieve granulada"],
  80: ["rain", "Chubascos ligeros"],
  81: ["rain", "Chubascos"],
  82: ["rain", "Chubascos fuertes"],
  85: ["snow", "Chubascos de nieve"],
  86: ["snow", "Chubascos de nieve fuertes"],
  95: ["storm", "Tormenta"],
  96: ["storm", "Tormenta con granizo"],
  99: ["storm", "Tormenta con granizo"],
};
const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

const wmo = (code) => WMO[code] || ["cloudy", "—"];
const r = (n) => Math.round(n) + 0; // evita "-0"
const hhmm = (iso) => iso.slice(11, 16);
const dayName = (ymd) => DAYS[new Date(ymd + "T12:00:00Z").getUTCDay()];

// Detalle para el panel interactivo: 7 días con sus horas, viento, humedad, lluvia
let detailCache = { at: 0, data: null };
const fHourKey = (iso) => iso.slice(0, 10);

export async function getWeatherDetail() {
  if (detailCache.data && Date.now() - detailCache.at < CACHE_MS) return detailCache.data;
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: config().lat,
    longitude: config().lon,
    timezone: TZ,
    current: "temperature_2m,apparent_temperature,weather_code,is_day,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
    forecast_days: "7",
    wind_speed_unit: "ms",
  });
  const res = await fetch(url, { headers: { "User-Agent": "nexus-home-dashboard" } });
  if (!res.ok) throw new Error("Open-Meteo respondió " + res.status);
  const j = await res.json();
  const c = j.current, h = j.hourly, d = j.daily;

  const iconFor = (code, isDay) => {
    let icon = wmo(code)[0];
    if (!isDay && (icon === "sun" || icon === "partly")) icon = icon === "sun" ? "moon" : "partlyNight";
    return icon;
  };
  const hoursByDay = {};
  h.time.forEach((t, i) => {
    const k = fHourKey(t);
    (hoursByDay[k] = hoursByDay[k] || []).push({
      h: t.slice(11, 13),
      temp: r(h.temperature_2m[i]),
      rainProb: h.precipitation_probability[i] ?? 0,
      rain: +(h.precipitation[i] || 0).toFixed(1),
      wind: Math.round(h.wind_speed_10m[i]),
      code: iconFor(h.weather_code[i], h.is_day[i]),
      text: wmo(h.weather_code[i])[1],
    });
  });

  const data = {
    location: config().city,
    now: {
      temp: r(c.temperature_2m), feels: r(c.apparent_temperature), humidity: c.relative_humidity_2m,
      wind: Math.round(c.wind_speed_10m), gusts: Math.round(c.wind_gusts_10m), rain: c.precipitation,
      code: iconFor(c.weather_code, c.is_day), text: wmo(c.weather_code)[1], time: c.time,
    },
    days: d.time.map((ymd, i) => ({
      date: ymd,
      d: dayName(ymd),
      code: wmo(d.weather_code[i])[0],
      text: wmo(d.weather_code[i])[1],
      max: r(d.temperature_2m_max[i]),
      min: r(d.temperature_2m_min[i]),
      sunrise: hhmm(d.sunrise[i]),
      sunset: hhmm(d.sunset[i]),
      rain: +(d.precipitation_sum[i] || 0).toFixed(1),
      rainProb: d.precipitation_probability_max[i] ?? 0,
      wind: Math.round(d.wind_speed_10m_max[i]),
      hours: hoursByDay[ymd] || [],
    })),
  };
  // Igual que en la portada: si las estaciones ven lluvia o nieve, manda eso
  try {
    const o = await observedPrecip(config().lat, config().lon);
    if (o && o.kind !== (data.now.code === "storm" ? "rain" : data.now.code)) {
      data.now.code = o.kind;
      data.now.text = o.kind === "snow" ? (o.now ? "Nevando" : "Ha nevado hace poco") : (o.now ? "Lloviendo" : "Ha llovido hace poco");
    }
  } catch { /* sin observaciones */ }
  detailCache = { at: Date.now(), data };
  return data;
}

// Caché en memoria del Worker (se reinicia si Cloudflare recicla la instancia)
let cache = { at: 0, data: null };

// ---------- ¿Está lloviendo o nevando de verdad? ----------
// Los modelos de pronóstico a veces dicen «nublado» mientras nieva. Las estaciones automáticas de
// SMHI más cercanas informan cada hora del tiempo presente (código WMO 4680, guardado como 100+código).
// Si alguna ve precipitación ahora o en la última hora, el tipo (lluvia o nieve) lo decide lo que
// diga la estación y, si es dudoso, la fracción congelada que calcula SMHI para la casa.
// Estaciones de SMHI con "tiempo presente" más cercanas a la casa (las 2 activas a menos de 60 km).
// Se buscan solas a partir de lat/lon de la configuración; la lista se guarda un día.
let stationCache = { at: 0, key: "", list: [] };
async function nearestStations(lat, lon) {
  const key = lat + "," + lon;
  if (stationCache.key === key && Date.now() - stationCache.at < 86400e3) return stationCache.list;
  const j = await smhiJson("https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/13.json");
  const rad = Math.PI / 180;
  const km = (a, b, c, d) => 6371 * 2 * Math.asin(Math.sqrt(Math.sin((c - a) * rad / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin((d - b) * rad / 2) ** 2));
  const list = (j.station || [])
    .filter((st) => st.active && Date.now() - (st.to || 0) < 2 * 86400e3)
    .map((st) => ({ id: String(st.key), name: String(st.name || "").replace(/ A$| Aut$/, ""), d: km(lat, lon, st.latitude, st.longitude) }))
    .filter((st) => st.d <= 60)
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map((st) => [st.id, st.name]);
  stationCache = { at: Date.now(), key, list };
  return list;
}
function obsKind(v) {
  let c = Number(v);
  if (!Number.isFinite(c)) return null;
  const auto = c >= 100;
  if (auto) c -= 100;
  // [tipo, ahora]: tipo = "rain" | "snow" | "any"
  if (auto) {
    if (c >= 20 && c <= 26) return [{ 22: "rain", 23: "rain", 24: "snow", 25: "rain" }[c] || "any", false];
    if (c >= 40 && c <= 48) return ["any", true];
    if (c >= 50 && c <= 66) return ["rain", true];
    if (c === 67 || c === 68) return ["any", true]; // lluvia y nieve mezcladas
    if (c >= 70 && c <= 78) return ["snow", true];
    if (c >= 80 && c <= 84) return ["rain", true];
    if (c >= 85 && c <= 87) return ["snow", true];
    if (c >= 89 && c <= 96) return ["rain", true];
    return null;
  }
  if (c >= 20 && c <= 27) return [{ 20: "rain", 21: "rain", 22: "snow", 23: "any", 24: "rain", 25: "rain", 26: "snow", 27: "snow" }[c] || "any", false];
  if (c >= 50 && c <= 67) return ["rain", true];
  if (c === 68 || c === 69) return ["any", true];
  if (c >= 70 && c <= 79) return ["snow", true];
  if (c >= 80 && c <= 84) return ["rain", true];
  if (c >= 85 && c <= 88) return ["snow", true];
  if (c >= 91 && c <= 99) return ["rain", true];
  return null;
}
async function smhiJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "nexus-home-dashboard" }, cf: { cacheTtl: 300 } });
  if (!r.ok) throw new Error("SMHI " + r.status);
  return r.json();
}
export async function observedPrecip(lat, lon) {
  const stations = await nearestStations(lat, lon);
  if (!stations.length) return null; // fuera de Suecia o sin estaciones cerca
  const obs = await Promise.all(stations.map(async ([id, name]) => {
    try {
      const j = await smhiJson(`https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/13/station/${id}/period/latest-hour/data.json`);
      const v = (j.value || []).slice(-1)[0];
      if (!v || Date.now() - v.date > 3 * 3600e3) return null; // dato viejo: no sirve
      const k = obsKind(v.value);
      return k ? { kind: k[0], now: k[1], name } : null;
    } catch { return null; }
  }));
  const seen = obs.filter(Boolean).sort((a, b) => (b.now - a.now));
  if (!seen.length) return null;
  let kind = seen.find((o) => o.kind === "snow") ? "snow" : seen[0].kind;
  let frozen = null;
  try {
    const f = await smhiJson(`https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon}/lat/${lat}/data.json`);
    const nowT = Date.now();
    const cur = (f.timeSeries || []).reduce((best, t) => (Math.abs(Date.parse(t.time) - nowT) < Math.abs(Date.parse(best.time) - nowT) ? t : best));
    frozen = cur.data.precipitation_frozen_part;
  } catch { /* sin la fracción, manda la estación */ }
  // La estación ve lluvia pero SMHI calcula que más de la mitad cae congelada: aguanieve/nieve
  if (kind !== "snow" && frozen != null && frozen >= 50) kind = "snow";
  if (kind === "any") kind = frozen != null && frozen < 50 ? "rain" : "snow";
  const at = seen.find((o) => o.kind === kind) || seen[0];
  return { kind, now: seen.some((o) => o.now), station: at.name, frozen };
}

export async function getWeather() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: config().lat,
    longitude: config().lon,
    timezone: TZ,
    current: "temperature_2m,apparent_temperature,weather_code,is_day",
    hourly: "temperature_2m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset",
    forecast_days: "6",
  });

  const res = await fetch(url, { headers: { "User-Agent": "nexus-home-dashboard" } });
  if (!res.ok) throw new Error("Open-Meteo respondió " + res.status);
  const j = await res.json();
  const c = j.current, d = j.daily, hr = j.hourly || { temperature_2m: [] };

  let [icon, text] = wmo(c.weather_code);
  if (!c.is_day && (icon === "sun" || icon === "partly")) icon = icon === "sun" ? "moon" : "partlyNight";
  // Lo que ven las estaciones manda sobre el modelo cuando cae algo
  let observed = null;
  try { observed = await observedPrecip(config().lat, config().lon); } catch { /* sin observaciones */ }
  if (observed && observed.kind !== (icon === "storm" ? "rain" : icon)) {
    icon = observed.kind;
    text = observed.kind === "snow" ? (observed.now ? "Nevando" : "Ha nevado hace poco") : (observed.now ? "Lloviendo" : "Ha llovido hace poco");
  }

  const data = {
    location: config().city,
    updated: c.time, // hora local de Suecia
    now: { temp: r(c.temperature_2m), feels: r(c.apparent_temperature), code: icon, text, observed },
    today: {
      date: d.time[0],
      max: r(d.temperature_2m_max[0]),
      min: r(d.temperature_2m_min[0]),
      sunrise: hhmm(d.sunrise[0]),
      sunset: hhmm(d.sunset[0]),
      // Temperatura de cada hora de hoy (00–23) y el sol de mañana, para la barra del día
      temps: hr.temperature_2m.slice(0, 24).map(r),
      nextSunrise: d.sunrise[1] ? hhmm(d.sunrise[1]) : null,
      nextSunset: d.sunset[1] ? hhmm(d.sunset[1]) : null,
    },
    days: d.time.slice(1, 6).map((ymd, i) => ({
      date: ymd,
      d: dayName(ymd),
      code: wmo(d.weather_code[i + 1])[0],
      text: wmo(d.weather_code[i + 1])[1],
      max: r(d.temperature_2m_max[i + 1]),
      min: r(d.temperature_2m_min[i + 1]),
    })),
  };

  cache = { at: Date.now(), data };
  return data;
}
