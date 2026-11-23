// Vida en casa: plantas, menú de la semana, colegio, familia en otro país, vacaciones
// y avisos de temporada / festivos de Suecia. Todo en Cloudflare KV.

import { config } from "./config.js";
import { todayKey, addDays } from "./planner.js";

const DAY = 86400000;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const clip = (s, n) => String(s || "").trim().slice(0, n);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / DAY);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const dowOf = (key) => new Date(key + "T12:00:00Z").getUTCDay();
const getJSON = async (env, key, fallback) => (await env.NEXUS_KV.get(key, "json")) ?? fallback;
const putJSON = (env, key, v) => env.NEXUS_KV.put(key, JSON.stringify(v));

// ---------- plantas ----------
// Grupos de plantas que se riegan cada N días en fechas fijas (anchor = un día de riego).
// [{ id, name, every, anchor: "AAAA-MM-DD", last: "AAAA-MM-DD" | null }]
function plantStatus(p, today) {
  if (today < p.anchor) return { ...p, pending: false, due: p.anchor, dueIn: daysBetween(today, p.anchor), late: 0 };
  const k = Math.floor(daysBetween(p.anchor, today) / p.every);
  const cycle = addDays(p.anchor, k * p.every);              // último día de riego que ya llegó
  if (!p.last || p.last < cycle) return { ...p, pending: true, due: cycle, dueIn: 0, late: daysBetween(cycle, today) };
  const next = addDays(cycle, p.every);
  return { ...p, pending: false, due: next, dueIn: daysBetween(today, next), late: 0 };
}

export async function listPlants(env) {
  const today = todayKey();
  return (await getJSON(env, "plants", [])).map((p) => plantStatus(p, today));
}

export async function savePlant(env, { id, name, every, anchor, weekday }) {
  const list = await getJSON(env, "plants", []);
  const e = Math.round(Number(every) || 14);
  if (!(e >= 1 && e <= 90)) throw new Error("Cada cuántos días: entre 1 y 90");
  let a = isDate(anchor) ? anchor : null;
  if (!a && weekday != null) { // el próximo día de esa semana (hoy incluido)
    const t = todayKey();
    a = addDays(t, (Number(weekday) - dowOf(t) + 7) % 7);
  }
  if (!a) a = todayKey();
  // Sin id, un nombre que ya existe actualiza ese grupo en lugar de duplicarlo
  const old = list.find((p) => p.id === id) || (!id && list.find((p) => p.name.toLowerCase() === clip(name, 30).toLowerCase()));
  const p = { id: old ? old.id : "p" + uid(), name: clip(name, 30) || (old && old.name) || "Plantas", every: e, anchor: a, last: old ? old.last : null };
  const next = old ? list.map((x) => (x.id === id ? p : x)) : [...list, p].slice(-6);
  await putJSON(env, "plants", next);
  return listPlants(env);
}

export async function waterPlant(env, which) {
  const list = await getJSON(env, "plants", []);
  const q = String(which || "").toLowerCase();
  const p = list.find((x) => x.id === which) || list.find((x) => q && x.name.toLowerCase().includes(q)) || (list.length === 1 ? list[0] : null);
  if (!p) throw new Error("No encuentro esas plantas");
  p.last = todayKey();
  await putJSON(env, "plants", list);
  return listPlants(env);
}

export async function deletePlant(env, id) {
  await putJSON(env, "plants", (await getJSON(env, "plants", [])).filter((p) => p.id !== id));
  return listPlants(env);
}

export function plantPhrase(name) {
  const l = String(name || "plantas").toLowerCase();
  return /^(las|los|el|la) /.test(l) ? l : /^(plantas|flores|macetas)/.test(l) ? "las " + l : l;
}

// ---------- menú de la semana ----------
// { "AAAA-MM-DD": { meal, ingredients: [] } }
export async function getMenu(env, days = 7) {
  const today = todayKey();
  const all = await getJSON(env, "menu", {});
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    out.push({ date: d, meal: (all[d] && all[d].meal) || "", ingredients: (all[d] && all[d].ingredients) || [] });
  }
  return out;
}

export async function setMenu(env, date, { meal, ingredients }) {
  if (!isDate(date)) throw new Error("Fecha no válida (AAAA-MM-DD)");
  const today = todayKey();
  if (date < addDays(today, -1) || date > addDays(today, 30)) throw new Error("El menú es para los próximos 30 días");
  const all = await getJSON(env, "menu", {});
  for (const d of Object.keys(all)) if (d < addDays(today, -7)) delete all[d]; // limpiar lo viejo
  const m = clip(meal, 80);
  const ing = (Array.isArray(ingredients) ? ingredients : String(ingredients || "").split(/,|\n/))
    .map((x) => clip(x, 40)).filter(Boolean).slice(0, 25);
  if (!m && !ing.length) delete all[date];
  else all[date] = { meal: m, ingredients: ing };
  await putJSON(env, "menu", all);
  return getMenu(env);
}

// Ingredientes del menú (entre dos fechas) que aún no están en la lista de compras
export async function menuIngredients(env, from, to) {
  const all = await getJSON(env, "menu", {});
  const a = isDate(from) ? from : todayKey(), b = isDate(to) ? to : addDays(a, 6);
  const seen = new Set();
  const out = [];
  for (const [d, v] of Object.entries(all)) {
    if (d < a || d > b) continue;
    for (const i of v.ingredients || []) { const k = i.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(i); } }
  }
  return out;
}

// ---------- colegio ----------
// { name, days: { "1": { start, end, bring: [] }, … "5": … } }  (1 = lunes)
export async function getSchool(env) {
  return getJSON(env, "school", { name: "", days: {} });
}

export async function setSchool(env, { name, days }) {
  const out = { name: clip(name, 30), days: {} };
  for (const k of ["1", "2", "3", "4", "5", "6", "0"]) {
    const d = days && days[k];
    if (!d) continue;
    const t = (s) => (/^\d{1,2}:\d{2}$/.test(String(s || "")) ? String(s).padStart(5, "0") : "");
    const bring = (Array.isArray(d.bring) ? d.bring : String(d.bring || "").split(/,|\n/)).map((x) => clip(x, 50)).filter(Boolean).slice(0, 6);
    if (t(d.start) || t(d.end) || bring.length) out.days[k] = { start: t(d.start), end: t(d.end), bring };
  }
  await putJSON(env, "school", out);
  return out;
}

// Lo de hoy y mañana (sin colegio en festivos ni en vacaciones de la familia)
export async function schoolSummary(env) {
  const s = await getSchool(env);
  if (!s.name && !Object.keys(s.days || {}).length) return null;
  const vac = await vacation(env);
  const day = (key) => {
    const d = (s.days || {})[String(dowOf(key))];
    if (!d) return null;
    const hol = holidaysOf(Number(key.slice(0, 4))).find((h) => h.date === key && h.red);
    if (hol || (vac && key >= vac.from && key <= vac.to)) return null;
    return { date: key, ...d };
  };
  const t = todayKey();
  return { name: s.name, today: day(t), tomorrow: day(addDays(t, 1)) };
}

// ---------- familia en otro país ----------
export async function getAbroad(env) { return getJSON(env, "abroad", []); }
export async function setAbroad(env, list) {
  const out = (Array.isArray(list) ? list : []).slice(0, 3).map((x) => ({ name: clip(x.name, 24), tz: clip(x.tz, 40) }))
    .filter((x) => x.name && x.tz);
  for (const x of out) {
    try { new Intl.DateTimeFormat("es-CL", { timeZone: x.tz }); } catch { throw new Error("Zona horaria no válida: " + x.tz); }
  }
  await putJSON(env, "abroad", out);
  return out;
}

// ---------- vacaciones ----------
export async function vacation(env) {
  const v = (await getJSON(env, "settings", {})).vacation;
  if (!v || !isDate(v.from) || !isDate(v.to) || v.to < todayKey()) return null;
  return v;
}
export async function setVacation(env, { from, to }) {
  const s = await getJSON(env, "settings", {});
  if (!from && !to) { delete s.vacation; await putJSON(env, "settings", s); return null; }
  if (!isDate(from) || !isDate(to) || to < from) throw new Error("Fechas no válidas (AAAA-MM-DD, la vuelta después de la ida)");
  if (daysBetween(from, to) > 90) throw new Error("Como máximo 90 días");
  s.vacation = { from, to };
  await putJSON(env, "settings", s);
  return s.vacation;
}

// ---------- Suecia: festivos y avisos de temporada ----------
function easter(y) { // algoritmo de Meeus/Jones/Butcher
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
// Primer día de la semana `dow` (0 = domingo) entre dos fechas
const firstDow = (from, to, dow) => { for (let d = from; d <= to; d = addDays(d, 1)) if (dowOf(d) === dow) return d; return from; };
const lastSunday = (y, m) => { const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); let d = end; while (dowOf(d) !== 0) d = addDays(d, -1); return d; };

export function holidaysOf(y) {
  const e = easter(y), p = (n) => addDays(e, n), d = (md) => `${y}-${md}`;
  return [
    { date: d("01-01"), name: "Año Nuevo", red: true },
    { date: d("01-06"), name: "Reyes (Trettondedag jul)", red: true },
    { date: p(-47), name: "Fettisdagen: día de la semla", red: false },
    { date: p(-2), name: "Viernes Santo", red: true },
    { date: e, name: "Domingo de Pascua", red: true },
    { date: p(1), name: "Lunes de Pascua", red: true },
    { date: d("04-30"), name: "Valborg (noche de Walpurgis)", red: false },
    { date: d("05-01"), name: "Primero de mayo", red: true },
    { date: p(39), name: "Ascensión", red: true },
    { date: p(49), name: "Pentecostés", red: true },
    { date: d("06-06"), name: "Día Nacional de Suecia", red: true },
    { date: firstDow(d("06-19"), d("06-25"), 5), name: "Víspera de Midsommar", red: true },
    { date: firstDow(d("06-20"), d("06-26"), 6), name: "Midsommar", red: true },
    { date: d("10-04"), name: "Día del bollo de canela (kanelbulle)", red: false },
    { date: firstDow(d("10-31"), d("11-06"), 6), name: "Todos los Santos", red: true },
    { date: d("12-13"), name: "Santa Lucía", red: false },
    { date: d("12-24"), name: "Nochebuena", red: true },
    { date: d("12-25"), name: "Navidad", red: true },
    { date: d("12-26"), name: "San Esteban (Annandag jul)", red: true },
    { date: d("12-31"), name: "Nochevieja", red: true },
  ];
}

// Avisos de los próximos `days` días: festivos (aparecen ese día y el anterior) y consejos
// de temporada (aparecen durante su ventana). [{ id, kind, text, date, inDays }]
export function seasonNotices(days = 7) {
  const t = todayKey(), y = Number(t.slice(0, 4));
  const out = [];
  for (const yy of [y, y + 1]) for (const h of holidaysOf(yy)) {
    const n = daysBetween(t, h.date);
    if (n >= 0 && n <= days) out.push({ id: "h" + h.date, kind: "holiday", red: h.red, text: h.name, date: h.date, inDays: n });
  }
  const LABELS = { vinterdack: "Neumáticos de invierno", sommardack: "Neumáticos de verano", brandvarnare: "Detector de humo", dst3: "Cambio de hora", dst10: "Cambio de hora" };
  const tip = (id, from, to, text, date, info) => { if (t >= from && t <= to) out.push({ id, kind: "tip", label: LABELS[id] || text.split(": ")[0], text, date: date || to, inDays: daysBetween(t, date || to), info: info || [] }); };
  // Neumáticos: de invierno hasta el día en que pasan a ser obligatorios (1-12); se esconde y vuelve
  // 2 días antes de que termine la temporada (31-3) para avisar de los de verano, hasta el 15-4.
  tip("vinterdack", `${y}-11-10`, `${y}-12-01`, "Neumáticos de invierno: obligatorios del 1 de diciembre al 31 de marzo si hay condiciones invernales", `${y}-12-01`, [
    "Obligatorios del 1 de diciembre al 31 de marzo cuando hay condiciones invernales: nieve, hielo, escarcha o agua helada en la calzada.",
    "Profundidad mínima del dibujo en invierno: 3 mm.",
    "Los de clavos se pueden llevar del 1 de octubre al 15 de abril (fuera de esas fechas, solo si hay condiciones invernales).",
    "Pidan hora en el taller con tiempo: a finales de noviembre se llenan.",
  ]);
  tip("sommardack", `${y}-03-29`, `${y}-04-15`, "Neumáticos de verano: desde el 1 de abril; los de clavos, quitarlos antes del 16 de abril", `${y}-04-15`, [
    "Desde el 1 de abril ya no es obligatorio llevar neumáticos de invierno.",
    "Los de clavos hay que quitarlos antes del 16 de abril, salvo que haya condiciones invernales.",
    "Los de invierno sin clavos se pueden seguir usando, pero en verano frenan peor y se gastan antes.",
    "Profundidad mínima del dibujo en verano: 1,6 mm.",
  ]);
  tip("brandvarnare", `${y}-11-28`, `${y}-12-01`, "1 de diciembre, día del detector de humo: presionen el botón de prueba de cada detector", `${y}-12-01`, [
    "Presionen el botón de prueba de cada detector hasta que suene.",
    "Si no suena o suena débil, cambien la pila (o el detector si tiene más de 10 años).",
    "Lo ideal es un detector en cada planta y cerca de los dormitorios.",
  ]);
  for (const [m, text, info] of [
    [3, "Este domingo se adelanta la hora (de 2:00 a 3:00): se duerme una hora menos", ["La madrugada del domingo, a las 2:00 pasan a ser las 3:00.", "La tablet y los celulares cambian solos; los relojes del horno o del auto, no."]],
    [10, "Este domingo se atrasa la hora (de 3:00 a 2:00): una hora más de sueño", ["La madrugada del domingo, a las 3:00 vuelven a ser las 2:00.", "La tablet y los celulares cambian solos; los relojes del horno o del auto, no."]],
  ]) {
    const s = lastSunday(y, m);
    tip("dst" + m, addDays(s, -3), s, text, s, info);
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}
