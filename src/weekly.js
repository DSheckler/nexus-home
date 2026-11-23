// Resumen de la semana que viene (el domingo por la tarde, y por voz cuando se pide):
// agenda, tiempo, basura, cumpleaños, tareas, recordatorios y gasto de luz.

import { agendaRange } from "./calendar.js";
import { getWeatherDetail } from "./weather.js";
import { nextPickups, upcomingDates } from "./household.js";
import { listChores, listReminders, todayKey, addDays } from "./planner.js";
import { powerMonth } from "./consumption.js";
import * as L from "./life.js";

const TZ = "Europe/Stockholm";
const fDay = new Intl.DateTimeFormat("es-CL", { weekday: "long", timeZone: "UTC" });
const fDayTZ = new Intl.DateTimeFormat("es-CL", { weekday: "long", timeZone: TZ });
const fHour = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
const dayName = (key) => fDay.format(new Date(key + "T12:00:00Z"));

export async function getWeeklyBriefing(env) {
  const safe = (p) => p.catch(() => null);
  const today = todayKey();
  const end = addDays(today, 7);
  const [range, detail, pickups, dates, chores, reminders, pm] = await Promise.all([
    safe(agendaRange(env, 8)), safe(getWeatherDetail()), safe(nextPickups(env)), safe(upcomingDates(env, 7)),
    safe(listChores(env)), safe(listReminders(env)), safe(powerMonth(env)),
  ]);
  const parts = ["Este es el resumen de la semana que viene."];

  // Agenda: los días con algo, de mañana a dentro de 7 días
  const events = (((range && (range.events || range.items)) || (Array.isArray(range) ? range : [])))
    .filter((e) => e.date > today && e.date <= end && e.type !== "birthday");
  if (events.length) {
    const byDay = new Map();
    for (const e of events) {
      const a = byDay.get(e.date) || [];
      a.push(e.allDay || !e.start ? e.title : `${e.title} a las ${e.start}`);
      byDay.set(e.date, a);
    }
    const days = [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, 5)
      .map(([d, list]) => `el ${dayName(d)}, ${list.slice(0, 3).join(" y ")}`);
    parts.push(`En la agenda: ${days.join("; ")}.`);
  } else parts.push("La agenda de la semana está libre.");

  for (const d of dates || []) {
    if (d.inDays < 1) continue;
    const what = d.kind === "cumpleaños" ? `el cumpleaños de ${d.name}${d.age ? `, que cumple ${d.age}` : ""}` : d.kind === "aniversario" ? `el aniversario: ${d.name}` : d.name;
    parts.push(`El ${dayName(d.date)} es ${what}.`);
  }

  const wk = (pickups || []).filter((p) => p.inDays >= 1 && p.inDays <= 7);
  if (wk.length) parts.push(`Basura: ${wk.map((p) => `${p.type} el ${dayName(p.date)}`).join(", ")}.`);

  const rem = (reminders || []).filter((r) => r.at > Date.now() && r.at < Date.now() + 7 * 86400000);
  if (rem.length) parts.push(`Recordatorios: ${rem.slice(0, 4).map((r) => `${r.text}, el ${fDayTZ.format(new Date(r.at))} a las ${fHour.format(new Date(r.at))}`).join("; ")}.`);

  const due = (chores || []).filter((c) => c.dueIn <= 7);
  if (due.length) parts.push(`Tareas de la semana: ${due.slice(0, 5).map((c) => `${c.name}${c.who ? ` (le toca a ${c.who})` : ""}`).join(", ")}.`);

  const [plants, menu] = await Promise.all([safe(L.listPlants(env)), safe(L.getMenu(env, 8))]);
  for (const p of plants || []) if (p.pending || p.dueIn <= 7) parts.push(p.pending ? `Hay que regar ${L.plantPhrase(p.name)} cuanto antes.` : `El ${dayName(p.due)} toca regar ${L.plantPhrase(p.name)}.`);
  const planned = (menu || []).slice(1).filter((d) => d.meal).length;
  parts.push(planned ? `El menú tiene ${planned} de los próximos 7 días planificados.` : "El menú de la semana está vacío: pueden planificarlo en el panel o pedírmelo.");
  for (const n of L.seasonNotices(7)) {
    if (n.kind === "holiday" && n.inDays >= 1) parts.push(`El ${dayName(n.date)} es ${n.text}.`);
    if (n.kind === "tip") parts.push(n.text + ".");
  }

  if (detail && detail.days && detail.days.length) {
    const days = detail.days.slice(1, 7);
    if (days.length) {
      const min = Math.min(...days.map((d) => d.min)), max = Math.max(...days.map((d) => d.max));
      const wet = days.filter((d) => d.rainProb >= 60).map((d) => dayName(d.date || d.day || ""));
      parts.push(`El tiempo: entre ${min} y ${max} grados${wet.length && wet[0] ? `; probable lluvia el ${wet.slice(0, 3).join(", ")}` : ""}.`);
    }
  }

  if (pm && pm.current) {
    const c = pm.current;
    parts.push(`De luz llevamos unas ${c.kr} coronas este mes; a este ritmo, unas ${c.forecastKr} en total.`);
    if (c.compare) parts.push(c.compare.savedForecastKr >= 0 ? `Frente a ${c.compare.name}, ahorran unas ${c.compare.savedForecastKr} coronas.` : `Con ${c.compare.name} pagarían unas ${-c.compare.savedForecastKr} coronas menos.`);
  }
  parts.push("¡Buena semana!");
  return parts.join(" ");
}
