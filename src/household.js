// Datos de la casa guardados en Cloudflare KV:
// temporizadores, lista de la compra, notas familiares y calendario de recogida de basura.

const TZ = "Europe/Stockholm";
const fKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const clip = (s, n) => String(s || "").trim().slice(0, n);

async function getList(env, key) {
  const v = await env.NEXUS_KV.get(key, "json");
  return Array.isArray(v) ? v : [];
}
const putList = (env, key, list) => env.NEXUS_KV.put(key, JSON.stringify(list));

// ---------- Temporizadores ----------
export async function listTimers(env) {
  const now = Date.now();
  const all = await getList(env, "timers");
  const alive = all.filter((t) => t.endsAt > now - 10 * 60 * 1000); // los vencidos se limpian a los 10 min
  if (alive.length !== all.length) await putList(env, "timers", alive);
  return alive;
}

export async function createTimer(env, { seconds, label }) {
  const s = Math.round(Number(seconds));
  if (!(s >= 5 && s <= 24 * 3600)) throw new Error("Duración no válida (entre 5 segundos y 24 horas)");
  const timers = await listTimers(env);
  if (timers.length >= 10) throw new Error("Máximo 10 temporizadores");
  const t = { id: "t" + uid(), label: clip(label, 30) || "Temporizador", seconds: s, endsAt: Date.now() + s * 1000 };
  await putList(env, "timers", [...timers, t]);
  return t;
}

export async function deleteTimer(env, id) {
  const timers = await listTimers(env);
  const left = id === "all" ? [] : timers.filter((t) => t.id !== id);
  await putList(env, "timers", left);
  return left;
}

// ---------- Lista de la compra ----------
export const listShopping = (env) => getList(env, "shopping");

export async function addShopping(env, items) {
  const list = await listShopping(env);
  const have = new Set(list.map((i) => i.text.toLowerCase()));
  for (const raw of [].concat(items)) {
    const text = clip(raw, 60);
    if (text && !have.has(text.toLowerCase())) { list.push({ id: "s" + uid(), text, done: false }); have.add(text.toLowerCase()); }
  }
  if (list.length > 80) throw new Error("La lista está llena (80 artículos)");
  await putList(env, "shopping", list);
  return list;
}

export async function updateShopping(env, id, patch) {
  const list = await listShopping(env);
  const it = list.find((i) => i.id === id);
  if (!it) throw new Error("Artículo no encontrado");
  if (typeof patch.done === "boolean") it.done = patch.done;
  await putList(env, "shopping", list);
  return list;
}

// Quita por id o por texto aproximado; "comprados" o "todo" vacían en bloque
export async function removeShopping(env, which) {
  let list = await listShopping(env);
  const w = String(which || "").toLowerCase().trim();
  if (w === "todo") list = [];
  else if (w === "comprados") list = list.filter((i) => !i.done);
  else list = list.filter((i) => i.id !== which && !i.text.toLowerCase().includes(w));
  await putList(env, "shopping", list);
  return list;
}

// ---------- Notas familiares ----------
export const listNotes = (env) => getList(env, "notes");

export async function addNote(env, { to, text, from }) {
  const notes = await listNotes(env);
  const n = { id: "n" + uid(), to: clip(to, 20) || "Todos", text: clip(text, 160), from: clip(from, 20), at: Date.now() };
  if (!n.text) throw new Error("La nota está vacía");
  await putList(env, "notes", [...notes, n].slice(-10));
  return n;
}

export async function deleteNote(env, id) {
  const left = (await listNotes(env)).filter((n) => n.id !== id && id !== "all");
  await putList(env, "notes", left);
  return left;
}

// ---------- Ajustes (modo noche manual) ----------
export async function getSettings(env) {
  return (await env.NEXUS_KV.get("settings", "json")) || {};
}

// Minutos que faltan para las HH:MM de Suecia (la próxima vez que lleguen)
function msUntil(hhmm) {
  const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
  const [h, m] = fmt.format(new Date()).split(":").map(Number);
  const [th, tm] = hhmm.split(":").map(Number);
  let diff = th * 60 + tm - (h * 60 + m);
  if (diff <= 0) diff += 1440;
  return diff * 60 * 1000;
}

// Hora de despertar de la próxima mañana: 07:00 de lunes a viernes, 08:00 sábado y domingo
function msUntilWake() {
  const d = new Date();
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = DAYS.indexOf(new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(d));
  const [h, m] = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(d).split(":").map(Number);
  const wakeMin = (dow) => (dow === 0 || dow === 6 ? 8 * 60 : 7 * 60);
  const target = h * 60 + m < wakeMin(today) ? wakeMin(today) : wakeMin((today + 1) % 7);
  return msUntil(`${String(Math.floor(target / 60)).padStart(2, "0")}:${String(target % 60).padStart(2, "0")}`);
}

// accion: "desactivar" (hasta la próxima mañana), "activar" (hasta la hora de despertar) o "auto" (horario normal)
export async function setNightMode(env, accion) {
  const s = await getSettings(env);
  const until = Date.now() + msUntilWake();
  if (accion === "desactivar") s.night = { offUntil: until };
  else if (accion === "activar") s.night = { onUntil: until };
  else s.night = {};
  await env.NEXUS_KV.put("settings", JSON.stringify(s));
  return s.night;
}

// ---------- Recogida de basura ----------
// Cada regla: { type: "Restavfall", weekday: 0-6 (0=domingo), everyWeeks: 1-8, first: "AAAA-MM-DD" }
export const listGarbage = (env) => getList(env, "garbage");

export async function setGarbage(env, rules) {
  const clean = [].concat(rules || []).slice(0, 8).map((r) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.first || "")) throw new Error("Fecha de la próxima recogida no válida (AAAA-MM-DD)");
    const every = Math.round(Number(r.everyWeeks) || 1);
    if (every < 1 || every > 8) throw new Error("Frecuencia no válida (de 1 a 8 semanas)");
    return { type: clip(r.type, 30) || "Basura", everyWeeks: every, first: r.first };
  });
  await putList(env, "garbage", clean);
  return clean;
}

const addDays = (key, n) => { const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000);

// Próximas recogidas a partir de hoy, ordenadas
export async function nextPickups(env) {
  const today = fKey.format(new Date());
  const rules = await listGarbage(env);
  return rules.map((r) => {
    const step = r.everyWeeks * 7;
    let diff = daysBetween(r.first, today);
    let date = r.first;
    if (diff > 0) date = addDays(r.first, Math.ceil(diff / step) * step);
    return { type: r.type, date, inDays: daysBetween(today, date) };
  }).sort((a, b) => a.inDays - b.inDays);
}

// ---------- Fechas importantes (cumpleaños, aniversarios…) ----------
// { id, name: "Ana", kind: "cumpleaños" | "aniversario" | "fecha", md: "MM-DD", year?: 1990 }
export const listDates = (env) => getList(env, "dates");

export async function addDate(env, { name, date, kind }) {
  const n = clip(name, 40);
  if (!n) throw new Error("Falta el nombre");
  const m = String(date || "").match(/^(?:(\d{4})-)?(\d{2})-(\d{2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) throw new Error("Fecha no válida (AAAA-MM-DD o MM-DD)");
  const k = ["cumpleaños", "aniversario", "fecha"].includes(kind) ? kind : "cumpleaños";
  const list = (await listDates(env)).filter((d) => !(d.name.toLowerCase() === n.toLowerCase() && d.kind === k));
  if (list.length >= 60) throw new Error("Máximo 60 fechas");
  const d = { id: "d" + uid(), name: n, kind: k, md: `${m[2]}-${m[3]}`, year: m[1] ? Number(m[1]) : null };
  await putList(env, "dates", [...list, d]);
  return d;
}

export async function deleteDate(env, which) {
  const q = String(which || "").toLowerCase().trim();
  const list = await listDates(env);
  const left = list.filter((d) => d.id !== which && !d.name.toLowerCase().includes(q));
  if (left.length === list.length) throw new Error(`No encuentro la fecha "${which}"`);
  await putList(env, "dates", left);
  return left;
}

// Próximas fechas en los siguientes `days` días: [{ id, name, kind, date, inDays, age, title }]
export async function upcomingDates(env, days = 30) {
  const today = fKey.format(new Date());
  const year = Number(today.slice(0, 4));
  const out = [];
  for (const d of await listDates(env)) {
    for (const y of [year, year + 1]) {
      const date = `${y}-${d.md}`;
      const inDays = daysBetween(today, date);
      if (inDays < 0 || inDays > days) continue;
      const age = d.year ? y - d.year : null;
      const title = d.kind === "cumpleaños" ? `Cumpleaños de ${d.name}${age ? ` (${age})` : ""}`
        : d.kind === "aniversario" ? `Aniversario: ${d.name}${age ? ` (${age} años)` : ""}` : d.name;
      out.push({ id: d.id, name: d.name, kind: d.kind, date, inDays, age, title });
      break;
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}
