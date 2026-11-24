// NEXUS Home - lógica de la pantalla principal (sin frameworks).
(function () {
  "use strict";

  const TZ = "Europe/Stockholm";
  const ICON = window.NEXUS_ICONS;
  const ALARMS = window.NexusAlarms;
  const $ = (id) => document.getElementById(id);

  // Ventana visible de la línea del día
  const DAY_START = 6 * 60;   // 06:00
  const DAY_END = 24 * 60;    // 24:00

  // Modo nocturno automático. Índice = día de la semana (0 = domingo).
  // START: cuándo empieza la noche de ese día (24:00 = medianoche).
  // END: a qué hora termina la noche esa mañana (y NEXUS da los buenos días).
  // Índice 0 = domingo. Lunes a viernes: 07:00 a 22:00. Viernes y sábado la noche
  // empieza a las 00:00 y el fin de semana se despierta a las 08:00.
  const NIGHT_START = [22 * 60, 22 * 60, 22 * 60, 22 * 60, 22 * 60, 24 * 60, 24 * 60];
  const NIGHT_END = [8 * 60, 7 * 60, 7 * 60, 7 * 60, 7 * 60, 7 * 60, 8 * 60];
  const WAKE_MS = 30 * 60 * 1000; // tocar la pantalla de noche la enciende 30 minutos
  let wakeUntil = 0;

  function scheduledNight(n) {
    const prev = (n.dow + 6) % 7;
    return n.min >= NIGHT_START[n.dow] || (n.min + 1440 >= NIGHT_START[prev] && n.min < NIGHT_END[n.dow]);
  }

  // Frecuencia de actualización
  const WEATHER_EVERY = 15 * 60 * 1000;
  const SYNC_EVERY = 60 * 1000; // agenda y alarmas (respaldo: lo normal es el aviso al instante de Google)

  // Parámetros de prueba: ?modo=noche | ?modo=dia | ?probar=alarma
  const params = new URLSearchParams(location.search);
  const forcedMode = params.get("modo");

  // ---------- almacenamiento local ----------
  function load(key) {
    try { return JSON.parse(localStorage.getItem("nexus." + key)); } catch { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem("nexus." + key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
  }

  // ---------- vinculación de la tablet ----------
  // La clave llega una sola vez en el fragmento: https://.../#token=XXXX
  // (el fragmento nunca se envía al servidor) y se guarda en este dispositivo.
  (function pairFromHash() {
    const m = location.hash.match(/token=([a-f0-9]{32,128})/i);
    if (m) {
      save("token", m[1]);
      history.replaceState(null, "", location.pathname + location.search);
    }
  })();

  // Estado: se rellena desde el backend; arranca con la última copia guardada
  const state = {
    weather: load("weather"),
    agenda: load("agenda"),
    alarms: load("alarms") || [],
    weatherOk: false,
    authorized: true,
  };

  async function api(path, opts = {}) {
    const headers = { Authorization: "Bearer " + (load("token") || "") };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let r;
    try {
      r = await fetch(path, {
        method: opts.method || "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      const was = state.netFailAt > (state.netOkAt || 0);
      state.netFailAt = Date.now();
      if (!was) { renderStatus(); remoteLog({ type: "red", msg: path + ": " + (e.message || e) }); }
      throw e;
    }
    if (state.netFailAt > (state.netOkAt || 0)) { state.netOkAt = Date.now(); renderStatus(); }
    else state.netOkAt = Date.now();
    if (r.status === 401) { state.authorized = false; renderStatus(); throw new Error("Tablet no vinculada"); }
    state.authorized = true;
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "Error del servidor");
    return j;
  }

  // ---------- utilidades ----------
  const fTime = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
  const fDate = new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  const fDow = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ });
  const fKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const nowMin = () => toMin(fTime.format(new Date()));
  const pct = (min) => Math.max(0, Math.min(100, ((min - DAY_START) / (DAY_END - DAY_START)) * 100));
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  // Momento actual en hora de Suecia
  function now() {
    const d = new Date();
    const hhmm = fTime.format(d);
    return { hhmm, min: toMin(hhmm), dow: DOW[fDow.format(d)], dateKey: fKey.format(d) };
  }

  // Crear elementos sin innerHTML para textos (seguro con datos reales)
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k === "html") el.innerHTML = v; // solo para iconos propios
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) el.append(c);
    return el;
  }
  const people = () => (state.agenda && state.agenda.people) || {};
  const color = (who) => (people()[who] || {}).color || "var(--muted)";
  const name = (who) => (people()[who] || {}).name || "";

  // ---------- hora ----------
  function renderClock() {
    const d = new Date();
    $("clock").textContent = fTime.format(d);
    $("date").textContent = cap(fDate.format(d));
    renderNightExtra(d);
  }

  // ---------- modo noche: mañana y la luna ----------
  // Fase de la luna (0 = nueva, 0,5 = llena) a partir de una luna nueva conocida
  const SYNODIC = 29.530588853, NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);
  function moonPhase(d) { const age = (((d - NEW_MOON) / 86400000) % SYNODIC + SYNODIC) % SYNODIC; return age / SYNODIC; }
  function moonName(p) {
    const n = ["Luna nueva", "Luna creciente", "Cuarto creciente", "Luna gibosa creciente", "Luna llena", "Luna gibosa menguante", "Cuarto menguante", "Luna menguante"];
    return n[Math.floor((p * 8 + 0.5) % 8)];
  }
  // Dibujo de la luna con la parte iluminada (hemisferio norte: crece por la derecha)
  function moonSvg(p) {
    const waxing = p < 0.5, crescent = p < 0.25 || p > 0.75;
    const rx = (10 * Math.abs(Math.cos(2 * Math.PI * p))).toFixed(2);
    const outer = waxing ? 1 : 0, inner = waxing ? (crescent ? 0 : 1) : (crescent ? 1 : 0);
    return `<svg viewBox="0 0 24 24" class="moon-svg"><circle cx="12" cy="12" r="10" class="moon-dark"/><path class="moon-lit" d="M12 2 A10 10 0 0 ${outer} 12 22 A${rx} 10 0 0 ${inner} 12 2Z"/></svg>`;
  }
  function renderNightExtra(d) {
    const box = $("nightExtra");
    if (!box) return;
    const w = state.weather;
    const tomorrow = w && w.days && w.days.find((x) => x.date > new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d));
    const p = moonPhase(d.getTime());
    const key = JSON.stringify([tomorrow && [tomorrow.code, tomorrow.max, tomorrow.min], moonName(p), Math.round(p * 40)]);
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    box.replaceChildren(...[
      tomorrow && h("span", { class: "nx" }, h("span", { class: "nx-ic", html: ICON[tomorrow.code] || ICON.cloudy }), h("span", {}, "Mañana " + tomorrow.max + "° / " + tomorrow.min + "° · " + tomorrow.text.toLowerCase())),
      h("span", { class: "nx" }, h("span", { class: "nx-ic", html: moonSvg(p) }), h("span", {}, moonName(p))),
    ].filter(Boolean));
  }

  function renderAlarm() {
    const n = ALARMS.next(state.alarms, now());
    if (!n) {
      $("alarm").replaceChildren(h("span", { html: ICON.bell }), h("span", {}, "Sin alarmas"));
      return;
    }
    // Corta, para caber junto a la fecha: "Mañana 06:30"
    $("alarm").replaceChildren(
      h("span", { html: ICON.bell }),
      h("span", {}, cap(n.dayText) + " "),
      h("strong", {}, n.alarm.time)
    );
    $("alarm").title = "Próxima alarma: " + n.dayText + " a las " + n.alarm.time;
  }

  // ---------- cielo vivo ----------
  // El fondo cambia suavemente con la posición del sol (amanecer, día, atardecer, noche)
  // y se vuelve más gris con nubes o lluvia. El abajo siempre es oscuro para leer bien.
  const SKY = {
    night: { top: [10, 15, 28], bot: [6, 8, 13], glow: [70, 90, 160, 0.10] },
    dawn: { top: [43, 47, 85], bot: [70, 40, 55], glow: [255, 170, 110, 0.32] },
    day: { top: [29, 74, 116], bot: [12, 30, 48], glow: [255, 236, 190, 0.16] },
    dusk: { top: [58, 44, 90], bot: [72, 36, 46], glow: [255, 140, 90, 0.28] },
  };
  const GREY = { top: [44, 50, 58], bot: [20, 23, 28] };
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const rgb = (c) => `rgb(${c.slice(0, 3).map(Math.round).join(",")})`;

  function updateSky() {
    const w = state.weather;
    const sr = w ? toMin(w.today.sunrise) : 8 * 60, ss = w ? toMin(w.today.sunset) : 16 * 60;
    const m = params.get("cielo") ? toMin(params.get("cielo")) : nowMin(); // ?cielo=HH:MM para previsualizar
    const stops = [[0, SKY.night], [sr - 90, SKY.night], [sr - 20, SKY.dawn], [sr + 70, SKY.day], [ss - 60, SKY.day], [ss + 15, SKY.dusk], [ss + 90, SKY.night], [1440, SKY.night]];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) if (m >= stops[i][0] && m <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    const t = b[0] === a[0] ? 0 : (m - a[0]) / (b[0] - a[0]);
    let top = mix(a[1].top, b[1].top, t), bot = mix(a[1].bot, b[1].bot, t);
    const glow = mix(a[1].glow, b[1].glow, t);
    // Nubes, niebla o lluvia apagan el color del cielo
    const code = params.get("clima") || (w && w.now.code); // ?clima=sun|partly|cloudy|rain|snow para previsualizar
    const grey = { cloudy: 0.45, fog: 0.55, rain: 0.5, storm: 0.6, snow: 0.35, partly: 0.2, partlyNight: 0.2 }[code] || 0;
    if (grey) { top = mix(top, GREY.top, grey); bot = mix(bot, GREY.bot, grey * 0.6); glow[3] *= 1 - grey; }
    // Momento del cielo para el cristal y su animación (js/sky.js)
    let sky = m < sr - 30 || m > ss + 60 ? "night" : m < sr + 150 ? "morning" : m > ss - 70 ? "dusk" : "day";
    if (code === "rain" || code === "storm") sky = sky === "night" ? "night" : "rain";
    else if (code === "snow") sky = sky === "night" ? "night" : "snow";
    const fx = code === "rain" || code === "storm" ? "rain" : code === "snow" ? "snow" : sky === "night" ? "stars" : sky;
    const cloudy = { cloudy: 1, fog: 1, partly: .5, partlyNight: .5 }[code] || 0;
    if (document.body.dataset.sky !== sky) document.body.dataset.sky = sky;
    if (window.NexusSky) window.NexusSky.set(fx, { cloudy });
    else window.NEXUS_SKY = { fx, cloudy };
    const s = document.documentElement.style;
    s.setProperty("--sky-top", rgb(top));
    s.setProperty("--sky-bot", rgb(bot));
    s.setProperty("--sky-glow", `rgba(${glow.slice(0, 3).map(Math.round).join(",")},${glow[3].toFixed(3)})`);
  }

  const WX_CLASS = { sun: "tint-warm", partly: "tint-warm", cloudy: "tint-cloud", fog: "tint-cloud", rain: "tint-rain", storm: "tint-rain", snow: "tint-snow", moon: "tint-night", partlyNight: "tint-night" };

  // ---------- clima ----------
  function renderWeather() {
    const w = state.weather;
    $("weather").className = "panel weather " + ((w && WX_CLASS[w.now.code]) || "");
    if (!w) {
      $("weather").replaceChildren(h("p", { class: "empty" }, "Cargando el clima…"));
      return;
    }
    const days = w.days.map((d) =>
      h("div", { class: "wx-day", title: d.text || "" },
        h("span", { class: "d" }, d.d),
        h("span", { html: ICON[d.code] || ICON.cloudy }),
        h("span", { class: "t" }, `${d.max}°`, h("span", {}, `${d.min}°`))
      )
    );
    $("weather").replaceChildren(
      h("div", { class: "wx-now" },
        h("span", { class: "wx-icon", html: ICON[w.now.code] || ICON.cloudy }),
        h("span", { class: "wx-temp" }, `${w.now.temp}°`),
        h("div", { class: "wx-info" },
          h("span", { class: "wx-place" }, w.location),
          h("span", { class: "wx-desc" }, `${w.now.text}, sensación ${w.now.feels}°`),
          h("span", { class: "wx-range" }, `Máx ${w.today.max}°  Mín ${w.today.min}°`)
        )
      ),
      h("div", { class: "wx-days" }, ...days)
    );
  }

  let weatherRetry = null;
  async function fetchWeather() {
    try {
      const j = await api("/api/weather");
      state.weather = j;
      state.weatherOk = true;
      renderNightExtra(new Date());
      save("weather", j);
    } catch (e) {
      state.weatherOk = false; // se queda la última copia buena
      remoteLog({ type: "tiempo", msg: e.message || String(e) });
      clearTimeout(weatherRetry);
      weatherRetry = setTimeout(fetchWeather, 60 * 1000);
    }
    renderWeather();
    renderTimeline();
    renderStatus();
    updateSky();
  }

  // ---------- agenda ----------
  function remainingToday() {
    const n = nowMin();
    return ((state.agenda && state.agenda.today) || []).filter((e) => toMin(e.end) > n);
  }

  function renderAgenda() {
    const a = state.agenda;
    if (!a) {
      $("agenda").replaceChildren(h("p", { class: "empty" }, "Cargando la agenda…"));
      return;
    }
    // Solo lo que queda del día (lo pasado se ve atenuado en la línea del día)
    const todayItems = remainingToday().slice(0, 4).map((e) =>
      h("li", { class: "item", style: `--c:${color(e.who)}` },
        h("span", { class: "when" }, e.allDay ? "Hoy" : e.start),
        h("span", { class: "mark" }),
        h("span", { class: "what" }, e.title, h("span", { class: "who" }, name(e.who)))
      )
    );
    const nextItems = a.upcoming.slice(0, 3).map((e) =>
      h("li", { class: "item" + (e.type === "birthday" || e.type === "holiday" ? " birthday" : ""), style: `--c:${color(e.who)}` },
        h("span", { class: "when" }, e.when),
        h("span", { class: "mark" }),
        h("span", { class: "what" },
          e.type === "birthday" ? h("span", { html: ICON.cake }) : e.type === "holiday" ? h("span", { html: ICON.flag }) : null,
          e.title,
          e.type === "birthday" || e.type === "holiday" ? null : h("span", { class: "who" }, name(e.who))
        )
      )
    );
    $("agenda").replaceChildren(
      h("h2", {}, "Hoy"),
      todayItems.length ? h("ul", { class: "list" }, ...todayItems) : h("p", { class: "empty" }, "Nada más por hoy."),
      h("h2", {}, "Próximos días"),
      nextItems.length ? h("ul", { class: "list", id: "nextList" }, ...nextItems) : h("p", { class: "empty" }, "Sin actividades próximas.")
    );
    fitAgenda();
  }

  // Quita elementos del final hasta que todo quepa (nunca texto cortado)
  function fitAgenda() {
    const box = $("agenda"), list = $("nextList");
    box.style.removeProperty("--ag-size");
    let size = 2.05;
    while (box.scrollHeight > box.clientHeight + 1 && size > 1.6) {
      size -= 0.05;
      box.style.setProperty("--ag-size", size.toFixed(2) + "rem");
    }
    if (!list) return;
    while (list.children.length > 1 && box.scrollHeight > box.clientHeight + 1) {
      list.lastElementChild.remove();
    }
  }

  async function fetchAgenda() {
    try {
      const j = await api("/api/agenda");
      state.agenda = j;
      save("agenda", j);
    } catch { /* se queda la última copia buena */ }
    renderAgenda();
    renderTimeline();
    renderStatus();
  }

  // ---------- alarmas ----------
  function setAlarms(list) {
    state.alarms = list;
    save("alarms", list);
    renderAlarm();
  }

  async function fetchAlarms() {
    try { setAlarms((await api("/api/alarms")).alarms); } catch { /* copia local */ }
  }

  // ---------- barra del sol (en la tarjeta del clima) ----------
  // De 00 a 24: el tramo con luz, la hora actual, las actividades de hoy como puntos y la
  // temperatura prevista cada 6 horas. Tocar el tramo de luz o un punto muestra el detalle.
  const dayPct = (min) => Math.max(0, Math.min(100, (min / 1440) * 100));
  const fmtDur = (m) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  let sunTipFor = null;
  function sunTip(key, title, body) {
    const tip = $("sunTip");
    if (!tip) return;
    if (sunTipFor === key && !tip.hidden) { tip.hidden = true; sunTipFor = null; return; }
    sunTipFor = key;
    tip.replaceChildren(h("b", {}, title), h("span", {}, body));
    tip.hidden = false;
    clearTimeout(sunTip.t);
    sunTip.t = setTimeout(() => { tip.hidden = true; sunTipFor = null; }, 8000);
  }
  function lightText(w) {
    const sr = toMin(w.today.sunrise), ss = toMin(w.today.sunset), len = ss - sr;
    const noon = Math.round((sr + ss) / 2);
    const noonTxt = `${String(Math.floor(noon / 60)).padStart(2, "0")}:${String(noon % 60).padStart(2, "0")}`;
    let txt = `Amanece a las ${w.today.sunrise} y anochece a las ${w.today.sunset}: ${fmtDur(len)} min de luz. El sol está más alto a las ${noonTxt}.`;
    // Días hasta el próximo solsticio
    const n = now(), [y, mo, d] = n.dateKey.split("-").map(Number);
    const today = Date.UTC(y, mo - 1, d);
    const win = Date.UTC(y, 11, 21), sum = Date.UTC(y, 5, 21);
    let target, kind;
    if (today < sum) { target = sum; kind = "verano"; } else if (today < win) { target = win; kind = "invierno"; } else { target = Date.UTC(y + 1, 5, 21); kind = "verano"; }
    const days = Math.round((target - today) / 864e5);
    if (days === 0) txt += ` Hoy es el solsticio de ${kind}.`;
    else txt += ` Faltan ${days} días para el solsticio de ${kind}: desde entonces los días se ${kind === "invierno" ? "alargan" : "acortan"}.`;
    return txt;
  }
  function renderTimeline() {
    const n = nowMin(), w = state.weather;
    const box = $("timeline");
    const parts = [];
    let light = null;
    if (w) {
      const { sunrise, sunset } = w.today;
      const sr = toMin(sunrise), ss = toMin(sunset), len = ss - sr;
      const facts = [
        h("div", {}, h("b", {}, h("span", { html: ICON.sunrise }), sunrise), h("span", {}, "amanecer")),
        h("div", {}, h("b", {}, h("span", { html: ICON.sunset }), sunset), h("span", {}, "atardecer")),
      ];
      let sub = "de luz";
      if (w.today.nextSunrise && w.today.nextSunset) {
        const diff = toMin(w.today.nextSunset) - toMin(w.today.nextSunrise) - len;
        sub += diff === 0 ? " · igual mañana" : ` · ${diff > 0 ? "+" : "−"}${Math.abs(diff)} min mañana`;
      }
      facts.push(h("div", { style: "text-align:right" }, h("b", {}, fmtDur(len)), h("span", {}, sub)));
      parts.push(h("div", { class: "sun-facts" }, ...facts));
      light = h("span", { class: "sun-light", style: `left:${dayPct(sr)}%;width:${dayPct(ss) - dayPct(sr)}%` });
    }
    const events = ((state.agenda && state.agenda.today) || []).filter((e) => !e.allDay).map((e) =>
      h("button", {
        type: "button",
        class: "sun-ev" + (toMin(e.end) <= n ? " past" : ""),
        style: `left:${dayPct(toMin(e.start))}%;--c:${color(e.who)}`,
        "aria-label": `${e.title}, ${e.start}`,
        onclick: (ev) => { ev.stopPropagation(); sunTip("ev" + e.start + e.title, e.title, `Hoy de ${e.start} a ${e.end}${name(e.who) ? " · " + name(e.who) : ""}`); },
      })
    );
    const ticks = [], temps = [];
    for (let hh = 0; hh <= 24; hh += 6) {
      ticks.push(h("span", { style: `left:${(hh / 24) * 100}%` }, String(hh).padStart(2, "0")));
      const t = w && w.today.temps && w.today.temps[Math.min(hh, 23)];
      if (t != null) temps.push(h("span", { style: `left:${(hh / 24) * 100}%` }, String(t).replace("-", "−") + "°"));
    }
    parts.push(h("div", { class: "sun-track", onclick: () => { if (w) sunTip("light", "Luz del sol hoy", lightText(w)); } },
      h("div", { class: "sun-rail" }, h("span", { class: "sun-past", style: `width:${dayPct(n)}%` }), light),
      h("span", { class: "sun-now", style: `left:${dayPct(n)}%`, "data-t": fTime.format(new Date()) }),
      ...events,
      h("div", { class: "sun-ticks" }, ...ticks),
      temps.length ? h("div", { class: "sun-temps" }, ...temps) : null,
      h("div", { class: "sun-tip", id: "sunTip", hidden: true })
    ));
    sunTipFor = null;
    box.replaceChildren(...parts);
  }

  // ---------- estado del sistema ----------
  function renderStatus() {
    const dot = $("sys").querySelector(".dot");
    const txt = $("sys").querySelector("span");
    if (!state.authorized) {
      dot.className = "dot err";
      txt.textContent = "Tablet sin vincular";
    } else if (!navigator.onLine || state.netFailAt > (state.netOkAt || 0)) {
      dot.className = "dot err";
      txt.textContent = "Sin conexión";
    } else if (!state.weatherOk && state.weather) {
      dot.className = "dot err";
      txt.textContent = "Sin datos del tiempo";
    } else if (state.agenda && state.agenda.source === "example") {
      dot.className = "dot ok";
      txt.textContent = "Agenda de ejemplo";
    } else if (state.agenda && state.agenda.errors && state.agenda.errors.length) {
      dot.className = "dot err";
      // "Ana: Google Calendar (...): Not Found" -> "Falta el calendario de Ana"
      const who = state.agenda.errors.map((e) => e.split(":")[0]).join(" y ");
      txt.textContent = "Sin calendario de " + who;
    } else {
      dot.className = "dot ok";
      txt.textContent = "Conectado";
    }
    // Con todo bien, bastan los iconos; el texto solo aparece si hay un problema
    $("sys").hidden = dot.className === "dot ok" && txt.textContent === "Conectado";
  }

  // ---------- batería y Wi-Fi de la tablet ----------
  async function readDevice() {
    if (window.NexusAndroid && window.NexusAndroid.status) {
      try { return JSON.parse(window.NexusAndroid.status()); } catch { /* sigue con el navegador */ }
    }
    const d = { wifi: navigator.onLine, bars: navigator.onLine ? 4 : 0, battery: -1, plugged: false };
    try {
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        d.battery = Math.round(b.level * 100);
        d.plugged = d.charging = b.charging;
      }
    } catch { /* sin datos */ }
    return d;
  }

  function wifiSvg(d) {
    const on = (i) => (d.wifi && d.bars > i ? "currentColor" : "var(--line)");
    if (!d.wifi) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/><path d="M3 3l18 18"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round">'
      + `<path d="M2.5 9a14 14 0 0 1 19 0" stroke="${on(3)}"/>`
      + `<path d="M5.5 12.5a9.5 9.5 0 0 1 13 0" stroke="${on(2)}"/>`
      + `<path d="M8.5 16a5 5 0 0 1 7 0" stroke="${on(1)}"/>`
      + '<circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none"/></svg>';
  }

  function batterySvg(d) {
    const pct = Math.max(0, Math.min(100, d.battery));
    const w = Math.max(1.5, (pct / 100) * 15);
    const bolt = d.plugged ? '<path d="M12.8 7.5 10 12.3h3l-1.8 4.2" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' : "";
    return '<svg viewBox="0 0 26 24" fill="none"><rect x="1.5" y="6.5" width="19" height="11" rx="2.5" stroke="currentColor" stroke-width="1.6"/>'
      + '<rect x="21.5" y="10" width="2.5" height="4" rx="1" fill="currentColor"/>'
      + `<rect x="3.5" y="8.5" width="${w}" height="7" rx="1.2" fill="currentColor"/>${bolt}</svg>`;
  }

  async function renderDevice() {
    const d = await readDevice();
    const parts = [h("span", { class: "dev-wifi" + (d.wifi ? "" : " bad"), title: d.wifi ? "Wi-Fi conectado" : "Sin Wi-Fi", html: wifiSvg(d) })];
    if (d.battery >= 0) {
      const cls = "dev-bat" + (d.plugged ? " plugged" : "") + (d.battery <= 15 && !d.plugged ? " bad" : "");
      parts.push(h("span", { class: cls, title: d.plugged ? "Enchufada" : "Con batería" },
        h("span", { html: batterySvg(d) }), h("span", { class: "dev-pct" }, `${d.battery}%`)));
    }
    $("dev").replaceChildren(...parts);
  }

  // ---------- barra inferior ----------
  function renderActions() {
    const actions = [
      { icon: "home", label: "Casa", run: () => window.NexusHome && window.NexusHome.openHouse() },
      { icon: "alarm", label: "Alarmas", run: () => ALARMS.openSheet() },
      { icon: "check", label: "Tareas", run: () => window.NexusHome && window.NexusHome.openChores() },
      { icon: "music", label: "Música", run: () => window.NexusHome && window.NexusHome.openMusic() },
      { icon: "menu", label: "Menú", run: () => window.NexusHome && window.NexusHome.openMenu() },
    ];
    $("actions").replaceChildren(
      ...actions.map((a) => h("button", { class: "action", type: "button", onclick: a.run }, h("span", { html: ICON[a.icon] }), a.label))
    );
  }

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- pantalla siempre encendida (Wake Lock) ----------
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible" && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch { /* no disponible */ }
  }
  document.addEventListener("visibilitychange", keepAwake);

  // ---------- pantalla completa real ----------
  // Abierto como app, Android reserva 72 px para sus botones y los deja en
  // blanco. La API Fullscreen ocupa toda la pantalla; exige un toque, así
  // que se pide en cada toque mientras no esté activa.
  const isApp = matchMedia("(display-mode: fullscreen), (display-mode: standalone)").matches;
  function goFullscreen() {
    const el = document.documentElement;
    if (!isApp || document.fullscreenElement || !el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  }
  // En pantallas táctiles el navegador solo concede el permiso al levantar el dedo
  document.addEventListener("pointerup", goFullscreen, { passive: true });

  // ---------- modo nocturno ----------
  // En la app NEXUS de la tablet (window.NexusAndroid) también baja el brillo real
  const NIGHT_BRIGHTNESS = 0.03;
  let lastNight = null;
  function applyMode(force) {
    let night;
    // Ajuste por voz guardado en el servidor: { offUntil, onUntil } (ms)
    const s = (window.NexusHome && window.NexusHome.settings && window.NexusHome.settings().night) || {};
    const t = Date.now();
    if (forcedMode === "noche") night = true;
    else if (forcedMode === "dia") night = false;
    else if (s.onUntil > t) night = true;
    else if (s.offUntil > t || wakeUntil > t) night = false;
    else night = scheduledNight(now());
    // Vacaciones: panel atenuado todo el día (tocar lo despierta 30 min, como de noche)
    const vac = window.NexusHome && window.NexusHome.vacationActive && window.NexusHome.vacationActive();
    if (vac && !(wakeUntil > t) && forcedMode !== "dia") night = true;
    document.body.classList.toggle("vacation", !!vac);
    if (vac) {
      const v = window.NexusHome.settings().vacation;
      $("vac").textContent = "De vacaciones hasta el " + new Date(v.to + "T12:00:00Z").toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    }
    document.body.classList.toggle("night", night);
    document.documentElement.classList.toggle("night", night);
    if (night !== lastNight && window.NexusHome && window.NexusHome.fitLayout) requestAnimationFrame(() => window.NexusHome.fitLayout());
    if ((force || night !== lastNight) && window.NexusAndroid) {
      try { window.NexusAndroid.setBrightness(night ? NIGHT_BRIGHTNESS : -1); } catch { /* sin app */ }
    }
    lastNight = night;
  }

  // De noche, tocar la pantalla enciende el panel 30 minutos
  function wakePanel(withToast) {
    if (!document.body.classList.contains("night")) return;
    wakeUntil = Date.now() + WAKE_MS;
    applyMode(true);
    renderAgenda();
    renderTimeline();
    if (window.NexusHome) window.NexusHome.refresh();
    if (withToast) toast("Panel encendido 30 minutos. También puedes decir «Oye NEXUS, desactiva el modo noche».");
  }
  document.addEventListener("pointerup", () => {
    if (document.querySelector(".ring")) return;
    wakePanel(true);
  });

  // ---------- resumen de la mañana y de la noche ----------
  // NEXUS ya no habla solo: en esas horas aparece un botón y el resumen se lee al tocarlo.
  // Mañana: desde que termina la noche (07:00 / 08:00) hasta 3 h después.
  // Noche: las 2 h antes del modo noche (el domingo, el resumen de la semana que viene).
  // También se puede pedir en cualquier momento: «Oye NEXUS, resumen del día».
  const fDay = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
  const morningKey = () => "morning." + fDay.format(new Date());
  function markMorning() { try { localStorage.setItem("nexus.morning", morningKey()); } catch { /* sin almacenamiento */ } }
  function briefingSlot() {
    const n = now();
    const end = NIGHT_END[n.dow], start = NIGHT_START[n.dow];
    if (n.min >= end && n.min < end + 180) return { kind: "morning", label: "Resumen de la mañana", icon: "sun", url: "/api/briefing?morning=1" };
    if (n.min >= start - 120 && n.min < start) {
      return n.dow === 0
        ? { kind: "weekly", label: "Resumen de la semana", icon: "moon", url: "/api/briefing?weekly=1" }
        : { kind: "evening", label: "Resumen de la noche", icon: "moon", url: "/api/briefing?evening=1" };
    }
    return null;
  }
  function playBriefing(slot) {
    if (!window.NexusVoice) return;
    if (slot.kind === "morning") markMorning();
    api(slot.url).then((j) => window.NexusVoice.say(j.text)).catch(() => toast("No pude preparar el resumen"));
  }

  // Gesto oculto: mantener presionada la fecha 3 s abre los ajustes de Android
  (function systemGesture() {
    let t = null;
    const el = $("date");
    const cancel = () => { clearTimeout(t); t = null; };
    el.addEventListener("pointerdown", () => {
      t = setTimeout(() => {
        if (window.NexusAndroid) window.NexusAndroid.openSystemSettings();
        else toast("Ajustes del sistema: solo disponible en la app NEXUS");
      }, 3000);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => el.addEventListener(ev, cancel));
  })();

  // ---------- ciclo ----------
  function everyMinute() {
    renderClock();
    updateSky();
    applyMode();
    renderAlarm();
    renderAgenda();
    renderTimeline();
    ALARMS.check(now());
  }

  function scheduleTick() {
    const d = new Date();
    const ms = 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 30;
    setTimeout(() => { everyMinute(); scheduleTick(); }, ms);
  }

  // ---------- actualización automática ----------
  // Si se publica una versión nueva, la tablet se recarga sola
  // (nunca mientras suena una alarma o hay un panel abierto).
  let loadedVersion = null;
  // Diagnóstico: errores y eventos al servidor (como mucho 15 por carga)
  let logged = 0;
  function remoteLog(o) {
    if (logged++ > 15) return;
    try { fetch("/api/log", { method: "POST", headers: { Authorization: "Bearer " + (load("token") || ""), "Content-Type": "application/json" }, body: JSON.stringify({ v: loadedVersion || "?", ua: navigator.userAgent.slice(0, 120), w: innerWidth + "x" + innerHeight, ...o }) }).catch(() => {}); } catch { /* */ }
  }
  window.NexusLog = remoteLog;
  window.addEventListener("error", (e) => remoteLog({ type: "error", msg: e.message, src: (e.filename || "").split("/").pop() + ":" + e.lineno }));
  window.addEventListener("unhandledrejection", (e) => remoteLog({ type: "promesa", msg: String(e.reason && (e.reason.message || e.reason)) }));

  async function checkVersion() {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      const { version } = await r.json();
      if (!loadedVersion) { loadedVersion = version; remoteLog({ type: "carga" }); }
      else if (version !== loadedVersion && !document.querySelector(".ring, .sheet-wrap")) location.reload();
    } catch { /* sin red: se reintenta */ }
  }

  // Contexto compartido con el módulo de alarmas
  window.NEXUS = {
    state, api, h, toast, ICON, toMin, now, setAlarms, remainingToday, color, name,
    token: () => load("token") || "",
    applyMode,
    wakePanel: () => wakePanel(false),
    markMorning: () => markMorning(),
    briefingSlot: () => briefingSlot(),
    playBriefing: (slot) => playBriefing(slot),
    refreshAgenda: () => fetchAgenda(),
    refreshAlarms: () => fetchAlarms(),
  };
  ALARMS.init(window.NEXUS);
  if (window.NexusVoice) window.NexusVoice.init(window.NEXUS);
  if (window.NexusWake && window.NexusVoice) window.NexusWake.init(window.NEXUS, window.NexusVoice);
  if (window.NexusHome) window.NexusHome.init(window.NEXUS);
  if (window.NexusSensor) window.NexusSensor.init(window.NEXUS);
  if (window.NexusTV) window.NexusTV.init(window.NEXUS);
  if (window.NexusCook) window.NexusCook.init(window.NEXUS);
  if (window.NexusWeather) window.NexusWeather.init(window.NEXUS);
  if (window.NexusAgenda) window.NexusAgenda.init(window.NEXUS);

  // Primer dibujo con la copia guardada (arranque instantáneo, incluso sin red)
  renderWeather();
  renderActions();
  renderClock();
  applyMode();
  renderAlarm();
  renderAgenda();
  renderTimeline();
  renderStatus();
  scheduleTick();
  keepAwake();

  // Datos frescos
  fetchWeather();
  fetchAgenda();
  fetchAlarms();
  checkVersion();
  setInterval(checkVersion, 5 * 60 * 1000);
  setInterval(fetchWeather, WEATHER_EVERY);
  setInterval(() => { fetchAgenda(); fetchAlarms(); }, SYNC_EVERY);
  window.addEventListener("online", () => { fetchWeather(); fetchAgenda(); fetchAlarms(); renderDevice(); });
  window.addEventListener("offline", () => { renderDevice(); renderStatus(); });
  renderDevice();
  setInterval(renderDevice, 30 * 1000);
  window.addEventListener("resize", renderAgenda);
  if (document.fonts) document.fonts.ready.then(renderAgenda);

  if (params.get("probar") === "alarma") {
    setTimeout(() => ALARMS.test(), 1500);
  }
})();
