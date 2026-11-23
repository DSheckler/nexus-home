// Datos de la casa guardados en Cloudflare KV:
// temporizadores, lista de compras, notas familiares y calendario de recogida de basura.

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

// ---------- Lista de compras ----------
export const listShopping = (env) => getList(env, "shopping");

export async function addShopping(env, items) {
  const list = await listShopping(env);
  if (![].concat(items).some((x) => clip(x, 60))) throw new Error("Escribe qué hay que agregar");
  const have = new Map(list.map((i) => [i.text.toLowerCase(), i]));
  for (const raw of [].concat(items)) {
    const text = clip(raw, 60);
    if (!text) continue;
    const old = have.get(text.toLowerCase());
    if (old) { old.done = false; continue; } // ya estaba (quizá como comprado): vuelve a estar pendiente
    const it = { id: "s" + uid(), text, done: false };
    list.push(it); have.set(text.toLowerCase(), it);
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

const MAX_NOTES = 10;
const VOICE_DAYS = 14;               // el audio de una nota de voz se borra solo a los 14 días
export const VOICE_MAX_BYTES = 1.5 * 1024 * 1024;
const voiceKey = (id) => "voice:" + id;

// Guarda la lista y borra el audio de las notas de voz que salen de ella
async function saveNotes(env, before, after) {
  await putList(env, "notes", after);
  const keep = new Set(after.map((n) => n.id));
  await Promise.all(before.filter((n) => n.kind === "voice" && !keep.has(n.id)).map((n) => env.NEXUS_KV.delete(voiceKey(n.id)).catch(() => {})));
}

export async function addNote(env, { to, text, from }) {
  const notes = await listNotes(env);
  const n = { id: "n" + uid(), to: clip(to, 20) || "Todos", text: clip(text, 160), from: clip(from, 20), at: Date.now() };
  if (!n.text) throw new Error("La nota está vacía");
  await saveNotes(env, notes, [...notes, n].slice(-MAX_NOTES));
  return n;
}

// Nota de voz: el audio va aparte en KV (las notas solo guardan sus datos)
export async function addVoiceNote(env, { to, from, seconds, mime, audio }) {
  if (!audio || audio.byteLength < 500) throw new Error("La grabación está vacía");
  if (audio.byteLength > VOICE_MAX_BYTES) throw new Error("La nota de voz es demasiado larga");
  if (!/^audio\/[a-z0-9.+-]+(;.*)?$/i.test(mime || "")) throw new Error("Formato de audio no válido");
  const notes = await listNotes(env);
  const n = {
    id: "n" + uid(), kind: "voice", to: clip(to, 20) || "Todos", from: clip(from, 20), text: "Nota de voz",
    seconds: Math.max(1, Math.min(120, Math.round(Number(seconds) || 0))), at: Date.now(),
  };
  await env.NEXUS_KV.put(voiceKey(n.id), audio, { expirationTtl: VOICE_DAYS * 86400, metadata: { mime: mime.split(";")[0] } });
  await saveNotes(env, notes, [...notes, n].slice(-MAX_NOTES));
  return n;
}

export async function getVoiceAudio(env, id) {
  const r = await env.NEXUS_KV.getWithMetadata(voiceKey(id), "arrayBuffer");
  return r && r.value ? { audio: r.value, mime: (r.metadata && r.metadata.mime) || "audio/mp4" } : null;
}

export async function deleteNote(env, id) {
  const notes = await listNotes(env);
  const left = notes.filter((n) => n.id !== id && id !== "all");
  await saveNotes(env, notes, left);
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
  if (list.filter((d) => d.src !== "iphone").length >= 60) throw new Error("Máximo 60 fechas");
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

// Cumpleaños de los contactos del iPhone (los envía un Atajo). Sustituye la importación
// anterior; las fechas guardadas a mano no se tocan y tienen prioridad.
// items: [{ name, date }] con date "AAAA-MM-DD" (el iPhone pone 1604 si no hay año), "MM-DD" o "--MM-DD"
export function parseDateLines(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(.+?)\s*[;:\t|]\s*(\S+)$/);
    return m ? { name: m[1], date: m[2] } : null;
  }).filter(Boolean);
}
export async function importDates(env, items) {
  if (!Array.isArray(items)) throw new Error("Lista de cumpleaños no válida");
  const manual = (await listDates(env)).filter((d) => d.src !== "iphone");
  const taken = new Set(manual.map((d) => d.name.toLowerCase()));
  const seen = new Set();
  const out = [];
  let skipped = 0;
  for (const it of items.slice(0, 1000)) {
    const name = clip(it && it.name, 40);
    const raw = String((it && it.date) || "").trim();
    let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/) || raw.match(/^-{0,2}()(\d{2})-(\d{2})$/);
    if (!m) { const e = raw.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$/); if (e) m = [raw, e[3] || "", e[2].padStart(2, "0"), e[1].padStart(2, "0")]; }
    if (!name || !m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) { skipped++; continue; }
    const key = name.toLowerCase();
    if (taken.has(key) || seen.has(key)) { skipped++; continue; }
    seen.add(key);
    const year = m[1] && +m[1] >= 1900 ? +m[1] : null; // 1604 = cumpleaños sin año en el iPhone
    out.push({ id: "d" + uid(), name, kind: "cumpleaños", md: `${m[2]}-${m[3]}`, year, src: "iphone" });
    if (out.length >= 400) break;
  }
  await putList(env, "dates", [...manual, ...out]);
  return { imported: out.length, skipped, manual: manual.length };
}

// Próximas fechas en los siguientes `days` días: [{ id, name, kind, date, inDays, age, title, src }]
// Los cumpleaños importados del iPhone solo salen si faltan 7 días o menos (para no llenar la
// agenda de conocidos), salvo cuando se piden todas (days >= 366).
export async function upcomingDates(env, days = 30) {
  const today = fKey.format(new Date());
  const year = Number(today.slice(0, 4));
  const out = [];
  for (const d of await listDates(env)) {
    for (const y of [year, year + 1]) {
      const date = `${y}-${d.md}`;
      const inDays = daysBetween(today, date);
      if (inDays < 0 || inDays > days) continue;
      if (d.src === "iphone" && days < 366 && inDays > 7) break;
      const age = d.year ? y - d.year : null;
      const title = d.kind === "cumpleaños" ? `Cumpleaños de ${d.name}${age ? ` (${age})` : ""}`
        : d.kind === "aniversario" ? `Aniversario: ${d.name}${age ? ` (${age} años)` : ""}` : d.name;
      out.push({ id: d.id, name: d.name, kind: d.kind, date, inDays, age, title, src: d.src || null });
      break;
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}
