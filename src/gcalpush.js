// Google Calendar al instante: Google avisa al Worker cuando cambia un calendario
// (notificaciones push con "events.watch") y el Worker avisa a la tablet por la conexión en vivo.
// Los canales de aviso caducan (como mucho 1 semana): una tarea programada los renueva.

import { gcal, googleConfigured, calendarsConfig } from "./google.js";

const DAY = 86400000;
const KV_CHANNELS = "gcal:channels";
const KV_ORIGIN = "gcal:origin";
const KV_VER = "gcal:ver";
const KV_ERROR = "gcal:watchError";

// Clave que Google devuelve en cada aviso: así nadie más puede fingir un aviso
export async function pushSecret(env) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gcal-push|" + (env.NEXUS_TOKEN || "")));
  return [...new Uint8Array(h)].slice(0, 20).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Versión de la agenda: cambia con cada aviso; la caché de la agenda la compara para no servir datos viejos
export async function agendaVersion(env) {
  return (await env.NEXUS_KV.get(KV_VER)) || "0";
}
export async function bumpAgenda(env) {
  await env.NEXUS_KV.put(KV_VER, String(Date.now()));
}

// Calendarios reales (no las personas que comparten el calendario de otra, "host")
function watchable(env) {
  return calendarsConfig(env).filter((c) => !c.host && c.id);
}

export async function watchStatus(env) {
  const channels = (await env.NEXUS_KV.get(KV_CHANNELS, "json")) || [];
  const err = await env.NEXUS_KV.get(KV_ERROR, "json");
  return { channels: channels.map((c) => ({ who: c.who, expira: new Date(c.exp).toISOString() })), error: err };
}

// Crea (o renueva) un canal por calendario. origin: "https://<tu-worker>.workers.dev"
export async function startWatches(env, origin) {
  if (!googleConfigured(env)) return { ok: false, error: "Google Calendar no está configurado" };
  if (origin) await env.NEXUS_KV.put(KV_ORIGIN, origin);
  origin = origin || (await env.NEXUS_KV.get(KV_ORIGIN));
  if (!origin) return { ok: false, error: "Falta la dirección del Worker" };
  const old = (await env.NEXUS_KV.get(KV_CHANNELS, "json")) || [];
  const token = await pushSecret(env);
  const fresh = [], errors = [];
  for (const cal of watchable(env)) {
    try {
      const id = "nexus-" + cal.who + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const r = await gcal(env, `/calendars/${encodeURIComponent(cal.id)}/events/watch`, {
        method: "POST",
        body: { id, type: "web_hook", address: origin + "/gcal/push", token, params: { ttl: String(7 * 24 * 3600) } },
      });
      fresh.push({ id: r.id, resourceId: r.resourceId, who: cal.who, exp: Number(r.expiration) || Date.now() + 6 * DAY });
    } catch (e) {
      errors.push(`${cal.who}: ${e.message}`);
    }
  }
  // Los canales antiguos se cierran (si ya caducaron, Google responde con error y no pasa nada)
  for (const c of old) {
    try { await gcal(env, "/channels/stop", { method: "POST", body: { id: c.id, resourceId: c.resourceId } }); } catch { /* ya no existía */ }
  }
  await env.NEXUS_KV.put(KV_CHANNELS, JSON.stringify(fresh));
  if (errors.length) await env.NEXUS_KV.put(KV_ERROR, JSON.stringify({ at: Date.now(), errors }));
  else await env.NEXUS_KV.delete(KV_ERROR);
  return { ok: !errors.length, canales: fresh.length, errors };
}

// Tarea programada (y arranque): renovar si falta algún canal o caducan en menos de 2 días.
// Si Google dio error hace poco, no se insiste más de una vez cada 6 horas.
export async function ensureWatches(env, origin) {
  if (!googleConfigured(env)) return null;
  const channels = (await env.NEXUS_KV.get(KV_CHANNELS, "json")) || [];
  const needed = watchable(env).length;
  const soon = channels.some((c) => c.exp - Date.now() < 2 * DAY);
  if (channels.length >= needed && !soon) return null;
  const err = await env.NEXUS_KV.get(KV_ERROR, "json");
  if (err && Date.now() - err.at < 6 * 3600000 && channels.length) return null;
  if (err && Date.now() - err.at < 6 * 3600000 && !origin) return null;
  return startWatches(env, origin);
}

// Aviso de Google: comprobar la clave y marcar la agenda como cambiada
export async function handlePush(request, env) {
  if (request.headers.get("X-Goog-Channel-Token") !== (await pushSecret(env))) return false;
  const state = request.headers.get("X-Goog-Resource-State");
  if (state === "sync") return "sync"; // primer mensaje al crear el canal: no hay cambios
  await bumpAgenda(env);
  return "changed";
}
