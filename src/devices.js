// Etapa 7 (opción A): dispositivos Shelly controlados por su API oficial en la nube (v2).
// No hace falta Home Assistant ni ningún equipo encendido en casa.
//
// Secretos de Cloudflare:  SHELLY_AUTH_KEY  y  SHELLY_SERVER (p. ej. "shelly-123-eu.shelly.cloud")
//   (app Shelly → Ajustes de usuario → Authorization cloud key: ahí salen la clave y el servidor)
// Lista de dispositivos en KV "devices":
//   [{ "key": "salon", "name": "Lámpara del salón", "id": "<Device Id>", "type": "switch"|"light", "channel": 0, "room": "Salón" }]
// Límite de Shelly: 1 petición por segundo.

const cfgOk = (env) => Boolean(env.SHELLY_AUTH_KEY && env.SHELLY_SERVER);

export async function listDeviceConfig(env) {
  const v = await env.NEXUS_KV.get("devices", "json");
  return Array.isArray(v) ? v : [];
}

export async function setDeviceConfig(env, list) {
  const clean = [].concat(list || []).slice(0, 30).map((d, i) => {
    if (!d.id || !d.name) throw new Error("Cada dispositivo necesita id y nombre");
    return {
      key: String(d.key || "d" + i).replace(/[^a-z0-9_-]/gi, "").slice(0, 20) || "d" + i,
      name: String(d.name).slice(0, 40),
      id: String(d.id).slice(0, 40),
      type: d.type === "light" ? "light" : "switch",
      channel: Number(d.channel) || 0,
      room: String(d.room || "").slice(0, 30),
    };
  });
  await env.NEXUS_KV.put("devices", JSON.stringify(clean));
  return clean;
}

let lastCall = 0;
async function shelly(env, path, payload) {
  // Respeta el límite de 1 petición/segundo de Shelly
  const wait = lastCall + 1050 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const host = String(env.SHELLY_SERVER).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const res = await fetch(`https://${host}${path}?auth_key=${encodeURIComponent(env.SHELLY_AUTH_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* sin cuerpo */ }
  if (!res.ok) {
    const code = data && data.error;
    const msg = { DEVICE_OFFLINE: "el dispositivo está desconectado", DEVICE_NOT_FOUND: "dispositivo no encontrado" }[code] || code || res.status;
    throw new Error("Shelly: " + msg);
  }
  return data;
}

// Estado de todos los dispositivos (hasta 10 por consulta)
export async function getDevices(env) {
  const list = await listDeviceConfig(env);
  if (!cfgOk(env)) return { configured: false, devices: list.map((d) => ({ ...d, online: null, on: null })) };
  if (!list.length) return { configured: true, devices: [] };
  const ids = [...new Set(list.map((d) => d.id))];
  const states = [];
  for (let i = 0; i < ids.length; i += 10) {
    const r = await shelly(env, "/v2/devices/api/get", { ids: ids.slice(i, i + 10), select: ["status"] });
    if (Array.isArray(r)) states.push(...r);
  }
  const byId = new Map(states.map((s) => [s.id, s]));
  return {
    configured: true,
    devices: list.map((d) => {
      const s = byId.get(d.id);
      const comp = s && s.status && (s.status[`${d.type}:${d.channel}`] || s.status[`switch:${d.channel}`] || s.status[`light:${d.channel}`]);
      return {
        ...d,
        online: s ? Boolean(s.online) : false,
        on: comp ? Boolean(comp.output ?? comp.ison) : null,
        brightness: comp && typeof comp.brightness === "number" ? comp.brightness : null,
      };
    }),
  };
}

// Encender/apagar (y brillo en luces). `who` = key o nombre aproximado
export async function controlDevice(env, who, { on, brightness }) {
  if (!cfgOk(env)) throw new Error("Shelly aún no está configurado");
  const list = await listDeviceConfig(env);
  const q = String(who || "").toLowerCase();
  const d = list.find((x) => x.key === who) || list.find((x) => x.name.toLowerCase().includes(q) || q.includes(x.name.toLowerCase()));
  if (!d) throw new Error(`No conozco el dispositivo "${who}"`);
  if (d.type === "light") {
    const body = { id: d.id, channel: d.channel };
    if (typeof on === "boolean") body.on = on;
    if (typeof brightness === "number") { body.brightness = Math.max(1, Math.min(100, Math.round(brightness))); body.on = true; }
    await shelly(env, "/v2/devices/api/set/light", body);
  } else {
    if (typeof on !== "boolean") throw new Error("Indica encender o apagar");
    await shelly(env, "/v2/devices/api/set/switch", { id: d.id, channel: d.channel, on });
  }
  return { name: d.name, on: brightness ? true : on, brightness: brightness ?? null };
}
