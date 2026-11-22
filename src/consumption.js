// Lo que se paga de luz en el mes, sin contador conectado.
//
// No hay forma automática de leer el consumo (ni la red ni la compañía tienen API), así que:
// - Durante el mes se ESTIMA: consumo diario habitual × precio real de cada hora
//   (spot + compañía + red + impuesto, con IVA), repartido según un perfil típico de un piso.
// - Cuando llega la factura se apunta el total de kWh del mes ("lectura"). Con eso el mes
//   queda calculado con datos reales y el consumo diario de los meses siguientes se ajusta.
//
// Los precios spot de los días pasados se guardan en KV (no cambian), así que cada día solo
// se descarga una vez.

import { config } from "./config.js";
import { pricesFor, hourly, contractFor, VAT } from "./extras.js";

const TZ = "Europe/Stockholm";
const fKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
const fHour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ });
const READINGS = "power:readings";

// Reparto del consumo de un día en un piso sin calefacción eléctrica: poco de noche,
// picos al desayunar y, sobre todo, de 17 a 21 (cocina, luces, tele, lavadora).
const RAW = [0.6, 0.5, 0.5, 0.5, 0.5, 0.6, 0.9, 1.2, 1.1, 0.9, 0.9, 0.9, 1.0, 0.9, 0.9, 1.0, 1.2, 1.5, 1.7, 1.6, 1.4, 1.2, 1.0, 0.8];
const SUM = RAW.reduce((a, b) => a + b, 0);
const PROFILE = RAW.map((x) => x / SUM);

const daysIn = (month) => { const [y, m] = month.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const monthOf = (key) => key.slice(0, 7);
const prevMonth = (month) => { const [y, m] = month.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
const round = (x, d = 0) => +x.toFixed(d);

// Precio spot por hora (kr/kWh sin IVA) de un día: 24 valores
async function dayPrices(env, key, today) {
  const kvKey = `spot:${config().zone}:${key}`;
  if (key < today) {
    const cached = await env.NEXUS_KV.get(kvKey, "json");
    if (cached) return cached;
  }
  const raw = await pricesFor(key).catch(() => null);
  if (!raw || !raw.length) return null;
  const h = hourly(raw);
  const out = Array.from({ length: 24 }, (_, i) => {
    const x = h.find((e) => Number(e.h) === i);
    return x ? x.sek : h.reduce((s, e) => s + e.sek, 0) / h.length; // día del cambio de hora
  });
  if (key < today) await env.NEXUS_KV.put(kvKey, JSON.stringify(out), { expirationTtl: 420 * 86400 });
  return out;
}

// ---------- lecturas de factura ----------
export async function listReadings(env) {
  return (await env.NEXUS_KV.get(READINGS, "json")) || [];
}

export async function saveReading(env, { month, kwh }) {
  month = String(month || "");
  const n = Number(String(kwh).replace(",", "."));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Mes no válido (formato AAAA-MM)");
  if (month >= monthOf(fKey.format(new Date()))) throw new Error("Solo se pueden apuntar meses ya terminados");
  if (!(n > 0 && n < 20000)) throw new Error("Consumo no válido (kWh del mes)");
  const list = (await listReadings(env)).filter((r) => r.month !== month);
  list.push({ month, kwh: round(n, 1), at: Date.now() });
  list.sort((a, b) => (a.month < b.month ? -1 : 1));
  await env.NEXUS_KV.put(READINGS, JSON.stringify(list.slice(-36)));
  cache.clear();
  return list.slice(-36);
}

export async function deleteReading(env, month) {
  const list = (await listReadings(env)).filter((r) => r.month !== month);
  await env.NEXUS_KV.put(READINGS, JSON.stringify(list));
  cache.clear();
  return list;
}

// Consumo diario que se usa para estimar: el mismo mes del año pasado si se apuntó;
// si no, el último mes apuntado (de los últimos 3); si no, el consumo anual de la configuración.
function dailyRate(readings, month) {
  const [y, m] = month.split("-");
  const lastYear = readings.find((r) => r.month === `${Number(y) - 1}-${m}`);
  if (lastYear) return { perDay: lastYear.kwh / daysIn(lastYear.month), basis: `el consumo de ${label(lastYear.month)}` };
  let p = month;
  for (let i = 0; i < 3; i++) {
    p = prevMonth(p);
    const r = readings.find((x) => x.month === p);
    if (r) return { perDay: r.kwh / daysIn(r.month), basis: `el consumo de ${label(r.month)}` };
  }
  const year = Number(config().yearKwh) || 2400;
  return { perDay: year / 365, basis: `un consumo de ${year} kWh al año` };
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const label = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} de ${month.slice(0, 4)}`;

// Coste de un mes. Si es el mes en curso, hasta ahora. perDay = kWh por día.
async function monthCost(env, month, perDay) {
  const today = fKey.format(new Date());
  const nowH = Number(fHour.format(new Date()));
  const total = daysIn(month);
  const days = [];
  for (let d = 1; d <= total; d++) {
    const key = `${month}-${String(d).padStart(2, "0")}`;
    if (key > today) break;
    days.push(key);
  }
  const prices = await Promise.all(days.map((k) => dayPrices(env, k, today)));
  const fixedGrid = Number(config().gridMonthlyKr) || 0;
  const extraOre = (c) => c.ore + config().gridOre + config().taxOre; // öre/kWh con IVA

  // Contratos que pagan la media del mes: necesitan el spot medio (de lo que va de mes)
  const known = prices.filter(Boolean);
  const avgSpot = known.length ? known.flat().reduce((s, x) => s + x, 0) / (known.length * 24) : 0;

  let kwh = 0, energy = 0, fixed = 0, missing = 0;
  days.forEach((key, i) => {
    const c = contractFor(key);
    const share = key === today ? PROFILE.slice(0, nowH + 1).reduce((a, b) => a + b, 0) : 1;
    const dayKwh = perDay * share;
    kwh += dayKwh;
    fixed += (fixedGrid + (Number(c.monthlyKr) || 0)) / total * (key === today ? (nowH + 1) / 24 : 1);
    const p = prices[i];
    if (!p) { missing++; energy += dayKwh * (avgSpot * VAT + extraOre(c) / 100); return; }
    if (c.hourly) {
      const hours = key === today ? nowH + 1 : 24;
      for (let h = 0; h < hours; h++) energy += perDay * PROFILE[h] * (p[h] * VAT + extraOre(c) / 100);
    } else {
      energy += dayKwh * (avgSpot * VAT + extraOre(c) / 100);
    }
  });
  const kr = energy + fixed;
  return {
    month, label: label(month), days: days.length, totalDays: total,
    kwh: round(kwh), energyKr: round(energy), fixedKr: round(fixed), kr: round(kr),
    perKwh: kwh ? round(energy / kwh, 2) : 0, missingDays: missing,
    hasGridFee: fixedGrid > 0,
  };
}

const cache = new Map(); // isolate: el resumen vale 20 min

// Resumen para el panel y la voz: mes en curso (estimado) y meses apuntados (calculados)
export async function powerMonth(env) {
  const month = monthOf(fKey.format(new Date()));
  const hit = cache.get(month);
  if (hit && Date.now() - hit.at < 20 * 60 * 1000) return hit.data;
  const readings = await listReadings(env);
  const rate = dailyRate(readings, month);
  const current = await monthCost(env, month, rate.perDay);
  // Previsión del mes completo al mismo ritmo
  current.forecastKr = current.days ? round(current.kr / (current.days - 1 + PROFILE.slice(0, Number(fHour.format(new Date())) + 1).reduce((a, b) => a + b, 0)) * current.totalDays) : 0;
  current.forecastKwh = round(rate.perDay * current.totalDays);
  current.basis = rate.basis;
  const past = [];
  for (const r of readings.slice(-6).reverse()) {
    const c = await monthCost(env, r.month, r.kwh / daysIn(r.month)).catch(() => null);
    if (c) past.push({ month: r.month, label: c.label, kwh: r.kwh, kr: c.kr, perKwh: c.perKwh, missingDays: c.missingDays });
  }
  const data = { current, past, readings: readings.map((r) => r.month) };
  cache.set(month, { at: Date.now(), data });
  return data;
}

// Frase para la voz
export async function powerMonthText(env) {
  const { current: c, past } = await powerMonth(env);
  const last = past[0];
  const prev = last ? ` En ${last.label} fueron ${last.kwh} kilovatios hora, unas ${last.kr} coronas.` : " Cuando llegue la factura, apunta los kilovatios hora del mes y el cálculo será exacto.";
  return `Este mes llevamos unos ${c.kwh} kilovatios hora y unas ${c.kr} coronas de luz, contando la red y los impuestos. A este ritmo, el mes completo saldrá por unas ${c.forecastKr} coronas. Es una estimación con ${c.basis}.${prev}`;
}
