// NEXUS Home - alarmas: gestión, sonido y rutina matutina.
(function () {
  "use strict";

  const LETTERS = ["D", "L", "M", "X", "J", "V", "S"]; // 0 = domingo
  const NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const WEEK = [1, 2, 3, 4, 5, 6, 0]; // orden de lunes a domingo
  const SNOOZE_MIN = 9;
  const MAX_RING_MS = 10 * 60 * 1000;

  let N = null;           // contexto compartido (window.NEXUS)
  let audio = null;       // AudioContext
  let ring = null;        // { alarm, el, timer, started }
  let snoozes = [];       // [{ alarm, at: "HH:MM" }]
  const rung = new Set(); // evita repetir en el mismo minuto

  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  function daysText(days) {
    if (!days.length) return "Una vez";
    if (days.length === 7) return "Todos los días";
    if (same(days, [1, 2, 3, 4, 5])) return "De lunes a viernes";
    if (same(days, [0, 6])) return "Fines de semana";
    return WEEK.filter((d) => days.includes(d)).map((d) => LETTERS[d]).join("  ");
  }

  // ---------- próxima alarma ----------
  function next(alarms, now) {
    let best = null;
    for (const a of alarms || []) {
      if (!a.enabled) continue;
      const m = N.toMin(a.time);
      for (let d = 0; d < 8; d++) {
        const dow = (now.dow + d) % 7;
        if (d === 0 && m <= now.min) continue;
        if (a.days.length && !a.days.includes(dow)) continue;
        const off = d * 1440 + m;
        if (!best || off < best.off) best = { alarm: a, off, d, dow };
        break;
      }
    }
    if (!best) return null;
    best.dayText = best.d === 0 ? "hoy" : best.d === 1 ? "mañana" : "el " + NAMES[best.dow];
    return best;
  }

  // ---------- sonido (sintetizado, sin archivos) ----------
  function unlockAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch { /* sin audio */ }
    if (ring) ring.el.classList.toggle("muted", !audioReady());
  }
  const audioReady = () => audio && audio.state === "running";

  // Un compresor evita que el sonido se distorsione al subir mucho el volumen
  let master = null;
  function out() {
    if (!master) {
      master = audio.createDynamicsCompressor();
      master.threshold.value = -10;
      master.ratio.value = 4;
      const boost = audio.createGain();
      boost.gain.value = 1.6;
      master.connect(boost).connect(audio.destination);
    }
    return master;
  }

  // Una nota con timbre de marimba: fundamental redonda + armónico agudo que se apaga rápido
  function mallet(freq, at, level, length = 1.2) {
    [[freq, 1, length], [freq * 3.99, 0.22, 0.18], [freq * 2, 0.12, length * 0.6]].forEach(([f, mix, dur]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, level * mix), at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(out());
      o.start(at);
      o.stop(at + dur + 0.05);
    });
  }

  // Alarma: melodía suave y luminosa (composición propia) que empieza bajito y va
  // creciendo; a los 20 s se suma una segunda voz una octava más alta.
  const N5 = { C: 523.25, D: 587.33, E: 659.25, G: 783.99, A: 880, C6: 1046.5, D6: 1174.66, E6: 1318.51 };
  const MELODY = [
    ["E", 0], ["G", 0.24], ["A", 0.48], ["C6", 0.72], ["A", 1.08], ["G", 1.32], ["E6", 1.56], ["D6", 1.92],
    ["C6", 2.4], ["A", 2.64], ["G", 2.88], ["A", 3.12], ["C6", 3.36],
  ];
  const ALARM_EVERY = 4400;
  function alarmPhrase(level, elapsed) {
    if (!audioReady()) return;
    const t = audio.currentTime + 0.02;
    for (const [n, off] of MELODY) mallet(N5[n], t + off, level, n === "C6" && off > 3 ? 2.2 : 1.1);
    if (elapsed > 20000) for (const [n, off] of MELODY) mallet(N5[n] * 2, t + off + 0.01, level * 0.35, 0.6);
  }

  // Temporizador: pitido de cocina, tres toques cortos y secos (no se confunde con la alarma)
  const TIMER_EVERY = 1500;
  function timerBeeps(level) {
    if (!audioReady()) return;
    const t = audio.currentTime + 0.02;
    [0, 0.16, 0.32].forEach((off) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "square";
      o.frequency.value = 2093;
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(level * 0.35, t + off + 0.005);
      g.gain.setValueAtTime(level * 0.35, t + off + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.11);
      o.connect(g).connect(out());
      o.start(t + off);
      o.stop(t + off + 0.13);
    });
  }

  // ---------- sonar ----------
  function check(now) {
    if (ring && ring.alarm.kind !== "timer") { const c = ring.el.querySelector(".ring-clock"); if (c) c.textContent = now.hhmm; }

    const away = window.NexusHome && window.NexusHome.vacationActive && window.NexusHome.vacationActive();
    for (const a of N.state.alarms) {
      if (!a.enabled || a.time !== now.hhmm || away) continue; // de vacaciones no suenan las alarmas
      if (a.days.length && !a.days.includes(now.dow)) continue;
      const key = a.id + now.dateKey + now.hhmm;
      if (rung.has(key)) continue;
      rung.add(key);
      start(a);
      if (!a.days.length) save({ ...a, enabled: false }); // una sola vez: se desactiva
    }
    const due = snoozes.filter((s) => s.at === now.hhmm);
    snoozes = snoozes.filter((s) => s.at !== now.hhmm);
    if (due.length) start(due[0].alarm);
  }

  function start(alarm) {
    stop(true);
    unlockAudio();
    const el = renderRing(alarm);
    document.body.append(el);
    // Al sonar, la pantalla se ilumina aunque sea de noche
    if (window.NexusAndroid) { try { window.NexusAndroid.setBrightness(0.6); } catch { /* sin app */ } }
    // Volumen de la tablet al máximo mientras suena (se devuelve al detener)
    if (window.NexusAndroid && window.NexusAndroid.alarmVolume) { try { window.NexusAndroid.alarmVolume(true); } catch { /* sin app */ } }
    const started = Date.now();
    const isTimer = alarm.kind === "timer";
    const play = () => {
      const elapsed = Date.now() - started;
      if (elapsed > (isTimer ? 3 * 60 * 1000 : MAX_RING_MS)) return stop();
      if (isTimer) timerBeeps(0.8);
      // La alarma empieza suave y llega al máximo en unos 45 s
      else alarmPhrase(Math.min(0.9, 0.18 + (elapsed / 45000) * 0.72), elapsed);
    };
    ring = { alarm, el, started, timer: setInterval(play, isTimer ? TIMER_EVERY : ALARM_EVERY) };
    el.classList.toggle("muted", !audioReady());
    play();
  }

  function stop(silent) {
    if (!ring) return;
    const finished = ring.alarm;
    clearInterval(ring.timer);
    ring.el.remove();
    ring = null;
    if (window.NexusAndroid && window.NexusAndroid.alarmVolume) { try { window.NexusAndroid.alarmVolume(false); } catch { /* sin app */ } }
    // Al detener una alarma con rutina, NEXUS lee el resumen del día
    if (!silent && finished.routine && finished.id !== "test" && window.NexusVoice) {
      if (N.markMorning) N.markMorning(); // el saludo de la mañana ya no se repite
      N.api("/api/briefing?morning=1").then((j) => window.NexusVoice.say(j.text)).catch(() => {});
    }
    if (N.applyMode) N.applyMode(true); // vuelve el brillo que toque (noche o día)
    if (!silent) N.toast(finished.kind === "timer" ? "Temporizador detenido" : "Alarma detenida");
  }

  function snooze() {
    const a = ring.alarm;
    const t = N.toMin(N.now().hhmm) + SNOOZE_MIN;
    const at = `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    snoozes.push({ alarm: a, at });
    stop(true);
    N.toast(`Pospuesta hasta las ${at}`);
  }

  function greeting(min) {
    if (min < 12 * 60) return "Buenos días";
    if (min < 20 * 60) return "Buenas tardes";
    return "Buenas noches";
  }

  // Un minuto más a un temporizador que acaba de sonar
  async function addMinute() {
    const a = ring.alarm;
    stop(true);
    try {
      await N.api("/api/timers", { method: "POST", body: { seconds: 60, label: a.timerLabel || "Temporizador" } });
      if (window.NexusHome) window.NexusHome.refresh();
      N.toast("Un minuto más");
    } catch (err) { N.toast(err.message); }
  }

  function renderRing(alarm) {
    const { h, ICON, state } = N;
    const now = N.now();
    if (alarm.kind === "timer") {
      return h("div", { class: "ring timer-ring", role: "alertdialog", "aria-label": "Temporizador" }, h("div", { class: "ring-inner" },
        h("p", { class: "ring-greet" }, alarm.reminder ? "Recordatorio" : "Temporizador terminado"),
        h("div", { class: "ring-clock" }, "00:00"),
        h("p", { class: "ring-label" }, alarm.timerLabel || "Temporizador"),
        h("p", { class: "ring-muted" }, "Toca la pantalla para activar el sonido"),
        h("div", { class: "ring-actions" },
          h("button", { class: "btn ghost", type: "button", onclick: addMinute }, "+1 min"),
          h("button", { class: "btn primary", type: "button", onclick: () => stop() }, "Detener"))));
    }
    const parts = [
      h("p", { class: "ring-greet" }, greeting(now.min)),
      h("div", { class: "ring-clock" }, now.hhmm),
      h("p", { class: "ring-label" }, alarm.label),
    ];

    if (alarm.routine) {
      const w = state.weather;
      if (w) {
        parts.push(h("div", { class: "ring-wx" },
          h("span", { html: ICON[w.now.code] || ICON.cloudy }),
          h("span", {}, `${w.now.temp}° en ${w.location}. ${w.now.text}, máxima de ${w.today.max}°.`)
        ));
      }
      const events = N.remainingToday();
      parts.push(h("p", { class: "ring-sub" },
        events.length ? (events.length === 1 ? "Hoy tienes 1 actividad" : `Hoy tienes ${events.length} actividades`) : "Hoy no tienes actividades en la agenda"));
      if (events.length) {
        parts.push(h("ul", { class: "ring-list" }, ...events.slice(0, 3).map((e) =>
          h("li", { style: `--c:${N.color(e.who)}` }, h("span", { class: "when" }, e.start), h("span", { class: "mark" }), e.title)
        )));
      }
    }

    parts.push(
      h("p", { class: "ring-muted" }, "Toca la pantalla para activar el sonido"),
      h("div", { class: "ring-actions" },
        h("button", { class: "btn ghost", type: "button", onclick: snooze }, `Posponer ${SNOOZE_MIN} min`),
        h("button", { class: "btn primary", type: "button", onclick: () => stop() }, "Detener")
      )
    );
    return h("div", { class: "ring", role: "alertdialog", "aria-label": "Alarma" }, h("div", { class: "ring-inner" }, ...parts));
  }

  // ---------- guardar en el backend ----------
  async function save(alarm) {
    const isNew = !alarm.id;
    const res = await N.api(isNew ? "/api/alarms" : "/api/alarms/" + alarm.id, {
      method: isNew ? "POST" : "PUT",
      body: alarm,
    });
    N.setAlarms(res.alarms);
    return res.alarms;
  }

  async function remove(id) {
    const res = await N.api("/api/alarms/" + id, { method: "DELETE" });
    N.setAlarms(res.alarms);
  }

  // ---------- panel de gestión ----------
  let sheet = null;

  function openSheet() {
    closeSheet();
    sheet = N.h("div", { class: "sheet-wrap", onclick: (e) => { if (e.target === sheet) closeSheet(); } },
      N.h("div", { class: "sheet", role: "dialog", "aria-label": "Alarmas" }));
    document.body.append(sheet);
    showList();
  }

  function closeSheet() {
    if (sheet) sheet.remove();
    sheet = null;
  }

  function setSheet(...children) {
    sheet.firstChild.replaceChildren(...children);
  }

  function toggle(on, onchange, label) {
    const b = N.h("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(on), "aria-label": label });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = b.getAttribute("aria-checked") !== "true";
      b.setAttribute("aria-checked", String(v));
      onchange(v);
    });
    return b;
  }

  // Pestañas Alarmas / Temporizador
  function tabs(active) {
    const { h } = N;
    const tab = (id, label, fn) => h("button", { class: "al-tab", type: "button", "aria-pressed": String(active === id), onclick: fn }, label);
    return h("div", { class: "al-tabs" }, tab("alarms", "Alarmas", showList), tab("timer", "Temporizador", showTimer));
  }

  function showList() {
    const { h } = N;
    const alarms = [...N.state.alarms].sort((a, b) => a.time.localeCompare(b.time));
    const rows = alarms.map((a) =>
      h("li", { class: "al-row" + (a.enabled ? "" : " off") },
        h("button", { class: "al-main", type: "button", onclick: () => showEditor(a) },
          h("span", { class: "al-time" }, a.time),
          h("span", { class: "al-meta" }, h("span", { class: "al-label" }, a.label), h("span", { class: "al-days" }, daysText(a.days)))
        ),
        toggle(a.enabled, async (v) => {
          try { await save({ ...a, enabled: v }); showList(); } catch (err) { N.toast(err.message); showList(); }
        }, "Activar " + a.label)
      )
    );
    const n = next(N.state.alarms, N.now());
    setSheet(
      h("header", { class: "sheet-head" },
        tabs("alarms"),
        h("button", { class: "btn ghost", type: "button", onclick: closeSheet }, "Cerrar")
      ),
      h("p", { class: "sheet-sub" }, n ? `La próxima suena ${n.dayText} a las ${n.alarm.time}.` : "No hay ninguna alarma activa."),
      rows.length ? h("ul", { class: "al-list" }, ...rows) : h("p", { class: "empty" }, "Todavía no hay alarmas. Crea la primera."),
      h("div", { class: "sheet-foot" },
        h("button", { class: "btn ghost", type: "button", onclick: () => { closeSheet(); test(); } }, "Probar sonido"),
        h("button", { class: "btn primary", type: "button", onclick: () => showEditor(null) }, "Nueva alarma")
      )
    );
  }

  function showEditor(alarm) {
    const { h } = N;
    const draft = alarm ? { ...alarm, days: [...alarm.days] } : { time: "07:00", days: [1, 2, 3, 4, 5], label: "", enabled: true, routine: true };

    // Selector propio de 24 h (el nativo de Android usa a.m./p.m.)
    let [hh, mm] = draft.time.split(":").map(Number);
    const pad = (n) => String(n).padStart(2, "0");
    const hVal = h("span", { class: "ed-val" }, pad(hh));
    const mVal = h("span", { class: "ed-val" }, pad(mm));
    const chevUp = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>';
    const chevDown = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    function step(kind, dir) {
      if (kind === "h") { hh = (hh + dir + 24) % 24; hVal.textContent = pad(hh); }
      else { mm = dir > 0 ? (Math.floor(mm / 5) * 5 + 5) % 60 : (Math.ceil(mm / 5) * 5 - 5 + 60) % 60; mVal.textContent = pad(mm); }
    }
    // Mantener pulsado repite el paso
    function stepper(kind, dir, label) {
      const b = h("button", { class: "ed-step", type: "button", "aria-label": label, html: dir > 0 ? chevUp : chevDown });
      let t1, t2;
      const end = () => { clearTimeout(t1); clearInterval(t2); };
      b.addEventListener("pointerdown", () => { step(kind, dir); t1 = setTimeout(() => { t2 = setInterval(() => step(kind, dir), 110); }, 450); });
      ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => b.addEventListener(ev, end));
      return b;
    }
    const time = h("div", { class: "ed-picker", role: "group", "aria-label": "Hora" },
      h("div", { class: "ed-col" }, stepper("h", 1, "Subir hora"), hVal, stepper("h", -1, "Bajar hora")),
      h("span", { class: "ed-colon" }, ":"),
      h("div", { class: "ed-col" }, stepper("m", 1, "Subir minutos"), mVal, stepper("m", -1, "Bajar minutos"))
    );
    const label = h("input", { class: "ed-input", type: "text", maxlength: "40", value: draft.label, placeholder: "Por ejemplo: Colegio", "aria-label": "Nombre" });
    const chips = WEEK.map((d) => {
      const b = h("button", { class: "chip", type: "button", "aria-pressed": String(draft.days.includes(d)), "aria-label": NAMES[d] }, LETTERS[d]);
      b.addEventListener("click", () => {
        const on = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", String(on));
        draft.days = on ? [...draft.days, d] : draft.days.filter((x) => x !== d);
      });
      return b;
    });

    async function onSave() {
      draft.time = `${pad(hh)}:${pad(mm)}`;
      draft.label = label.value.trim() || "Alarma";
      try {
        await save(draft);
        N.toast(alarm ? "Alarma guardada" : "Alarma creada");
        showList();
      } catch (err) { N.toast(err.message); }
    }

    async function onDelete() {
      try { await remove(alarm.id); N.toast("Alarma eliminada"); showList(); } catch (err) { N.toast(err.message); }
    }

    setSheet(
      h("header", { class: "sheet-head" },
        h("h2", {}, alarm ? "Editar alarma" : "Nueva alarma"),
        h("button", { class: "btn ghost", type: "button", onclick: showList }, "Cancelar")
      ),
      h("div", { class: "ed-grid" },
        time,
        h("div", { class: "ed-side" },
          h("div", { class: "ed-field" }, h("span", { class: "ed-cap" }, "Repetir"), h("div", { class: "chips" }, ...chips),
            h("span", { class: "ed-hint" }, "Sin días marcados, suena una sola vez.")),
          h("label", { class: "ed-field" }, h("span", { class: "ed-cap" }, "Nombre"), label),
          h("div", { class: "ed-row" },
            h("span", {}, h("span", { class: "ed-cap" }, "Rutina de mañana"), h("span", { class: "ed-hint" }, "Muestra el clima y la agenda al sonar.")),
            toggle(draft.routine, (v) => { draft.routine = v; }, "Rutina de mañana")
          )
        )
      ),
      h("div", { class: "sheet-foot" },
        alarm ? h("button", { class: "btn danger", type: "button", onclick: onDelete }, "Eliminar") : h("span"),
        h("button", { class: "btn primary", type: "button", onclick: onSave }, alarm ? "Guardar" : "Crear alarma")
      )
    );
  }

  // ---------- temporizador ----------
  let timerTick = null;
  function showTimer() {
    const { h } = N;
    clearInterval(timerTick);
    let hh = 0, mm = 10, ss = 0;
    const pad = (n) => String(n).padStart(2, "0");
    const vals = { h: h("span", { class: "ed-val" }, pad(hh)), m: h("span", { class: "ed-val" }, pad(mm)), s: h("span", { class: "ed-val" }, pad(ss)) };
    const show = () => { vals.h.textContent = pad(hh); vals.m.textContent = pad(mm); vals.s.textContent = pad(ss); };
    const chev = (up) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${up ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}"/></svg>`;
    function step(k, dir) {
      if (k === "h") hh = (hh + dir + 24) % 24;
      else if (k === "m") mm = (mm + dir + 60) % 60;
      else ss = (ss + dir * 5 + 60) % 60;
      show();
    }
    const stepper = (k, dir, label) => {
      const b = h("button", { class: "ed-step", type: "button", "aria-label": label, html: chev(dir > 0) });
      let t1, t2;
      const end = () => { clearTimeout(t1); clearInterval(t2); };
      b.addEventListener("pointerdown", () => { step(k, dir); t1 = setTimeout(() => { t2 = setInterval(() => step(k, dir), 100); }, 450); });
      ["pointerup", "pointerleave", "pointercancel"].forEach((e) => b.addEventListener(e, end));
      return b;
    };
    const col = (k, cap) => h("div", { class: "ed-col" }, stepper(k, 1, "Subir " + cap), vals[k], stepper(k, -1, "Bajar " + cap), h("span", { class: "tm-cap" }, cap));
    const picker = h("div", { class: "ed-picker tm-picker", role: "group", "aria-label": "Duración" },
      col("h", "h"), h("span", { class: "ed-colon" }, ":"), col("m", "min"), h("span", { class: "ed-colon" }, ":"), col("s", "s"));
    const presets = [1, 3, 5, 10, 15, 20, 30, 45, 60].map((m) => h("button", { class: "tm-preset", type: "button",
      onclick: () => { hh = Math.floor(m / 60); mm = m % 60; ss = 0; show(); } }, m < 60 ? `${m} min` : "1 h"));
    const label = h("input", { class: "ed-input", type: "text", maxlength: "30", placeholder: "Por ejemplo: Pasta", "aria-label": "Nombre" });
    const list = h("ul", { class: "tm-list" });

    function renderActive() {
      const timers = (window.NexusHome && window.NexusHome.timers && window.NexusHome.timers()) || [];
      const left = timers.map((t) => ({ t, s: Math.round((t.endsAt - Date.now()) / 1000) })).filter((x) => x.s > 0);
      list.replaceChildren(...left.map(({ t, s }) => h("li", { class: "tm-row" },
        h("span", { class: "tm-left" }, `${s >= 3600 ? Math.floor(s / 3600) + ":" : ""}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`),
        h("span", { class: "tm-name" }, t.label),
        h("button", { class: "btn ghost", type: "button", onclick: async () => {
          await N.api("/api/timers/" + t.id, { method: "DELETE" }).catch(() => {});
          if (window.NexusHome) await window.NexusHome.refresh();
          renderActive();
        } }, "Cancelar"))));
      list.hidden = !left.length;
    }

    async function startTimer() {
      const seconds = hh * 3600 + mm * 60 + ss;
      if (seconds < 5) return N.toast("Elige una duración");
      try {
        await N.api("/api/timers", { method: "POST", body: { seconds, label: label.value.trim() || undefined } });
        if (window.NexusHome) await window.NexusHome.refresh();
        N.toast("Temporizador en marcha");
        label.value = "";
        renderActive();
      } catch (err) { N.toast(err.message); }
    }

    setSheet(
      h("header", { class: "sheet-head" }, tabs("timer"), h("button", { class: "btn ghost", type: "button", onclick: closeSheet }, "Cerrar")),
      h("div", { class: "tm-grid" },
        picker,
        h("div", { class: "ed-side" },
          h("div", { class: "ed-field" }, h("span", { class: "ed-cap" }, "Rápidos"), h("div", { class: "tm-presets" }, ...presets)),
          h("label", { class: "ed-field" }, h("span", { class: "ed-cap" }, "Nombre (opcional)"), label))),
      list,
      h("div", { class: "sheet-foot" },
        h("button", { class: "btn ghost", type: "button", onclick: () => { closeSheet(); start({ id: "test-timer", kind: "timer", timerLabel: "Prueba", label: "Prueba", days: [], routine: false }); } }, "Probar sonido"),
        h("button", { class: "btn primary", type: "button", onclick: startTimer }, "Iniciar")));
    renderActive();
    timerTick = setInterval(() => { if (!sheet || !document.contains(list)) return clearInterval(timerTick); renderActive(); }, 1000);
  }

  // Aviso corto de "nota nueva": tres notas suaves ascendentes (no se confunde con alarma ni temporizador)
  function chime() {
    unlockAudio();
    if (!audioReady()) return false;
    const t = audio.currentTime + 0.05;
    mallet(N5.G, t, 0.35, 0.9);
    mallet(N5.C6, t + 0.16, 0.4, 1.0);
    mallet(N5.E6, t + 0.32, 0.45, 1.4);
    return true;
  }

  // Prueba manual: hace sonar una alarma de ejemplo ahora
  function test() {
    start({ id: "test", time: N.now().hhmm, days: [], label: "Prueba de alarma", routine: true, enabled: true });
  }

  function init(ctx) {
    N = ctx;
    document.addEventListener("pointerup", unlockAudio, { passive: true });
  }

  window.NexusAlarms = { init, next, check, openSheet, test, ringNow: start, chime };
})();
