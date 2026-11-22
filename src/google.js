// Acceso a Google Calendar con una cuenta de servicio (sin caducidad semanal).
// Secretos necesarios en Cloudflare:
//   GOOGLE_SA         -> contenido completo del JSON de la cuenta de servicio
//   GOOGLE_CALENDARS  -> [{ "who":"ana", "name":"Ana", "color":"#6fa8dc", "id":"correo@gmail.com" }, ...]
//                        "birthdays": true marca un calendario de cumpleaños.

const SCOPE = "https://www.googleapis.com/auth/calendar";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

let tokenCache = { token: null, exp: 0 };

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

async function importKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export function googleConfigured(env) {
  return Boolean(env.GOOGLE_SA && env.GOOGLE_CALENDARS);
}

export function calendarsConfig(env) {
  return JSON.parse(env.GOOGLE_CALENDARS);
}

async function accessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const sa = JSON.parse(env.GOOGLE_SA);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlText(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const key = await importKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${b64url(sig)}` }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("Google rechazó la cuenta de servicio: " + (j.error_description || j.error));
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tokenCache.token;
}

export async function gcal(env, path, opts = {}) {
  const token = await accessToken(env);
  const res = await fetch(API + path, {
    method: opts.method || "GET",
    headers: { Authorization: "Bearer " + token, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const j = await res.json();
  if (!res.ok) {
    const msg = (j.error && j.error.message) || res.status;
    throw new Error(`Google Calendar (${path.split("?")[0]}): ${msg}`);
  }
  return j;
}

// Eventos de un calendario entre dos instantes (eventos recurrentes ya expandidos)
export async function listEvents(env, calendarId, timeMin, timeMax) {
  const q = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
  });
  const j = await gcal(env, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
  return (j.items || []).filter((e) => e.status !== "cancelled");
}
