// NEXUS Home - la casa: tarjetas de información (avisos SMHI, temporizadores, notas,
// precio de la luz, basura, compra) y paneles de Lista, Música y Casa (Shelly).
(function () {
  "use strict";

  const REFRESH_MS = 30 * 1000; // copia de seguridad: lo normal es que los cambios lleguen al momento por la conexión en vivo
  const LIVE_TRUST_MS = 90 * 1000; // tras un aviso en vivo, se fía de él (KV puede tardar en ponerse al día)
  const liveAt = { shopping: 0, notes: 0 };
  let knownNotes = null;      // ids de notas ya vistas (para sonar solo con las nuevas)
  const MAX_PLAYS = 2;         // una nota de voz se escucha como mucho 2 veces y luego se borra sola
  const plays = (() => { try { return JSON.parse(localStorage.getItem("nexus.plays") || "{}"); } catch { return {}; } })();
  let playing = null;         // { id, audio, url }
  let N = null;
  let data = null;            // último /api/home
  let tick = null;            // reloj de los temporizadores
  const rung = new Set();     // temporizadores que ya sonaron
  const $ = (id) => document.getElementById(id);
  const mmss = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
  const kr = (v) => v.toFixed(2).replace(".", ",");

  // ---------- datos ----------
  async function refresh() {
    try {
      const prev = data;
      data = await N.api("/api/home");
      data.skew = Date.now() - data.now;
      // Lo recibido en vivo hace poco manda sobre la lectura de KV (que puede ir algo atrasada)
      for (const k of ["shopping", "notes"]) if (prev && Date.now() - liveAt[k] < LIVE_TRUST_MS) data[k] = prev[k];
      checkNewNotes(data.notes);
    } catch { /* se queda la última copia */ }
    render();
    if (N.applyMode) N.applyMode(); // por si cambió el ajuste del modo noche
  }

  // ---------- tarjetas ----------
  function card(cls, title, body, onclick, icon) {
    const t = N.h("span", { class: "card-t" }, icon ? N.h("span", { class: "ic", html: N.ICON[icon] }) : null, title);
    return N.h("button", { class: "card " + cls, type: "button", onclick }, t, body);
  }

  function powerCard(p) {
    const max = Math.max(...p.hours.map((x) => x.sek), 0.01);
    const min = Math.min(...p.hours.map((x) => x.sek));
    const bars = N.h("span", { class: "pbars", "aria-hidden": "true" }, ...p.hours.map((x) =>
      N.h("i", { class: (x.h === p.now.h ? "now " : "") + (x.sek === min ? "low" : ""), style: `height:${Math.max(8, (x.sek / max) * 100)}%` })));
    const sub = p.cheapestRest && p.cheapestRest.h !== p.now.h ? `Más barata a las ${p.cheapestRest.h}:00` : "Ahora es lo más barato";
    // Color según el precio de ahora frente a la media del día
    const level = p.now.sek < p.avg * 0.9 ? "" : p.now.sek <= p.avg * 1.15 ? " mid" : " high";
    const tint = level === "" ? "rgba(127,191,142,.18)" : level === " mid" ? "rgba(232,184,106,.16)" : "rgba(224,122,110,.18)";
    const c = card("power" + level, "Luz", N.h("span", { class: "card-b" },
      N.h("span", { class: "card-v" }, kr(p.real ? p.real.now : p.now.sek), N.h("small", {}, " kr/kWh")), bars, N.h("span", { class: "card-s" }, sub)),
    openPower, "bolt");
    c.style.setProperty("--tint", tint);
    // Gasto estimado del mes en la esquina
    const pm = data.powerMonth && data.powerMonth.current;
    if (pm) c.firstChild.append(N.h("span", { class: "badge month", title: "Gasto estimado del mes" }, "Mes ~" + Math.round(pm.kr) + " kr"));
    return c;
  }

  // ---------- widget de música (lo que suena en Spotify/YouTube) ----------
  let media = null;          // { app, title, artist, playing, artKey, art }
  const hasMediaBridge = () => window.NexusAndroid && window.NexusAndroid.mediaInfo;

  function pollMedia() {
    if (!hasMediaBridge()) return;
    let m = null;
    try { m = JSON.parse(window.NexusAndroid.mediaInfo()); } catch { /* sin datos */ }
    if (!m || !m.available || !m.title) m = null;
    const changed = JSON.stringify(m && [m.title, m.artist, m.playing, m.artKey]) !== JSON.stringify(media && [media.title, media.artist, media.playing, media.artKey]);
    if (m && media && m.artKey === media.artKey) { m.art = media.art; m.tint = media.tint; }
    else if (m) {
      try { m.art = window.NexusAndroid.mediaArt(); } catch { m.art = ""; }
      if (m.art) artTint(m.art, (t) => { if (media === m) { m.tint = t; render(); } });
    }
    media = m;
    if (changed) render();
  }

  function mediaCard() {
    const ctl = (action, label, svg) => N.h("button", { class: "mbtn", type: "button", "aria-label": label, html: svg, onclick: (e) => {
      e.stopPropagation();
      window.NexusAndroid.mediaControl(action);
      setTimeout(pollMedia, 400);
    } });
    const P = (d) => `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${d}"/></svg>`;
    const appName = media.app.includes("spotify") ? "Spotify" : media.app.includes("youtube") ? "YouTube" : "Música";
    const el = N.h("div", { class: "pill media-pill", style: media.tint ? `--tint:${media.tint}` : null },
      media.art ? N.h("img", { class: "mart", src: media.art, alt: "" }) : N.h("span", { class: "mart blank" }),
      N.h("span", { class: "minfo", onclick: () => openApp(appName === "YouTube" ? "youtube" : "spotify") },
        N.h("span", { class: "card-t" }, N.h("span", { class: "ic", html: N.ICON.music }), appName),
        N.h("span", { class: "mtitle" }, media.title),
        N.h("span", { class: "card-s" }, media.artist || "")),
      N.h("span", { class: "mctl" },
        ctl("prev", "Anterior", P("M6 5h2v14H6zM20 5v14L9 12z")),
        media.playing ? ctl("pause", "Pausa", P("M7 5h4v14H7zM13 5h4v14h-4z")) : ctl("play", "Reproducir", P("M8 5v14l11-7z")),
        ctl("next", "Siguiente", P("M16 5h2v14h-2zM4 5v14l11-7z"))));
    return el;
  }

  // Color medio de la carátula, para teñir el widget de música
  function artTint(src, cb) {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 12;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, 12, 12);
        const d = g.getImageData(0, 0, 12, 12).data;
        let r = 0, gr = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        cb(`rgba(${Math.round(r / n)},${Math.round(gr / n)},${Math.round(b / n)},.35)`);
      } catch { cb(null); }
    };
    img.src = src;
  }

  // Orden fijo: junto a la alarma, una franja con lo que pasa ahora (música, avisos,
  // temporizadores, cumpleaños, basura); debajo siempre las mismas tres tarjetas (Notas, Compra, Luz).
  // Solo se redibuja si algo ha cambiado: en la tablet, rehacer todo cada 30 s se nota.
  let lastKey = "";
  function renderKey() {
    const ai = data.ai && data.ai.used >= data.ai.free * 0.7 ? [data.ai.used >= data.ai.free, Math.round(100 - data.ai.used / data.ai.free * 100)] : 0;
    const p = data.power;
    return JSON.stringify([
      media && [media.title, media.artist, media.playing, media.artKey, media.tint || ""],
      data.warnings, ai, (data.timers || []).map((t) => [t.id, t.label, t.endsAt]),
      data.notes, (data.notes || []).map((n) => plays[n.id] || 0), playing && playing.id,
      data.dates, p && [p.now.h, p.now.sek, p.real && p.real.now, p.cheapestRest && p.cheapestRest.h, p.avg],
      data.shopping, (data.garbage || [])[0], new Date().toDateString(),
      data.powerMonth && data.powerMonth.current && data.powerMonth.current.kr,
      data.reminders, data.chores, data.power && data.power.hourlyContract,
      data.plants, data.menu, data.school, data.aurora && [data.aurora.chance, data.aurora.when], data.air, data.season,
      data.settings && data.settings.vacation, data.abroad, hourNow(),
    ]);
  }

  function render() {
    const box = $("info");
    if (!data) { lastKey = ""; $("pills").replaceChildren(); return box.replaceChildren(); }
    const key = renderKey();
    if (key === lastKey && box.childElementCount) return;
    lastKey = key;
    const now = Date.now() - (data.skew || 0);

    // ---- franja de avisos ----
    const chips = [];
    if (media) chips.push(mediaCard());
    chips.push(...reminderPills(now));
    for (const w of data.warnings || []) {
      const until = w.end ? " · hasta " + new Date(w.end).toLocaleString("es-ES", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" }) : "";
      chips.push(chip("warn " + w.level, "warn", "SMHI: " + w.event + until, () => N.toast(w.text || w.event)));
    }
    const top = [];
    let aiPill = null;
    const ai = data.ai;
    if (ai && ai.used >= ai.free * 0.7) {
      const out = ai.used >= ai.free;
      const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
      const at = reset.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false });
      aiPill = (chip("warn " + (out ? "orange" : "yellow"), "warn", out ? "Sin IA hasta " + at : "IA " + Math.max(0, Math.round(100 - ai.used / ai.free * 100)) + " %",
        () => N.toast(out ? "NEXUS no puede responder con IA hasta las " + at + ". Las preguntas habituales y el resto del panel funcionan." : "La voz natural y «Oye NEXUS» se apagan solas antes de agotarla.")));
    }
    for (const t of data.timers || []) {
      const left = (t.endsAt - now) / 1000;
      if (left < -5) continue;
      const c = chip("timer", "timer", null, null);
      c.append(N.h("span", {}, t.label + " "), N.h("strong", { "data-timer": t.id }, mmss(left)));
      armTap(c, "Toca otra vez para cancelar el temporizador", async () => { await N.api("/api/timers/" + t.id, { method: "DELETE" }).catch(() => {}); refresh(); });
      chips.push(c);
    }
    for (const d of (data.dates || []).filter((x) => x.inDays <= 1).slice(0, 2)) {
      const kind = d.kind === "cumpleaños" ? "cumpleaños de " : d.kind === "aniversario" ? "aniversario: " : "";
      chips.push(chip("date", "cake", (d.inDays === 0 ? "Hoy: " : "Mañana: ") + kind + d.name + (d.age ? ` (${d.age})` : ""), () => N.toast(d.title)));
    }
    chips.push(...chorePills());
    const ex = extraPills();
    chips.push(...ex.action);
    top.push(...ex.info);
    const pp = powerPill();
    if (pp) chips.push(pp);
    const g = (data.garbage || [])[0];
    if (g && g.inDays <= 7) {
      const day = g.inDays === 0 ? "hoy" : g.inDays === 1 ? "mañana" : "el " + new Date(g.date + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "long", timeZone: "UTC" });
      chips.push(chip("garbage" + (g.inDays <= 1 ? " soon" : ""), "recycle", `Basura ${day}: ${g.type}`, null));
    }

    // ---- tres tarjetas fijas ----
    const tiles = [notesTile(), shopTile(), data.power ? powerCard(data.power) : emptyTile("bolt", "Luz ahora", "Sin datos del precio"), plantsTile()].filter(Boolean);

    $("pills").replaceChildren(...chips);
    $("pillsTop").replaceChildren(...top);
    $("aiState").replaceChildren(...(aiPill ? [aiPill] : []));
    box.replaceChildren(N.h("div", { class: "tiles" + (tiles.length === 4 ? " four" : "") }, ...tiles));
    renderAbroad();
    fitChips();
    fitLayout();
    startTick();
    refreshNotesSheet();
  }

  function chip(cls, icon, text, onclick) {
    if (onclick) { const f = onclick; onclick = (e) => { try { f(e); } catch (err) { if (window.NexusLog) window.NexusLog({ type: "error-toque", what: cls, msg: err.message }); } }; }
    return N.h("button", { class: "pill " + cls + (text ? " has-t" : ""), type: "button", onclick, title: text || null }, N.h("span", { class: "ic", html: N.ICON[icon] }), text ? N.h("span", { class: "pill-t" }, text) : null);
  }
  // Toque doble para acciones que borran algo
  function armTap(el, hint, run) {
    let armed = false;
    el.addEventListener("click", () => {
      if (!armed) { armed = true; el.classList.add("armed"); N.toast(hint); setTimeout(() => { armed = false; el.classList.remove("armed"); }, 3000); return; }
      run();
    });
  }
  function badge(el, n) { el.firstChild.append(N.h("span", { class: "badge" + (n ? "" : " zero") }, String(n))); return el; }
  function emptyTile(icon, title, text) {
    return card("tile-empty", title, N.h("span", { class: "card-b" }, N.h("span", { class: "card-s" }, text)), null, icon);
  }

  // Notas: las de voz primero, luego las escritas (las más nuevas arriba)
  function sortedNotes() {
    const notes = (data.notes || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    return [...notes.filter((n) => n.kind === "voice"), ...notes.filter((n) => n.kind !== "voice")];
  }
  const SHOW = 2;
  function notesTile() {
    const notes = sortedNotes();
    const unheard = notes.some((n) => n.kind === "voice" && !(plays[n.id] > 0));
    const rows = notes.slice(0, SHOW).map(noteRow);
    const more = notes.length - SHOW;
    const body = N.h("span", { class: "card-b rows" },
      ...(rows.length ? rows : [N.h("span", { class: "row empty-row" }, "Sin notas")]),
      N.h("span", { class: "card-s" }, more > 0 ? `+${more} más · toca para verlas` : notes.length ? "Toca para ver o quitar" : "Se dejan desde el móvil o por voz"));
    const c = card("notes" + (unheard ? " unheard" : ""), "Notas", body, (e) => {
      const p = e.target && e.target.closest && e.target.closest("[data-play]");
      if (p) { const n = notes.find((x) => x.id === p.dataset.play); if (n) return toggleVoice(n); }
      openNotes();
    }, "note");
    return badge(c, notes.length);
  }
  function noteRow(n) {
    if (n.kind !== "voice") return N.h("span", { class: "row" }, N.h("b", {}, n.to + ": "), n.text);
    const isPlaying = playing && playing.id === n.id;
    const count = plays[n.id] || 0;
    const label = isPlaying ? (count + 1 >= MAX_PLAYS ? "Última vez…" : "Reproduciendo…")
      : `Voz para ${n.to} · ${secs(n.seconds || 0)}` + (count ? " · 1 de 2" : "");
    return N.h("span", { class: "row voice" + (isPlaying ? " playing" : "") + (count ? "" : " new") },
      N.h("span", { class: "vplay", "data-play": n.id, role: "button", "aria-label": isPlaying ? "Parar" : "Escuchar nota de voz" }, isPlaying ? "■" : "▶"),
      N.h("span", { class: "vtxt" }, label));
  }
  function toggleVoice(n) {
    if (playing && playing.id === n.id) return stopVoice();
    playVoice(n);
  }

  function shopTile() {
    const pending = (data.shopping || []).filter((i) => !i.done);
    const rows = pending.slice(0, SHOW).map((i) => N.h("span", { class: "row" }, i.text));
    const more = pending.length - SHOW;
    const body = N.h("span", { class: "card-b rows" },
      ...(rows.length ? rows : [N.h("span", { class: "row empty-row" }, "Lista vacía")]),
      N.h("span", { class: "card-s" }, more > 0 ? `+${more} más · toca para abrir` : "Toca para abrir la lista"));
    return badge(card("shop", "Compra", body, openList, "cart"), pending.length);
  }

  // En la franja solo caben unas pocas: las primeras son las más importantes, y lo que
  // no cabe se resume en un «+N» que lo muestra al tocarlo (nada desaparece sin avisar)
  function fitChips() {
    fitRow($("pills"));
    fitRow($("pillsTop"));
  }
  function fitRow(row) {
    if (!row) return;
    row.querySelectorAll(".pill-more").forEach((e) => e.remove());
    const kids = [...row.children];
    for (const c of kids) c.hidden = false;
    if (!kids.length) return;
    const right = row.getBoundingClientRect().right + 1;
    const hidden = kids.filter((c) => c.getBoundingClientRect().right > right);
    if (!hidden.length) return;
    hidden.forEach((c) => { c.hidden = true; });
    const more = N.h("button", { class: "pill pill-more", type: "button", onclick: () => openNotices(hidden) }, "+" + hidden.length);
    row.append(more);
    while (more.getBoundingClientRect().right > right) {
      const vis = kids.filter((c) => !c.hidden);
      if (!vis.length) break;
      const last = vis[vis.length - 1];
      last.hidden = true; hidden.unshift(last);
      more.textContent = "+" + hidden.length;
    }
  }


  // Avisos que no caben en la franja: en una hoja, completos. Tocar uno hace lo mismo que en la franja.
  function openNotices(list) {
    const rows = list.map((c) => {
      const icon = c.querySelector(".ic");
      const row = N.h("li", { class: "notice-row " + c.className.replace(/\bpill\b|\bhas-t\b/g, "") },
        icon ? N.h("span", { class: "ic", html: icon.innerHTML }) : null,
        N.h("span", { class: "notice-t" }, c.title || c.textContent.trim()));
      row.addEventListener("click", () => { closeSheet(); c.hidden = false; c.click(); });
      return row;
    });
    openSheet("Avisos", N.h("ul", { class: "notice-list" }, ...rows));
  }

  // La columna de la hora debe caber entera (en la tablet real hay unos píxeles menos):
  // si no cabe, la hora se reduce poco a poco, como mucho hasta 17rem.
  function fitLayout() {
    const tb = document.querySelector(".time-block");
    if (!tb || document.body.classList.contains("night")) { if (tb) tb.style.removeProperty("--clock-size"); return; }
    tb.style.removeProperty("--clock-size");
    const info = $("info");
    // La zona de tarjetas se encoge y recorta en vez de desbordar: hay que mirar las dos cosas
    const over = () => tb.scrollHeight > tb.clientHeight + 1 || (info && info.scrollHeight > info.clientHeight + 1);
    let size = 25;
    while (over() && size > 17) {
      size -= 0.5;
      tb.style.setProperty("--clock-size", size + "rem");
    }
  }

  // ---------- temporizadores ----------
  function startTick() {
    clearInterval(tick);
    if (!data || !((data.timers || []).length || remindersToday(Date.now()))) return;
    tick = setInterval(() => {
      const now = Date.now() - (data.skew || 0);
      checkReminders(now);
      for (const t of data.timers || []) {
        const left = (t.endsAt - now) / 1000;
        const el = document.querySelector(`[data-timer="${t.id}"]`);
        if (el) el.textContent = mmss(left);
        if (left <= 0 && !rung.has(t.id)) {
          rung.add(t.id);
          window.NexusAlarms.ringNow({ id: t.id, kind: "timer", timerLabel: t.label, label: "Temporizador: " + t.label, routine: false, days: [], enabled: true });
          N.api("/api/timers/" + t.id, { method: "DELETE" }).then(refresh).catch(() => {});
        }
      }
    }, 1000);
  }

  // ---------- aviso de luz barata o cara (solo si se paga el precio de cada hora) ----------
  function powerPill() {
    const p = data.power;
    if (!p || !p.hourlyContract || !p.real || !p.hours || !p.hours.length) return null;
    const extra = p.real.now - p.now.sek * 1.25;                 // red + impuesto + compañía (por kWh)
    const real = (sek) => sek * 1.25 + extra;
    const avg = p.hours.reduce((s, x) => s + real(x.sek), 0) / p.hours.length;
    const now = real(p.now.sek);
    const hourNow = Number(p.now.h);
    if (hourNow < 7 || hourNow >= 22) return null;               // de noche no molesta
    const pct = Math.round((now / avg - 1) * 100);
    if (pct <= -25) return chip("power-cheap", "bolt", `Luz barata ahora · ${kr(now)} kr (${pct} %)`, () => N.toast("Buen momento para la lavadora, el lavavajillas o cargar cosas."));
    if (pct >= 35) {
      // ¿Hasta cuándo sigue cara?
      const rest = p.hours.filter((x) => Number(x.h) > hourNow);
      const ok = rest.find((x) => real(x.sek) < avg * 1.1);
      return chip("power-dear", "bolt", `Luz cara ahora${ok ? ` hasta las ${ok.h}:00` : ""} · ${kr(now)} kr`, () => N.toast(p.cheapestRest ? `La más barata del resto del día: a las ${p.cheapestRest.h}:00.` : "Mejor espera para lo que gaste mucho."));
    }
    // Si dentro de 1-3 horas viene una hora muy barata, avisarlo
    const soon = p.hours.filter((x) => Number(x.h) > hourNow && Number(x.h) <= hourNow + 3 && Number(x.h) < 22)
      .find((x) => real(x.sek) <= avg * 0.75);
    if (soon) return chip("power-cheap soon", "bolt", `Luz barata a las ${soon.h}:00`, () => N.toast(`A las ${soon.h}:00 costará ${kr(real(soon.sek))} kr/kWh.`));
    return null;
  }

  // ---------- recordatorios ----------
  const fRemTime = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Stockholm" });
  const dayKey = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm" }).format(new Date(ms));
  function reminderPills(now) {
    const today = dayKey(now);
    return (data.reminders || []).filter((r) => r.at > now - 60000 && dayKey(r.at) === today).slice(0, 3).map((r) => {
      const c = chip("reminder", "bell", `${fRemTime.format(new Date(r.at))} ${r.text}`, null);
      armTap(c, "Toca otra vez para borrar el recordatorio", () => removeReminder(r));
      return c;
    });
  }
  async function removeReminder(r) {
    const j = await N.api("/api/reminders/" + r.id, { method: "DELETE" }).catch(() => null);
    if (j) { data.reminders = j.reminders; render(); }
  }
  const remRung = new Set();
  function checkReminders(now) {
    for (const r of data.reminders || []) {
      const key = r.id + "@" + r.at;
      if (r.at > now || remRung.has(key) || r.at < now - 10 * 60000) continue;
      remRung.add(key);
      window.NexusAlarms.ringNow({ id: r.id, kind: "timer", reminder: true, timerLabel: r.text, label: "Recordatorio: " + r.text, routine: false, days: [], enabled: true });
      N.api("/api/reminders/" + r.id + "/fired", { method: "POST" }).then((j) => { data.reminders = j.reminders; render(); }).catch(() => {});
    }
  }
  const remindersToday = (now) => (data.reminders || []).some((r) => dayKey(r.at) === dayKey(now) && r.at > now - 10 * 60000);

  // ---------- tareas de la casa ----------
  function chorePills() {
    return (data.chores || []).filter((c) => c.dueIn <= 0).slice(0, 3).map((c) => {
      const el = chip("chore" + (c.dueIn < 0 ? " late" : ""), "check", `Toca: ${c.name}${c.who ? " · " + c.who : ""}`, null);
      armTap(el, "Toca otra vez para marcarla hecha", () => choreDone(c));
      return el;
    });
  }
  async function choreDone(c) {
    try {
      const j = await N.api("/api/chores/" + c.id + "/done", { method: "POST" });
      data.chores = j.chores; render();
      const next = j.chores.find((x) => x.id === c.id);
      N.toast(`Hecho: ${c.name}` + (next && next.who ? `. La próxima vez le toca a ${next.who}` : ""));
      if (sheet && sheet.dataset.kind === "chores") openChores();
    } catch (err) { N.toast(err.message); }
  }
  function dueText(c) {
    if (c.dueIn < 0) return `atrasada ${-c.dueIn} ${c.dueIn === -1 ? "día" : "días"}`;
    if (c.dueIn === 0) return "toca hoy";
    if (c.dueIn === 1) return "mañana";
    return `en ${c.dueIn} días`;
  }
  function openChores() {
    const list = data.chores || [];
    const rows = list.map((c) => N.h("li", { class: "note-row" + (c.dueIn <= 0 ? " due" : "") },
      N.h("span", { class: "note-main" }, N.h("span", { class: "note-text" }, c.name),
        N.h("span", { class: "note-meta" }, `Cada ${c.every === 1 ? "día" : c.every + " días"} · ${dueText(c)}` + (c.who ? ` · le toca a ${c.who}` : ""))),
      N.h("button", { class: "btn primary", type: "button", onclick: () => choreDone(c) }, "Hecho"),
      N.h("button", { class: "btn ghost note-del", type: "button", onclick: async () => {
        const j = await N.api("/api/chores/" + c.id, { method: "DELETE" }).catch(() => null);
        if (j) { data.chores = j.chores; render(); openChores(); }
      } }, "Quitar")));
    const name = N.h("input", { class: "ed-input", type: "text", maxlength: "40", placeholder: "Nueva tarea (p. ej. regar las plantas)", "aria-label": "Tarea" });
    const every = N.h("select", { class: "ed-input pw-sel", "aria-label": "Cada cuánto" },
      ...[[1, "Cada día"], [2, "Cada 2 días"], [3, "Cada 3 días"], [7, "Cada semana"], [14, "Cada 2 semanas"], [30, "Cada mes"]].map(([v, t]) => N.h("option", { value: v, selected: v === 7 ? true : null }, t)));
    const fam = family || [];
    const picks = fam.map((f) => { const cb = N.h("input", { type: "checkbox", value: f }); return { cb, el: N.h("label", { class: "who-pick" }, cb, f) }; });
    const form = N.h("form", { class: "chore-add" },
      N.h("div", { class: "list-add" }, name, every),
      picks.length ? N.h("div", { class: "who-row" }, N.h("span", { class: "note-meta" }, "Turnos:"), ...picks.map((p) => p.el)) : null,
      N.h("button", { class: "btn primary", type: "submit" }, "Añadir tarea"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      try {
        const j = await N.api("/api/chores", { method: "POST", body: { name: name.value.trim(), every: Number(every.value), people: picks.filter((p) => p.cb.checked).map((p) => p.cb.value) } });
        data.chores = j.chores; render(); openChores();
      } catch (err) { N.toast(err.message); }
    });
    openSheet("Tareas de la casa",
      N.h("p", { class: "sheet-sub" }, "Se repiten solas y van rotando el turno. También por voz: «Oye NEXUS, ya regué las plantas»."),
      rows.length ? N.h("ul", { class: "note-list short" }, ...rows) : N.h("p", { class: "empty" }, "Aún no hay tareas."),
      form);
    sheet.dataset.kind = "chores";
  }

  // ---------- invitados: enlace temporal con QR ----------
  function loadQr() {
    if (window.qrcode) return Promise.resolve();
    return new Promise((ok, fail) => { const s = document.createElement("script"); s.src = "js/qrcode.js"; s.onload = ok; s.onerror = fail; document.head.append(s); });
  }
  function guestButton() {
    return N.h("div", { class: "guest-box" },
      N.h("span", { class: "note-meta" }, "¿Visita en casa? Pueden usar la lista de la compra y dejar notas desde su móvil, sin ver nada más."),
      N.h("button", { class: "btn", type: "button", onclick: goFrom(openHouse, () => openGuest()) }, "Invitar con un QR"));
  }
  async function openGuest(hours = 24) {
    openSheet("Invitado", N.h("p", { class: "sheet-sub" }, "Creando el enlace…"));
    try {
      const [j] = await Promise.all([N.api("/api/guests", { method: "POST", body: { hours } }), loadQr()]);
      const qr = window.qrcode(0, "M"); qr.addData(j.guest.url); qr.make();
      const until = new Date(j.guest.expires).toLocaleString("es-ES", { weekday: "long", hour: "2-digit", minute: "2-digit" });
      if (!sheet) return;
      sheet.firstChild.replaceChildren(sheet.firstChild.firstChild,
        N.h("p", { class: "sheet-sub" }, `Que escaneen el código con la cámara del móvil. Sirve hasta el ${until}.`),
        N.h("div", { class: "qr", html: qr.createSvgTag({ cellSize: 7, margin: 2, scalable: true }) }),
        N.h("div", { class: "sheet-foot" },
          N.h("button", { class: "btn ghost", type: "button", onclick: async () => { await N.api("/api/guests/" + j.guest.id, { method: "DELETE" }).catch(() => {}); N.toast("Enlace de invitado anulado"); closeSheet(); } }, "Anular ya"),
          N.h("button", { class: "btn ghost", type: "button", onclick: async () => { await N.api("/api/guests/" + j.guest.id, { method: "DELETE" }).catch(() => {}); openGuest(24 * 7); } }, "Mejor 7 días")));
    } catch (err) { N.toast(err.message || "No se pudo crear el enlace"); closeSheet(); }
  }

  // ---------- plantas ----------
  const fDayShort = new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const shortDay = (key) => fDayShort.format(new Date(key + "T12:00:00Z")).replace(/\.$/, "");
  const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  function plantsTile() {
    const list = (data.plants || []).filter((x) => x.pending || x.dueIn <= 2);
    if (!list.length) return null; // recién regadas: la tarjeta vuelve 2 días antes del siguiente riego
    const p = list.find((x) => x.pending) || list[0];
    const big = p.pending ? (p.late ? `Hace ${p.late} d` : "¡Hoy!") : p.dueIn === 1 ? "Mañana" : `En ${p.dueIn} d`;
    const sub = p.pending ? "2 toques: regadas" : `Próximo: ${shortDay(p.due)}`;
    const c = card("plants" + (p.pending ? " due" : ""), list.length > 1 ? "Plantas" : p.name,
      N.h("span", { class: "card-b" }, N.h("span", { class: "card-v" }, big), N.h("span", { class: "card-s" }, sub)), null, "plant");
    if (p.pending) armTap(c, "Toca otra vez para marcarlas regadas", () => waterPlants(p));
    else c.addEventListener("click", openPlants);
    return c;
  }
  async function waterPlants(p) {
    try {
      const j = await N.api("/api/plants/" + p.id + "/water", { method: "POST" });
      data.plants = j.plants; render();
      const n = j.plants.find((x) => x.id === p.id);
      N.toast(`¡Regadas! Próximo riego: ${n ? shortDay(n.due) : ""}`);
      if (sheet && sheet.dataset.kind === "plants") openPlants();
    } catch (e) { N.toast(e.message); }
  }
  function openPlants() {
    const list = data.plants || [];
    const rows = list.map((p) => {
      const every = N.h("select", { class: "ed-input pw-sel", "aria-label": "Cada cuánto" },
        ...[[7, "Cada semana"], [14, "Cada 2 semanas"], [21, "Cada 3 semanas"], [28, "Cada 4 semanas"], [3, "Cada 3 días"]].map(([v, t]) => N.h("option", { value: v, selected: v === p.every ? true : null }, t)));
      const wd = N.h("select", { class: "ed-input pw-sel", "aria-label": "Día" },
        ...WEEKDAYS.map((d, i) => N.h("option", { value: i, selected: new Date(p.anchor + "T12:00:00Z").getUTCDay() === i ? true : null }, d)));
      const save = async () => {
        try {
          // Mantener el ciclo: si no cambia el día de la semana, se conserva la fecha de referencia
          const sameDay = new Date(p.anchor + "T12:00:00Z").getUTCDay() === Number(wd.value);
          const j = await N.api("/api/plants", { method: "PUT", body: { id: p.id, name: p.name, every: Number(every.value), ...(sameDay ? { anchor: p.anchor } : { weekday: Number(wd.value) }) } });
          data.plants = j.plants; render(); openPlants();
        } catch (e) { N.toast(e.message); }
      };
      every.addEventListener("change", save); wd.addEventListener("change", save);
      return N.h("li", { class: "note-row" + (p.pending ? " due" : "") },
        N.h("span", { class: "note-main" }, N.h("span", { class: "note-text" }, p.name),
          N.h("span", { class: "note-meta" }, p.pending ? (p.late ? `Atrasado ${p.late} días` : "Toca regar hoy") : `Próximo riego: ${shortDay(p.due)}` + (p.last ? ` · última vez ${shortDay(p.last)}` : ""))),
        every, wd,
        N.h("button", { class: "btn primary", type: "button", onclick: () => waterPlants(p) }, "Regadas"));
    });
    const name = N.h("input", { class: "ed-input", type: "text", maxlength: "30", placeholder: "Otro grupo (p. ej. plantas del balcón)", "aria-label": "Nombre" });
    const form = N.h("form", { class: "list-add" }, name, N.h("button", { class: "btn", type: "submit" }, "Añadir"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      const j = await N.api("/api/plants", { method: "PUT", body: { name: name.value.trim(), every: 14, weekday: 0 } }).catch((err) => { N.toast(err.message); return null; });
      if (j) { data.plants = j.plants; render(); openPlants(); }
    });
    openSheet("Plantas",
      N.h("p", { class: "sheet-sub" }, "Se riegan en días fijos. Al regarlas, toca «Regadas» (o di «Oye NEXUS, ya regué las plantas»)."),
      rows.length ? N.h("ul", { class: "note-list short" }, ...rows) : N.h("p", { class: "empty" }, "No hay plantas apuntadas."),
      form);
    sheet.dataset.kind = "plants";
  }

  // ---------- avisos nuevos de la franja ----------
  const hourNow = () => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Stockholm" }).format(new Date()));
  function extraPills() {
    const out = [], info = [];
    const h = hourNow();
    // Aurora boreal (por la tarde-noche)
    const a = data.aurora;
    if (a && a.chance && (h >= 16 || h < 3)) info.push(chip("aurora", "aurora", a.chance === "alta" ? `Auroras posibles esta noche (${a.when})` : `Quizá auroras hacia el norte`, () => N.toast(`Actividad Kp ${String(a.kp).replace(".", ",")}${a.clouds != null ? `, ${a.clouds} % de nubes` : ""}. Mirad al norte, lejos de las luces.`)));
    // Colegio: por la mañana lo de hoy; por la tarde lo de mañana
    const sc = data.school;
    if (sc) {
      const d = h < 10 ? sc.today : h >= 16 ? sc.tomorrow : null;
      if (d && d.bring && d.bring.length) out.push(chip("school", "school", `${h >= 16 ? "Mañana " : ""}${sc.name || "Colegio"}: ${d.bring.join(", ")}`, () => N.toast((d.start ? `Entra a las ${d.start}` : "") + (d.end ? `, sale a las ${d.end}` : ""))));
    }
    // Cena de hoy (por la tarde)
    const m = data.menu && data.menu[0];
    if (m && m.meal && h >= 14 && h < 21) out.push(chip("menu", "menu", `Cena: ${m.meal}`, () => openMenu()));
    // Polen, aire y UV (de día)
    const air = data.air;
    if (air && h >= 6 && h < 21) {
      const high = (air.pollen || []).filter((p) => p.level === "alto");
      if (high.length) info.push(chip("air", "leaf", `Polen alto: ${high.map((p) => p.name).join(", ")}`, () => N.toast((air.pollen || []).map((p) => `${p.name}: ${p.level}`).join(" · "))));
      if (air.uvMax >= 6 && h < 17) info.push(chip("air uv", "sun", `UV ${String(air.uvMax).replace(".", ",")}: protector solar`, null));
      if (air.aqi != null && air.aqi > 60) info.push(chip("air bad", "leaf", `Aire ${air.aqiText}`, null));
    }
    // Festivos (hoy y mañana) y consejos de temporada
    for (const n of data.season || []) {
      if (n.kind === "holiday" && n.inDays <= 1) info.push(chip("holiday", "flag", (n.inDays === 0 ? "Hoy: " : "Mañana: ") + n.text, null));
      if (n.kind === "tip") info.push(chip("tip", "info", n.label || n.text.split(": ")[0], () => openTip(n)));
    }
    // Vacaciones: la víspera, la lista de antes de salir
    const v = data.settings && data.settings.vacation;
    if (v && v.from === dayKey(Date.now() + 86400000)) out.push(chip("vacation", "flag", "Mañana os vais: lista de salida", () => openVacation()));
    return { action: out, info };
  }

  function openTip(n) {
    const lines = (n.info && n.info.length ? n.info : [n.text]).map((t) => N.h("li", { class: "tip-row" }, t));
    openSheet(n.label || n.text.split(": ")[0], N.h("p", { class: "sheet-sub" }, n.text + "."), N.h("ul", { class: "tip-list" }, ...lines));
  }

  // ---------- menú de la semana ----------
  function openMenu() {
    const list = (data.menuWeek || data.menu || []);
    const rows = list.map((d, i) => {
      const meal = N.h("input", { class: "ed-input", type: "text", maxlength: "80", value: d.meal || "", placeholder: "¿Qué cenamos?", "aria-label": "Cena" });
      const ing = N.h("input", { class: "ed-input ing", type: "text", maxlength: "300", value: (d.ingredients || []).join(", "), placeholder: "Ingredientes (con comas)", "aria-label": "Ingredientes" });
      const save = async () => {
        try { const j = await N.api("/api/menu/" + d.date, { method: "PUT", body: { meal: meal.value, ingredients: ing.value } }); data.menuWeek = j.menu; data.menu = j.menu.slice(0, 2); render(); }
        catch (e) { N.toast(e.message); }
      };
      meal.addEventListener("change", save); ing.addEventListener("change", save);
      const cook = N.h("button", { class: "btn ghost", type: "button", title: "Cocinar paso a paso", onclick: () => {
        if (!meal.value.trim()) return N.toast("Primero escribe qué se cena ese día");
        closeSheet();
        if (window.NexusVoice) window.NexusVoice.ask(`Vamos a cocinar ${meal.value.trim()}` + (ing.value.trim() ? ` con ${ing.value.trim()}` : ""));
      } }, "Cocinar");
      return N.h("li", { class: "menu-row" + (i === 0 ? " today" : "") },
        N.h("span", { class: "menu-day" }, i === 0 ? "Hoy" : i === 1 ? "Mañana" : shortDay(d.date)),
        N.h("span", { class: "menu-fields" }, meal, ing), cook);
    });
    openSheet("Menú de la semana",
      N.h("p", { class: "sheet-sub" }, "Se guarda al escribir. También por voz: «Oye NEXUS, planifica el menú de la semana» o «¿qué cenamos hoy?»."),
      N.h("ul", { class: "menu-list" }, ...rows),
      N.h("div", { class: "sheet-foot" },
        N.h("button", { class: "btn primary", type: "button", onclick: async () => {
          const j = await N.api("/api/menu/shop", { method: "POST", body: {} }).catch((e) => { N.toast(e.message); return null; });
          if (j) { data.shopping = j.items; render(); N.toast(j.added.length ? `Añadido a la compra: ${j.added.join(", ")}` : "Ya estaba todo en la lista"); }
        } }, "Pasar ingredientes a la compra"), N.h("span")));
    sheet.dataset.kind = "menu";
  }
  async function openMenuFresh() {
    const j = await N.api("/api/menu").catch(() => null);
    if (j) data.menuWeek = j.menu;
    openMenu();
  }

  // ---------- colegio ----------
  async function openSchool() {
    const j = await N.api("/api/school").catch(() => null);
    const s = (j && j.school) || { name: "", days: {} };
    const name = N.h("input", { class: "ed-input", type: "text", maxlength: "30", value: s.name || "", placeholder: "Nombre (p. ej. Sofía)", "aria-label": "Nombre" });
    const DAYS = [["1", "Lunes"], ["2", "Martes"], ["3", "Miércoles"], ["4", "Jueves"], ["5", "Viernes"]];
    const fields = DAYS.map(([k, label]) => {
      const d = s.days[k] || {};
      const st = N.h("input", { class: "ed-input t", type: "time", value: d.start || "", "aria-label": label + " entrada" });
      const en = N.h("input", { class: "ed-input t", type: "time", value: d.end || "", "aria-label": label + " salida" });
      const br = N.h("input", { class: "ed-input", type: "text", maxlength: "200", value: (d.bring || []).join(", "), placeholder: "Qué llevar (p. ej. ropa de deporte)", "aria-label": label + " llevar" });
      return { k, st, en, br, row: N.h("li", { class: "school-row" }, N.h("span", { class: "menu-day" }, label), st, en, br) };
    });
    const saveBtn = N.h("button", { class: "btn primary", type: "button", onclick: async () => {
      const days = {};
      for (const f of fields) days[f.k] = { start: f.st.value, end: f.en.value, bring: f.br.value };
      try { await N.api("/api/school", { method: "PUT", body: { name: name.value, days } }); N.toast("Horario guardado"); afterSave(); refresh(); }
      catch (e) { N.toast(e.message); }
    } }, "Guardar");
    openSheet("Colegio",
      N.h("p", { class: "sheet-sub" }, "Por la mañana sale lo que hay que llevar hoy y por la tarde lo de mañana. Los festivos no cuentan."),
      N.h("div", { class: "list-add" }, name),
      N.h("ul", { class: "menu-list" }, ...fields.map((f) => f.row)),
      N.h("div", { class: "sheet-foot" }, N.h("span"), saveBtn));
  }

  // ---------- familia en otro país ----------
  const ZONES = [["Chile", "America/Santiago"], ["Argentina", "America/Argentina/Buenos_Aires"], ["España", "Europe/Madrid"], ["México", "America/Mexico_City"],
    ["Colombia", "America/Bogota"], ["Perú", "America/Lima"], ["Uruguay", "America/Montevideo"], ["Venezuela", "America/Caracas"], ["Ecuador", "America/Guayaquil"],
    ["Bolivia", "America/La_Paz"], ["Paraguay", "America/Asuncion"], ["Brasil", "America/Sao_Paulo"], ["Cuba", "America/Havana"], ["Nueva York", "America/New_York"], ["Londres", "Europe/London"]];
  const timeIn = (tz) => new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date());
  const hourIn = (tz) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date()));
  function renderAbroad() {
    const box = $("abroad");
    if (!box) return;
    const list = (data && data.abroad) || [];
    box.replaceChildren(...list.map((x) => N.h("button", { class: "abroad", type: "button", onclick: () => {
      const h = hourIn(x.tz), here = hourNow();
      const good = h >= 9 && h < 22 && here >= 8 && here < 22;
      N.toast(`En ${x.name} son las ${timeIn(x.tz)}. ` + (good ? "Buen momento para llamar." : h < 9 || h >= 22 ? "Allí es tarde o muy temprano: mejor más tarde." : "Aquí ya es tarde."));
    } }, N.h("span", { class: "abroad-n" }, x.name), " ", timeIn(x.tz))));
  }
  async function openAbroad() {
    const list = [...((data && data.abroad) || [])];
    const draw = () => {
      const rows = list.map((x, i) => N.h("li", { class: "note-row" },
        N.h("span", { class: "note-main" }, N.h("span", { class: "note-text" }, x.name), N.h("span", { class: "note-meta" }, `Allí son las ${timeIn(x.tz)}`)),
        N.h("button", { class: "btn ghost note-del", type: "button", onclick: () => { list.splice(i, 1); save(); } }, "Quitar")));
      const name = N.h("input", { class: "ed-input", type: "text", maxlength: "24", placeholder: "Nombre (p. ej. Abuelos)", "aria-label": "Nombre" });
      const zone = N.h("select", { class: "ed-input pw-sel", "aria-label": "País" }, ...ZONES.map(([n, tz]) => N.h("option", { value: tz }, n)));
      const form = N.h("form", { class: "list-add" }, name, zone, N.h("button", { class: "btn", type: "submit" }, "Añadir"));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const label = name.value.trim() || ZONES.find(([, tz]) => tz === zone.value)[0];
        list.push({ name: label, tz: zone.value }); save();
      });
      openSheet("Familia lejos",
        N.h("p", { class: "sheet-sub" }, "Su hora sale arriba del panel. Tócala para saber si es buen momento para llamar."),
        rows.length ? N.h("ul", { class: "note-list short" }, ...rows) : N.h("p", { class: "empty" }, "Aún no hay ninguna."),
        list.length < 3 ? form : null);
    };
    const save = async () => {
      try { const j = await N.api("/api/abroad", { method: "PUT", body: { abroad: list } }); data.abroad = j.abroad; renderAbroad(); draw(); }
      catch (e) { N.toast(e.message); }
    };
    draw();
  }

  // ---------- vacaciones ----------
  const CHECKLIST = ["Regar las plantas (o pedir a alguien que lo haga)", "Sacar la basura y el reciclaje", "Vaciar la nevera de lo que caduca", "Cerrar ventanas y bajar la calefacción", "Desenchufar lo que no haga falta", "Avisar a un vecino de confianza", "Llevar cargadores, pasaportes y documentos"];
  const vacationActive = () => {
    const v = data && data.settings && data.settings.vacation;
    const t = dayKey(Date.now());
    return !!(v && t >= v.from && t <= v.to);
  };
  function openVacation() {
    const v = (data.settings && data.settings.vacation) || null;
    const from = N.h("input", { class: "ed-input t", type: "date", value: v ? v.from : "", "aria-label": "Ida" });
    const to = N.h("input", { class: "ed-input t", type: "date", value: v ? v.to : "", "aria-label": "Vuelta" });
    let checked = {};
    try { checked = JSON.parse(localStorage.getItem("nexus.vaclist") || "{}"); } catch { /* */ }
    const items = CHECKLIST.map((t, i) => {
      const cb = N.h("input", { type: "checkbox", checked: checked[i] ? true : null });
      cb.addEventListener("change", () => { checked[i] = cb.checked; try { localStorage.setItem("nexus.vaclist", JSON.stringify(checked)); } catch { /* */ } });
      return N.h("li", { class: "vac-item" }, N.h("label", {}, cb, " " + t));
    });
    openSheet("Vacaciones",
      N.h("p", { class: "sheet-sub" }, "Mientras estéis fuera, el panel queda atenuado, las alarmas no suenan y no hay resúmenes hablados."),
      N.h("div", { class: "list-add" }, N.h("span", { class: "note-meta" }, "Ida"), from, N.h("span", { class: "note-meta" }, "Vuelta"), to),
      N.h("h3", { class: "pw-h" }, "Antes de salir"),
      N.h("ul", { class: "vac-list" }, ...items),
      N.h("div", { class: "sheet-foot" },
        v ? N.h("button", { class: "btn ghost", type: "button", onclick: async () => { await N.api("/api/vacation", { method: "DELETE" }).catch(() => {}); try { localStorage.removeItem("nexus.vaclist"); } catch { /* */ } closeSheet(); refresh(); N.toast("Modo vacaciones quitado"); } }, "Quitar vacaciones") : N.h("span"),
        N.h("button", { class: "btn primary", type: "button", onclick: async () => {
          try { await N.api("/api/vacation", { method: "PUT", body: { from: from.value, to: to.value } }); afterSave(); refresh(); N.toast("Vacaciones guardadas. ¡Buen viaje!"); }
          catch (e) { N.toast(e.message); }
        } }, "Guardar")));
  }
  // Tras guardar: volver a la hoja anterior si la hay; si no, cerrar
  function afterSave() { const b = sheetBack; if (b) { sheetBack = null; sheetTitle = null; b(); } else closeSheet(); }
  function houseExtras() {
    return N.h("div", { class: "house-extras" },
      N.h("button", { class: "btn ghost", type: "button", onclick: goFrom(openHouse, openPlants) }, "Plantas"),
      N.h("button", { class: "btn ghost", type: "button", onclick: goFrom(openHouse, openSchool) }, "Colegio"),
      N.h("button", { class: "btn ghost", type: "button", onclick: goFrom(openHouse, openAbroad) }, "Familia lejos"),
      N.h("button", { class: "btn ghost", type: "button", onclick: goFrom(openHouse, openVacation) }, "Vacaciones"));
  }

  // ---------- paneles ----------
  let sheet = null;
  // Navegación entre hojas: si se abre una hoja desde otra (p. ej. Colegio desde Casa), lleva
  // un botón «Volver». backTo se pone justo antes de abrir; la hoja lo conserva aunque se redibuje.
  let backTo = null, sheetBack = null, sheetTitle = null;
  const goFrom = (back, open) => () => { backTo = back; open(); };
  function openSheet(title, ...children) {
    if (backTo) { sheetBack = backTo; backTo = null; sheetTitle = title; }
    else if (title !== sheetTitle) { sheetBack = null; sheetTitle = title; }
    if (sheet) sheet.remove();
    const back = sheetBack;
    sheet = N.h("div", { class: "sheet-wrap", onclick: (e) => { if (e.target === sheet) closeSheet(); } },
      N.h("div", { class: "sheet" },
        N.h("header", { class: "sheet-head" },
          back ? N.h("button", { class: "btn ghost back", type: "button", onclick: () => { sheetBack = null; sheetTitle = null; back(); } }, "‹ Volver") : null,
          N.h("h2", {}, title),
          N.h("button", { class: "btn ghost", type: "button", onclick: closeSheet }, "Cerrar")),
        ...children));
    document.body.append(sheet);
  }
  function closeSheet() { if (sheet) sheet.remove(); sheet = null; sheetBack = null; sheetTitle = null; }

  // Lista de la compra
  function openList() {
    const items = data && data.shopping ? data.shopping : [];
    const input = N.h("input", { class: "ed-input", type: "text", maxlength: "60", placeholder: "Añadir artículo…", "aria-label": "Artículo" });
    const form = N.h("form", { class: "list-add" }, input, N.h("button", { class: "btn primary", type: "submit" }, "Añadir"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      const j = await N.api("/api/shopping", { method: "POST", body: { text: input.value.trim() } }).catch(() => null);
      if (j) { data.shopping = j.items; render(); openList(); }
    });
    const rows = items.map((i) => N.h("li", { class: "shop-row" + (i.done ? " done" : "") },
      N.h("button", { class: "shop-main", type: "button", onclick: async () => {
        const j = await N.api("/api/shopping/" + i.id, { method: "PATCH", body: { done: !i.done } }).catch(() => null);
        if (j) { data.shopping = j.items; render(); openList(); }
      } }, N.h("span", { class: "check", "aria-hidden": "true" }), i.text)));
    openSheet("Lista de la compra",
      N.h("p", { class: "sheet-sub" }, "También por voz: «Oye NEXUS, añade café a la lista»."),
      rows.length ? N.h("ul", { class: "shop-list" }, ...rows) : N.h("p", { class: "empty" }, "La lista está vacía."),
      form,
      N.h("div", { class: "sheet-foot" },
        N.h("button", { class: "btn ghost", type: "button", onclick: async () => {
          const j = await N.api("/api/shopping/comprados", { method: "DELETE" }).catch(() => null);
          if (j) { data.shopping = j.items; render(); openList(); }
        } }, "Quitar comprados"), N.h("span")));
  }

  // Hoja con todas las notas: escuchar las de voz y quitar cualquiera
  function openNotes() {
    const notes = sortedNotes();
    const rows = notes.map((n) => {
      const del = N.h("button", { class: "btn ghost note-del", type: "button", onclick: () => removeNote(n) }, "Quitar");
      const who = "Para " + n.to + (n.from ? " · de " + n.from : "");
      if (n.kind === "voice") {
        const isPlaying = playing && playing.id === n.id;
        const count = plays[n.id] || 0;
        const state = isPlaying ? (count + 1 >= MAX_PLAYS ? "Última vez… luego se borra" : "Reproduciendo…") : count ? "Escuchada 1 vez: la próxima se borra" : "Sin escuchar";
        return N.h("li", { class: "note-row voice" + (isPlaying ? " playing" : "") },
          N.h("button", { class: "vplay big", type: "button", "aria-label": isPlaying ? "Parar" : "Escuchar", onclick: () => toggleVoice(n) }, isPlaying ? "■" : "▶"),
          N.h("span", { class: "note-main" }, N.h("span", { class: "note-text" }, "Nota de voz · " + secs(n.seconds || 0)), N.h("span", { class: "note-meta" }, who + " · " + state)),
          del);
      }
      return N.h("li", { class: "note-row" },
        N.h("span", { class: "note-main" }, N.h("span", { class: "note-text" }, n.text), N.h("span", { class: "note-meta" }, who)),
        del);
    });
    openSheet("Notas",
      N.h("p", { class: "sheet-sub" }, "Una nota de voz se puede escuchar 2 veces y luego se borra sola."),
      rows.length ? N.h("ul", { class: "note-list" }, ...rows) : N.h("p", { class: "empty" }, "No hay notas. Se dejan desde el móvil o por voz: «Oye NEXUS, deja una nota para Ana: …»."));
    sheet.dataset.kind = "notes";
  }
  function refreshNotesSheet() {
    if (sheet && sheet.dataset.kind === "notes") openNotes();
  }

  // Luz: precio de ahora, gasto del mes (estimado) y meses apuntados con la factura
  const kr0 = (v) => Math.round(v).toLocaleString("es-ES");
  function openPower() {
    const p = data && data.power;
    const pm = data && data.powerMonth;
    const body = [];
    if (p) {
      body.push(N.h("p", { class: "sheet-sub" }, p.real
        ? `Ahora ${kr(p.real.now)} kr/kWh con todo incluido (spot ${kr(p.now.sek)}). ` + (p.hourlyContract ? "Pagas el precio de cada momento: usa las horas baratas." : "Con tu contrato pagas la media del mes, no la de cada hora.")
        : `Precio spot ${p.zone} sin impuestos ni red. Media de hoy: ${kr(p.avg)} kr/kWh`));
    }
    if (pm && pm.current) {
      const c = pm.current;
      body.push(N.h("div", { class: "pw-month" },
        N.h("div", { class: "pw-big" }, N.h("span", { class: "pw-v" }, "~" + kr0(c.kr) + " kr"), N.h("span", { class: "pw-l" }, `${c.label.split(" ")[0]} hasta hoy · ~${c.kwh} kWh`)),
        N.h("div", { class: "pw-big" }, N.h("span", { class: "pw-v" }, "~" + kr0(c.forecastKr) + " kr"), N.h("span", { class: "pw-l" }, `previsión del mes · ~${c.forecastKwh} kWh`))),
        N.h("p", { class: "pw-note" }, `Estimado con ${c.basis} y el precio real de cada hora. Incluye red, impuesto e IVA` + (c.hasGridFee ? ", y la cuota fija de la red." : " (falta la cuota fija de la red).")));
      if (c.compare) body.push(N.h("p", { class: "pw-cmp " + (c.compare.savedForecastKr >= 0 ? "good" : "bad") },
        `Con ${c.compare.name} este mes saldría por ~${kr0(c.compare.forecastKr)} kr: ` + (c.compare.savedForecastKr >= 0 ? `con ${c.compare.current} ahorráis ~${kr0(c.compare.savedForecastKr)} kr.` : `con ${c.compare.current} pagáis ~${kr0(-c.compare.savedForecastKr)} kr más.`)));
    }
    const rows = ((pm && pm.past) || []).map((r) => N.h("li", { class: "note-row" },
      N.h("span", { class: "note-main" }, N.h("span", { class: "note-text" }, r.label.charAt(0).toUpperCase() + r.label.slice(1)),
        N.h("span", { class: "note-meta" }, `${r.kwh} kWh de la factura · ${kr(r.perKwh)} kr/kWh de media` + (r.compare ? ` · con ${r.compare.name}: ~${kr0(r.compare.kr)} kr` : ""))),
      N.h("span", { class: "pw-kr" }, "~" + kr0(r.kr) + " kr"),
      N.h("button", { class: "btn ghost note-del", type: "button", onclick: async () => {
        const j = await N.api("/api/power/readings/" + r.month, { method: "DELETE" }).catch(() => null);
        if (j) { data.powerMonth = j; lastKey = ""; render(); openPower(); }
      } }, "Quitar")));
    body.push(N.h("h3", { class: "pw-h" }, "Meses con factura"));
    body.push(rows.length ? N.h("ul", { class: "note-list short" }, ...rows) : N.h("p", { class: "pw-note" }, "Aún no hay ninguno. Cuando llegue la factura, apunta los kWh del mes: el cálculo queda exacto y la estimación de los meses siguientes mejora."));

    // Apuntar los kWh de un mes ya terminado (los últimos 3)
    const months = [];
    const d = new Date(); d.setDate(1);
    for (let i = 0; i < 3; i++) { d.setMonth(d.getMonth() - 1); months.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")); }
    const MES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    const sel = N.h("select", { class: "ed-input pw-sel", "aria-label": "Mes" }, ...months.map((m) => N.h("option", { value: m }, MES[Number(m.slice(5)) - 1] + " " + m.slice(0, 4))));
    const input = N.h("input", { class: "ed-input", type: "number", inputmode: "decimal", min: "1", max: "20000", step: "0.1", placeholder: "kWh del mes", "aria-label": "kWh del mes" });
    const form = N.h("form", { class: "list-add" }, sel, input, N.h("button", { class: "btn primary", type: "submit" }, "Guardar"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input.value) return;
      try {
        const j = await N.api("/api/power/readings", { method: "POST", body: { month: sel.value, kwh: input.value } });
        data.powerMonth = j; lastKey = ""; render(); openPower();
        N.toast("Consumo guardado");
      } catch (err) { N.toast(err.message); }
    });
    body.push(form);
    openSheet("Luz", ...body);
    sheet.dataset.kind = "power";
  }

  // Música y vídeo
  const APPS = {
    spotify: { pkg: "com.spotify.music", url: (q) => (q ? "spotify:search:" + encodeURIComponent(q) : "spotify:"), web: "https://open.spotify.com" },
    youtube: { pkg: "com.google.android.youtube", url: (q) => (q ? "https://www.youtube.com/results?search_query=" + encodeURIComponent(q) : "https://www.youtube.com"), web: "https://www.youtube.com" },
  };
  function openApp(app, query) {
    const a = APPS[app];
    if (!a) return;
    closeSheet();
    if (window.NexusAndroid && window.NexusAndroid.openApp) {
      const ok = window.NexusAndroid.openApp(a.pkg, a.url(query || ""));
      if (ok) { N.toast("Pulsa el botón de inicio para volver a NEXUS"); return; }
    }
    N.toast(app === "spotify" ? "Spotify no está disponible en este dispositivo" : "YouTube no está disponible en este dispositivo");
  }
  function openMusic() {
    openSheet("Música y vídeo",
      N.h("p", { class: "sheet-sub" }, "Se abre la app; el botón de inicio de la tablet vuelve a NEXUS. También por voz: «Oye NEXUS, pon música relajante en Spotify»."),
      N.h("div", { class: "media-grid" },
        N.h("button", { class: "media spotify", type: "button", onclick: () => openApp("spotify") }, N.h("span", { class: "media-n" }, "Spotify"), N.h("span", { class: "media-s" }, "Música y podcasts")),
        N.h("button", { class: "media youtube", type: "button", onclick: () => openApp("youtube") }, N.h("span", { class: "media-n" }, "YouTube"), N.h("span", { class: "media-s" }, "Vídeos"))));
  }

  // Casa (Shelly): plano con las luces encima, o lista si no hay plano
  const SVGNS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs, text) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };

  async function toggleDevice(d, on) {
    try { await N.api("/api/devices/" + d.key, { method: "POST", body: { on } }); return true; }
    catch (err) { N.toast(err.message); return false; }
  }

  function floorPlan(plan, devices) {
    const W = plan.width || 100, H = plan.height || 60;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "plan", role: "img", "aria-label": "Plano de la casa" });
    for (const r of plan.rooms) {
      svg.append(svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 0.8, class: "room" }));
      svg.append(svgEl("text", { x: r.x + 1.6, y: r.y + 3.4, class: "room-name" }, r.name));
    }
    const byKey = new Map(devices.map((d) => [d.key, d]));
    for (const [key, pos] of Object.entries(plan.marks || {})) {
      const d = byKey.get(key);
      if (!d) continue;
      const g = svgEl("g", { class: "lamp" + (d.on ? " on" : "") + (d.online === false ? " off" : ""), transform: `translate(${pos.x} ${pos.y})`, role: "button", tabindex: "0", "aria-label": d.name });
      g.append(svgEl("circle", { r: 4.2, class: "halo" }), svgEl("circle", { r: 2.2, class: "dot" }), svgEl("text", { y: 6.6, class: "lamp-name" }, d.name));
      g.addEventListener("click", async () => {
        if (d.online === false) return N.toast(d.name + " está desconectado");
        const on = !d.on;
        g.classList.toggle("on", on);
        if (await toggleDevice(d, on)) d.on = on; else g.classList.toggle("on", !on);
      });
      svg.append(g);
    }
    return svg;
  }

  async function openHouse() {
    openSheet("Casa", N.h("p", { class: "sheet-sub" }, "Cargando…"));
    let j = null, plan = null;
    try { [j, plan] = await Promise.all([N.api("/api/devices"), N.api("/api/floorplan").then((r) => r.plan).catch(() => null)]); } catch { /* sin conexión */ }
    if (!sheet) return;
    const body = [];
    if (plan && plan.rooms && plan.rooms.length) {
      sheet.firstChild.classList.add("wide");
      body.push(N.h("p", { class: "sheet-sub" }, j && j.devices.length ? "Toca una luz para encenderla o apagarla." : "Plano listo. Las luces aparecerán aquí cuando conectes dispositivos Shelly."));
      body.push(floorPlan(plan, (j && j.devices) || []));
      sheet.firstChild.replaceChildren(sheet.firstChild.firstChild, ...body, houseExtras(), guestButton());
      return;
    }
    if (!j) body.push(N.h("p", { class: "empty" }, "No he podido consultar los dispositivos."));
    else if (!j.configured || !j.devices.length) {
      body.push(N.h("p", { class: "sheet-sub" }, "Aún no hay dispositivos conectados."),
        N.h("p", { class: "empty" }, "Cuando tengas enchufes o luces Shelly en la app Shelly, NEXUS podrá encenderlos y apagarlos desde aquí y por voz («Oye NEXUS, apaga la lámpara del salón»)."));
    } else {
      body.push(N.h("ul", { class: "al-list" }, ...j.devices.map((d) => {
        const sw = N.h("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(!!d.on), disabled: d.online ? null : true, "aria-label": d.name });
        sw.addEventListener("click", async () => {
          const on = sw.getAttribute("aria-checked") !== "true";
          sw.setAttribute("aria-checked", String(on));
          try { await N.api("/api/devices/" + d.key, { method: "POST", body: { on } }); }
          catch (err) { sw.setAttribute("aria-checked", String(!on)); N.toast(err.message); }
        });
        return N.h("li", { class: "al-row" + (d.online ? "" : " off") },
          N.h("span", { class: "al-main" }, N.h("span", { class: "al-meta" }, N.h("span", { class: "al-label" }, d.name), N.h("span", { class: "al-days" }, (d.room ? d.room + " · " : "") + (d.online ? (d.on ? "Encendido" : "Apagado") : "Desconectado")))),
          sw);
      })));
    }
    sheet.firstChild.replaceChildren(sheet.firstChild.firstChild, ...body, houseExtras(), guestButton());
  }

  // ---------- notas nuevas: sonido de aviso ----------
  function checkNewNotes(notes) {
    const ids = (notes || []).map((n) => n.id);
    if (knownNotes) {
      const fresh = (notes || []).filter((n) => !knownNotes.has(n.id));
      if (fresh.length) announce(fresh[fresh.length - 1]);
    }
    knownNotes = new Set(ids);
  }
  function announce(n) {
    if (document.body.classList.contains("night")) return; // de noche, sin sonido (se ve por la mañana)
    if (document.querySelector(".ring")) return;            // no tapar una alarma que suena
    if (window.NexusAlarms && window.NexusAlarms.chime) window.NexusAlarms.chime();
    if (N.wakePanel) N.wakePanel();
    const de = n.from ? " de " + n.from : "";
    N.toast(n.kind === "voice" ? `Nota de voz${de} para ${n.to}` : `Nota nueva${de} para ${n.to}`);
  }

  // ---------- notas de voz ----------
  const secs = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  function savePlays() {
    const live = new Set(((data && data.notes) || []).map((n) => n.id));
    for (const id of Object.keys(plays)) if (!live.has(id)) delete plays[id]; // olvidar las notas que ya no están
    try { localStorage.setItem("nexus.plays", JSON.stringify(plays)); } catch { /* sin almacenamiento */ }
  }

  async function playVoice(n) {
    stopVoice();
    if (window.NexusWake) window.NexusWake.pause(); // que "Oye NEXUS" no se escuche a sí mismo
    playing = { id: n.id, audio: null, url: null };
    render();
    try {
      const r = await fetch("/api/notes/" + n.id + "/audio", { headers: { Authorization: "Bearer " + N.token() } });
      if (!r.ok) throw new Error(r.status === 404 ? "El audio de esta nota ya no está disponible" : "No se pudo cargar la nota de voz");
      if (!playing || playing.id !== n.id) return; // la pararon mientras cargaba
      playing.url = URL.createObjectURL(await r.blob());
      playing.audio = new Audio(playing.url);
      playing.audio.onended = () => {
        plays[n.id] = (plays[n.id] || 0) + 1;
        savePlays();
        stopVoice();
        if (plays[n.id] >= MAX_PLAYS) {
          removeNote(n);
          N.toast("Nota de voz escuchada 2 veces: eliminada");
        }
      };
      playing.audio.onerror = () => { N.toast("No se pudo reproducir la nota de voz"); stopVoice(); };
      await playing.audio.play();
    } catch (e) {
      N.toast(e.message || "No se pudo reproducir la nota de voz");
      stopVoice();
    }
  }

  function stopVoice() {
    if (!playing) return;
    try { if (playing.audio) playing.audio.pause(); } catch { /* ya parado */ }
    if (playing.url) URL.revokeObjectURL(playing.url);
    playing = null;
    if (window.NexusWake) window.NexusWake.resume();
    render();
  }

  async function removeNote(n) {
    if (playing && playing.id === n.id) stopVoice();
    const j = await N.api("/api/notes/" + n.id, { method: "DELETE" }).catch(() => null);
    if (j) { data.notes = j.notes; liveAt.notes = Date.now(); knownNotes = new Set(j.notes.map((x) => x.id)); render(); }
    else refresh();
  }

  // ---------- conexión en vivo (WebSocket) ----------
  // El servidor avisa al momento cuando cambian la lista o las notas. Si se corta, se
  // reconecta solo; mientras tanto sigue la actualización cada 30 s.
  let live = null, liveRetry = 2000, livePing = null;
  function connectLive() {
    if (!window.WebSocket || !N.token()) return;
    try {
      live = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live", ["nexus", N.token()]);
    } catch { return scheduleLive(); }
    live.onopen = () => {
      liveRetry = 2000;
      clearInterval(livePing);
      livePing = setInterval(() => { try { live.send("ping"); } catch { /* se reconecta al cerrarse */ } }, 25000);
      refresh(); // por si cambió algo mientras estaba desconectada
    };
    live.onmessage = (ev) => {
      if (ev.data === "pong") return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (!data) return;
      if (m.type === "shopping" && Array.isArray(m.items)) {
        data.shopping = m.items; liveAt.shopping = Date.now();
        render(); refreshListSheet();
      } else if (m.type === "reminders" && Array.isArray(m.reminders)) {
        data.reminders = m.reminders; render();
      } else if (m.type === "chores" && Array.isArray(m.chores)) {
        data.chores = m.chores; render();
        if (sheet && sheet.dataset.kind === "chores") openChores();
      } else if (m.type === "plants" && Array.isArray(m.plants)) {
        data.plants = m.plants; render();
        if (sheet && sheet.dataset.kind === "plants") openPlants();
      } else if (m.type === "menu" && Array.isArray(m.menu)) {
        data.menuWeek = m.menu; data.menu = m.menu.slice(0, 2); render();
      } else if (m.type === "refresh") {
        refresh();
      } else if (m.type === "powerMonth" && m.powerMonth) {
        data.powerMonth = m.powerMonth;
        render();
        if (sheet && sheet.dataset.kind === "power") openPower();
      } else if (m.type === "notes" && Array.isArray(m.notes)) {
        data.notes = m.notes; liveAt.notes = Date.now();
        checkNewNotes(m.notes);
        render();
      }
    };
    live.onclose = () => { clearInterval(livePing); live = null; scheduleLive(); };
    live.onerror = () => { try { live.close(); } catch { /* */ } };
  }
  function scheduleLive() {
    setTimeout(connectLive, liveRetry);
    liveRetry = Math.min(liveRetry * 2, 60000);
  }
  // Si la lista está abierta, se redibuja (salvo que estén escribiendo en ella)
  function refreshListSheet() {
    const input = document.querySelector(".list-add .ed-input");
    if (!input) return;
    if (document.activeElement === input && input.value) return;
    openList();
  }

  let family = null;
  function init(ctx) {
    N = ctx;
    N.api("/api/config").then((c) => { family = c.family || []; }).catch(() => {});
    setInterval(renderAbroad, 30 * 1000);
    refresh();
    connectLive();
    setInterval(refresh, REFRESH_MS);
    if (hasMediaBridge()) setInterval(() => { if (document.visibilityState === "visible") pollMedia(); }, 2000);
    window.addEventListener("resize", fitChips);
    // La línea de la alarma cambia de ancho al cargarse: volver a medir la franja de avisos
    if (window.ResizeObserver) { const ro = new ResizeObserver(() => fitChips()); ro.observe($("pills")); ro.observe($("pillsTop")); }
    window.addEventListener("resize", fitLayout);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { fitLayout(); fitChips(); });
    // Al salir a Spotify/YouTube, el micrófono se suelta (y vuelve al regresar)
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  }

  window.NexusHome = { init, refresh, openList, openMusic, openHouse, openApp, openChores, openMenu: openMenuFresh, vacationActive, fitLayout, settings: () => (data && data.settings) || {},
    timers: () => ((data && data.timers) || []).map((t) => ({ ...t, endsAt: t.endsAt + (data.skew || 0) })) };
})();
