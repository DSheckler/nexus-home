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
  detailCache = { at: Date.now(), data };
  return data;
}

// Caché en memoria del Worker (se reinicia si Cloudflare recicla la instancia)
let cache = { at: 0, data: null };

export async function getWeather() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: config().lat,
    longitude: config().lon,
    timezone: TZ,
    current: "temperature_2m,apparent_temperature,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset",
    forecast_days: "6",
  });

  const res = await fetch(url, { headers: { "User-Agent": "nexus-home-dashboard" } });
  if (!res.ok) throw new Error("Open-Meteo respondió " + res.status);
  const j = await res.json();
  const c = j.current, d = j.daily;

  let [icon, text] = wmo(c.weather_code);
  if (!c.is_day && (icon === "sun" || icon === "partly")) icon = icon === "sun" ? "moon" : "partlyNight";

  const data = {
    location: config().city,
    updated: c.time, // hora local de Suecia
    now: { temp: r(c.temperature_2m), feels: r(c.apparent_temperature), code: icon, text },
    today: {
      date: d.time[0],
      max: r(d.temperature_2m_max[0]),
      min: r(d.temperature_2m_min[0]),
      sunrise: hhmm(d.sunrise[0]),
      sunset: hhmm(d.sunset[0]),
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
