// Respuestas directas sin IA para las preguntas más habituales.
// Son instantáneas y no gastan cuota. Si la frase no encaja claramente, devuelve null
// y responde el asistente con IA como siempre.

import { getWeather, getWeatherDetail } from "./weather.js";
import { getAgenda } from "./calendar.js";
import * as H from "./household.js";
import { getPower, nextAlarmText } from "./extras.js";
import { config } from "./config.js";

const TZ = "Europe/Stockholm";
const fHour = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
const kr = (v) => String(v.toFixed(2)).replace(".", ",");

// Números escritos con palabras (Whisper suele poner cifras, pero no siempre)
const NUM = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veinticinco: 25, treinta: 30, cuarenta: 40, cuarenta_y_cinco: 45, cincuenta: 50, sesenta: 60, noventa: 90,
};
const num = (w) => (/^\d+$/.test(w) ? Number(w) : NUM[w.replace(/ /g, "_")]);

// Frase "limpia": minúsculas, sin tildes, sin "oye nexus" ni signos
function clean(q) {
  return q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!.,;:]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(oye |hey |ey )?(nexus |nexos |lexus )?/, "")
    .replace(/ (nexus|por favor|porfa)$/, "").trim();
}

const INTENTS = [
  // ---------- hora ----------
  { re: /^(que hora es|me dices la hora|dime la hora)$/, run: async () => `Son las ${fHour.format(new Date())}.` },

  // ---------- tiempo ahora ----------
  {
    re: /^(que|como) (tiempo|clima) (hace|tenemos|hay)( hoy| ahora| fuera| afuera)?$|^(que temperatura hace|cuantos grados hace|hace frio)( hoy| ahora| fuera| afuera)?$/,
    run: async () => {
      const w = await getWeather();
      const feels = w.now.feels < w.now.temp - 2 ? `, con sensación de ${w.now.feels}` : "";
      return `Ahora hay ${w.now.temp} grados en ${config().city}${feels}, ${w.now.text.toLowerCase()}. Hoy, entre ${w.today.min} y ${w.today.max} grados.`;
    },
  },

  // ---------- lluvia hoy ----------
  {
    re: /^(va a llover|llovera|lloverá|va a nevar|nevara)( hoy)?$|^(necesito|hace falta|llevo) (el )?paraguas( hoy)?$/,
    run: async () => {
      const d = await getWeatherDetail();
      const nowH = d.now.time.slice(11, 13);
      const wet = d.days[0].hours.filter((x) => x.h >= nowH && x.rainProb >= 50);
      if (!wet.length) return `No se espera lluvia el resto del día: probabilidad máxima de ${Math.max(0, ...d.days[0].hours.filter((x) => x.h >= nowH).map((x) => x.rainProb))} por ciento.`;
      return `Sí, es probable a partir de las ${wet[0].h}:00, con un ${wet[0].rainProb} por ciento. Mejor lleva paraguas.`;
    },
  },

  // ---------- tiempo de mañana ----------
  {
    re: /^(que|como) (tiempo|clima) (hara|va a hacer|hay|tendremos) manana$|^(como estara|como sera) (el tiempo |el clima )?manana$|^(el )?(tiempo|clima) (de|para) manana$|^(va a llover|llovera) manana$/,
    run: async () => {
      const d = await getWeatherDetail();
      const t = d.days[1];
      if (!t) return null;
      const rain = t.rainProb >= 50 ? ` Probabilidad de lluvia: ${t.rainProb} por ciento.` : "";
      return `Mañana se espera ${t.text.toLowerCase()}, entre ${t.min} y ${t.max} grados.${rain}`;
    },
  },

  // ---------- temporizador ----------
  {
    re: /^(pon|ponme|crea|programa|inicia|activa)( una?)? (temporizador|timer|cronometro|alarma) (de )?(.+?)( para (.+))?$|^(avisame|recuerdame) en (.+?)( para (.+))?$/,
    run: async (m, env, changed) => {
      const amount = m[5] || m[9];
      const label = (m[7] || m[11] || "").trim();
      const secs = parseDuration(amount);
      if (!secs) return null; // "pon una alarma a las 7" → que lo haga la IA
      const t = await H.createTimer(env, { seconds: secs, label: label || undefined });
      changed.home = true;
      return `Temporizador de ${sayDuration(secs)}${label ? ` para ${label}` : ""} en marcha.`;
    },
  },

  // ---------- lista de la compra ----------
  {
    re: /^(anade|agrega|apunta|pon|mete|anota) (.+?) (a|en) la lista( de la compra| de compras)?$/,
    run: async (m, env, changed) => {
      const items = m[2].split(/,| y /).map((s) => s.trim()).filter(Boolean).slice(0, 10);
      if (!items.length) return null;
      await H.addShopping(env, items);
      changed.home = true;
      return `Añadido a la lista: ${items.join(", ")}.`;
    },
  },
  {
    re: /^(que (hay|tenemos|falta|queda) en la lista( de la compra)?|lee(me)? la lista( de la compra)?|que hay que comprar|que tenemos que comprar)$/,
    run: async (m, env) => {
      const pending = (await H.listShopping(env)).filter((i) => !i.done).map((i) => i.text);
      if (!pending.length) return "La lista de la compra está vacía.";
      return `En la lista hay ${pending.length === 1 ? "una cosa" : pending.length + " cosas"}: ${pending.slice(0, 12).join(", ")}.`;
    },
  },

  // ---------- precio de la luz ----------
  {
    re: /^(cuanto (cuesta|vale|esta) la (luz|electricidad)( ahora| hoy)?|(que )?precio (tiene )?(de )?la (luz|electricidad)( ahora| hoy)?|esta (cara|barata) la luz( ahora)?|cuando (es|esta) (mas barata|barata) la luz( hoy)?)$/,
    run: async () => {
      const p = await getPower();
      const c = p.real.cheapestRest;
      const level = p.now.sek < p.avg * 0.9 ? "barata" : p.now.sek <= p.avg * 1.15 ? "en la media" : "cara";
      const best = c && c.h !== p.now.h ? ` La más barata del resto del día será a las ${c.h}:00, a ${kr(c.sek)}.` : " Ahora es lo más barato del día.";
      return `Ahora la luz cuesta ${kr(p.real.now)} coronas el kilovatio hora, con todo incluido: está ${level}.${best}`;
    },
  },

  // ---------- agenda de mañana ----------
  {
    re: /^(que (hay|tengo|tenemos) (para )?manana|que hacemos manana|(la )?agenda (de|para) manana|que tenemos en la agenda manana)$/,
    run: async (m, env) => {
      const a = await getAgenda(env);
      const tmr = (a.upcoming || []).filter((e) => e.when === "Mañana");
      if (!tmr.length) return "Mañana no hay nada en la agenda.";
      return `Mañana: ${tmr.slice(0, 4).map((e) => e.title).join(", ")}.`;
    },
  },

  // ---------- alarma ----------
  {
    re: /^(a que hora (suena|sonara) (la|mi) alarma( manana)?|cuando suena (la|mi) alarma|tengo (alguna )?alarma( manana)?|hay alarma( manana)?)$/,
    run: async (m, env) => nextAlarmText(env),
  },
];

function parseDuration(text) {
  const t = text.trim();
  if (/^media hora$/.test(t)) return 1800;
  if (/^(un )?cuarto de hora$/.test(t)) return 900;
  if (/^(una )?hora y media$/.test(t)) return 5400;
  let total = 0, matched = false;
  const re = /(\d+|[a-z_]+(?: y [a-z]+)?) (segundos?|minutos?|horas?)/g;
  let m;
  while ((m = re.exec(t))) {
    const n = num(m[1]);
    if (!n) return 0;
    total += n * (m[2].startsWith("seg") ? 1 : m[2].startsWith("min") ? 60 : 3600);
    matched = true;
  }
  if (/ y media$/.test(t) && matched) total += /horas?/.test(t) ? 1800 : 30;
  return matched && total >= 5 && total <= 86400 ? total : 0;
}

function sayDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const parts = [];
  if (h) parts.push(h === 1 ? "una hora" : `${h} horas`);
  if (m) parts.push(m === 1 ? "un minuto" : `${m} minutos`);
  if (x) parts.push(`${x} segundos`);
  return parts.join(" y ");
}

export async function quickAnswer(env, question, changed) {
  if (question.length > 90) return null;
  const q = clean(question);
  for (const it of INTENTS) {
    const m = q.match(it.re);
    if (!m) continue;
    try {
      const reply = await it.run(m, env, changed);
      if (reply) return reply;
    } catch { /* si falla un dato, que conteste la IA */ }
    return null;
  }
  return null;
}

export const _test = { clean, parseDuration, INTENTS };
