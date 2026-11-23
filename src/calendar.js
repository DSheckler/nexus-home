// Agenda familiar desde Google Calendar.
// Sin Google configurado, devuelve datos de ejemplo con el mismo formato.

import { googleConfigured, calendarsConfig, listEvents, gcal } from "./google.js";
import { upcomingDates } from "./household.js";
import { holidaysOf } from "./life.js";
import { agendaVersion, bumpAgenda } from "./gcalpush.js";

const TZ = "Europe/Stockholm";
const DAYS_AHEAD = 14;
const CACHE_MS = 60 * 1000;

const fKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
const fTime = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
const fShort = new Intl.DateTimeFormat("es-CL", { weekday: "short", day: "numeric", timeZone: TZ });

let cache = { at: 0, data: null, ver: "" };

// "2026-11-23" + n días (en calendario, sin depender de la hora)
function addDays(key, n) {
  const d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function whenLabel(dateKey, todayKey) {
  if (dateKey === addDays(todayKey, 1)) return "Mañana";
  const s = fShort.format(new Date(dateKey + "T12:00:00Z")).replace(".", "");
  return s.charAt(0).toUpperCase() + s.slice(1); // "Lun 23"
}

// Personas sin cuenta de Google (p. ej. un niño): config con "host": sus eventos
// se guardan en el calendario de otra persona, marcados con una propiedad privada
// y con su nombre delante del título ("Sofía · Dentista") para verlo en el celular.
const realCals = (cals) => cals.filter((c) => !c.host);

function guestOf(e, cal, cals) {
  const tag = e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.nexusWho;
  return tag ? cals.find((c) => c.host && c.who === tag && c.id === cal.id) : null;
}

function guestBody(cal, body) {
  if (!cal.host) return body;
  return { ...body, summary: `${cal.name} · ${body.summary}`, extendedProperties: { private: { nexusWho: cal.who } } };
}

// Normaliza un evento de Google a nuestro formato
function normalize(e, cal, cals = []) {
  const guest = guestOf(e, cal, cals);
  if (guest) {
    cal = guest;
    const prefix = guest.name + " · ";
    if ((e.summary || "").startsWith(prefix)) e = { ...e, summary: e.summary.slice(prefix.length) };
  }
  const allDay = Boolean(e.start.date);
  const start = allDay ? null : new Date(e.start.dateTime);
  const end = allDay ? null : new Date(e.end.dateTime);
  const isBirthday = cal.birthdays || e.eventType === "birthday";
  return {
    id: e.id,
    who: cal.who,
    title: (e.summary || "(Sin título)").trim(),
    allDay,
    dateKey: allDay ? e.start.date : fKey.format(start),
    endKey: allDay ? addDays(e.end.date, -1) : fKey.format(end),
    start: allDay ? null : fTime.format(start),
    end: allDay ? null : fTime.format(end),
    sortAt: allDay ? new Date(e.start.date + "T00:00:00Z").getTime() : start.getTime(),
    type: isBirthday ? "birthday" : "event",
  };
}

// Cumpleaños y fechas guardados en NEXUS (no en Google) se agregan a "Próximos días"
export async function getAgenda(env) {
  const base = await getAgendaBase(env);
  const dates = await upcomingDates(env, DAYS_AHEAD).catch(() => []);
  const todayKey = fKey.format(new Date());
  const until = new Date(Date.parse(todayKey + "T12:00:00Z") + DAYS_AHEAD * 86400000).toISOString().slice(0, 10);
  const y = Number(todayKey.slice(0, 4));
  const holidays = [...holidaysOf(y), ...holidaysOf(y + 1)].filter((h) => h.red && h.date > todayKey && h.date <= until);
  if (!dates.length && !holidays.length) return base;
  const extra = [
    ...dates.map((d) => ({ when: d.inDays === 0 ? "Hoy" : whenLabel(d.date, todayKey), title: d.title, who: "familia", type: "birthday", sortKey: d.date })),
    ...holidays.map((h) => ({ when: whenLabel(h.date, todayKey), title: h.name, who: "familia", type: "holiday", sortKey: h.date })),
  ];
  const keyOf = (e) => (e.when === "Hoy" ? todayKey : e.sortKey || "");
  const upcoming = [...extra, ...(base.upcoming || [])];
  // Orden: las fechas propias delante si son hoy o mañana; el resto, ya viene ordenado por día
  upcoming.sort((a, b) => (keyOf(a) && keyOf(b) ? keyOf(a).localeCompare(keyOf(b)) : 0));
  return { ...base, upcoming: upcoming.slice(0, 8) };
}

async function getAgendaBase(env) {
  if (!googleConfigured(env)) return exampleAgenda();
  const ver = await agendaVersion(env).catch(() => "");
  if (cache.data && cache.ver === ver && Date.now() - cache.at < CACHE_MS) return cache.data;

  const cals = calendarsConfig(env);
  const now = new Date();
  const todayKey = fKey.format(now);
  const timeMin = new Date(now.getTime() - 24 * 3600 * 1000);
  const timeMax = new Date(now.getTime() + (DAYS_AHEAD + 1) * 24 * 3600 * 1000);

  const people = {};
  for (const c of cals) if (!c.birthdays) people[c.who] = { name: c.name, color: c.color };
  people.familia = people.familia || { name: "Familia", color: "#e8b86a" };

  const errors = [];
  const lists = await Promise.all(realCals(cals).map(async (cal) => {
    try { return (await listEvents(env, cal.id, timeMin, timeMax)).map((e) => normalize(e, cal, cals)); }
    catch (err) { errors.push(`${cal.name}: ${err.message}`); return []; }
  }));
  const events = lists.flat().sort((a, b) => a.sortAt - b.sortAt);

  // Hoy: eventos que tocan el día de hoy (incluye los de varios días)
  const today = events
    .filter((e) => e.dateKey <= todayKey && e.endKey >= todayKey && e.type !== "birthday")
    .map((e) => ({
      title: e.title, who: e.who, allDay: e.allDay || e.dateKey !== todayKey,
      start: e.dateKey === todayKey && !e.allDay ? e.start : "00:00",
      end: e.endKey === todayKey && !e.allDay ? e.end : "23:59",
    }));

  // Próximos días: lo que empieza después de hoy (cumpleaños de hoy incluidos)
  const upcoming = events
    .filter((e) => e.dateKey > todayKey || (e.type === "birthday" && e.dateKey === todayKey))
    .slice(0, 8)
    .map((e) => ({
      when: e.dateKey === todayKey ? "Hoy" : whenLabel(e.dateKey, todayKey),
      sortKey: e.dateKey,
      title: e.type === "birthday" || e.allDay ? e.title : `${e.title} ${e.start}`,
      who: e.who,
      type: e.type,
    }));

  const data = { source: "google", people, today, upcoming, errors, updated: now.toISOString() };
  cache = { at: Date.now(), data, ver };
  return data;
}

// ---------- Operaciones para el asistente ----------

function calendarFor(env, who) {
  const cal = calendarsConfig(env).find((c) => c.who === who);
  if (!cal) {
    const known = calendarsConfig(env).map((c) => c.who).join(", ");
    throw new Error(`No hay calendario configurado para "${who}". Disponibles: ${known}`);
  }
  return cal;
}

// Eventos de los próximos `days` días con id y fecha completos
let rangeCache = { key: "", at: 0, data: null, ver: "" };

export async function agendaRange(env, days = 7) {
  if (!googleConfigured(env)) return withDates(env, exampleRange(days), days); // modo demostración
  const key = String(days);
  const ver = await agendaVersion(env).catch(() => "");
  if (rangeCache.key === key && rangeCache.ver === ver && Date.now() - rangeCache.at < CACHE_MS) return withDates(env, rangeCache.data, days);
  const data = await agendaRangeFresh(env, days);
  rangeCache = { key, at: Date.now(), data, ver };
  return withDates(env, data, days);
}

async function withDates(env, events, days) {
  const dates = await upcomingDates(env, days - 1).catch(() => []);
  if (!dates.length) return events;
  const extra = dates.map((d) => ({ id: d.id, who: "familia", title: d.title, allDay: true, date: d.date, start: null, end: null, type: "birthday" }));
  return [...events, ...extra].sort((a, b) => a.date.localeCompare(b.date));
}

async function agendaRangeFresh(env, days) {
  const now = new Date();
  const todayKey = fKey.format(now);
  const lastKey = addDays(todayKey, Math.max(0, Math.min(30, days - 1)));
  const timeMin = new Date(now.getTime() - 24 * 3600 * 1000);
  const timeMax = new Date(now.getTime() + (days + 1) * 24 * 3600 * 1000);
  const cals = calendarsConfig(env);
  // Un calendario aún no compartido no debe dejar sin agenda al resto
  const lists = await Promise.all(realCals(cals).map(async (cal) => {
    try { return (await listEvents(env, cal.id, timeMin, timeMax)).map((e) => normalize(e, cal, cals)); }
    catch { return []; }
  }));
  return lists.flat()
    .filter((e) => e.endKey >= todayKey && e.dateKey <= lastKey)
    .sort((a, b) => a.sortAt - b.sortAt)
    .map(({ id, who, title, allDay, dateKey, start, end, type }) => ({ id, who, title, allDay, date: dateKey, start, end, type }));
}

function eventBody({ title, date, start, end, allDay }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Fecha no válida (usa AAAA-MM-DD)");
  if (allDay || !start) {
    return { summary: title, start: { date }, end: { date: addDays(date, 1) } };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) throw new Error("Hora de inicio no válida (HH:MM)");
  let endTime = end;
  let endDate = date;
  if (!endTime) {
    const [h, m] = start.split(":").map(Number);
    const t = h * 60 + m + 60;
    endTime = `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    if (t >= 1440) endDate = addDays(date, 1);
  }
  return {
    summary: title,
    start: { dateTime: `${date}T${start}:00`, timeZone: TZ },
    end: { dateTime: `${endDate}T${endTime}:00`, timeZone: TZ },
  };
}

export async function createEvent(env, input) {
  const cal = calendarFor(env, input.who);
  const body = guestBody(cal, eventBody(input));
  if (input.description) body.description = String(input.description).slice(0, 500);
  const e = await gcal(env, `/calendars/${encodeURIComponent(cal.id)}/events`, { method: "POST", body });
  cache = { at: 0, data: null, ver: "" }; rangeCache = { key: "", at: 0, data: null, ver: "" }; await bumpAgenda(env).catch(() => {});
  return { id: e.id, who: cal.who, title: input.title };
}

export async function updateEvent(env, { who, id, ...changes }) {
  const cal = calendarFor(env, who);
  const path = `/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(id)}`;
  const current = normalize(await gcal(env, path), cal, calendarsConfig(env));
  const merged = {
    title: changes.title ?? current.title,
    date: changes.date ?? current.dateKey,
    allDay: changes.allDay ?? current.allDay,
    start: changes.start ?? current.start,
    end: changes.end ?? (changes.start ? undefined : current.end),
  };
  const e = await gcal(env, path, { method: "PATCH", body: guestBody(cal, eventBody(merged)) });
  cache = { at: 0, data: null, ver: "" }; rangeCache = { key: "", at: 0, data: null, ver: "" }; await bumpAgenda(env).catch(() => {});
  return { id: e.id, who: cal.who, title: merged.title };
}

export async function deleteEvent(env, { who, id }) {
  const cal = calendarFor(env, who);
  await gcal(env, `/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(id)}`, { method: "DELETE" });
  cache = { at: 0, data: null, ver: "" }; rangeCache = { key: "", at: 0, data: null, ver: "" }; await bumpAgenda(env).catch(() => {});
  return { deleted: true };
}

// Eventos de ejemplo con fechas reales (para el panel de agenda sin Google)
function exampleRange(days) {
  const today = fKey.format(new Date());
  const ev = (d, who, title, start, end) => ({ id: "ej" + d + start.replace(":", ""), who, title, allDay: false, date: addDays(today, d), start, end, type: "event" });
  return [
    ev(0, "sofia", "Natación", "09:30", "10:30"), ev(0, "familia", "Almuerzo con los abuelos", "13:00", "15:00"),
    ev(0, "sofia", "Fútbol", "17:00", "18:30"), ev(0, "ana", "Llamar al fontanero", "19:30", "20:00"),
    ev(1, "sofia", "Dentista", "08:15", "09:00"), ev(1, "luis", "Reunión de trabajo", "10:00", "11:30"),
    ev(2, "ana", "Reunión de padres", "18:00", "19:00"), ev(3, "luis", "Yoga", "18:30", "19:30"),
    ev(4, "familia", "Cena con amigos", "20:00", "22:30"), ev(6, "sofia", "Partido de fútbol", "11:00", "12:30"),
  ].filter((e) => e.date <= addDays(today, days - 1));
}

function exampleAgenda() {
  return {
    source: "example",
    people: {
      ana: { name: "Ana", color: "#6fa8dc" },
      luis: { name: "Luis", color: "#e58fa0" },
      sofia: { name: "Sofía", color: "#8cc5a0" },
      familia: { name: "Familia", color: "#e8b86a" },
    },
    today: [
      { start: "09:30", end: "10:30", title: "Natación", who: "sofia" },
      { start: "13:00", end: "15:00", title: "Almuerzo con los abuelos", who: "familia" },
      { start: "17:00", end: "18:30", title: "Fútbol", who: "sofia" },
      { start: "19:30", end: "20:00", title: "Llamar al fontanero", who: "ana" },
    ],
    upcoming: [
      { when: "Mañana", title: "Cumpleaños de ejemplo", who: "luis", type: "birthday" },
      { when: "Lun 23", title: "Dentista 08:15", who: "sofia" },
      { when: "Mar 24", title: "Reunión de padres", who: "ana" },
    ],
  };
}
