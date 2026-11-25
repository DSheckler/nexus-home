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
import { notify } from "./hub.js";
import { powerMonth, saveReading, deleteReading } from "./consumption.js";
import * as P from "./planner.js";
import { getWeeklyBriefing } from "./weekly.js";
import * as L from "./life.js";
import { getAir, getAurora } from "./outdoor.js";
import * as S from "./smart.js";
import { handlePush, startWatches, ensureWatches, watchStatus } from "./gcalpush.js";

export { HomeHub } from "./hub.js";

// Cambiar en cada publicación: la tablet se recarga sola al detectarlo.
const VERSION = "1.28.10";

// Todo lo de la casa en una sola petición para el panel
async function homeSnapshot(env) {
  const safe = (p) => p.catch(() => null);
  const [timers, shopping, notes, garbage, power, warnings, settings, dates, reminders, chores, plants, menu, school, abroad, air, aurora] = await Promise.all([
    safe(H.listTimers(env)), safe(H.listShopping(env)), safe(H.listNotes(env)),
    safe(H.nextPickups(env)), safe(getPower()), safe(getWarnings(env)), safe(H.getSettings(env)), safe(H.upcomingDates(env, 7)),
    safe(P.listReminders(env)), safe(P.listChores(env)), safe(L.listPlants(env)), safe(L.getMenu(env, 2)), safe(L.schoolSummary(env)),
    safe(L.getAbroad(env)), safe(getAir(env)), safe(getAurora(env)),
  ]);
  const [presence, errands, shopSuggest, receipts] = await Promise.all([
    safe(S.getPresence(env)), safe(S.listErrands(env)), safe(S.shoppingSuggestions(env, shopping)), safe(S.receiptsSummary(env)),
  ]);
  const ai = { used: await getUsage(env).catch(() => 0), free: DAILY_FREE };
  const season = L.seasonNotices(7);
  return { timers, shopping, notes, garbage, power, warnings, settings, dates, reminders, chores, plants, menu, school, abroad, air, aurora, season, ai, presence, errands, shopSuggest, receipts: receipts && { current: receipts.current, previous: receipts.previous }, now: Date.now() };
}

const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // ~1 minuto de voz comprimida
const TTS_MODEL = "@cf/deepgram/aura-2-es";
const TTS_NEURONS_PER_CHAR = 2.7273;     // 2727,27 neuronas por 1.000 caracteres
const STT_NEURONS = 5;                    // una frase corta (~47 neuronas por minuto de audio)
const WAKE_NEURONS = 2;                   // fragmento de "Oye NEXUS" (2-3 s): antes no se contaba
const WAKE_LIMIT = 8000;                  // por encima, la escucha "Oye NEXUS" se pausa hasta mañana
const TTS_MAX_CHARS = 220;                // textos más largos (p. ej. el resumen) se leen con la voz de la tablet

const json = (data, status = 200, maxAge = 0) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": maxAge ? `private, max-age=${maxAge}` : "no-store" },
  });

// Voz a texto con Whisper en Workers AI. La pista (nombres de la familia y la ciudad) mejora nombres propios.
// Sin "Oye NEXUS" en la pista: con ruido, Whisper tiende a copiar la pista y la tablet
// se activaba sola.
const whisperPrompt = () => `${config().family.join(", ")}. ${config().city}.`;

// Frases que Whisper inventa con silencio o ruido (subtítulos de vídeos con los que se entrenó)
const HALLUCINATION = /(subt[ií]tul|amara\.org|suscr[ií]bete|gracias por (ver|mirar)|nos vemos en el pr[oó]ximo|m[uú]sica de fondo|^\W*(m[uú]sica|aplausos|risas)\W*$|^[\s.,¡!¿?…-]*$)/i;
const fold = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();

async function whisper(env, base64, count = true, { wake = false } = {}) {
  const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    // Para la activación, una pista que enseña la palabra pero no empieza por ella: si Whisper
    // la copiara con ruido, no coincide con "Oye NEXUS…" al principio y no activa nada.
    audio: base64, language: "es", initial_prompt: wake ? "Asistente de casa llamado Nexus." : whisperPrompt(),
  });
  await addUsage(env, wake ? WAKE_NEURONS : STT_NEURONS).catch(() => {});
  let text = (r.text || "").trim();
  if (HALLUCINATION.test(text)) text = "";
  // Si solo repite la pista (los nombres y la ciudad), no se ha dicho nada
  if (!wake && text && fold(whisperPrompt()).includes(fold(text))) text = "";
  return text;
}

function toBase64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function transcribe(request, env, wake = false) {
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) throw new Error("No llegó audio");
  if (buf.byteLength > MAX_AUDIO_BYTES) throw new Error("Grabación demasiado larga");
  return whisper(env, toBase64(buf), true, { wake });
}

// Un turno de conversación completo en una sola petición:
// audio -> texto (Whisper) -> respuesta (asistente). Ahorra viajes de ida y vuelta.
async function voiceTurn(request, env) {
  const { audio, history, cooking } = await body(request);
  if (!audio || typeof audio !== "string") throw new Error("No llegó audio");
  if (audio.length > MAX_AUDIO_BYTES * 1.4) throw new Error("Grabación demasiado larga");
  const text = await whisper(env, audio);
  if (!text) return { text: "" };
  const r = await askAssistant(env, { text, history, cooking: !!cooking });
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
// para los celulares). Si se pierde un celular, basta con cambiar la familiar.
async function scopeOf(request, env) {
  let key = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  // WebSocket: el navegador no permite cabeceras, la clave va como subprotocolo ("nexus", clave)
  if (!key && request.headers.get("Upgrade") === "websocket") {
    key = ((request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((s) => s.trim())[1]) || "";
  }
  if (env.NEXUS_TOKEN && safeEqual(key, env.NEXUS_TOKEN)) return "full";
  if (env.FAMILY_TOKEN && safeEqual(key, env.FAMILY_TOKEN)) return "family";
  if (await P.isGuest(env, key)) return "guest";
  return null;
}
const FAMILY_PATHS = /^\/api\/(?:(shopping|notes|config|live|reminders|chores|guests)(\/[a-z0-9]{1,20})?|notes\/voice|notes\/[a-z0-9]{1,20}\/audio|power\/month|power\/readings(\/\d{4}-\d{2})?|dates\/import|chores\/[a-z0-9]{1,20}\/done|(plants|menu|school|abroad|vacation|outdoor|warnings)|plants\/[a-z0-9]{1,20}(\/water)?|menu\/(\d{4}-\d{2}-\d{2}|shop)|devices(\/[a-z0-9_-]{1,20})?|presence|errands(\/[a-z0-9]{1,20})?|receipts(\/[a-z0-9]{1,20})?|recipe(\/photo)?|tv)$/i;
// Invitados: solo la lista de compras y las notas de texto
const GUEST_PATHS = /^\/api\/(?:shopping(\/[a-z0-9]{1,20})?|notes(\/(?!voice$)[a-z0-9]{1,20})?|config|live)$/;

// El asistente cambió algo de la casa: los celulares reciben la lista y las notas al momento
function pushHome(env, ctx) {
  const p = Promise.all([H.listShopping(env), H.listNotes(env)]).then(([items, notes]) => Promise.all([
    notify(env, null, { type: "shopping", items }, ["family", "guest"]),
    notify(env, null, { type: "notes", notes, added: null }, ["family", "guest"]),
  ])).catch(() => {});
  if (ctx) ctx.waitUntil(p);
}

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
  const scope = await scopeOf(request, env);
  if (!scope) return json({ ok: false, error: "unauthorized" }, 401);
  if (scope === "family" && !FAMILY_PATHS.test(path)) return json({ ok: false, error: "forbidden" }, 403);
  if (scope === "guest" && !GUEST_PATHS.test(path)) return json({ ok: false, error: "forbidden" }, 403);
  if (scope === "family" && path === "/api/devices" && method !== "GET") return json({ ok: false, error: "forbidden" }, 403);

  if (path === "/api/weather" && method === "GET") {
    return json({ ok: true, ...(await getWeather()) }, 200, 300);
  }
  if (path === "/api/weather/detail" && method === "GET") {
    return json({ ok: true, ...(await getWeatherDetail()) }, 200, 300);
  }
  if (path === "/api/agenda" && method === "GET") {
    // De paso, se asegura de que Google avise de los cambios (si aún no hay canales o van a caducar)
    ctx.waitUntil(ensureWatches(env, url.origin).catch((e) => console.error("gcal watch", e)));
    return json({ ok: true, ...(await getAgenda(env)) });
  }
  // Avisos al instante de Google Calendar: estado y (re)arranque manual
  if (path === "/api/gcal/watch") {
    if (method === "GET") return json({ ok: true, ...(await watchStatus(env)) });
    if (method === "POST") return json(await startWatches(env, url.origin));
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
    return json({ ok: true, text: await transcribe(request, env, !!url.searchParams.get("wake")) });
  }
  if (path === "/api/assistant" && method === "POST") {
    const r = await askAssistant(env, await body(request));
    await addUsage(env, r.neurons);
    if (r.changed && r.changed.home) pushHome(env, ctx);
    return json({ ok: true, ...r });
  }
  if (path === "/api/voice" && method === "POST") {
    const r = await voiceTurn(request, env);
    if (r.changed && r.changed.home) pushHome(env, ctx);
    return json({ ok: true, ...r });
  }
  if (path === "/api/speak" && method === "POST") return speak(request, env, ctx);
  if (path === "/api/usage" && method === "GET") {
    return json({ ok: true, neurons: await getUsage(env), voiceLimit: VOICE_LIMIT, dailyFree: DAILY_FREE });
  }

  // Diagnóstico de la tablet: errores de JavaScript y toques en los avisos
  if (path === "/api/log") {
    if (method === "POST") {
      const b = await body(request);
      const e = { at: new Date().toISOString(), ...Object.fromEntries(Object.entries(b || {}).slice(0, 8).map(([k, v]) => [k.slice(0, 20), String(v).slice(0, 300)])) };
      console.log("tablet", JSON.stringify(e));
      const list = (await env.NEXUS_KV.get("clientlog", "json")) || [];
      await env.NEXUS_KV.put("clientlog", JSON.stringify([...list, e].slice(-40)), { expirationTtl: 7 * 86400 });
      return json({ ok: true });
    }
    if (method === "GET") return json({ ok: true, log: (await env.NEXUS_KV.get("clientlog", "json")) || [] });
  }
  if (path === "/api/config" && method === "GET") return json({ ok: true, city: config().city, family: config().family, scope });
  if (path === "/api/home" && method === "GET") {
    const [home, month] = await Promise.all([homeSnapshot(env), powerMonth(env).catch(() => null)]);
    return json({ ok: true, ...home, powerMonth: month });
  }

  // Gasto de luz del mes: estimado del mes en curso y lecturas de la factura (kWh del mes)
  if (path === "/api/power/month" && method === "GET") return json({ ok: true, ...(await powerMonth(env)) });
  if (path === "/api/power/readings" && method === "POST") {
    await saveReading(env, await body(request));
    const month = await powerMonth(env);
    notify(env, ctx, { type: "powerMonth", powerMonth: month }, ["full", "family"]);
    return json({ ok: true, ...month });
  }
  const mt0 = path.match(/^\/api\/power\/readings\/(\d{4}-\d{2})$/);
  if (mt0 && method === "DELETE") {
    await deleteReading(env, mt0[1]);
    const month = await powerMonth(env);
    notify(env, ctx, { type: "powerMonth", powerMonth: month }, ["full", "family"]);
    return json({ ok: true, ...month });
  }
  if (path === "/api/briefing" && method === "GET") {
    const q = url.searchParams;
    const text = q.get("weekly") ? await getWeeklyBriefing(env) : q.get("evening") ? await getEveningBriefing(env) : await getBriefing(env, { morning: !!q.get("morning") });
    return json({ ok: true, text });
  }

  // Cumpleaños de los contactos del iPhone (los envía un Atajo): JSON {items:[{name,date}]} o
  // texto con una línea por persona "Nombre;AAAA-MM-DD"
  if (path === "/api/dates/import" && method === "POST") {
    const raw = await request.text();
    let items;
    try { const j = JSON.parse(raw); items = Array.isArray(j) ? j : j.items; } catch { items = H.parseDateLines(raw); }
    const r = await H.importDates(env, items);
    notify(env, ctx, { type: "refresh" }, ["full"]);
    return json({ ok: true, ...r, message: `NEXUS: ${r.imported} cumpleaños importados` + (r.skipped ? `, ${r.skipped} sin fecha válida o repetidos` : "") });
  }

  // Recordatorios con fecha y hora
  const remDone = async (status = 200) => { const reminders = await P.listReminders(env); notify(env, ctx, { type: "reminders", reminders }, ["full", "family"]); return json({ ok: true, reminders }, status); };
  if (path === "/api/reminders") {
    if (method === "GET") return json({ ok: true, reminders: await P.listReminders(env) });
    if (method === "POST") { await P.addReminder(env, await body(request)); return remDone(201); }
  }
  let mr = path.match(/^\/api\/reminders\/([a-z0-9]{1,20})\/fired$/);
  if (mr && method === "POST") { await P.reminderFired(env, mr[1]); return remDone(); }
  mr = path.match(/^\/api\/reminders\/([a-z0-9]{1,20})$/);
  if (mr && method === "DELETE") { await P.deleteReminder(env, mr[1]); return remDone(); }

  // Tareas de la casa
  const choresDone = async (extra = {}, status = 200) => { const chores = await P.listChores(env); notify(env, ctx, { type: "chores", chores }, ["full", "family"]); return json({ ok: true, chores, ...extra }, status); };
  if (path === "/api/chores") {
    if (method === "GET") return json({ ok: true, chores: await P.listChores(env) });
    if (method === "POST") { await P.addChore(env, await body(request)); return choresDone({}, 201); }
  }
  mr = path.match(/^\/api\/chores\/([a-z0-9]{1,20})\/done$/);
  if (mr && method === "POST") { const r = await P.doneChore(env, mr[1]); return choresDone({ doneBy: r.doneBy }); }
  mr = path.match(/^\/api\/chores\/([a-z0-9]{1,20})$/);
  if (mr && method === "DELETE") { await P.deleteChore(env, mr[1]); return choresDone(); }

  // Plantas: riego cada N días en fechas fijas
  const plantsDone = async (plants, status = 200) => { notify(env, ctx, { type: "plants", plants }, ["full", "family"]); return json({ ok: true, plants }, status); };
  if (path === "/api/plants") {
    if (method === "GET") return json({ ok: true, plants: await L.listPlants(env) });
    if (method === "PUT") return plantsDone(await L.savePlant(env, await body(request)));
  }
  mr = path.match(/^\/api\/plants\/([a-z0-9]{1,20})\/water$/);
  if (mr && method === "POST") return plantsDone(await L.waterPlant(env, mr[1]));
  mr = path.match(/^\/api\/plants\/([a-z0-9]{1,20})$/);
  if (mr && method === "DELETE") return plantsDone(await L.deletePlant(env, mr[1]));

  // Menú de la semana
  const menuDone = async (menu) => { notify(env, ctx, { type: "menu", menu }, ["full", "family"]); return json({ ok: true, menu }); };
  if (path === "/api/menu" && method === "GET") return json({ ok: true, menu: await L.getMenu(env, 7) });
  mr = path.match(/^\/api\/menu\/(\d{4}-\d{2}-\d{2})$/);
  if (mr && method === "PUT") return menuDone(await L.setMenu(env, mr[1], await body(request)));
  if (mr && method === "DELETE") return menuDone(await L.setMenu(env, mr[1], {}));
  if (path === "/api/menu/shop" && method === "POST") {
    const b = await body(request);
    const want = await L.menuIngredients(env, b.from, b.to);
    const have = new Set((await H.listShopping(env)).filter((i) => !i.done).map((i) => i.text.toLowerCase()));
    const add = want.filter((i) => !have.has(i.toLowerCase()));
    const items = add.length ? await H.addShopping(env, add) : await H.listShopping(env);
    notify(env, ctx, { type: "shopping", items });
    return json({ ok: true, added: add, items });
  }

  // Colegio, familia en otro país y vacaciones
  if (path === "/api/school") {
    if (method === "GET") return json({ ok: true, school: await L.getSchool(env) });
    if (method === "PUT") { const school = await L.setSchool(env, await body(request)); notify(env, ctx, { type: "refresh" }, ["full"]); return json({ ok: true, school }); }
  }
  if (path === "/api/abroad") {
    if (method === "GET") return json({ ok: true, abroad: await L.getAbroad(env) });
    if (method === "PUT") { const abroad = await L.setAbroad(env, (await body(request)).abroad); notify(env, ctx, { type: "refresh" }, ["full"]); return json({ ok: true, abroad }); }
  }
  if (path === "/api/vacation") {
    if (method === "GET") return json({ ok: true, vacation: await L.vacation(env) });
    if (method === "PUT" || method === "DELETE") {
      const vacation = await L.setVacation(env, method === "DELETE" ? {} : await body(request));
      notify(env, ctx, { type: "refresh" }, ["full"]);
      return json({ ok: true, vacation });
    }
  }
  if (path === "/api/warnings" && method === "GET") return json({ ok: true, warnings: await getWarnings(env) });
  if (path === "/api/outdoor" && method === "GET") {
    const [air, aurora] = await Promise.all([getAir(env).catch(() => null), getAurora(env).catch(() => null)]);
    return json({ ok: true, air, aurora, season: L.seasonNotices(14) });
  }

  // Enlaces de invitado (temporales)
  if (path === "/api/guests") {
    if (method === "GET") return json({ ok: true, guests: (await P.listGuests(env)).map(({ token, ...g }) => ({ ...g, url: `${url.origin}/movil.html#k=${token}` })) });
    if (method === "POST") {
      const g = await P.createGuest(env, await body(request));
      return json({ ok: true, guest: { id: g.id, name: g.name, expires: g.expires, url: `${url.origin}/movil.html#k=${g.token}` } }, 201);
    }
  }
  mr = path.match(/^\/api\/guests\/([a-z0-9]{1,20})$/);
  if (mr && method === "DELETE") { await P.deleteGuest(env, mr[1]); return json({ ok: true }); }

  // Temporizadores
  if (path === "/api/timers" && method === "POST") return json({ ok: true, timer: await H.createTimer(env, await body(request)) }, 201);
  let mt = path.match(/^\/api\/timers\/([a-z0-9]{1,20})$/);
  if (mt && method === "DELETE") return json({ ok: true, timers: await H.deleteTimer(env, mt[1]) });

  // Conexión en vivo (WebSocket) para que los cambios lleguen al momento
  if (path === "/api/live") {
    if (!env.HUB || request.headers.get("Upgrade") !== "websocket") return json({ ok: false, error: "websocket" }, 426);
    return env.HUB.get(env.HUB.idFromName("casa")).fetch(new Request("https://hub/?scope=" + scope, request));
  }

  // Lista de compras (cada cambio se avisa al momento a las pantallas)
  const shopDone = (items, status = 200) => { notify(env, ctx, { type: "shopping", items }); return json({ ok: true, items }, status); };
  if (path === "/api/shopping") {
    if (method === "GET") { const items = await H.listShopping(env); return json({ ok: true, items, suggest: await S.shoppingSuggestions(env, items).catch(() => []) }); }
    if (method === "POST") return shopDone(await H.addShopping(env, (await body(request)).text));
  }
  mt = path.match(/^\/api\/shopping\/([a-z0-9]{1,20})$/);
  if (mt && method === "PATCH") return shopDone(await H.updateShopping(env, mt[1], await body(request)));
  if (mt && method === "DELETE") return shopDone(await H.removeShopping(env, mt[1]));

  // Notas (de texto y de voz)
  const notesDone = (notes, added, status = 200) => { notify(env, ctx, { type: "notes", notes, added: added ? added.id : null }); return json({ ok: true, notes }, status); };
  if (path === "/api/notes") {
    if (method === "GET") return json({ ok: true, notes: await H.listNotes(env) });
    if (method === "POST") { const n = await H.addNote(env, await body(request)); return notesDone(await H.listNotes(env), n, 201); }
  }
  if (path === "/api/notes/voice" && method === "POST") {
    if (scope === "guest") return json({ ok: false, error: "forbidden" }, 403); // invitados: solo notas de texto
    if (Number(request.headers.get("Content-Length") || 0) > H.VOICE_MAX_BYTES) return json({ ok: false, error: "La nota de voz es demasiado larga" }, 413);
    const dec = (h) => { try { return decodeURIComponent(request.headers.get(h) || ""); } catch { return ""; } };
    const n = await H.addVoiceNote(env, {
      to: dec("X-Note-To"), from: dec("X-Note-From"), seconds: request.headers.get("X-Note-Seconds"),
      mime: request.headers.get("Content-Type"), audio: await request.arrayBuffer(),
    });
    return notesDone(await H.listNotes(env), n, 201);
  }
  mt = path.match(/^\/api\/notes\/([a-z0-9]{1,20})\/audio$/);
  if (mt && method === "GET") {
    const v = await H.getVoiceAudio(env, mt[1]);
    if (!v) return json({ ok: false, error: "El audio ya no está disponible" }, 404);
    return new Response(v.audio, { headers: { "Content-Type": v.mime, "Cache-Control": "private, max-age=86400" } });
  }
  mt = path.match(/^\/api\/notes\/([a-z0-9]{1,20})$/);
  if (mt && method === "DELETE") return notesDone(await H.deleteNote(env, mt[1]));

  // Quién está en casa (Atajos del iPhone o botón del celular) y recados al llegar
  if (path === "/api/presence") {
    if (method === "GET") return json({ ok: true, presence: await S.getPresence(env) });
    if (method === "POST") {
      // Acepta JSON, formulario o parámetros en el enlace (los Atajos del iPhone a veces mandan formulario)
      let b = {};
      const ct = request.headers.get("Content-Type") || "";
      try {
        if (/json/i.test(ct)) b = await request.json();
        else if (/form/i.test(ct)) b = Object.fromEntries(await request.formData());
        else { const t = await request.text(); try { b = JSON.parse(t); } catch { b = Object.fromEntries(new URLSearchParams(t)); } }
      } catch { b = {}; }
      for (const [k, v] of url.searchParams) if (!(k in b)) b[k] = v;
      const pick = (o, ...keys) => { for (const k of Object.keys(o)) if (keys.includes(k.trim().toLowerCase())) return String(o[k]).trim(); return ""; };
      const who = pick(b, "who", "quien", "quién", "nombre"), state = pick(b, "state", "estado");
      let r;
      try { r = await S.setPresence(env, who, state); }
      catch (e) {
        console.log("presencia rechazada", JSON.stringify({ ct, keys: Object.keys(b), who, state, error: e.message }));
        await env.NEXUS_KV.put("presence:lasterror", JSON.stringify({ at: new Date().toISOString(), ct, keys: Object.keys(b), who, state, error: e.message }), { expirationTtl: 7 * 86400 });
        throw e;
      }
      notify(env, ctx, { type: "presence", presence: r.presence, arrived: r.arrived ? r.name : null });
      if (r.delivered.length) { const notes = await H.listNotes(env); notify(env, ctx, { type: "notes", notes, added: r.delivered[0].id }); notify(env, ctx, { type: "errands", errands: await S.listErrands(env) }); }
      return json({ ok: true, ...r });
    }
  }
  if (path === "/api/errands") {
    if (method === "GET") return json({ ok: true, errands: await S.listErrands(env) });
    if (method === "POST") {
      const r = await S.addErrand(env, await body(request));
      if (r.now) notify(env, ctx, { type: "notes", notes: await H.listNotes(env), added: r.note.id });
      else notify(env, ctx, { type: "errands", errands: r.errands });
      return json({ ok: true, ...r }, 201);
    }
  }
  mt = path.match(/^\/api\/errands\/([a-z0-9]{1,20})$/);
  if (mt && method === "DELETE") { const errands = await S.deleteErrand(env, mt[1]); notify(env, ctx, { type: "errands", errands }); return json({ ok: true, errands }); }

  // Boletas del súper (foto desde el celular → total del mes)
  const imageBody = async () => {
    if (Number(request.headers.get("Content-Length") || 0) > S.MAX_IMAGE) throw new Error("La foto es demasiado grande");
    return { image: await request.arrayBuffer(), mime: (request.headers.get("Content-Type") || "").split(";")[0] };
  };
  if (path === "/api/receipts") {
    if (method === "GET") return json({ ok: true, ...(await S.receiptsSummary(env)) });
    if (method === "POST") {
      const { image, mime } = await imageBody();
      let from = ""; try { from = decodeURIComponent(request.headers.get("X-From") || ""); } catch { /* sin nombre */ }
      const receipt = await S.addReceipt(env, image, mime, from);
      const summary = await S.receiptsSummary(env);
      notify(env, ctx, { type: "receipts", receipts: { current: summary.current, previous: summary.previous } });
      return json({ ok: true, receipt, ...summary }, 201);
    }
  }
  mt = path.match(/^\/api\/receipts\/([a-z0-9]{1,20})$/);
  if (mt && method === "DELETE") {
    await S.deleteReceipt(env, mt[1]);
    const summary = await S.receiptsSummary(env);
    notify(env, ctx, { type: "receipts", receipts: { current: summary.current, previous: summary.previous } });
    return json({ ok: true, ...summary });
  }

  // Tele desde el celular: el servidor pasa la orden a la tablet (que está en la misma red que
  // la TV Box) y la tablet devuelve el resultado. Solo órdenes de la lista.
  const TV_ACTIONS = ["on", "off", "volup", "voldown", "mute", "playpause", "home", "back", "up", "down", "left", "right", "ok", "app", "search", "ytsearch"];
  if (path === "/api/tv" && method === "POST") {
    const b = await body(request);
    if (!TV_ACTIONS.includes(b.action)) return json({ ok: false, error: "Orden no válida" }, 400);
    const id = "tv" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    notify(env, ctx, { type: "tv", id, action: b.action, arg: String(b.arg || "").slice(0, 80) }, ["full"]);
    return json({ ok: true, id });
  }
  if (path === "/api/tv/result" && method === "POST" && scope === "full") {
    const b = await body(request);
    notify(env, ctx, { type: "tvresult", id: String(b.id || "").slice(0, 30), ok: !!b.ok, msg: String(b.msg || "").slice(0, 160) }, ["family"]);
    return json({ ok: true });
  }

  // Recetas desde un enlace o una foto: se abren en el modo cocina de la tablet
  if ((path === "/api/recipe" || path === "/api/recipe/photo") && method === "POST") {
    let recipe;
    if (path === "/api/recipe") recipe = await S.recipeFromUrl(env, (await body(request)).url);
    else { const { image, mime } = await imageBody(); recipe = await S.recipeFromPhoto(env, image, mime); }
    await env.NEXUS_KV.put("recipe:last", JSON.stringify(recipe), { expirationTtl: 7 * 86400 });
    notify(env, ctx, { type: "cook", recipe }, ["full"]);
    return json({ ok: true, recipe });
  }

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
  // Tarea programada (diaria): renueva los avisos de Google Calendar antes de que caduquen
  async scheduled(event, env, ctx) {
    loadConfig(env);
    ctx.waitUntil(ensureWatches(env).catch((e) => console.error("gcal renovar", e)));
  },

  async fetch(request, env, ctx) {
    loadConfig(env);
    const url = new URL(request.url);

    // Aviso de Google Calendar (público, comprobado con una clave secreta del canal)
    if (url.pathname === "/gcal/push" && request.method === "POST") {
      const r = await handlePush(request, env).catch(() => false);
      if (r === "changed") ctx.waitUntil(notify(env, null, { type: "agenda" }, ["full"]));
      return new Response(null, { status: r ? 200 : 403 });
    }

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
