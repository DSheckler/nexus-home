// Recordatorios con fecha y hora, tareas de la casa con turnos y enlaces de invitado.
// Todo en Cloudflare KV.

import { config } from "./config.js";

const TZ = "Europe/Stockholm";
const fKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
const fParts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fWhen = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const clip = (s, n) => String(s || "").trim().slice(0, n);
const DAY = 86400000;

async function getList(env, key) {
  const v = await env.NEXUS_KV.get(key, "json");
  return Array.isArray(v) ? v : [];
}
const putList = (env, key, list) => env.NEXUS_KV.put(key, JSON.stringify(list));

// Fecha y hora de Suecia ("2026-11-26", "18:00") → instante (ms), con el horario de verano correcto
export function stockholmToMs(date, time) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms) => {
    const p = Object.fromEntries(fParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms); // segunda vuelta por si cae en el cambio de hora
  return ms;
}
export const todayKey = () => fKey.format(new Date());
export const addDays = (key, n) => new Date(Date.parse(key + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / DAY);
export const whenText = (ms) => fWhen.format(new Date(ms));

// ---------- recordatorios ----------
// [{ id, text, at (ms), who }]. Los que ya sonaron se borran desde la tablet; los muy viejos, solos.
export async function listReminders(env) {
  const all = await getList(env, "reminders");
  const alive = all.filter((r) => r.at > Date.now() - 2 * DAY);
  if (alive.length !== all.length) await putList(env, "reminders", alive);
  return alive.sort((a, b) => a.at - b.at);
}

export async function addReminder(env, { text, date, time, at, who }) {
  const t = clip(text, 120);
  if (!t) throw new Error("Falta qué recordar");
  let ms = Number(at);
  if (!ms) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || !/^\d{1,2}:\d{2}$/.test(String(time || ""))) throw new Error("Fecha u hora no válidas (AAAA-MM-DD y HH:MM)");
    ms = stockholmToMs(date, time.padStart(5, "0"));
  }
  if (!(ms > Date.now() - 60000)) throw new Error("Esa hora ya ha pasado");
  if (ms > Date.now() + 366 * DAY) throw new Error("Como máximo, con un año de antelación");
  const list = await listReminders(env);
  if (list.length >= 50) throw new Error("Máximo 50 recordatorios");
  const r = { id: "r" + uid(), text: t, at: ms, who: clip(who, 30) || null };
  await putList(env, "reminders", [...list, r]);
  return r;
}

export async function deleteReminder(env, which) {
  const q = String(which || "").toLowerCase().trim();
  const list = await listReminders(env);
  const left = list.filter((r) => r.id !== which && !(q.length > 2 && r.text.toLowerCase().includes(q)));
  if (left.length === list.length) throw new Error(`No encuentro el recordatorio "${which}"`);
  await putList(env, "reminders", left);
  return left;
}

// ---------- tareas de la casa ----------
// [{ id, name, every (días), people: [nombres], turn, last: "AAAA-MM-DD" | null }]
function withDue(c, today) {
  const due = c.last ? addDays(c.last, c.every) : today;
  const who = c.people && c.people.length ? c.people[(c.turn || 0) % c.people.length] : null;
  return { ...c, due, dueIn: daysBetween(today, due), who };
}

export async function listChores(env) {
  const today = todayKey();
  return (await getList(env, "chores")).map((c) => withDue(c, today)).sort((a, b) => a.dueIn - b.dueIn);
}

export async function addChore(env, { name, every, people }) {
  const n = clip(name, 40);
  if (!n) throw new Error("Falta el nombre de la tarea");
  const e = Math.round(Number(every));
  if (!(e >= 1 && e <= 365)) throw new Error("Cada cuántos días: entre 1 y 365");
  const fam = config().family || [];
  const ppl = (Array.isArray(people) ? people : String(people || "").split(/,| y /)).map((p) => clip(p, 30)).filter(Boolean)
    .map((p) => fam.find((f) => f.toLowerCase() === p.toLowerCase()) || p).slice(0, 8);
  const list = (await getList(env, "chores")).filter((c) => c.name.toLowerCase() !== n.toLowerCase());
  if (list.length >= 30) throw new Error("Máximo 30 tareas");
  const c = { id: "c" + uid(), name: n, every: e, people: ppl, turn: 0, last: null };
  await putList(env, "chores", [...list, c]);
  return withDue(c, todayKey());
}

function findChore(list, which) {
  const q = String(which || "").toLowerCase().trim();
  return list.find((c) => c.id === which) || list.find((c) => c.name.toLowerCase() === q)
    || list.find((c) => q.length > 2 && (c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase())));
}

export async function doneChore(env, which) {
  const list = await getList(env, "chores");
  const c = findChore(list, which);
  if (!c) throw new Error(`No encuentro la tarea "${which}"`);
  const doneBy = c.people && c.people.length ? c.people[(c.turn || 0) % c.people.length] : null;
  c.last = todayKey();
  c.turn = c.people && c.people.length ? ((c.turn || 0) + 1) % c.people.length : 0;
  await putList(env, "chores", list);
  return { done: withDue(c, todayKey()), doneBy };
}

export async function deleteChore(env, which) {
  const list = await getList(env, "chores");
  const c = findChore(list, which);
  if (!c) throw new Error(`No encuentro la tarea "${which}"`);
  await putList(env, "chores", list.filter((x) => x !== c));
  return listChores(env);
}

// ---------- invitados ----------
// Enlace temporal para que una visita use la lista de la compra y las notas. La clave se guarda
// en KV con caducidad ("guest:<clave>") y en una lista para poder verla y revocarla.
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function listGuests(env) {
  const all = await getList(env, "guests");
  const alive = all.filter((g) => g.expires > Date.now());
  if (alive.length !== all.length) await putList(env, "guests", alive);
  return alive;
}

export async function createGuest(env, { hours, name }) {
  const h = Math.min(Math.max(Math.round(Number(hours) || 24), 1), 24 * 14);
  const list = await listGuests(env);
  if (list.length >= 10) throw new Error("Máximo 10 enlaces de invitado a la vez");
  const g = { id: "g" + uid(), token: hex(24), name: clip(name, 30) || "Invitado", expires: Date.now() + h * 3600000 };
  await env.NEXUS_KV.put("guest:" + g.token, JSON.stringify({ id: g.id, name: g.name }), { expirationTtl: Math.max(60, h * 3600) });
  await putList(env, "guests", [...list, g]);
  return g;
}

export async function deleteGuest(env, id) {
  const list = await listGuests(env);
  const g = list.find((x) => x.id === id);
  if (!g) throw new Error("Ese enlace ya no existe");
  await env.NEXUS_KV.delete("guest:" + g.token);
  await putList(env, "guests", list.filter((x) => x !== g));
  return list.filter((x) => x !== g);
}

export async function isGuest(env, key) {
  if (!/^[a-f0-9]{48}$/.test(key || "")) return false;
  return !!(await env.NEXUS_KV.get("guest:" + key));
}
