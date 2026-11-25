// NEXUS Home - funciones "de asistente": quién está en casa, recados al llegar,
// sugerencias de compra, boletas del súper y recetas desde un enlace o una foto.
// Todo se guarda en Cloudflare KV; la IA (gratis, Workers AI) solo lee fotos y textos.

import { config } from "./config.js";
import { addNote } from "./household.js";
import { addUsage } from "./usage.js";

const TZ = "Europe/Stockholm";
const fMonth = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: TZ });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const clip = (s, n) => String(s || "").trim().slice(0, n);
const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const getJ = async (env, key, def) => (await env.NEXUS_KV.get(key, "json")) ?? def;
const putJ = (env, key, v) => env.NEXUS_KV.put(key, JSON.stringify(v));

// Modelo con visión (fotos de boletas y recetas): Mistral Small 3.1, incluido en la cuota gratuita
const VISION = "@cf/mistralai/mistral-small-3.1-24b-instruct";
const TEXT = "@cf/openai/gpt-oss-120b";

// Nombre de la familia que corresponde a lo escrito ("so" → "Sofía")
export function familyName(raw) {
  const f = fold(raw);
  if (!f) return null;
  return config().family.find((n) => fold(n) === f) || config().family.find((n) => fold(n).startsWith(f) || f.startsWith(fold(n))) || null;
}

// ---------- Quién está en casa ----------
// Cada celular avisa con un Atajo del iPhone («Al llegar a casa» / «Al salir de casa»)
// o con el botón del celular. Solo se guarda "en casa" o "fuera" y la hora: nunca la ubicación.
export async function getPresence(env) {
  const all = await getJ(env, "presence", {});
  const out = {};
  for (const n of config().family) if (all[n]) out[n] = all[n];
  return out;
}

export async function setPresence(env, who, state) {
  const name = familyName(who);
  if (!name) throw new Error("No conozco a «" + clip(who, 20) + "» en la familia");
  const st = fold(state).replace(/[^a-z0-9 ]/g, "").trim();
  const home = /^(home|en ?casa|llegue|llego|llegada|arrive|arrived|1|true|si|on)$/.test(st);
  const away = /^(away|fuera|sali|salgo|salida|leave|left|0|false|no|off)$/.test(st);
  if (!home && !away) throw new Error("Estado no válido: usa «llegué» o «salí»");
  const all = await getJ(env, "presence", {});
  const before = all[name] && all[name].home;
  all[name] = { home, at: Date.now() };
  await putJ(env, "presence", all);
  // Al llegar, se entregan los recados que esperaban a esa persona
  const delivered = home && !before ? await releaseErrands(env, name) : [];
  return { presence: await getPresence(env), name, home, arrived: home && !before, delivered };
}

// ---------- Recados para cuando alguien llegue ----------
export const listErrands = (env) => getJ(env, "errands", []);

export async function addErrand(env, { to, text, from }) {
  const name = familyName(to);
  if (!name) throw new Error("¿Para quién es el recado? No conozco a «" + clip(to, 20) + "»");
  const t = clip(text, 160);
  if (!t) throw new Error("El recado está vacío");
  const p = await getPresence(env);
  // Si ya está en casa, el recado se deja al tiro como nota
  if (p[name] && p[name].home) {
    const note = await addNote(env, { to: name, text: t, from: clip(from, 20) });
    return { now: true, note, errands: await listErrands(env) };
  }
  const list = await listErrands(env);
  if (list.length >= 20) throw new Error("Hay demasiados recados pendientes");
  const e = { id: "e" + uid(), to: name, text: t, from: clip(from, 20), at: Date.now() };
  list.push(e);
  await putJ(env, "errands", list);
  return { now: false, errand: e, errands: list };
}

export async function deleteErrand(env, id) {
  const list = (await listErrands(env)).filter((e) => e.id !== id);
  await putJ(env, "errands", list);
  return list;
}

async function releaseErrands(env, name) {
  const list = await listErrands(env);
  const mine = list.filter((e) => e.to === name);
  if (!mine.length) return [];
  await putJ(env, "errands", list.filter((e) => e.to !== name));
  const notes = [];
  for (const e of mine) notes.push(await addNote(env, { to: name, text: e.text, from: e.from }).catch(() => null));
  return notes.filter(Boolean);
}

// ---------- Lista de compras que aprende ----------
// Se anota cuándo se pide cada cosa; si algo se compra con regularidad y ya toca, se sugiere.
const HIST = "shophist";
export async function recordShopping(env, texts) {
  const hist = await getJ(env, HIST, {});
  const now = Date.now();
  for (const raw of [].concat(texts)) {
    const k = fold(raw).replace(/\s+/g, " ").slice(0, 40);
    if (!k) continue;
    const h = hist[k] || (hist[k] = { t: clip(raw, 40), at: [] });
    if (h.at.length && now - h.at[h.at.length - 1] < 2 * 86400000) continue; // dos veces en 2 días cuenta como una
    h.at = [...h.at, now].slice(-8);
    h.t = clip(raw, 40);
  }
  // Como mucho 150 artículos: se olvidan los que llevan más tiempo sin pedirse
  const keys = Object.keys(hist);
  if (keys.length > 150) keys.sort((a, b) => hist[a].at.at(-1) - hist[b].at.at(-1)).slice(0, keys.length - 150).forEach((k) => delete hist[k]);
  await putJ(env, HIST, hist);
}

export async function shoppingSuggestions(env, list) {
  const hist = await getJ(env, HIST, {});
  const pending = new Set((list || []).filter((i) => !i.done).map((i) => fold(i.text)));
  const now = Date.now();
  const out = [];
  for (const [k, h] of Object.entries(hist)) {
    if (h.at.length < 3 || pending.has(k)) continue;
    const gaps = h.at.slice(1).map((t, i) => t - h.at[i]);
    const every = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const since = now - h.at[h.at.length - 1];
    if (since >= every * 0.9 && since < every * 4) out.push({ text: h.t, days: Math.round(since / 86400000), every: Math.round(every / 86400000), due: since / every });
  }
  return out.sort((a, b) => b.due - a.due).slice(0, 4);
}

// ---------- Boletas del súper ----------
function toB64(buf) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
// Primer objeto JSON de una respuesta del modelo (a veces viene entre ```json ... ```)
function firstJson(text) {
  const t = String(text || "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
async function vision(env, prompt, image, mime, maxTokens = 1200) {
  const r = await env.AI.run(VISION, {
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${mime};base64,${toB64(image)}` } }] }],
    max_tokens: maxTokens,
  });
  await addUsage(env, (r.usage && r.usage.neurons) || 60).catch(() => {});
  return firstJson(r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content);
}
const num = (v) => { const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

export const MAX_IMAGE = 4 * 1024 * 1024;
export async function addReceipt(env, image, mime, from) {
  if (!image || image.byteLength < 2000) throw new Error("La foto está vacía");
  if (image.byteLength > MAX_IMAGE) throw new Error("La foto es demasiado grande");
  if (!/^image\/(jpeg|png|webp)$/i.test(mime || "")) throw new Error("Formato de foto no válido (JPG o PNG)");
  const j = await vision(env, 'Lee esta boleta de supermercado (Suecia, en coronas). Responde solo JSON: {"tienda":string,"fecha":"AAAA-MM-DD","total":number,"articulos":[{"nombre":string,"precio":number}]}. "total" es lo que se pagó (TOTALT / ATT BETALA). Si no se lee bien la foto, responde {"error":"ilegible"}.', image, mime);
  if (!j || j.error || !num(j.total)) throw new Error("No pude leer la boleta. Prueba con una foto más cerca, recta y con buena luz.");
  const today = new Date().toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(j.fecha || "") && j.fecha <= today && j.fecha > "2020" ? j.fecha : today;
  const rec = {
    id: "r" + uid(), store: clip(j.tienda, 40) || "Súper", date, total: num(j.total), from: clip(from, 20), at: Date.now(),
    items: (Array.isArray(j.articulos) ? j.articulos : []).slice(0, 60).map((x) => ({ name: clip(x.nombre, 40), price: num(x.precio) })).filter((x) => x.name),
  };
  const list = await getJ(env, "receipts", []);
  list.push(rec);
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  await putJ(env, "receipts", list.slice(-300));
  return rec;
}

export async function deleteReceipt(env, id) {
  const list = (await getJ(env, "receipts", [])).filter((r) => r.id !== id);
  await putJ(env, "receipts", list);
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
// Gasto del mes en curso y del anterior, por tienda, y las últimas boletas
export async function receiptsSummary(env) {
  const list = await getJ(env, "receipts", []);
  const month = fMonth.format(new Date());
  const [y, m] = month.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const sum = (mm) => {
    const rs = list.filter((r) => r.date.startsWith(mm));
    const byStore = {};
    for (const r of rs) byStore[r.store] = Math.round(((byStore[r.store] || 0) + r.total) * 100) / 100;
    return { month: mm, label: MONTHS[Number(mm.slice(5)) - 1], total: Math.round(rs.reduce((s, r) => s + r.total, 0)), count: rs.length, byStore };
  };
  return { current: sum(month), previous: sum(prev), recent: list.slice(-15).reverse().map(({ items, ...r }) => ({ ...r, items: items.length })) };
}

// ---------- Recetas desde un enlace o una foto ----------
// Formato del modo cocina: { title, servings, ingredients: [], steps: [{ text, minutes }] }
const minutesIn = (t) => { const m = String(t).match(/(\d+)\s*(?:min|minutos|minuter|minutes)\b/i); const h = String(t).match(/(\d+)\s*(?:h|horas?|timmar|timme|hours?)\b/i); return (m ? +m[1] : 0) + (h ? +h[1] * 60 : 0); };
const decode = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, " ").trim();

function findRecipeLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const isRecipe = (o) => o && (o["@type"] === "Recipe" || (Array.isArray(o["@type"]) && o["@type"].includes("Recipe")));
  const walk = (o) => {
    if (!o || typeof o !== "object") return null;
    if (isRecipe(o)) return o;
    for (const v of Array.isArray(o) ? o : Object.values(o)) { const r = walk(v); if (r) return r; }
    return null;
  };
  for (const b of blocks) { try { const r = walk(JSON.parse(b.trim())); if (r) return r; } catch { /* bloque roto */ } }
  return null;
}

function stepsFromLd(ins) {
  const out = [];
  const add = (x) => {
    if (!x) return;
    if (typeof x === "string") { decode(x).split(/(?<=\.)\s+(?=[A-ZÁÉÍÓÚÅÄÖ])/).forEach((t) => t && out.push(t)); return; }
    if (Array.isArray(x)) return x.forEach(add);
    if (x.itemListElement) return add(x.itemListElement);
    if (x.text || x.name) out.push(decode(x.text || x.name));
  };
  add(ins);
  return out.filter((t) => t.length > 2);
}

// ¿Está en español? (si no, se traduce)
const looksSpanish = (t) => (String(t).match(/\b(de|la|el|los|las|y|con|en|hasta|minutos|agrega|añade|mezcla|cocina)\b/gi) || []).length > (String(t).match(/\b(och|med|till|på|ett|en|the|and|with|minutes|minuter|add|mix)\b/gi) || []).length;

async function llmRecipe(env, sourceText) {
  const r = await env.AI.run(TEXT, {
    messages: [
      { role: "system", content: 'Conviertes recetas al formato del modo cocina, en español neutro de Chile (usa palabras de Chile: papas, frutillas, palta, crema, porotos). Responde solo JSON: {"titulo":string,"personas":number|null,"ingredientes":[string con cantidad],"pasos":[{"texto":string,"minutos":number}]}. Pasos cortos, una acción cada uno (máximo 20). "minutos" solo si hay que esperar (leudar, cocer, hornear: usa el tiempo mayor); si no, 0. Mantén las cantidades y unidades como están (dl = decilitros; msk, tsk y krm se escriben «cucharadas», «cucharaditas» y «pizca»); no las conviertas a tazas. Usa «agregar» (no «añadir»). No inventes ingredientes ni pasos.' },
      { role: "user", content: sourceText.slice(0, 12000) },
    ],
    reasoning: { effort: "low" },
    max_tokens: 2500,
  });
  const u = r.usage || {};
  await addUsage(env, u.neurons || ((u.prompt_tokens || 0) * 0.032 + (u.completion_tokens || 0) * 0.068)).catch(() => {});
  return firstJson(r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content);
}

function normalizeRecipe(j) {
  if (!j) return null;
  const steps = (Array.isArray(j.pasos) ? j.pasos : []).slice(0, 25).map((x) => typeof x === "string" ? { text: clip(x, 300), minutes: minutesIn(x) } : { text: clip(x.texto, 300), minutes: Math.max(0, Math.round(Number(x.minutos) || 0)) }).filter((s) => s.text);
  if (!steps.length) return null;
  return { title: clip(j.titulo, 80) || "Receta", servings: Number(j.personas) || null, ingredients: (Array.isArray(j.ingredientes) ? j.ingredientes : []).slice(0, 40).map((s) => clip(s, 100)).filter(Boolean), steps };
}

// Solo páginas públicas: nada de direcciones internas, IP privadas ni puertos raros
function safeUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { throw new Error("El enlace no es válido"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("El enlace debe empezar por http o https");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("El enlace no es válido");
  const h = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipv4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const privV4 = ipv4 && (() => { const [a, b] = [+ipv4[1], +ipv4[2]]; return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; })();
  const v6 = h.startsWith("[") || h.includes(":");
  if (!h.includes(".") || privV4 || v6 || /(^|\.)(localhost|local|internal|lan|home|intranet)$/.test(h)) throw new Error("Solo se pueden abrir páginas públicas");
  return url;
}

// Sigue las redirecciones a mano (como mucho 5) revisando cada destino
async function fetchPublic(raw) {
  let url = safeUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0 (NEXUS Home recetas)", Accept: "text/html" }, redirect: "manual", cf: { cacheTtl: 3600 } }).catch(() => null);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400 && res.headers.get("Location")) { url = safeUrl(new URL(res.headers.get("Location"), url).toString()); continue; }
    return res;
  }
  return null;
}

export async function recipeFromUrl(env, rawUrl) {
  const res = await fetchPublic(rawUrl);
  if (!res || !res.ok) throw new Error("No pude abrir esa página");
  const html = (await res.text()).slice(0, 1500000);
  const ld = findRecipeLd(html);
  if (ld) {
    const r = {
      titulo: decode(ld.name), personas: parseInt(String([].concat(ld.recipeYield || "")[0]), 10) || null,
      ingredientes: [].concat(ld.recipeIngredient || ld.ingredients || []).map(decode),
      pasos: stepsFromLd(ld.recipeInstructions),
    };
    const sample = r.titulo + " " + r.ingredientes.join(" ") + " " + r.pasos.join(" ");
    // Ya está en español y bien estructurada: sin gastar IA
    if (looksSpanish(sample) && r.pasos.length) return normalizeRecipe(r);
    return normalizeRecipe(await llmRecipe(env, JSON.stringify(r)));
  }
  // Sin datos estructurados: la IA lee el texto de la página
  const text = decode(html.replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, " "));
  if (text.length < 200) throw new Error("No encontré una receta en esa página");
  const r = normalizeRecipe(await llmRecipe(env, text));
  if (!r) throw new Error("No encontré una receta en esa página");
  return r;
}

export async function recipeFromPhoto(env, image, mime) {
  if (!image || image.byteLength < 2000) throw new Error("La foto está vacía");
  if (image.byteLength > MAX_IMAGE) throw new Error("La foto es demasiado grande");
  if (!/^image\/(jpeg|png|webp)$/i.test(mime || "")) throw new Error("Formato de foto no válido (JPG o PNG)");
  const j = await vision(env, 'Esta foto es una receta (de un libro, revista o pantalla), quizá en sueco o inglés. Pásala a español neutro de Chile. Responde solo JSON: {"titulo":string,"personas":number|null,"ingredientes":[string con cantidad],"pasos":[{"texto":string,"minutos":number}]}. Pasos cortos, una acción cada uno. "minutos" solo si hay que esperar (leudar, cocer, hornear: usa el tiempo mayor); si no, 0. Mantén las cantidades y unidades como están (dl = decilitros; msk, tsk y krm se escriben «cucharadas», «cucharaditas» y «pizca»); no las conviertas a tazas. Usa «agregar» (no «añadir»). No inventes nada. Si no es una receta, responde {"error":"no es receta"}.', image, mime, 2500);
  const r = j && !j.error ? normalizeRecipe(j) : null;
  if (!r) throw new Error("No pude leer una receta en esa foto. Prueba con más luz y la página completa.");
  return r;
}
