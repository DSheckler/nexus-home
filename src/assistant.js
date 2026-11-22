// Asistente de NEXUS Home con un modelo gratuito de Cloudflare Workers AI.
// Modelo: gpt-oss-120b (modelo abierto de OpenAI). Formato de chat compatible con OpenAI.
// Coste: dentro de la cuota diaria gratuita de Workers AI (10.000 neuronas/día).

import { getWeather } from "./weather.js";
import { agendaRange, createEvent, updateEvent, deleteEvent } from "./calendar.js";
import { googleConfigured, calendarsConfig } from "./google.js";
import { listAlarms, createAlarm, updateAlarm, deleteAlarm } from "./alarms.js";
import * as H from "./household.js";
import * as P from "./planner.js";
import * as L from "./life.js";
import { getWeeklyBriefing } from "./weekly.js";
import { householdContext, getBriefing, planCheapPower, runRoutine } from "./extras.js";

// Peticiones de resumen: se responden con el resumen exacto generado por código (sin IA)
// Rutinas: solo cuando la frase es exactamente eso (no "buenas noches, ¿qué tiempo hace?")
const LEAD = String.raw`^(?:oye\s+)?(?:nexus[,\s]*)?`;
const ROUTINES = [
  { name: "dormir", re: new RegExp(LEAD + String.raw`(?:buenas noches|me voy a (?:dormir|la cama|acostar)|nos vamos a (?:dormir|la cama|acostar)|a dormir|hasta manana)(?:[\s,]+(?:nexus|familia|a todos))?[\s.!,]*$`, "i") },
  { name: "salir", re: new RegExp(LEAD + String.raw`(?:me voy|nos vamos|me marcho|nos marchamos|salgo|salimos|ya me voy|ya nos vamos)(?:\s+(?:al|a la|a)\s+[a-z ]{2,20})?(?:[\s,]+nexus)?[\s.!,]*$`, "i") },
  { name: "llegar", re: new RegExp(LEAD + String.raw`(?:ya\s+)?(?:he llegado|hemos llegado|llegue|llegamos|estoy en casa|estamos en casa)(?:\s+a casa)?(?:[\s,]+nexus)?[\s.!,]*$`, "i") },
];
const WEEKLY = /\b(resumen|que (hay|tenemos|tengo)|como (viene|va)|plan(es)?)\b.*\b(semana|semanal)\b|\bresumen semanal\b/i;
const SUMMARY = /\b(resumen|res[uú]me(me|lo)?|ponme al d[ií]a|c[oó]mo (viene|va|est[aá]) (el d[ií]a|mi d[ií]a|hoy)|qu[eé] (hay|tengo) (para )?hoy|novedades)\b/i;
import { getDevices, controlDevice, listDeviceConfig } from "./devices.js";
import { quickAnswer } from "./quick.js";
import { config } from "./config.js";

const DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";
const TZ = "Europe/Stockholm";
const MAX_HISTORY = 6;   // turnos previos que se reenvían (menos texto = menos cuota)
const MAX_STEPS = 6;     // vueltas máximas modelo -> herramientas -> modelo

const fNow = new Intl.DateTimeFormat("es-ES", {
  weekday: "long", year: "numeric", month: "long", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ,
});
const fIso = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });

const listNames = (a) => (a.length > 1 ? a.slice(0, -1).join(", ") + " y " + a[a.length - 1] : a[0] || "");
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");

const SYSTEM = () => `Eres NEXUS, el asistente del panel de control de una casa en ${config().city} (Suecia).
La familia que vive en la casa la forma ${listNames(config().family)}. Hablas en español, con un tono cercano y tranquilo.

Tus respuestas se leen en voz alta en una tablet colgada en la pared:
- Responde en una o dos frases cortas (como mucho unas 35 palabras), sin listas, sin markdown, sin emojis y sin enlaces.
- Es una conversación hablada y continua: no termines cada respuesta con una pregunta de cortesía; pregunta solo si te falta un dato.
- Si la persona se despide o da las gracias para terminar, responde con una despedida muy breve.
- Di las horas en formato de 24 horas.
- Si la petición es ambigua (por ejemplo, no sabes para quién es un evento), pregunta solo lo imprescindible.

Herramientas:
- Usa las herramientas para consultar o cambiar la agenda, las alarmas y el clima; nunca inventes datos.
- Calcula las fechas a partir de la fecha actual que se indica en cada mensaje.
- Para crear un evento sin persona indicada, usa el calendario de quien habla si lo dijo; si no, pregunta para quién es.
- "Recuérdame…" a una hora concreta: crea una alarma de una sola vez (sin días) con un nombre que describa el recordatorio.
- Antes de borrar un evento o una alarma, confirma con la persona salvo que lo haya pedido de forma explícita e inequívoca.
- Después de crear, cambiar o borrar algo, confírmalo en una frase con el día y la hora.
- "Pon un temporizador de…": usa crear_temporizador (en segundos) con un nombre corto si lo dicen ("pasta").
- "Añade leche a la lista", "¿qué hay en la lista?": lista de la compra compartida.
- "Dile a ${config().family[config().family.length - 1] || "alguien"} que…", "deja una nota…": dejar_nota; las notas se ven en el panel hasta que alguien las quita.
- "Pon música", "pon a Shakira en Spotify", "pon un vídeo de…": abrir_musica (Spotify para música, YouTube para vídeos). Avisa de que se abre la app y que el botón de inicio vuelve a NEXUS.
- Luces y enchufes de casa: usa estado_casa y controlar_dispositivo; si no hay dispositivos configurados, dilo.
- Precio de la luz: en los datos actuales viene el spot y el precio real (con red, impuesto e IVA) y el contrato. "Avísame cuando la luz esté barata para la lavadora": avisar_luz_barata.
- Cumpleaños y aniversarios: guardar_fecha / borrar_fecha / ver_fechas. Las próximas vienen en los datos actuales.
- Recordatorios con día y hora ("recuérdame el jueves a las 18 sacar la basura"): crear_recordatorio con fecha y hora exactas calculadas desde la fecha actual; ver_recordatorios; borrar_recordatorio. Para "en 10 minutos" usa un temporizador.
- Recordatorios que se repiten ("cada lunes a las 8", "cada día 25"): crear_recordatorio con repetir (unidad dia/semana/mes y cada N); la fecha es la primera vez.
- Menú de la semana: ver_menu, poner_menu (una llamada por día; añade ingredientes si los sabes), menu_a_compra para pasar los ingredientes a la lista.
- Cocinar: "vamos a cocinar X" o "cocinemos lo del menú" → mostrar_receta con pasos cortos y claros (y minutos si hay espera). Luego responde solo con el primer paso.
- Plantas: ver_plantas / regar_plantas ("ya regué las plantas"). Colegio: ver_colegio. Vacaciones: modo_vacaciones con fechas, o quitar_vacaciones al volver.
- Tareas de la casa con turnos (regar plantas cada 3 días, le toca a…): ver_tareas, crear_tarea, tarea_hecha ("ya regué las plantas"), borrar_tarea.
- Avisos de SMHI vienen en los datos actuales.`;

const S = (props, required = []) => ({ type: "object", properties: props, required });
const DATE = { type: "string", description: "Fecha AAAA-MM-DD" };
const TIME = { type: "string", description: "Hora HH:MM en formato 24 h" };
const DAYS = { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "0=domingo, 1=lunes … 6=sábado" };

function buildTools(env, changed) {
  const people = googleConfigured(env) ? calendarsConfig(env).map((c) => c.who) : config().family.map(slug);
  const WHO = { type: "string", enum: people, description: "Calendario (persona) donde está o irá el evento" };

  return {
    consultar_clima: {
      description: "Clima actual y pronóstico en la ciudad de la casa, con amanecer y atardecer. 'hoy' es el día actual; 'proximos_dias' empieza mañana, y cada día lleva su fecha.",
      parameters: S({}),
      run: () => weatherForModel(),
    },
    consultar_agenda: {
      description: "Eventos de la familia desde hoy durante los próximos días. Devuelve id, persona, título, fecha y horas.",
      parameters: S({ dias: { type: "integer", minimum: 1, maximum: 30, description: "Número de días, incluido hoy" } }, ["dias"]),
      run: (a) => agendaRange(env, Number(a.dias) || 7),
    },
    crear_evento: {
      description: "Crea un evento en Google Calendar. Sin hora de inicio se crea de todo el día. Sin hora de fin dura una hora.",
      parameters: S({ persona: WHO, titulo: { type: "string" }, fecha: DATE, inicio: TIME, fin: TIME, descripcion: { type: "string" } }, ["persona", "titulo", "fecha"]),
      run: async (a) => {
        const r = await createEvent(env, { who: a.persona, title: a.titulo, date: a.fecha, start: a.inicio, end: a.fin, description: a.descripcion, allDay: !a.inicio });
        changed.agenda = true;
        return r;
      },
    },
    modificar_evento: {
      description: "Cambia título, fecha u horas de un evento existente (usa el id de consultar_agenda).",
      parameters: S({ persona: WHO, id: { type: "string" }, titulo: { type: "string" }, fecha: DATE, inicio: TIME, fin: TIME }, ["persona", "id"]),
      run: async (a) => {
        const r = await updateEvent(env, { who: a.persona, id: a.id, title: a.titulo, date: a.fecha, start: a.inicio, end: a.fin });
        changed.agenda = true;
        return r;
      },
    },
    borrar_evento: {
      description: "Borra un evento (usa el id de consultar_agenda). Confirma antes con la persona.",
      parameters: S({ persona: WHO, id: { type: "string" } }, ["persona", "id"]),
      run: async (a) => { const r = await deleteEvent(env, { who: a.persona, id: a.id }); changed.agenda = true; return r; },
    },
    consultar_alarmas: {
      description: "Lista las alarmas con id, hora, días (0=domingo … 6=sábado; vacío = una vez), nombre y si están activas.",
      parameters: S({}),
      run: () => listAlarms(env),
    },
    crear_alarma: {
      description: "Crea una alarma o recordatorio. Sin días suena una sola vez, la próxima vez que llegue esa hora.",
      parameters: S({ hora: TIME, dias: DAYS, nombre: { type: "string" }, rutina: { type: "boolean", description: "Mostrar clima y agenda al sonar (por defecto sí)" } }, ["hora"]),
      run: async (a) => {
        await createAlarm(env, { time: a.hora, days: a.dias || [], label: a.nombre, routine: a.rutina !== false });
        changed.alarms = true;
        return { creada: true, hora: a.hora, dias: a.dias || [] };
      },
    },
    modificar_alarma: {
      description: "Activa, desactiva o cambia una alarma existente (usa el id de consultar_alarmas).",
      parameters: S({ id: { type: "string" }, hora: TIME, dias: DAYS, nombre: { type: "string" }, activa: { type: "boolean" } }, ["id"]),
      run: async (a) => {
        const patch = {};
        if (a.hora) patch.time = a.hora;
        if (Array.isArray(a.dias)) patch.days = a.dias;
        if (a.nombre) patch.label = a.nombre;
        if (typeof a.activa === "boolean") patch.enabled = a.activa;
        await updateAlarm(env, a.id, patch);
        changed.alarms = true;
        return { modificada: true };
      },
    },
    crear_temporizador: {
      description: "Crea un temporizador (cuenta atrás) que suena en la tablet.",
      parameters: S({ segundos: { type: "integer", minimum: 5, maximum: 86400 }, nombre: { type: "string" } }, ["segundos"]),
      run: async (a) => { const t = await H.createTimer(env, { seconds: a.segundos, label: a.nombre }); changed.home = true; return { creado: t.label, segundos: t.seconds }; },
    },
    cancelar_temporizador: {
      description: "Cancela un temporizador por id (de los datos actuales) o 'all' para todos.",
      parameters: S({ id: { type: "string" } }, ["id"]),
      run: async (a) => { await H.deleteTimer(env, a.id); changed.home = true; return { cancelado: true }; },
    },
    anadir_compra: {
      description: "Añade uno o varios artículos a la lista de la compra compartida.",
      parameters: S({ articulos: { type: "array", items: { type: "string" } } }, ["articulos"]),
      run: async (a) => { const l = await H.addShopping(env, a.articulos); changed.home = true; return { articulos_en_lista: l.length }; },
    },
    ver_compra: {
      description: "Lista de la compra actual.",
      parameters: S({}),
      run: async () => (await H.listShopping(env)).map((i) => ({ articulo: i.text, comprado: i.done })),
    },
    quitar_compra: {
      description: "Quita un artículo de la lista (texto aproximado), 'comprados' para quitar los marcados, o 'todo' para vaciarla.",
      parameters: S({ articulo: { type: "string" } }, ["articulo"]),
      run: async (a) => { const l = await H.removeShopping(env, a.articulo); changed.home = true; return { quedan: l.length }; },
    },
    dejar_nota: {
      description: "Deja una nota visible en el panel para alguien de la familia (o 'Todos').",
      parameters: S({ para: { type: "string" }, texto: { type: "string" }, de: { type: "string" } }, ["para", "texto"]),
      run: async (a) => { await H.addNote(env, { to: a.para, text: a.texto, from: a.de }); changed.home = true; return { nota: "guardada" }; },
    },
    borrar_nota: {
      description: "Borra una nota por id (de los datos actuales) o 'all'.",
      parameters: S({ id: { type: "string" } }, ["id"]),
      run: async (a) => { await H.deleteNote(env, a.id); changed.home = true; return { borrada: true }; },
    },
    abrir_musica: {
      description: "Abre Spotify (música) o YouTube (vídeos) en la tablet, opcionalmente con una búsqueda.",
      parameters: S({ app: { type: "string", enum: ["spotify", "youtube"] }, buscar: { type: "string" } }, ["app"]),
      run: async (a) => { changed.open = { app: a.app, query: (a.buscar || "").slice(0, 80) }; return { abriendo: a.app }; },
    },
    avisar_luz_barata: {
      description: "Busca la hora más barata de las próximas 24 h para usar un aparato (lavadora, lavavajillas, secadora…) y deja un aviso. Si cae de noche, crea un recordatorio antes de dormir para usar el inicio diferido. Explica la hora, cuánto cuesta el kWh entonces frente a ahora, y el aviso creado.",
      parameters: S({ aparato: { type: "string", description: "Por ejemplo: la lavadora, el lavavajillas, la secadora" }, duracion_horas: { type: "integer", minimum: 1, maximum: 4, description: "Cuánto dura el programa (lavadora 2, lavavajillas 2, secadora 2)" } }, ["aparato"]),
      run: async (a) => { const r = await planCheapPower(env, { appliance: a.aparato, hours: a.duracion_horas || 2 }); changed.home = true; return r; },
    },
    guardar_fecha: {
      description: "Guarda un cumpleaños, aniversario u otra fecha importante que se repite cada año. NEXUS avisa una semana antes, tres días antes, el día anterior y el mismo día. Si dicen el año de nacimiento, inclúyelo para decir la edad.",
      parameters: S({ nombre: { type: "string", description: "Persona o motivo, p. ej. 'la abuela Rosa' o 'Ana y Luis'" }, fecha: { type: "string", description: "AAAA-MM-DD si se conoce el año, si no MM-DD" }, tipo: { type: "string", enum: ["cumpleaños", "aniversario", "fecha"] } }, ["nombre", "fecha"]),
      run: async (a) => { const d = await H.addDate(env, { name: a.nombre, date: a.fecha, kind: a.tipo }); changed.home = true; changed.agenda = true; return { guardada: d }; },
    },
    borrar_fecha: {
      description: "Borra una fecha importante guardada (por nombre).",
      parameters: S({ nombre: { type: "string" } }, ["nombre"]),
      run: async (a) => { await H.deleteDate(env, a.nombre); changed.home = true; changed.agenda = true; return { borrada: true }; },
    },
    ver_fechas: {
      description: "Lista las fechas importantes guardadas (cumpleaños, aniversarios) con cuántos días faltan.",
      parameters: S({}),
      run: () => H.upcomingDates(env, 366),
    },
    crear_recordatorio: {
      description: "Crea un recordatorio que suena en el panel a una fecha y hora concretas (hora de Suecia). Puede repetirse.",
      parameters: S({
        texto: { type: "string", description: "Qué recordar, corto, p. ej. 'sacar la basura'" }, fecha: DATE, hora: TIME,
        persona: { type: "string", description: "Para quién (opcional)" },
        repetir: { type: "object", description: "Opcional: se repite", properties: { unidad: { type: "string", enum: ["dia", "semana", "mes"] }, cada: { type: "integer", minimum: 1, maximum: 52 } } },
      }, ["texto", "fecha", "hora"]),
      run: async (a) => { const r = await P.addReminder(env, { text: a.texto, date: a.fecha, time: a.hora, who: a.persona, repeat: a.repetir }); changed.home = true; return { creado: { texto: r.text, cuando: P.whenText(r.at), repite: P.repeatText(r.repeat) || "no" } }; },
    },
    ver_menu: {
      description: "Menú de cenas de los próximos 7 días (fecha, comida, ingredientes).",
      parameters: S({}),
      run: () => L.getMenu(env, 7),
    },
    poner_menu: {
      description: "Pone (o cambia) la comida de un día del menú. Comida vacía la quita.",
      parameters: S({ fecha: DATE, comida: { type: "string" }, ingredientes: { type: "array", items: { type: "string" } } }, ["fecha", "comida"]),
      run: async (a) => { await L.setMenu(env, a.fecha, { meal: a.comida, ingredients: a.ingredientes }); changed.home = true; return { guardado: true }; },
    },
    menu_a_compra: {
      description: "Añade a la lista de la compra los ingredientes del menú entre dos fechas que aún no estén en la lista.",
      parameters: S({ desde: DATE, hasta: DATE }, []),
      run: async (a) => {
        const want = await L.menuIngredients(env, a.desde, a.hasta);
        const have = new Set((await H.listShopping(env)).filter((i) => !i.done).map((i) => i.text.toLowerCase()));
        const add = want.filter((i) => !have.has(i.toLowerCase()));
        if (add.length) await H.addShopping(env, add);
        changed.home = true;
        return { anadidos: add };
      },
    },
    mostrar_receta: {
      description: "Abre el modo cocina en el panel con una receta paso a paso. Pasos cortos (una acción cada uno), en español, para la familia.",
      parameters: S({
        titulo: { type: "string" }, personas: { type: "integer" },
        ingredientes: { type: "array", items: { type: "string" }, description: "Con cantidades" },
        pasos: { type: "array", items: { type: "object", properties: { texto: { type: "string" }, minutos: { type: "integer", description: "Si hay que esperar (horno, cocción); si no, 0" } }, required: ["texto"] } },
      }, ["titulo", "pasos"]),
      run: async (a) => {
        const steps = (a.pasos || []).slice(0, 25).map((x) => ({ text: String(x.texto || "").slice(0, 300), minutes: Math.max(0, Math.round(Number(x.minutos) || 0)) })).filter((x) => x.text);
        if (!steps.length) return { error: "Faltan los pasos" };
        changed.cook = { start: { title: String(a.titulo).slice(0, 80), servings: a.personas || null, ingredients: (a.ingredientes || []).slice(0, 30).map(String), steps } };
        return { abierta: true, pasos: steps.length, primer_paso: steps[0].text };
      },
    },
    ver_plantas: {
      description: "Estado del riego de las plantas: si toca hoy, si está atrasado y cuándo es el próximo.",
      parameters: S({}),
      run: async () => (await L.listPlants(env)).map((p) => ({ plantas: p.name, cada_dias: p.every, toca_ahora: p.pending, dias_de_retraso: p.late, proximo_riego: p.due })),
    },
    regar_plantas: {
      description: "Marca las plantas como regadas hoy.",
      parameters: S({ cuales: { type: "string", description: "Nombre del grupo si hay varios (opcional)" } }, []),
      run: async (a) => { const l = await L.waterPlant(env, a.cuales || ""); changed.home = true; return { regadas: true, proximo_riego: l.map((p) => ({ plantas: p.name, fecha: p.due })) }; },
    },
    ver_colegio: {
      description: "Horario del colegio de hoy y mañana y qué hay que llevar.",
      parameters: S({}),
      run: async () => (await L.schoolSummary(env)) || { sin_configurar: true },
    },
    modo_vacaciones: {
      description: "Activa el modo vacaciones entre dos fechas: el panel se atenúa, las alarmas no suenan y no hay resúmenes.",
      parameters: S({ desde: DATE, hasta: DATE }, ["desde", "hasta"]),
      run: async (a) => { const v = await L.setVacation(env, { from: a.desde, to: a.hasta }); changed.home = true; return { vacaciones: v }; },
    },
    quitar_vacaciones: {
      description: "Quita el modo vacaciones (ya volvieron o se cancela el viaje).",
      parameters: S({}),
      run: async () => { await L.setVacation(env, {}); changed.home = true; return { quitado: true }; },
    },
    ver_recordatorios: {
      description: "Lista los recordatorios pendientes con su fecha y hora.",
      parameters: S({}),
      run: async () => (await P.listReminders(env)).filter((r) => r.at > Date.now()).map((r) => ({ id: r.id, texto: r.text, cuando: P.whenText(r.at) })),
    },
    borrar_recordatorio: {
      description: "Borra un recordatorio por su id o por parte del texto.",
      parameters: S({ cual: { type: "string" } }, ["cual"]),
      run: async (a) => { await P.deleteReminder(env, a.cual); changed.home = true; return { borrado: true }; },
    },
    ver_tareas: {
      description: "Tareas de la casa: cada cuánto se hacen, a quién le toca y cuándo vence (dias_para_vencer negativo = atrasada).",
      parameters: S({}),
      run: async () => (await P.listChores(env)).map((c) => ({ tarea: c.name, cada_dias: c.every, le_toca: c.who, vence: c.due, dias_para_vencer: c.dueIn })),
    },
    crear_tarea: {
      description: "Crea una tarea de la casa que se repite cada N días, con turnos entre personas (opcional).",
      parameters: S({ nombre: { type: "string" }, cada_dias: { type: "integer", minimum: 1, maximum: 365 }, personas: { type: "array", items: { type: "string" }, description: "Nombres en el orden de los turnos" } }, ["nombre", "cada_dias"]),
      run: async (a) => { const c = await P.addChore(env, { name: a.nombre, every: a.cada_dias, people: a.personas }); changed.home = true; return { creada: { tarea: c.name, le_toca: c.who } }; },
    },
    tarea_hecha: {
      description: "Marca una tarea de la casa como hecha hoy; pasa el turno a la siguiente persona.",
      parameters: S({ nombre: { type: "string" } }, ["nombre"]),
      run: async (a) => { const r = await P.doneChore(env, a.nombre); changed.home = true; return { hecha: r.done.name, proxima_vez: r.done.due, le_toca_ahora: r.done.who }; },
    },
    borrar_tarea: {
      description: "Borra una tarea de la casa.",
      parameters: S({ nombre: { type: "string" } }, ["nombre"]),
      run: async (a) => { await P.deleteChore(env, a.nombre); changed.home = true; return { borrada: true }; },
    },
    resumen_del_dia: {
      description: "Resumen exacto del día (tiempo, avisos, agenda pendiente, cumpleaños, notas, luz). Úsalo para cualquier petición de resumen y repite su texto tal cual.",
      parameters: S({}),
      run: async () => ({ resumen: await getBriefing(env) }),
    },
    modo_noche: {
      description: "Controla el modo noche del panel (hora en ámbar tenue y brillo bajo). 'desactivar' lo apaga hasta la mañana siguiente (p. ej. si hoy se trasnocha), 'activar' lo enciende ya hasta la hora de despertar, 'auto' vuelve al horario normal (de domingo a jueves de 22:00 a 07:00, el fin de semana despierta a las 08:00; viernes y sábado la noche empieza a las 00:00).",
      parameters: S({ accion: { type: "string", enum: ["desactivar", "activar", "auto"] } }, ["accion"]),
      run: async (a) => { const r = await H.setNightMode(env, a.accion); changed.home = true; return { modo_noche: a.accion, ajuste: r }; },
    },
    estado_casa: {
      description: "Estado de las luces y enchufes inteligentes (encendido/apagado, conectado).",
      parameters: S({}),
      run: () => getDevices(env),
    },
    controlar_dispositivo: {
      description: "Enciende o apaga un dispositivo de casa (por nombre), o fija el brillo de una luz (1-100).",
      parameters: S({ dispositivo: { type: "string" }, encender: { type: "boolean" }, brillo: { type: "integer", minimum: 1, maximum: 100 } }, ["dispositivo"]),
      run: async (a) => { const r = await controlDevice(env, a.dispositivo, { on: a.encender, brightness: a.brillo }); changed.devices = true; return r; },
    },
    borrar_alarma: {
      description: "Borra una alarma (usa el id de consultar_alarmas). Confirma antes con la persona.",
      parameters: S({ id: { type: "string" } }, ["id"]),
      run: async (a) => { await deleteAlarm(env, a.id); changed.alarms = true; return { borrada: true }; },
    },
  };
}

const DAY_NAMES = { Dom: "domingo", Lun: "lunes", Mar: "martes", "Mié": "miércoles", Jue: "jueves", Vie: "viernes", "Sáb": "sábado" };

async function weatherForModel() {
  const w = await getWeather();
  return {
    ahora: w.now,
    hoy: { fecha: w.today.date, maxima: w.today.max, minima: w.today.min, amanecer: w.today.sunrise, atardecer: w.today.sunset },
    proximos_dias: w.days.map((d, i) => ({
      fecha: d.date, dia: DAY_NAMES[d.d] || d.d, cuando: i === 0 ? "mañana" : undefined,
      tiempo: d.text, maxima: d.max, minima: d.min,
    })),
  };
}

// Datos que casi siempre hacen falta, ya incluidos en la pregunta: así el modelo
// responde en una sola llamada en vez de pedir herramientas una a una (más rápido).
async function contextSnapshot(env) {
  const safe = (p) => p.catch(() => null);
  const [clima, agenda, alarmas, casa, dispositivos] = await Promise.all([
    safe(weatherForModel()),
    safe(googleConfigured(env) ? agendaRange(env, 7) : Promise.resolve(null)),
    safe(listAlarms(env)),
    safe(householdContext(env)),
    safe(listDeviceConfig(env)),
  ]);
  const fechas = await H.upcomingDates(env, 45).catch(() => null);
  // Compacto: cada carácter que se manda al modelo gasta cuota
  const out = {
    clima: clima && { ahora: clima.ahora, hoy: clima.hoy, proximos_dias: clima.proximos_dias.slice(0, 2) },
    agenda_7_dias: agenda && agenda.map((e) => ({ id: e.id, quien: e.who, que: e.title, fecha: e.date, ...(e.allDay ? { todo_el_dia: true } : { de: e.start, a: e.end }), ...(e.type === "birthday" ? { cumple: true } : {}) })),
    alarmas: alarmas && alarmas.map((a) => ({ id: a.id, hora: a.time, dias: a.days, nombre: a.label, ...(a.enabled ? {} : { desactivada: true }) })),
    ...(casa || {}),
    fechas_importantes: fechas && fechas.map((d) => ({ que: d.title, fecha: d.date, faltan_dias: d.inDays })),
    dispositivos_casa: (dispositivos || []).map((d) => ({ nombre: d.name, tipo: d.type, sala: d.room })),
  };
  // Fuera lo vacío
  for (const k of Object.keys(out)) if (out[k] == null || (Array.isArray(out[k]) && !out[k].length)) delete out[k];
  return out;
}

// Ejecuta una llamada a herramienta y devuelve siempre texto para el modelo
async function runTool(tools, call) {
  const tool = tools[call.function && call.function.name];
  if (!tool) return JSON.stringify({ error: "Herramienta desconocida" });
  let args = {};
  try {
    const raw = call.function.arguments;
    args = typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : {}) : raw || {};
  } catch {
    return JSON.stringify({ error: "Argumentos no válidos (JSON mal formado)" });
  }
  const missing = (tool.parameters.required || []).filter((k) => args[k] === undefined || args[k] === "");
  if (missing.length) return JSON.stringify({ error: "Faltan datos: " + missing.join(", ") });
  try {
    return JSON.stringify(await tool.run(args));
  } catch (err) {
    return JSON.stringify({ error: String(err.message || err) });
  }
}

// Neuronas gastadas. Workers AI no siempre las devuelve: se calculan con los tokens
// (gpt-oss-120b: 0,35 USD/M de entrada y 0,75 USD/M de salida; 1.000 neuronas = 0,011 USD).
function neuronsOf(model, usage) {
  if (!usage) return 0;
  if (usage.neurons) return usage.neurons;
  const small = /20b/.test(model);
  const inRate = (small ? 0.2 : 0.35) / 0.011 / 1000, outRate = (small ? 0.3 : 0.75) / 0.011 / 1000;
  return (usage.prompt_tokens || 0) * inRate + (usage.completion_tokens || 0) * outRate;
}

// history: [{ role: "user"|"assistant", text }]
const COOK_CMDS = [
  ["next", /^(siguiente( paso)?|el siguiente|y ahora(\s+que)?|ya esta|listo|hecho|vale siguiente|continua|adelante|sigue)$/],
  ["prev", /^(anterior|paso anterior|atras|vuelve( atras)?|el anterior)$/],
  ["repeat", /^(repite(lo)?|otra vez|que\s+(has dicho|dijiste)|no te (he )?oido|como\s+era)$/],
  ["timer", /^(pon(me)?( el| un)? temporizador|temporizador|avisame cuando (este|termine))$/],
  ["ingredients", /^(ingredientes|que (necesito|hace falta)|lee(me)? los ingredientes)$/],
  ["end", /^(termina(r)?|salir|cierra( la receta)?|ya (hemos )?terminado|fin|terminamos)$/],
];

export async function askAssistant(env, { text, history = [], cooking = false }) {
  const question = String(text || "").trim().slice(0, 2000);
  if (!question) throw new Error("No se recibió ninguna pregunta");

  const model = env.ASSISTANT_MODEL || DEFAULT_MODEL;
  const changed = { agenda: false, alarms: false, home: false, devices: false, open: null };

  // Sin tildes: Whisper a veces las pone y a veces no
  const plain = question.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (cooking) {
    const c = plain.toLowerCase().replace(/[¿?¡!.,;:]/g, " ").replace(/\s+/g, " ").trim().replace(/^(oye |vale |bueno |nexus )+/, "").replace(/ nexus$/, "");
    const hit = COOK_CMDS.find(([, re]) => re.test(c));
    if (hit) { changed.cook = hit[0]; return { reply: "", changed, model: "cocina", neurons: 0 }; }
  }
  const routine = ROUTINES.find((r) => r.re.test(plain));
  if (routine) {
    const r = await runRoutine(env, routine.name);
    if (r.home) changed.home = true;
    return { reply: r.reply, changed, end: !!r.end, model: "rutina:" + routine.name, neurons: 0 };
  }
  if (WEEKLY.test(plain) && question.length < 80) {
    return { reply: await getWeeklyBriefing(env), changed, model: "directo", neurons: 0 };
  }
  if (SUMMARY.test(question) && question.length < 80) {
    return { reply: await getBriefing(env), changed, model: "resumen", neurons: 0 };
  }
  // Preguntas habituales (tiempo, hora, temporizador, lista, luz…): respuesta directa, sin IA
  const quick = await quickAnswer(env, question, changed);
  if (quick) return { reply: quick, changed, model: "directo", neurons: 0 };
  const tools = buildTools(env, changed);
  const toolDefs = Object.entries(tools).map(([name, t]) => ({
    type: "function",
    function: { name, description: t.description, parameters: t.parameters },
  }));

  const now = new Date();
  const snapshot = await contextSnapshot(env);
  const messages = [
    { role: "system", content: SYSTEM() },
    ...history.slice(-MAX_HISTORY)
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
      .map((m) => ({ role: m.role, content: m.text.slice(0, 2000) })),
    {
      role: "user",
      content: `[Ahora: ${fNow.format(now)} (${fIso.format(now)}), hora de Suecia]\n`
        + `[Datos actuales (úsalos directamente; las herramientas solo para cambiar algo o consultar otras fechas): ${JSON.stringify(snapshot)}]\n`
        + question,
    },
  ];

  let neurons = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await env.AI.run(model, {
      messages,
      tools: toolDefs,
      reasoning: { effort: "low" }, // rapidez en conversación
      max_tokens: 700,
    });
    neurons += neuronsOf(model, r.usage);
    const msg = r.choices && r.choices[0] && r.choices[0].message;
    if (!msg) throw new Error("Respuesta vacía del modelo");

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const reply = String(msg.content || "").replace(/[*_#`]/g, "").trim() || "Hecho.";
      return { reply, changed, model, neurons: Math.round(neurons) };
    }

    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
    const results = await Promise.all(calls.map((c) => runTool(tools, c)));
    calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: results[i] }));
  }
  return { reply: "Lo siento, me he liado con esa petición. ¿Puedes decírmelo de otra forma?", changed, model, neurons: Math.round(neurons) };
}
