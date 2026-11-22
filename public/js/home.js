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
    const c = card("power" + level, "Luz ahora", N.h("span", { class: "card-b" },
      N.h("span", { class: "card-v" }, kr(p.real ? p.real.now : p.now.sek), N.h("small", {}, " kr/kWh")), bars, N.h("span", { class: "card-s" }, sub)),
    () => N.toast(p.real
      ? `Precio real con red, impuesto e IVA (spot ahora ${kr(p.now.sek)}). ` + (p.hourlyContract ? "Pagas el precio de cada momento: usa las horas baratas." : "Con tu contrato pagas la media del mes, no la de cada hora.")
      : `Precio spot ${p.zone} sin impuestos ni red. Media de hoy: ${kr(p.avg)} kr/kWh`), "bolt");
    c.style.setProperty("--tint", tint);
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
    for (const w of data.warnings || []) {
      const until = w.end ? " · hasta " + new Date(w.end).toLocaleString("es-ES", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" }) : "";
      chips.push(chip("warn " + w.level, "warn", "SMHI: " + w.event + until, () => N.toast(w.text || w.event)));
    }
    const ai = data.ai;
    if (ai && ai.used >= ai.free * 0.7) {
      const out = ai.used >= ai.free;
      const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
      const at = reset.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false });
      chips.push(chip("warn " + (out ? "orange" : "yellow"), "warn", out ? "IA agotada hasta las " + at : "Queda " + Math.max(0, Math.round(100 - ai.used / ai.free * 100)) + " % de IA",
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
    const g = (data.garbage || [])[0];
    if (g && g.inDays <= 7) {
      const day = g.inDays === 0 ? "hoy" : g.inDays === 1 ? "mañana" : "el " + new Date(g.date + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "long", timeZone: "UTC" });
      chips.push(chip("garbage" + (g.inDays <= 1 ? " soon" : ""), "recycle", `Basura ${day}: ${g.type}`, null));
    }

    // ---- tres tarjetas fijas ----
    const tiles = [notesTile(), shopTile(), data.power ? powerCard(data.power) : emptyTile("bolt", "Luz ahora", "Sin datos del precio")];

    $("pills").replaceChildren(...chips);
    box.replaceChildren(N.h("div", { class: "tiles" }, ...tiles));
    fitChips();
    startTick();
    refreshNotesSheet();
  }

  function chip(cls, icon, text, onclick) {
    return N.h("button", { class: "pill " + cls, type: "button", onclick }, N.h("span", { class: "ic", html: N.ICON[icon] }), text);
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
    const row = $("pills");
    row.querySelectorAll(".pill-more").forEach((e) => e.remove());
    const kids = [...row.children];
    for (const c of kids) c.hidden = false;
    if (!kids.length) return;
    const right = row.getBoundingClientRect().right + 1;
    const hidden = kids.filter((c) => c.getBoundingClientRect().right > right);
    if (!hidden.length) return;
    hidden.forEach((c) => { c.hidden = true; });
    const more = N.h("button", { class: "pill pill-more", type: "button", onclick: () => N.toast(hidden.map((c) => c.textContent.trim()).join(" · ")) }, "+" + hidden.length);
    row.append(more);
    while (more.getBoundingClientRect().right > right) {
      const vis = kids.filter((c) => !c.hidden);
      if (!vis.length) break;
      const last = vis[vis.length - 1];
      last.hidden = true; hidden.unshift(last);
      more.textContent = "+" + hidden.length;
    }
  }


  // ---------- temporizadores ----------
  function startTick() {
    clearInterval(tick);
    if (!data || !(data.timers || []).length) return;
    tick = setInterval(() => {
      const now = Date.now() - (data.skew || 0);
      for (const t of data.timers) {
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

  // ---------- paneles ----------
  let sheet = null;
  function openSheet(title, ...children) {
    closeSheet();
    sheet = N.h("div", { class: "sheet-wrap", onclick: (e) => { if (e.target === sheet) closeSheet(); } },
      N.h("div", { class: "sheet" },
        N.h("header", { class: "sheet-head" }, N.h("h2", {}, title), N.h("button", { class: "btn ghost", type: "button", onclick: closeSheet }, "Cerrar")),
        ...children));
    document.body.append(sheet);
  }
  function closeSheet() { if (sheet) sheet.remove(); sheet = null; }

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
      sheet.firstChild.replaceChildren(sheet.firstChild.firstChild, ...body);
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
    sheet.firstChild.replaceChildren(sheet.firstChild.firstChild, ...body);
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

  function init(ctx) {
    N = ctx;
    refresh();
    connectLive();
    setInterval(refresh, REFRESH_MS);
    if (hasMediaBridge()) setInterval(() => { if (document.visibilityState === "visible") pollMedia(); }, 2000);
    window.addEventListener("resize", fitChips);
    // La línea de la alarma cambia de ancho al cargarse: volver a medir la franja de avisos
    if (window.ResizeObserver) new ResizeObserver(() => fitChips()).observe($("pills"));
    // Al salir a Spotify/YouTube, el micrófono se suelta (y vuelve al regresar)
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  }

  window.NexusHome = { init, refresh, openList, openMusic, openHouse, openApp, settings: () => (data && data.settings) || {},
    timers: () => ((data && data.timers) || []).map((t) => ({ ...t, endsAt: t.endsAt + (data.skew || 0) })) };
})();
