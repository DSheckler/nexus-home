// Respuestas directas sin IA para las preguntas más habituales.
// Son instantáneas y no gastan cuota. Si la frase no encaja claramente, devuelve null
// y responde el asistente con IA como siempre.

import { getWeather, getWeatherDetail } from "./weather.js";
import { getAgenda } from "./calendar.js";
import * as H from "./household.js";
import { getPower, nextAlarmText } from "./extras.js";
import { config } from "./config.js";
import { powerMonthText } from "./consumption.js";
import * as P from "./planner.js";

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

// Frase "limpia": minúsculas, sin tildes, sin "oye nexus", sin signos y sin coletillas
// de cortesía ("me puedes decir…", "oye, dime…"), para que casen más formas de preguntar
const POLITE = /^((me )?(puedes|podrias) decir(me)?|(puedes|podrias) (mirar|ver)|dime|sabes|quiero saber|una pregunta|oye|ey|hey|nexus|nexos|lexus|y|vale|bueno|a ver) /;
function clean(q) {
  let s = q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!.,;:]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/ (nexus|por favor|porfa)$/, "").trim();
  for (let i = 0; i < 4 && POLITE.test(s); i++) s = s.replace(POLITE, "");
  return s;
}
const words = (q) => q.split(" ").length;
const fDate = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const WX = /\b(tiempo|clima|temperatura|grados|frio|calor|abrigo)\b/;
const WET = /\b(llover|llovera|llueve|lluvia|nevar|nevara|nieva|nieve|paraguas)\b/;
const NOT_WX = /\b(temporizador|alarma|recuerda|recuerdame|avisa|avisame|cuanto tiempo|queda|falta|tarda|hace cuanto|semana|pasado manana)\b/;

// Temporizadores: "pon un temporizador de 5 minutos", "avísame dentro de 10 minutos para la pasta"…
function timerIntent(re, amountAt, labelAt) {
  return {
    re,
    run: async (m, env, changed) => {
      const secs = parseDuration(m[amountAt] || "");
      if (!secs) return null; // "pon una alarma a las 7" → que lo haga la IA
      const label = (m[labelAt] || "").trim();
      await H.createTimer(env, { seconds: secs, label: label || undefined });
      changed.home = true;
      return `Temporizador de ${sayDuration(secs)}${label ? ` para ${label}` : ""} en marcha.`;
    },
  };
}

const INTENTS = [
  // ---------- hora ----------
  { re: /^(que hora es|que horas son|que hora tenemos|me dices la hora|dime la hora|la hora)( ahora)?$/, run: async () => `Son las ${fHour.format(new Date())}.` },

  // ---------- fecha ----------
  {
    re: /^(que dia es( hoy)?|a que (dia )?estamos( hoy)?|que fecha es( hoy)?|cual es la fecha( de hoy)?|en que dia estamos)$/,
    run: async () => `Hoy es ${fDate.format(new Date())}.`,
  },

  // ---------- cortesía (sin gastar IA) ----------
  { re: /^(gracias|muchas gracias|vale gracias|ok gracias|genial gracias|perfecto gracias)$/, run: async () => "De nada." },
  { re: /^(hola|hola que tal)$/, run: async () => "¡Hola! ¿En qué te ayudo?" },

  // ---------- tiempo de mañana ----------
  {
    test: (q) => (WX.test(q) || WET.test(q)) && /\bmanana\b/.test(q) && !NOT_WX.test(q) && words(q) <= 9,
    run: async () => {
      const d = await getWeatherDetail();
      const t = d.days[1];
      if (!t) return null;
      const rain = t.rainProb >= 50 ? ` Probabilidad de lluvia: ${t.rainProb} por ciento.` : "";
      return `Mañana se espera ${t.text.toLowerCase()}, entre ${t.min} y ${t.max} grados.${rain}`;
    },
  },

  // ---------- lluvia hoy ----------
  {
    test: (q) => WET.test(q) && !/\bmanana\b/.test(q) && !NOT_WX.test(q) && words(q) <= 9,
    run: async () => {
      const d = await getWeatherDetail();
      const nowH = d.now.time.slice(11, 13);
      const wet = d.days[0].hours.filter((x) => x.h >= nowH && x.rainProb >= 50);
      if (!wet.length) return `No se espera lluvia el resto del día: probabilidad máxima de ${Math.max(0, ...d.days[0].hours.filter((x) => x.h >= nowH).map((x) => x.rainProb))} por ciento.`;
      return `Sí, es probable a partir de las ${wet[0].h}:00, con un ${wet[0].rainProb} por ciento. Mejor lleva paraguas.`;
    },
  },

  // ---------- tiempo ahora ----------
  {
    test: (q) => WX.test(q) && !/\bmanana\b/.test(q) && !NOT_WX.test(q) && words(q) <= 8,
    run: async () => {
      const w = await getWeather();
      const feels = w.now.feels < w.now.temp - 2 ? `, con sensación de ${w.now.feels}` : "";
      return `Ahora hay ${w.now.temp} grados en ${config().city}${feels}, ${w.now.text.toLowerCase()}. Hoy, entre ${w.today.min} y ${w.today.max} grados.`;
    },
  },

  // ---------- temporizador ----------
  timerIntent(/^(pon|ponme|crea|programa|inicia|activa|empieza)( un| una)? (temporizador|timer|cronometro|alarma) (de )?(.+?)( para (.+))?$/, 5, 7),
  timerIntent(/^(avisame|recuerdame|llamame) (en|dentro de) (.+?)( para (.+))?$/, 3, 5),
  timerIntent(/^(temporizador|timer|cronometro) (de )?(.+?)( para (.+))?$/, 3, 5),

  // ---------- lista de la compra ----------
  {
    re: /^(anade|agrega|apunta|pon|mete|anota|incluye|apuntame) (.+?) (a|en) (la|mi) (lista|compra)( de (la )?compras?| del super(mercado)?)?$/,
    run: async (m, env, changed) => {
      const items = m[2].split(/,| y /).map((s) => s.trim()).filter(Boolean).slice(0, 10);
      if (!items.length) return null;
      await H.addShopping(env, items);
      changed.home = true;
      return `Añadido a la lista: ${items.join(", ")}.`;
    },
  },
  {
    re: /^(que (hay|tenemos|tengo|falta|queda|pone) (en )?(la|mi) (lista|compra)( de (la )?compras?)?|lee(me)? (la|mi) lista( de (la )?compras?)?|que (hay|tenemos|tengo) que comprar|que (falta|necesitamos) comprar|(la )?lista de (la )?compras?|como (esta|va) la lista( de (la )?compras?)?)$/,
    run: async (m, env) => {
      const pending = (await H.listShopping(env)).filter((i) => !i.done).map((i) => i.text);
      if (!pending.length) return "La lista de la compra está vacía.";
      return `En la lista hay ${pending.length === 1 ? "una cosa" : pending.length + " cosas"}: ${pending.slice(0, 12).join(", ")}.`;
    },
  },

  // ---------- recordatorio con hora: "recuérdame mañana a las 6 de la tarde sacar la basura" ----------
  {
    re: /^(?:recuerdame|recuerdanos|avisame|avisanos)(?: que)? (?:(hoy|manana|pasado manana|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo)) )?a las (\d{1,2})(?:(?::| )(\d{2})| y (media|cuarto))?(?: (?:de la|por la) (manana|tarde|noche))? (?:que |de |para )?(.{2,120})$/,
    run: async (m, env, changed) => {
      const [, when, wd, hh, mm, frac, part, text] = m;
      let h = Number(hh);
      const min = mm ? Number(mm) : frac === "media" ? 30 : frac === "cuarto" ? 15 : 0;
      if (h > 23 || min > 59) return null;
      if ((part === "tarde" || part === "noche") && h < 12) h += 12;
      const today = P.todayKey();
      let date = today;
      if (when === "manana") date = P.addDays(today, 1);
      else if (when === "pasado manana") date = P.addDays(today, 2);
      else if (wd) {
        const target = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"].indexOf(wd);
        const dow = new Date(today + "T12:00:00Z").getUTCDay();
        date = P.addDays(today, (target - dow + 7) % 7);
      }
      const time = String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
      let at = P.stockholmToMs(date, time);
      if (at < Date.now()) {
        if (wd) at = P.stockholmToMs(P.addDays(date, 7), time);
        else if (!when && !part && h < 12 && P.stockholmToMs(date, String(h + 12).padStart(2, "0") + ":" + String(min).padStart(2, "0")) > Date.now()) at = P.stockholmToMs(date, String(h + 12).padStart(2, "0") + ":" + String(min).padStart(2, "0"));
        else if (!when) at = P.stockholmToMs(P.addDays(date, 1), time);
        else return null;
      }
      const r = await P.addReminder(env, { text, at });
      changed.home = true;
      return `Vale, te lo recuerdo el ${P.whenText(r.at)}: ${r.text}.`;
    },
  },

  // ---------- tareas de la casa ----------
  {
    re: /^(que tareas (hay|tenemos|tocan|quedan|me tocan|hay que hacer)( hoy| esta semana| pendientes)?|(las )?tareas( de (hoy|la casa|la semana))?|a quien le toca( hoy)?( .{2,40})?)$/,
    run: async (m, env) => {
      const list = await P.listChores(env);
      if (!list.length) return "No hay tareas de la casa apuntadas. Puedes crearlas en el panel, en Tareas.";
      const due = list.filter((c) => c.dueIn <= 0);
      const say = (c) => `${c.name}${c.who ? `, le toca a ${c.who}` : ""}`;
      if (due.length) return `Hoy toca: ${due.slice(0, 5).map(say).join("; ")}.`;
      const next = list[0];
      return `Hoy no toca ninguna tarea. La próxima es ${say(next)}, ${next.dueIn === 1 ? "mañana" : `dentro de ${next.dueIn} días`}.`;
    },
  },

  // ---------- gasto de luz del mes ----------
  {
    test: (q) => /\b(luz|electricidad|consumo|kwh|kilovatios)\b/.test(q)
      && /\b(gastado|gastamos|gastando|llevamos|consumido|consumimos|vamos a pagar|pagaremos|pagamos|factura|este mes|al mes|del mes)\b/.test(q)
      && !/\b(enciende|apaga|lampara|luces)\b/.test(q) && words(q) <= 12,
    run: async (m, env) => powerMonthText(env),
  },

  // ---------- precio de la luz ----------
  {
    test: (q) => /\b(luz|electricidad|kwh|kilovatio)\b/.test(q) && /\b(cuesta|vale|precio|cara|barata|caro|barato|cuanto|cuando|esta|tarifa)\b/.test(q)
      && !/\b(enciende|apaga|prende|enciendes|apagas|lampara|salon|cocina|dormitorio|bano|habitacion|encendida|apagada|luces)\b/.test(q) && words(q) <= 10,
    run: async () => {
      const p = await getPower();
      const c = p.real.cheapestRest;
      const level = p.now.sek < p.avg * 0.9 ? "barata" : p.now.sek <= p.avg * 1.15 ? "en la media" : "cara";
      const best = c && c.h !== p.now.h ? ` La más barata del resto del día será a las ${c.h}:00, a ${kr(c.sek)}.` : " Ahora es lo más barato del día.";
      return `Ahora la luz cuesta ${kr(p.real.now)} coronas el kilovatio hora, con todo incluido: está ${level}.${best}`;
    },
  },

  // ---------- agenda de hoy ----------
  {
    re: /^(que (hay|tengo|tenemos|hacemos) (para )?hoy|que (hay|tengo|tenemos) (hoy )?en la agenda( hoy| para hoy)?|(la )?agenda (de|para) hoy|que planes (hay|tenemos) (para )?hoy|(tengo|tenemos|hay) algo (para )?hoy)$/,
    run: async (m, env) => {
      const a = await getAgenda(env);
      const nowHM = fHour.format(new Date());
      const left = (a.today || []).filter((e) => e.allDay || e.end >= nowHM);
      if (!left.length) return "Hoy no queda nada en la agenda.";
      return `Hoy: ${left.slice(0, 5).map((e) => (e.allDay ? e.title : `${e.title} a las ${e.start}`)).join(", ")}.`;
    },
  },

  // ---------- agenda de mañana ----------
  {
    re: /^(que (hay|tengo|tenemos|hacemos) (para )?manana|que (hay|tengo|tenemos) en la agenda (para )?manana|(la )?agenda (de|para) manana|que planes (hay|tenemos) (para )?manana|(tengo|tenemos|hay) algo (para )?manana)$/,
    run: async (m, env) => {
      const a = await getAgenda(env);
      const tmr = (a.upcoming || []).filter((e) => e.when === "Mañana");
      if (!tmr.length) return "Mañana no hay nada en la agenda.";
      return `Mañana: ${tmr.slice(0, 4).map((e) => e.title).join(", ")}.`;
    },
  },

  // ---------- alarma ----------
  {
    re: /^(a que hora (suena|sonara) (la|mi|el) (alarma|despertador)( manana)?|cuando suena (la|mi|el) (alarma|despertador)( manana)?|tengo (alguna )?alarma( puesta)?( para)?( manana)?|hay (alguna )?alarma( puesta)?( para)?( manana)?|a que hora me (despierto|levanto)( manana)?)$/,
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
    const m = it.re ? q.match(it.re) : it.test(q) ? [q] : null;
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
