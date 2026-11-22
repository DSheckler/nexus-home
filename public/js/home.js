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
    const el = N.h("div", { class: "card media-card", style: media.tint ? `--tint:${media.tint}` : null },
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

  function render() {
    const box = $("info");
    if (!data) return box.replaceChildren();
    const cards = [];
    const now = Date.now() - (data.skew || 0);
    if (media) cards.push(mediaCard());

    for (const w of data.warnings || []) {
      cards.push(card("warn " + w.level, "Aviso SMHI", N.h("span", { class: "card-b" },
        N.h("span", { class: "card-v sm" }, w.event), N.h("span", { class: "card-s" }, w.end ? "Hasta " + new Date(w.end).toLocaleString("es-ES", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" }) : "")),
      () => N.toast(w.text || w.event), "warn"));
    }
    // Cuota gratuita diaria de la IA (voz y asistente): aviso desde el 70 %
    const ai = data.ai;
    if (ai && ai.used >= ai.free * 0.7) {
      const out = ai.used >= ai.free;
      const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
      const at = reset.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false });
      cards.push(card("warn " + (out ? "orange" : "yellow"), "Cuota de IA", N.h("span", { class: "card-b" },
        N.h("span", { class: "card-v sm" }, out ? "Agotada por hoy" : "Queda " + Math.max(0, Math.round(100 - ai.used / ai.free * 100)) + " %"),
        N.h("span", { class: "card-s" }, out ? "Vuelve a las " + at : "Se renueva a las " + at)),
      () => N.toast(out ? "NEXUS no puede responder hasta las " + at + ". El resto del panel funciona." : "La voz natural y «Oye NEXUS» se apagan solas antes de agotarla."), "warn"));
    }
    for (const t of data.timers || []) {
      const left = (t.endsAt - now) / 1000;
      if (left < -5) continue;
      cards.push(card("timer", t.label, N.h("span", { class: "card-b" }, N.h("span", { class: "card-v", "data-timer": t.id }, mmss(left)), N.h("span", { class: "card-s" }, "Toca para cancelar")),
        async () => { await N.api("/api/timers/" + t.id, { method: "DELETE" }).catch(() => {}); refresh(); }, "timer"));
    }
    for (const n of data.notes || []) {
      if (n.kind === "voice") { cards.push(voiceCard(n)); continue; }
      cards.push(card("note", "Para " + n.to, N.h("span", { class: "card-b" }, N.h("span", { class: "card-v sm" }, n.text), N.h("span", { class: "card-s" }, "Toca dos veces para quitar")), null, "note"));
      const el = cards[cards.length - 1];
      let armed = false;
      el.addEventListener("click", async () => {
        if (!armed) { armed = true; el.classList.add("armed"); setTimeout(() => { armed = false; el.classList.remove("armed"); }, 3000); return; }
        await N.api("/api/notes/" + n.id, { method: "DELETE" }).catch(() => {});
        refresh();
      });
    }
    // Cumpleaños y fechas de la próxima semana
    for (const d of (data.dates || []).slice(0, 2)) {
      const when = d.inDays === 0 ? "¡Hoy!" : d.inDays === 1 ? "Mañana" : `En ${d.inDays} días`;
      cards.push(card("date" + (d.inDays <= 1 ? " soon" : ""), d.kind === "cumpleaños" ? "Cumpleaños" : d.kind === "aniversario" ? "Aniversario" : "Fecha",
        N.h("span", { class: "card-b" }, N.h("span", { class: "card-v sm" }, d.name + (d.age ? ` · ${d.age}` : "")), N.h("span", { class: "card-s" }, when)),
        () => N.toast(d.title + " · " + new Date(d.date + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })), "cake"));
    }
    if (data.power) cards.push(powerCard(data.power));
    const pending = (data.shopping || []).filter((i) => !i.done);
    cards.push(card("shop", "Compra", N.h("span", { class: "card-b" },
      N.h("span", { class: "card-v" }, String(pending.length)), N.h("span", { class: "card-s" }, pending.length ? pending.slice(0, 2).map((i) => i.text).join(", ") : "Lista vacía")), openList, "cart"));
    const g = (data.garbage || [])[0];
    if (g && g.inDays <= 7) {
      const when = g.inDays === 0 ? "Hoy" : g.inDays === 1 ? "Mañana" : new Date(g.date + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "long", timeZone: "UTC" });
      cards.push(card("garbage" + (g.inDays <= 1 ? " soon" : ""), "Basura", N.h("span", { class: "card-b" }, N.h("span", { class: "card-v sm" }, g.type), N.h("span", { class: "card-s" }, when.charAt(0).toUpperCase() + when.slice(1))), null, "recycle"));
    }
    box.replaceChildren(...cards);
    fitCards();
    startTick();
  }

  // Solo las tarjetas que caben (las primeras son las más importantes)
  function fitCards() {
    const box = $("info");
    for (const c of box.children) c.hidden = false;
    const right = box.getBoundingClientRect().right;
    for (const c of box.children) if (c.getBoundingClientRect().right > right + 1) c.hidden = true;
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

  function voiceCard(n) {
    const isPlaying = playing && playing.id === n.id;
    const count = plays[n.id] || 0;
    const wasHeard = count > 0;
    const meta = (n.from ? "De " + n.from + " · " : "") + secs(n.seconds || 0);
    let foot;
    if (isPlaying) foot = N.h("span", { class: "card-s" }, count + 1 >= MAX_PLAYS ? "Última vez… luego se borra" : "Reproduciendo… toca para parar");
    else if (wasHeard) foot = N.h("span", { class: "vn-acts" },
      N.h("span", { class: "vn-act", "data-act": "play" }, "↻ Otra vez (última)"),
      N.h("span", { class: "vn-act del", "data-act": "del" }, "✕ Quitar"));
    else foot = N.h("span", { class: "card-s" }, "Toca para escuchar");
    const c = card("note voice" + (wasHeard ? "" : " unheard") + (isPlaying ? " playing" : ""), "Nota de voz · para " + n.to,
      N.h("span", { class: "card-b" }, N.h("span", { class: "card-v sm" }, N.h("span", { class: "vn-wave", "aria-hidden": "true" }, N.h("i"), N.h("i"), N.h("i"), N.h("i"), N.h("i")), meta), foot),
      (e) => {
        const act = e.target && e.target.closest && e.target.closest("[data-act]");
        if (act && act.dataset.act === "del") return removeNote(n);
        if (playing && playing.id === n.id) return stopVoice();
        playVoice(n);
      }, "mic");
    return c;
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
    window.addEventListener("resize", fitCards);
    // Al salir a Spotify/YouTube, el micrófono se suelta (y vuelve al regresar)
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  }

  window.NexusHome = { init, refresh, openList, openMusic, openHouse, openApp, settings: () => (data && data.settings) || {},
    timers: () => ((data && data.timers) || []).map((t) => ({ ...t, endsAt: t.endsAt + (data.skew || 0) })) };
})();
