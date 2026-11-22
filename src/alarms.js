// Alarmas guardadas en Cloudflare KV (clave "alarms").
// Formato de cada alarma:
// { id, time: "06:30", days: [1,2,3,4,5] (0=domingo; vacío = una sola vez),
//   label, enabled, routine (mostrar clima y agenda al sonar) }

const KEY = "alarms";
const MAX_ALARMS = 20;

const DEFAULTS = [
  { id: "a1", time: "06:30", days: [1, 2, 3, 4, 5], label: "Rutina de mañana", enabled: true, routine: true },
];

export async function listAlarms(env) {
  const raw = await env.NEXUS_KV.get(KEY, "json");
  return Array.isArray(raw) ? raw : DEFAULTS;
}

async function saveAll(env, alarms) {
  await env.NEXUS_KV.put(KEY, JSON.stringify(alarms));
  return alarms;
}

// Valida y limpia lo que llega del cliente. Lanza Error con mensaje claro.
function clean(input, id) {
  const time = String(input.time || "");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Hora no válida (usa HH:MM)");
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];
  const label = String(input.label || "").trim().slice(0, 40) || "Alarma";
  return { id, time, days, label, enabled: input.enabled !== false, routine: input.routine !== false };
}

export async function createAlarm(env, input) {
  const alarms = await listAlarms(env);
  if (alarms.length >= MAX_ALARMS) throw new Error("Máximo " + MAX_ALARMS + " alarmas");
  const alarm = clean(input, "a" + Date.now().toString(36));
  return saveAll(env, [...alarms, alarm]);
}

export async function updateAlarm(env, id, input) {
  const alarms = await listAlarms(env);
  const i = alarms.findIndex((a) => a.id === id);
  if (i < 0) throw new Error("Alarma no encontrada");
  alarms[i] = clean({ ...alarms[i], ...input }, id);
  return saveAll(env, alarms);
}

export async function deleteAlarm(env, id) {
  const alarms = await listAlarms(env);
  return saveAll(env, alarms.filter((a) => a.id !== id));
}
