// Precio de la electricidad (zona configurada), avisos oficiales de SMHI y resumen de buenos días.

import { config } from "./config.js";

import { getWeather, getWeatherDetail } from "./weather.js";
import { getAgenda } from "./calendar.js";
import { nextPickups, listNotes, listTimers, createTimer, upcomingDates, listShopping, setNightMode } from "./household.js";
import { listAlarms } from "./alarms.js";
import { listDeviceConfig, controlDevice } from "./devices.js";
import * as L from "./life.js";
import { getAir, getAurora } from "./outdoor.js";
import { addUsage } from "./usage.js";

// Lo nuevo de la casa para los resúmenes hablados: plantas, colegio, menú, festivos, polen y auroras
async function lifeLines(env, { when }) {
  const safe = (p) => p.catch(() => null);
  const [plants, school, menu, air, aurora] = await Promise.all([
    safe(L.listPlants(env)), safe(L.schoolSummary(env)), safe(L.getMenu(env, 2)),
    when === "morning" ? safe(getAir(env)) : null, when === "evening" ? safe(getAurora(env)) : null,
  ]);
  const out = [];
  const season = L.seasonNotices(1);
  if (when === "evening") {
    for (const h of season.filter((x) => x.kind === "holiday" && x.inDays === 1)) out.push(`Mañana es ${h.text}.`);
    const s = school && school.tomorrow;
    if (s && s.bring && s.bring.length) out.push(`Para mañana, ${school.name || "el colegio"} tiene que llevar: ${s.bring.join(", ")}.`);
    if (menu && menu[1] && menu[1].meal) out.push(`Mañana toca cenar ${menu[1].meal}.`);
    for (const p of plants || []) if (!p.pending && p.dueIn === 1) out.push(`Mañana toca regar ${L.plantPhrase(p.name)}.`);
    if (aurora && aurora.chance) out.push(aurora.chance === "alta" ? `Esta noche hay buenas opciones de ver auroras hacia las ${aurora.when}: mirad al norte.` : `Esta noche quizá se vean auroras bajas hacia el norte.`);
    return out;
  }
  for (const h of season.filter((x) => x.kind === "holiday" && x.inDays === 0)) out.push(`Hoy es ${h.text}.`);
  if (when === "morning") for (const t of season.filter((x) => x.kind === "tip" && x.inDays <= 1)) out.push(t.text + ".");
  for (const p of plants || []) if (p.pending) out.push(p.late ? `Hace ${p.late} días que toca regar ${L.plantPhrase(p.name)}.` : `Hoy toca regar ${L.plantPhrase(p.name)}.`);
  const s = school && school.today;
  if (when === "morning" && s) out.push(`${school.name || "Colegio"}: ${s.start ? `entra a las ${s.start}` : "hay colegio"}${s.bring && s.bring.length ? ` y tiene que llevar ${s.bring.join(", ")}` : ""}.`);
  if (menu && menu[0] && menu[0].meal) out.push(`Para cenar: ${menu[0].meal}.`);
  if (air) {
    const high = air.pollen.filter((p) => p.level === "alto");
    if (high.length) out.push(`Polen alto de ${high.map((p) => p.name).join(" y ")}.`);
    if (air.uvMax >= 6) out.push(`El índice UV llegará a ${String(air.uvMax).replace(".", ",")}: protector solar.`);
    if (air.aqi != null && air.aqi > 60) out.push(`La calidad del aire es ${air.aqiText}.`);
  }
  return out;
}

const TZ = "Europe/Stockholm";
const fKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
const fHour = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

// ---------- Electricidad (elprisetjustnu.se, gratis, sin clave) ----------
let powerCache = { at: 0, key: "", data: null };

export async function pricesFor(key) {
  const [y, m, d] = key.split("-");
  const r = await fetch(`https://www.elprisetjustnu.se/api/v1/prices/${y}/${m}-${d}_${config().zone}.json`);
  if (!r.ok) return null; // mañana aún no publicado (sale ~13:00)
  return r.json();
}

// Agrupa los bloques de 15 min en horas: [{ h: "00", sek }]
export function hourly(entries) {
  const by = new Map();
  for (const e of entries) {
    const h = e.time_start.slice(11, 13);
    const a = by.get(h) || [];
    a.push(e.SEK_per_kWh);
    by.set(h, a);
  }
  return [...by].map(([h, v]) => ({ h, sek: v.reduce((s, x) => s + x, 0) / v.length }));
}

// Lo que se paga de verdad por kWh además del spot, en öre/kWh CON IVA. El spot (sin IVA) se
// multiplica por 1,25. La red y el impuesto son iguales a cualquier hora. El contrato de luz
// cambia por fechas (se elige solo el día que toca). Todo sale de la configuración (src/config.js).
export const VAT = 1.25;
export const contractFor = (key) => {
  const list = [...(config().contracts || [])].sort((a, b) => (a.from < b.from ? -1 : 1));
  return list.filter((c) => c.from <= key).pop() || { ore: 0, name: "Sin contrato configurado", hourly: true };
};

export async function getPower() {
  const now = new Date();
  const key = fKey.format(now);
  if (powerCache.data && powerCache.key === key && Date.now() - powerCache.at < 15 * 60 * 1000) return powerCache.data;
  const today = await pricesFor(key);
  if (!today) throw new Error("Precio de la luz no disponible");
  const tomorrowKey = new Date(new Date(key + "T12:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
  const tomorrow = await pricesFor(tomorrowKey).catch(() => null);
  const hours = hourly(today);
  const nowHour = fHour.format(now).slice(0, 2);
  const cur = hours.find((x) => x.h === nowHour) || hours[0];
  const upcoming = hours.filter((x) => x.h >= nowHour);
  const cheapest = [...upcoming].sort((a, b) => a.sek - b.sek)[0];
  const contract = contractFor(key);
  const real = (sek) => +(sek * VAT + (contract.ore + config().gridOre + config().taxOre) / 100).toFixed(2);
  const data = {
    zone: config().zone,
    unit: "kr/kWh",
    now: { h: cur.h, sek: +cur.sek.toFixed(2) },
    cheapestRest: cheapest ? { h: cheapest.h, sek: +cheapest.sek.toFixed(2) } : null,
    avg: +(hours.reduce((s, x) => s + x.sek, 0) / hours.length).toFixed(2),
    hours: hours.map((x) => ({ h: x.h, sek: +x.sek.toFixed(2) })),
    tomorrow: tomorrow ? hourly(tomorrow).map((x) => ({ h: x.h, sek: +x.sek.toFixed(2) })) : null,
    note: "Precio mayorista spot, sin impuestos ni tarifa de red",
    // Precio final por kWh (spot + compañía + red + impuesto, con IVA)
    real: {
      now: real(cur.sek),
      avg: real(hours.reduce((s, x) => s + x.sek, 0) / hours.length),
      cheapestRest: cheapest ? { h: cheapest.h, sek: real(cheapest.sek) } : null,
    },
    contract: contract.name,
    hourlyContract: contract.hourly,
  };
  powerCache = { at: Date.now(), key, data };
  return data;
}

// ---------- Avisos de SMHI (impact-based warnings) ----------
let warnCache = { at: 0, data: null };

function inPolygon(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt.lat) !== (yj > pt.lat) && pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function coversHome(geometry, pt) {
  if (!geometry) return false;
  const toPt = (c) => (typeof c === "string" ? c.trim().split(/\s+/).map(Number) : c);
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polys.some((p) => p[0] && inPolygon(pt, p[0].map(toPt)));
}

// Nombres en español de los tipos de aviso de SMHI (metadata/events.json)
const WARN_ES = {
  THUNDER: "Tormenta eléctrica", WIND: "Viento fuerte", WIND_MOUNTAINS: "Viento en la montaña", STRONG_COOLING: "Frío intenso",
  SNOW: "Nieve", BLACK_ICE: "Hielo en las calles", RAIN: "Lluvia intensa", HIGH_TEMPERATURES: "Calor intenso",
  WIND_SEA: "Viento en el mar", ICE_ACCRETION: "Hielo en barcos", LOW_SEA_LEVEL: "Nivel del mar bajo", HIGH_SEALEVEL: "Nivel del mar alto",
  WATER_SHORTAGE: "Riesgo de falta de agua", HIGH_FLOW: "Ríos muy crecidos", FLOODING: "Inundaciones", FIRE: "Riesgo de incendio",
};
export const LEVEL_ES = { yellow: "amarillo", orange: "naranja", red: "rojo" };

// Traduce al español la descripción de un aviso (una vez por versión publicada; se guarda en KV).
// Modelo pequeño: unas 20 neuronas por aviso. Si falla, queda el texto en inglés.
async function warnSpanish(env, id, src) {
  const key = "smhiaviso:es:" + id;
  const cached = env && (await env.NEXUS_KV.get(key, "json").catch(() => null));
  if (cached) return cached;
  if (!env || !env.AI) return null;
  const model = "@cf/openai/gpt-oss-20b";
  const r = await env.AI.run(model, {
    messages: [
      { role: "system", content: "Traduces avisos meteorológicos oficiales de SMHI al español de España, claro y breve, para una familia. Responde solo con JSON: {\"happens\": string, \"affect\": [string]}. happens: qué va a pasar (1-2 frases). affect: 2 a 4 frases cortas con lo que dice el original sobre qué tener en cuenta, sin añadir consejos propios. Los lugares, con su nombre sueco (p. ej. Bottenhavet, Vänern, Västra Götaland)." },
      { role: "user", content: JSON.stringify(src) + "\nNombres suecos de los lugares, por si aparecen: " + (src.sv || "") },
    ],
    reasoning: { effort: "low" },
    max_tokens: 2000,
  });
  const u = r.usage || {};
  await addUsage(env, ((u.prompt_tokens || 0) * 0.2 + (u.completion_tokens || 0) * 0.3) / 0.011 / 1000).catch(() => {});
  const txt = String((r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || r.response || "");
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("respuesta sin JSON: " + txt.slice(0, 120));
  const j = JSON.parse(m[0]);
  const out = { happens: String(j.happens || "").slice(0, 400), affect: (Array.isArray(j.affect) ? j.affect : []).map((x) => String(x).slice(0, 220)).slice(0, 4) };
  if (!out.happens) return null;
  await env.NEXUS_KV.put(key, JSON.stringify(out), { expirationTtl: 10 * 86400 });
  return out;
}

// Avisos amarillos, naranjas o rojos que cubren la casa (ahora o en las próximas 48 h).
// Los "mensajes" informativos (p. ej. riesgo de falta de agua durante meses) no se muestran.
// WARN_TEST_POINT ("lat,lon", solo en pruebas locales) mira otro punto para ver un aviso real.
export async function getWarnings(env) {
  if (warnCache.data && Date.now() - warnCache.at < 10 * 60 * 1000) return warnCache.data;
  const r = await fetch("https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json");
  if (!r.ok) throw new Error("SMHI no responde");
  const all = await r.json();
  const test = env && env.WARN_TEST_POINT && env.WARN_TEST_POINT.split(",").map(Number);
  const pt = test ? { lat: test[0], lon: test[1] } : { lat: config().lat, lon: config().lon };
  const now = Date.now(), soon = now + 48 * 3600 * 1000;
  const out = [];
  for (const w of all) {
    for (const a of w.warningAreas || []) {
      const level = a.warningLevel && a.warningLevel.code;
      if (!["YELLOW", "ORANGE", "RED"].includes(level)) continue;
      const start = Date.parse(a.approximateStart || 0), end = a.approximateEnd ? Date.parse(a.approximateEnd) : Infinity;
      if (end < now || start > soon) continue;
      if (!coversHome(a.area && a.area.geometry, pt)) continue;
      const code = (w.event && w.event.code) || "";
      const desc = (c) => { const d = (a.descriptions || []).find((x) => x.title && x.title.code === c); return d && d.text ? (d.text.en || d.text.sv || "").trim() : ""; };
      const src = { event: w.event && w.event.en, happens: desc("HAPPENS") || desc("INCIDENT"), incident: desc("INCIDENT"), affect: desc("AFFECT") };
      const sv = (a.descriptions || []).map((x) => x.text && x.text.sv).find(Boolean);
      const id = `${w.id}-${a.id}-${Date.parse(a.published || 0) || 0}`;
      const es = await warnSpanish(env, id, { ...src, sv: (sv || "").slice(0, 400) }).catch((e) => { console.log("SMHI: no se pudo traducir el aviso", e.message); return null; });
      out.push({
        id, level: level.toLowerCase(), code,
        event: WARN_ES[code] || (w.event && w.event.sv) || "Aviso",
        eventSv: w.event && w.event.sv,
        area: a.areaName && a.areaName.sv,
        start: a.approximateStart, end: a.approximateEnd || null,
        happens: es ? es.happens : src.happens,
        affect: es ? es.affect : src.affect.split("\n").filter(Boolean).slice(0, 4),
        text: es ? es.happens : src.happens, // compatibilidad con el asistente y el panel antiguo
      });
    }
  }
  out.sort((x, y) => ["red", "orange", "yellow"].indexOf(x.level) - ["red", "orange", "yellow"].indexOf(y.level));
  warnCache = { at: Date.now(), data: out };
  return out;
}

// ---------- Resumen de buenos días (texto, sin IA: rápido y gratis) ----------
export async function getBriefing(env, { morning = false } = {}) {
  const now = new Date();
  const hour = Number(fHour.format(now).slice(0, 2));
  const saludo = hour < 12 ? "Buenos días" : hour < 20 ? "Buenas tardes" : "Buenas noches";
  const parts = [`${saludo}${morning ? ", familia" : ""}. Son las ${fHour.format(now)}.`];
  const safe = (p) => p.catch(() => null);
  const [w, agenda, pickups, warnings, notes, power, detail, dates] = await Promise.all([
    safe(getWeather()), safe(getAgenda(env)), safe(nextPickups(env)), safe(getWarnings(env)), safe(listNotes(env)), safe(getPower()), safe(getWeatherDetail()),
    safe(upcomingDates(env, 7)),
  ]);
  if (w) parts.push(`En ${config().city} hay ${w.now.temp} grados, ${w.now.text.toLowerCase()}, con una máxima de ${w.today.max}.`);
  if (warnings && warnings.length) parts.push(`Atención: SMHI tiene un aviso ${LEVEL_ES[warnings[0].level]} por ${warnings[0].event.toLowerCase()}.`);
  if (agenda && agenda.today) {
    const nowHHMM = fHour.format(now);
    const ev = agenda.today.filter((e) => !e.allDay && e.end > nowHHMM); // solo lo que queda del día
    if (ev.length) parts.push(`Hoy tienes ${ev.length === 1 ? "una actividad" : ev.length + " actividades"}: ${ev.slice(0, 3).map((e) => `${e.title} a las ${e.start}`).join(", ")}.`);
    else parts.push("Hoy no tienes actividades en la agenda.");
  }
  // Por la tarde-noche también se adelanta lo de mañana
  if (hour >= 17 && agenda && agenda.upcoming) {
    const tmr = agenda.upcoming.filter((e) => e.when === "Mañana");
    if (tmr.length) parts.push(`Mañana: ${tmr.slice(0, 3).map((e) => e.title).join(", ")}.`);
    if (w && w.days && w.days[0]) parts.push(`Mañana se espera ${w.days[0].text.toLowerCase()}, entre ${w.days[0].min} y ${w.days[0].max} grados.`);
  }
  parts.push(...datesText(dates, false));
  if (pickups && pickups[0] && pickups[0].inDays <= 1) parts.push(`${pickups[0].inDays === 0 ? "Hoy" : "Mañana"} se recoge ${pickups[0].type}.`);
  if (notes && notes.length) parts.push(notes.length === 1 ? `Hay una nota para ${notes[0].to}.` : `Hay ${notes.length} notas en el panel.`);
  parts.push(...(await lifeLines(env, { when: morning ? "morning" : "day" }).catch(() => [])));
  if (morning) parts.push(...recommendations(w, detail, power));
  else if (power && power.cheapestRest) parts.push(`La luz más barata de hoy será a las ${power.cheapestRest.h}:00.`);
  return parts.join(" ");
}

// Consejos prácticos para empezar el día (reglas simples, sin IA)
function recommendations(w, detail, power) {
  const out = [];
  const day = detail && detail.days && detail.days[0];
  if (w) {
    const t = Math.min(w.now.feels, w.today.min);
    if (t <= -10) out.push("Hace muchísimo frío: abrígate bien, con gorro, guantes y bufanda.");
    else if (t <= 0) out.push("Hace frío: ponte la chaqueta de invierno y guantes.");
    else if (t <= 8) out.push("Lleva una chaqueta abrigada.");
  }
  if (day) {
    const snow = /niev|nieve/i.test(day.text || "");
    if (day.rainProb >= 50) {
      if (snow) out.push("Puede nevar hoy: cuidado con el hielo en la calle.");
      else out.push(`Lleva paraguas: hay un ${day.rainProb} por ciento de probabilidad de lluvia.`);
      if (!snow && w && w.today.min <= 1) out.push("Con lluvia y temperaturas bajo cero puede haber hielo: camina con cuidado.");
    }
    if (day.wind >= 10) out.push("Hará viento fuerte.");
  }
  if (w && w.today.sunrise) out.push(`Hoy hay luz de ${w.today.sunrise} a ${w.today.sunset}.`);
  if (power && power.cheapestRest) {
    out.push(power.hourlyContract
      ? `Si vas a poner la lavadora o el lavavajillas, la luz más barata hoy será a las ${power.cheapestRest.h}:00, a ${String(power.real.cheapestRest.sek).replace(".", ",")} coronas el kilovatio hora.`
      : `La luz más barata de hoy será a las ${power.cheapestRest.h}:00.`);
  }
  out.push("Que tengan un buen día.");
  return out;
}

// Resumen compacto para el asistente
export async function householdContext(env) {
  const safe = (p) => p.catch(() => null);
  const [timers, pickups, notes, power, warnings] = await Promise.all([
    safe(listTimers(env)), safe(nextPickups(env)), safe(listNotes(env)), safe(getPower()), safe(getWarnings(env)),
  ]);
  return {
    temporizadores: timers && timers.map((t) => ({ id: t.id, nombre: t.label, quedan_seg: Math.max(0, Math.round((t.endsAt - Date.now()) / 1000)) })),
    recogida_basura: pickups,
    notas: notes && notes.map((n) => ({ id: n.id, para: n.to, texto: n.text })),
    luz_kr_kwh: power && { spot_ahora: power.now, precio_real_ahora: power.real.now, mas_barata_resto_del_dia: power.cheapestRest, media_hoy_real: power.real.avg, contrato: power.contract },
    avisos_smhi: warnings,
  };
}


// ---------- Fechas importantes en el resumen ----------
// Hoy, mañana, y avisos a 7 y 3 días (para tener tiempo de comprar el regalo)
function datesText(dates, evening) {
  const out = [];
  for (const d of dates || []) {
    const what = d.kind === "cumpleaños" ? `el cumpleaños de ${d.name}${d.age ? `, que cumple ${d.age}` : ""}`
      : d.kind === "aniversario" ? `el aniversario: ${d.name}${d.age ? `, ${d.age} años` : ""}` : d.name;
    if (!evening && d.inDays === 0) out.push(`¡Hoy es ${what}!`);
    else if (d.inDays === 1) out.push(`Mañana es ${what}.`);
    else if (!evening && d.src !== "iphone" && (d.inDays === 3 || d.inDays === 7)) out.push(`Faltan ${d.inDays} días para ${what}.`);
  }
  return out;
}

// ---------- Próxima alarma (texto) ----------
function swedishNow() {
  const d = new Date();
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(d));
  const [h, m] = fHour.format(d).split(":").map(Number);
  return { dow, min: h * 60 + m };
}

export async function nextAlarmText(env) {
  const n = swedishNow();
  let best = null;
  for (const a of await listAlarms(env)) {
    if (!a.enabled) continue;
    const [h, m] = a.time.split(":").map(Number);
    for (let d = 0; d < 8; d++) {
      const dow = (n.dow + d) % 7;
      if (d === 0 && h * 60 + m <= n.min) continue;
      if (a.days.length && !a.days.includes(dow)) continue;
      const off = d * 1440 + h * 60 + m;
      if (!best || off < best.off) best = { off, d, dow, time: a.time };
      break;
    }
  }
  if (!best || best.d > 1) return "Mañana no hay ninguna alarma.";
  return `La alarma sonará ${best.d === 0 ? "hoy" : "mañana"} a las ${best.time}.`;
}

// ---------- Resumen de buenas noches ----------
export async function getEveningBriefing(env) {
  const safe = (p) => p.catch(() => null);
  const [w, agenda, power, dates, alarm] = await Promise.all([
    safe(getWeather()), safe(getAgenda(env)), safe(getPower()), safe(upcomingDates(env, 2)), safe(nextAlarmText(env)),
  ]);
  const parts = ["Buenas noches."];
  const tmr = ((agenda && agenda.upcoming) || []).filter((e) => e.when === "Mañana" && e.type !== "birthday");
  parts.push(tmr.length ? `Mañana tienen: ${tmr.slice(0, 3).map((e) => e.title).join(", ")}.` : "Mañana no hay nada en la agenda.");
  parts.push(...datesText(dates, true));
  if (w && w.days && w.days[0]) {
    const d = w.days[0];
    parts.push(`Se espera ${d.text.toLowerCase()}, entre ${d.min} y ${d.max} grados.`);
    if (d.min <= 0) parts.push("Por la mañana hará frío: dejen preparada ropa de abrigo.");
  }
  if (alarm) parts.push(alarm);
  parts.push(...(await lifeLines(env, { when: "evening" }).catch(() => [])));
  if (power && power.hourlyContract && power.tomorrow && power.tomorrow.length) {
    const c = [...power.tomorrow].sort((a, b) => a.sek - b.sek)[0];
    parts.push(`Mañana la luz más barata será a las ${c.h}:00.`);
  }
  parts.push("Que descansen.");
  return parts.join(" ");
}

// ---------- Aviso de luz barata ----------
// Busca el bloque más barato de las próximas 24 h para un aparato que dura `hours` horas.
// Si cae de noche no despierta a nadie: avisa antes de dormir para usar el inicio diferido.
const nightStartMin = (dow) => (dow === 5 || dow === 6 ? 24 * 60 : 22 * 60);
const wakeMin = (dow) => (dow === 0 || dow === 6 ? 8 * 60 : 7 * 60);

export async function planCheapPower(env, { appliance = "la lavadora", hours = 2 } = {}) {
  const p = await getPower();
  const n = swedishNow();
  const dur = Math.max(1, Math.min(4, Math.round(Number(hours) || 2)));
  // Horas en minutos desde ahora (hoy desde la hora actual; mañana si ya se publicó, ~13:00)
  const slots = [];
  for (const x of p.hours) { const at = Number(x.h) * 60 - n.min; if (at > -60) slots.push({ at, sek: x.sek, day: 0, h: x.h }); }
  for (const x of p.tomorrow || []) slots.push({ at: 1440 + Number(x.h) * 60 - n.min, sek: x.sek, day: 1, h: x.h });
  let best = null;
  for (let i = 0; i + dur <= slots.length; i++) {
    const win = slots.slice(i, i + dur);
    if (win[win.length - 1].at - win[0].at !== (dur - 1) * 60 || win[0].at > 24 * 60) continue;
    const avg = win.reduce((s, x) => s + x.sek, 0) / dur;
    if (!best || avg < best.avg) best = { ...win[0], avg };
  }
  if (!best) throw new Error("No hay precios suficientes para calcularlo");
  const fixed = p.real.now - p.now.sek * 1.25; // recargos, red e impuesto (igual que la tarjeta)
  const real = (sek) => +(sek * 1.25 + fixed).toFixed(2);
  const startMin = Math.max(0, best.at);
  const startDow = (n.dow + best.day) % 7;
  const clock = Number(best.h) * 60;
  const nowCost = p.real.now, bestCost = real(best.avg);
  const res = {
    aparato: appliance, empezar_a_las: `${best.h}:00`, dia: best.day ? "mañana" : "hoy",
    precio_real_kr_kwh: bestCost, precio_ahora_kr_kwh: nowCost,
    ahorro_kr_por_kwh: +(nowCost - bestCost).toFixed(2), contrato_por_horas: p.hourlyContract,
  };
  if (startMin < 10) { res.aviso = "ahora mismo es el mejor momento"; return res; }
  // ¿Cae en horas de estar despiertos? (la noche de ese día empieza a las 22:00 o a las 00:00)
  const awake = clock >= wakeMin(startDow) && clock < nightStartMin(startDow) - 15;
  if (awake) {
    await createTimer(env, { seconds: startMin * 60, label: `Luz barata: ${appliance}` });
    res.aviso = `temporizador creado: sonará a las ${best.h}:00`;
  } else {
    // Recordatorio 15 minutos antes de dormir, con el retraso que hay que programar
    const bedAt = nightStartMin(n.dow) - 15 - n.min;
    if (bedAt > 1 && bedAt < startMin) {
      const delayH = Math.round((startMin - bedAt) / 60);
      await createTimer(env, { seconds: bedAt * 60, label: `Diferir ${appliance} ${delayH} h` });
      res.aviso = `cae de noche: recordatorio antes de dormir para programar ${appliance} con inicio diferido de unas ${delayH} horas`;
      res.inicio_diferido_horas = delayH;
    } else {
      res.aviso = `cae de noche: programa ${appliance} ahora con inicio diferido de unas ${Math.round(startMin / 60)} horas`;
      res.inicio_diferido_horas = Math.round(startMin / 60);
    }
  }
  return res;
}

// ---------- Rutinas por voz (sin IA, al instante) ----------
async function lightsAll(env, on) {
  try {
    if (!env.SHELLY_AUTH_KEY) return 0;
    const list = (await listDeviceConfig(env)).filter((d) => d.type === "light");
    for (const d of list) await controlDevice(env, d.key, { on }).catch(() => {});
    return list.length;
  } catch { return 0; }
}

export async function runRoutine(env, name) {
  const safe = (p) => p.catch(() => null);
  if (name === "salir") {
    const [w, detail, agenda, lights] = await Promise.all([safe(getWeather()), safe(getWeatherDetail()), safe(getAgenda(env)), lightsAll(env, false)]);
    const parts = ["Hasta luego."];
    if (w) parts.push(`Fuera hay ${w.now.temp} grados${w.now.feels < w.now.temp - 2 ? `, con sensación de ${w.now.feels}` : ""}.`);
    const day = detail && detail.days && detail.days[0];
    if (day && day.rainProb >= 50) parts.push("Lleva paraguas.");
    const nowHHMM = fHour.format(new Date());
    const ev = agenda && agenda.today && agenda.today.filter((e) => !e.allDay && e.start > nowHHMM)[0];
    if (ev) parts.push(`Recuerda: ${ev.title} a las ${ev.start}.`);
    if (lights) parts.push("He apagado las luces.");
    return { reply: parts.join(" "), end: true };
  }
  if (name === "llegar") {
    const [notes, shopping] = await Promise.all([safe(listNotes(env)), safe(listShopping(env))]);
    const n = swedishNow();
    const dark = n.min >= 15 * 60 || n.min < 8 * 60; // en invierno oscurece pronto
    const lights = dark ? await lightsAll(env, true) : 0;
    const parts = ["Bienvenidos a casa."];
    if (notes && notes.length) parts.push(notes.length === 1 ? `Hay una nota para ${notes[0].to}: ${notes[0].text}.` : `Hay ${notes.length} notas en el panel.`);
    const pending = (shopping || []).filter((i) => !i.done);
    if (pending.length) parts.push(`En la lista de la compra hay ${pending.length} ${pending.length === 1 ? "cosa" : "cosas"}.`);
    if (lights) parts.push("He encendido las luces.");
    return { reply: parts.join(" "), end: true };
  }
  if (name === "dormir") {
    const [alarm, agenda] = await Promise.all([safe(nextAlarmText(env)), safe(getAgenda(env))]);
    await setNightMode(env, "activar");
    const lights = await lightsAll(env, false);
    const tmr = ((agenda && agenda.upcoming) || []).filter((e) => e.when === "Mañana")[0];
    const parts = ["Buenas noches."];
    if (alarm) parts.push(alarm);
    if (tmr) parts.push(`Mañana: ${tmr.title}.`);
    if (lights) parts.push("He apagado las luces.");
    parts.push("Que descansen.");
    return { reply: parts.join(" "), end: true, home: true };
  }
  throw new Error("Rutina desconocida");
}
