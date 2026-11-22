// NEXUS Home - Backend (Cloudflare Worker)
// Las claves (Google, tablet) se guardan como "secrets" de Cloudflare
// y solo se usan aquí; nunca van en /public.

import { getWeather, getWeatherDetail } from "./weather.js";
import { getAgenda, agendaRange, createEvent, deleteEvent } from "./calendar.js";
import { listAlarms, createAlarm, updateAlarm, deleteAlarm } from "./alarms.js";
import { askAssistant } from "./assistant.js";
import { getUsage, addUsage, VOICE_LIMIT, DAILY_FREE } from "./usage.js";
import * as H from "./household.js";
import { getPower, getWarnings, getBriefing, getEveningBriefing } from "./extras.js";
import { getDevices, controlDevice, setDeviceConfig } from "./devices.js";
import { loadConfig, config } from "./config.js";

// Cambiar en cada publicación: la tablet se recarga sola al detectarlo.
const VERSION = "1.10.0";

// Todo lo de la casa en una sola petición para el panel
async function homeSnapshot(env) {
  const safe = (p) => p.catch(() => null);
  const [timers, shopping, notes, garbage, power, warnings, settings, dates] = await Promise.all([
    safe(H.listTimers(env)), safe(H.listShopping(env)), safe(H.listNotes(env)),
    safe(H.nextPickups(env)), safe(getPower()), safe(getWarnings()), safe(H.getSettings(env)), safe(H.upcomingDates(env, 7)),
  ]);
  const ai = { used: await getUsage(env).catch(() => 0), free: DAILY_FREE };
  return { timers, shopping, notes, garbage, power, warnings, settings, dates, ai, now: Date.now() };
}

const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // ~1 minuto de voz comprimida
const TTS_MODEL = "@cf/deepgram/aura-2-es";
const TTS_NEURONS_PER_CHAR = 2.7273;     // 2727,27 neuronas por 1.000 caracteres
const STT_NEURONS = 5;                    // una frase corta (~47 neuronas por minuto de audio)
const WAKE_LIMIT = 8000;                  // por encima, la escucha "Oye NEXUS" se pausa hasta mañana
const TTS_MAX_CHARS = 220;                // textos más largos (p. ej. el resumen) se leen con la voz de la tablet

const json = (data, status = 200, maxAge = 0) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": maxAge ? `private, max-age=${maxAge}` : "no-store" },
  });

// Voz a texto con Whisper en Workers AI. La pista (nombres de la familia y la ciudad) mejora nombres propios.
const whisperPrompt = () => `Oye NEXUS. ${config().family.join(", ")}. ${config().city}.`;

async function whisper(env, base64, count = true) {
  const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: base64, language: "es", initial_prompt: whisperPrompt(),
  });
  if (count) await addUsage(env, STT_NEURONS);
  return (r.text || "").trim();
}

function toBase64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function transcribe(request, env, count = true) {
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) throw new Error("No llegó audio");
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new Error("Grabación demasiado larga");
  return whisper(env, toBase64(buf), count);
}

// Un turno de conversación completo en una sola petición:
// audio -> texto (Whisper) -> respuesta (asistente). Ahorra viajes de ida y vuelta.
async function voiceTurn(request, env) {
  const { audio, history } = await body(request);
  if (!audio || typeof audio !== "string") throw new Error("No llegó audio");
  if (audio.length > MAX_AUDIO_BYTES * 1.4) throw new Error("Grabación demasiado larga");
  const text = await whisper(env, audio);
  if (!text) return { text: "" };
  const r = await askAssistant(env, { text, history });
  await addUsage(env, r.neurons);
  return { text, ...r };
}

// Texto a voz natural (Deepgram Aura-2, español). Si la cuota del día va alta,
// responde 429 y la tablet usa su propia voz.
// Las frases cortas ya dichas se guardan en KV (30 días): repetir "Hasta luego" o
// "Temporizador creado" no vuelve a gastar cuota. (La caché HTTP no funciona en workers.dev.)
const TTS_CACHE_DAYS = 30;
const TTS_CACHE_MAX_CHARS = 140;

async function ttsCacheKey(voice, text) {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(voice + "|" + norm));
  return "tts:" + voice + ":" + [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function speak(request, env, ctx) {
  const { text } = await body(request);
  const clean = String(text || "").trim().slice(0, 600);
  if (!clean) throw new Error("Texto vacío");
  if (clean.length > TTS_MAX_CHARS) return json({ ok: false, error: "long" }, 413);
  const voice = env.TTS_VOICE || "celeste";
  const cacheable = clean.length <= TTS_CACHE_MAX_CHARS;
  const key = cacheable ? await ttsCacheKey(voice, clean) : null;
  if (key) {
    const hit = await env.NEXUS_KV.get(key, "arrayBuffer").catch(() => null);
    if (hit) return new Response(hit, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Nexus-Tts": "cache" } });
  }
  const cost = clean.length * TTS_NEURONS_PER_CHAR;
  if ((await getUsage(env)) + cost > VOICE_LIMIT) return json({ ok: false, error: "quota" }, 429);
  const audio = await env.AI.run(TTS_MODEL, { text: clean, speaker: voice, encoding: "mp3" });
  await addUsage(env, cost);
  if (!key) return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  // Una copia va a la tablet (en streaming) y otra se guarda
  const [toClient, toCache] = audio.tee();
  const save = new Response(toCache).arrayBuffer()
    .then((buf) => env.NEXUS_KV.put(key, buf, { expirationTtl: TTS_CACHE_DAYS * 86400 }))
    .catch(() => {});
  if (ctx) ctx.waitUntil(save);
  return new Response(toClient, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Nexus-Tts": "new" } });
}

// Comparación en tiempo constante para no filtrar la clave por tiempos
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Dos claves: la de la tablet (acceso completo) y la familiar (solo compra y notas,
// para los móviles). Si se pierde un móvil, basta con cambiar la familiar.
function scopeOf(request, env) {
  const key = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (env.NEXUS_TOKEN && safeEqual(key, env.NEXUS_TOKEN)) return "full";
  if (env.FAMILY_TOKEN && safeEqual(key, env.FAMILY_TOKEN)) return "family";
  return null;
}
const FAMILY_PATHS = /^\/api\/(shopping|notes|config)(\/[a-z0-9]{1,20})?$/;

async function body(request) {
  try { return await request.json(); } catch { throw new Error("Cuerpo JSON no válido"); }
}

async function handleApi(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method;

  // Público: solo la comprobación de estado
  if (path === "/api/health") {
    return json({ ok: true, service: "nexus-home", version: VERSION, time: new Date().toISOString() });
  }

  // Todo lo demás exige una clave; la familiar solo sirve para compra y notas
  const scope = scopeOf(request, env);
  if (!scope) return json({ ok: false, error: "unauthorized" }, 401);
  if (scope === "family" && !FAMILY_PATHS.test(path)) return json({ ok: false, error: "forbidden" }, 403);

  if (path === "/api/weather" && method === "GET") {
    return json({ ok: true, ...(await getWeather()) }, 200, 300);
  }
  if (path === "/api/weather/detail" && method === "GET") {
    return json({ ok: true, ...(await getWeatherDetail()) }, 200, 300);
  }
  if (path === "/api/agenda" && method === "GET") {
    return json({ ok: true, ...(await getAgenda(env)) });
  }
  // Panel de agenda interactivo: 14 días con id, y crear/borrar eventos
  if (path === "/api/agenda/range" && method === "GET") {
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days")) || 14));
    return json({ ok: true, events: await agendaRange(env, days), people: (await getAgenda(env)).people });
  }
  if (path === "/api/agenda/events" && method === "POST") {
    const b = await body(request);
    const title = String(b.title || "").trim().slice(0, 120);
    if (!title) throw new Error("Falta el título");
    return json({ ok: true, event: await createEvent(env, { who: b.who, title, date: b.date, start: b.start || undefined, end: b.end || undefined, allDay: !b.start }) }, 201);
  }
  let me = path.match(/^\/api\/agenda\/events\/([a-z]{1,20})\/([A-Za-z0-9_]{1,200})$/);
  if (me && method === "DELETE") return json({ ok: true, ...(await deleteEvent(env, { who: me[1], id: me[2] })) });

  if (path === "/api/transcribe" && method === "POST") {
    // ?wake=1: fragmento corto de la escucha en espera ("Oye NEXUS").
    // Se corta antes de agotar la cuota para que el asistente siga respondiendo.
    if (url.searchParams.get("wake") && (await getUsage(env)) > WAKE_LIMIT) {
      return json({ ok: false, error: "quota" }, 429);
    }
    return json({ ok: true, text: await transcribe(request, env, !url.searchParams.get("wake")) });
  }
  if (path === "/api/assistant" && method === "POST") {
    const r = await askAssistant(env, await body(request));
    await addUsage(env, r.neurons);
    return json({ ok: true, ...r });
  }
  if (path === "/api/voice" && method === "POST") return json({ ok: true, ...(await voiceTurn(request, env)) });
  if (path === "/api/speak" && method === "POST") return speak(request, env, ctx);
  if (path === "/api/usage" && method === "GET") {
    return json({ ok: true, neurons: await getUsage(env), voiceLimit: VOICE_LIMIT, dailyFree: DAILY_FREE });
  }

  if (path === "/api/config" && method === "GET") return json({ ok: true, city: config().city, family: config().family });
  if (path === "/api/home" && method === "GET") return json({ ok: true, ...(await homeSnapshot(env)) });
  if (path === "/api/briefing" && method === "GET") return json({ ok: true, text: url.searchParams.get("evening") ? await getEveningBriefing(env) : await getBriefing(env, { morning: !!url.searchParams.get("morning") }) });

  // Temporizadores
  if (path === "/api/timers" && method === "POST") return json({ ok: true, timer: await H.createTimer(env, await body(request)) }, 201);
  let mt = path.match(/^\/api\/timers\/([a-z0-9]{1,20})$/);
  if (mt && method === "DELETE") return json({ ok: true, timers: await H.deleteTimer(env, mt[1]) });

  // Lista de la compra
  if (path === "/api/shopping") {
    if (method === "GET") return json({ ok: true, items: await H.listShopping(env) });
    if (method === "POST") return json({ ok: true, items: await H.addShopping(env, (await body(request)).text) });
  }
  mt = path.match(/^\/api\/shopping\/([a-z0-9]{1,20})$/);
  if (mt && method === "PATCH") return json({ ok: true, items: await H.updateShopping(env, mt[1], await body(request)) });
  if (mt && method === "DELETE") return json({ ok: true, items: await H.removeShopping(env, mt[1]) });

  // Notas
  if (path === "/api/notes") {
    if (method === "GET") return json({ ok: true, notes: await H.listNotes(env) });
    if (method === "POST") { await H.addNote(env, await body(request)); return json({ ok: true, notes: await H.listNotes(env) }, 201); }
  }
  mt = path.match(/^\/api\/notes\/([a-z0-9]{1,20})$/);
  if (mt && method === "DELETE") return json({ ok: true, notes: await H.deleteNote(env, mt[1]) });

  // Casa (Shelly)
  if (path === "/api/devices") {
    if (method === "GET") return json({ ok: true, ...(await getDevices(env)) });
    if (method === "PUT") return json({ ok: true, devices: await setDeviceConfig(env, (await body(request)).devices) });
  }
  // Plano de la casa: { width, height, rooms: [{name,x,y,w,h}], marks: { <deviceKey>: {x,y} } }
  if (path === "/api/floorplan") {
    if (method === "GET") return json({ ok: true, plan: await env.NEXUS_KV.get("floorplan", "json") });
    if (method === "PUT") {
      const plan = (await body(request)).plan;
      if (plan !== null && (!plan || !Array.isArray(plan.rooms) || plan.rooms.length > 40)) throw new Error("Plano no válido");
      await env.NEXUS_KV.put("floorplan", JSON.stringify(plan));
      return json({ ok: true });
    }
  }
  mt = path.match(/^\/api\/devices\/([a-z0-9_-]{1,20})$/i);
  if (mt && method === "POST") return json({ ok: true, ...(await controlDevice(env, mt[1], await body(request))) });

  if (path === "/api/alarms") {
    if (method === "GET") return json({ ok: true, alarms: await listAlarms(env) });
    if (method === "POST") return json({ ok: true, alarms: await createAlarm(env, await body(request)) }, 201);
  }
  const m = path.match(/^\/api\/alarms\/([a-z0-9]{1,20})$/);
  if (m) {
    if (method === "PUT") return json({ ok: true, alarms: await updateAlarm(env, m[1], await body(request)) });
    if (method === "DELETE") return json({ ok: true, alarms: await deleteAlarm(env, m[1]) });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    loadConfig(env);
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url, ctx);
      } catch (err) {
        console.error(url.pathname, err);
        const msg = String(err.message || err);
        // 4006 = cuota diaria gratuita de Workers AI agotada
        if (/4006|daily free allocation/i.test(msg)) {
          // Nuestro contador se queda corto: se marca como agotado para que el panel lo muestre
          const used = await getUsage(env).catch(() => DAILY_FREE);
          if (used < DAILY_FREE) await addUsage(env, DAILY_FREE - used).catch(() => {});
          return json({ ok: false, error: "quota" }, 429);
        }
        return json({ ok: false, error: msg }, 400);
      }
    }

    // Todo lo demás: archivos estáticos del dashboard
    return env.ASSETS.fetch(request);
  },
};
