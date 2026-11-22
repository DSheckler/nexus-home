// NEXUS Home - agenda interactiva (se abre al tocar el panel de agenda).
// 14 días a elegir, filtro por persona, y añadir o quitar eventos de Google Calendar.
(function () {
  "use strict";

  const DAYS = 14;
  const TZ = "Europe/Stockholm";
  let N = null;
  let sheet = null;
  let events = [];
  let people = {};
  let sel = null;          // "AAAA-MM-DD" elegido
  let who = "all";         // filtro de persona

  const fKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
  const fDow = new Intl.DateTimeFormat("es-ES", { weekday: "short", timeZone: "UTC" });
  const fLong = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const pad = (n) => String(n).padStart(2, "0");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const addDays = (key, n) => { const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const todayKey = () => fKey.format(new Date());
  const editable = () => Object.keys(people).filter((k) => k !== "familia");

  function close() { if (sheet) sheet.remove(); sheet = null; }

  async function load() {
    const j = await N.api("/api/agenda/range?days=" + DAYS);
    events = j.events || [];
    people = j.people || {};
  }

  async function open() {
    close();
    const h = N.h;
    sel = sel && sel >= todayKey() ? sel : todayKey();
    sheet = h("div", { class: "sheet-wrap", onclick: (e) => { if (e.target === sheet) close(); } },
      h("div", { class: "sheet wide ag-sheet" }, h("p", { class: "sheet-sub" }, "Cargando la agenda…")));
    document.body.append(sheet);
    try { await load(); }
    catch { if (sheet) sheet.firstChild.replaceChildren(h("p", { class: "empty" }, "No he podido cargar la agenda.")); return; }
    if (sheet) render();
  }

  const onDay = (key) => events.filter((e) => e.date === key && (who === "all" || e.who === who));

  function render() {
    const h = N.h;
    const t = todayKey();
    const keys = Array.from({ length: DAYS }, (_, i) => addDays(t, i));

    const filters = [["all", "Todos", null]].concat(Object.entries(people).filter(([k]) => events.some((e) => e.who === k) || editable().includes(k)).map(([k, p]) => [k, p.name, p.color]))
      .map(([k, label, c]) => h("button", { class: "ag-filter", type: "button", "aria-pressed": String(who === k), style: c ? `--c:${c}` : null,
        onclick: () => { who = k; render(); } }, c ? h("i", {}) : null, label));

    const chips = keys.map((k, i) => {
      const list = onDay(k);
      const dots = [...new Set(list.map((e) => e.who))].slice(0, 3).map((w) => h("i", { style: `--c:${N.color(w)}` }));
      const d = new Date(k + "T12:00:00Z");
      return h("button", { class: "ag-chip", type: "button", "aria-pressed": String(k === sel), onclick: () => { sel = k; render(); } },
        h("span", { class: "ag-chip-d" }, i === 0 ? "Hoy" : i === 1 ? "Mañana" : cap(fDow.format(d).replace(".", ""))),
        h("span", { class: "ag-chip-n" }, String(d.getUTCDate())),
        h("span", { class: "ag-dots" }, ...dots));
    });

    const list = onDay(sel).sort((a, b) => (a.allDay ? "" : a.start || "").localeCompare(b.allDay ? "" : b.start || ""));
    const rows = list.map((e) => {
      const del = e.type === "birthday" || e.type === "holiday" ? null : h("button", { class: "btn ghost ag-del", type: "button" }, "Quitar");
      if (del) {
        let armed = false;
        del.addEventListener("click", async () => {
          if (!armed) { armed = true; del.textContent = "¿Seguro?"; del.classList.add("danger"); setTimeout(() => { armed = false; if (del.isConnected) { del.textContent = "Quitar"; del.classList.remove("danger"); } }, 3000); return; }
          del.disabled = true;
          try {
            await N.api(`/api/agenda/events/${e.who}/${encodeURIComponent(e.id)}`, { method: "DELETE" });
            events = events.filter((x) => x !== e);
            N.toast("Evento quitado");
            N.refreshAgenda();
            render();
          } catch { del.disabled = false; N.toast("No he podido quitarlo"); }
        });
      }
      return h("li", { class: "ag-row", style: `--c:${N.color(e.who)}` },
        h("span", { class: "ag-time" }, e.allDay ? "Todo el día" : `${e.start}${e.end ? "–" + e.end : ""}`),
        h("span", { class: "mark" }),
        h("span", { class: "ag-what" },
          h("span", { class: "ag-title" }, e.type === "birthday" ? h("span", { html: N.ICON.cake }) : e.type === "holiday" ? h("span", { html: N.ICON.flag }) : null, e.title),
          h("span", { class: "who" }, N.name(e.who))),
        del);
    });

    const dLong = cap(fLong.format(new Date(sel + "T12:00:00Z")));
    sheet.firstChild.replaceChildren(
      h("header", { class: "sheet-head" },
        h("h2", {}, "Agenda familiar"),
        h("div", { class: "ag-filters" }, ...filters),
        h("button", { class: "btn ghost", type: "button", onclick: close }, "Cerrar")),
      h("div", { class: "ag-chips" }, ...chips),
      h("div", { class: "ag-dayhead" },
        h("span", {}, dLong),
        editable().length ? h("button", { class: "btn primary", type: "button", onclick: showForm }, "+ Añadir evento") : null),
      rows.length ? h("ul", { class: "ag-list" }, ...rows) : h("p", { class: "empty ag-empty" }, "Nada este día."));
  }

  // ---------- nuevo evento ----------
  function showForm() {
    const h = N.h;
    const owners = editable();
    let person = who !== "all" && owners.includes(who) ? who : owners[0];
    let allDay = false;
    let hh = 18, mm = 0, dur = 60;

    const title = h("input", { class: "ed-input", type: "text", maxlength: "120", placeholder: "Por ejemplo: Dentista", "aria-label": "Título" });
    const personBtns = owners.map((k) => h("button", { class: "ag-filter", type: "button", "aria-pressed": String(k === person), style: `--c:${N.color(k)}`,
      onclick: (ev) => { person = k; personBtns.forEach((b) => b.setAttribute("aria-pressed", String(b === ev.currentTarget))); } }, h("i", {}), N.name(k)));

    const hVal = h("span", { class: "ed-val" }, pad(hh));
    const mVal = h("span", { class: "ed-val" }, pad(mm));
    const dVal = h("span", { class: "ag-dur" }, "1 h");
    const chev = (up) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${up ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}"/></svg>`;
    const durText = () => (dur < 60 ? `${dur} min` : `${Math.floor(dur / 60)} h${dur % 60 ? " " + (dur % 60) : ""}`);
    function step(kind, dir) {
      if (kind === "h") { hh = (hh + dir + 24) % 24; hVal.textContent = pad(hh); }
      else if (kind === "m") { mm = (mm + dir * 15 + 60) % 60; mVal.textContent = pad(mm); }
      else { dur = Math.max(15, Math.min(480, dur + dir * 15)); dVal.textContent = durText(); }
    }
    const stepper = (kind, dir, label) => {
      const b = h("button", { class: "ed-step", type: "button", "aria-label": label, html: chev(dir > 0) });
      let t1, t2;
      const end = () => { clearTimeout(t1); clearInterval(t2); };
      b.addEventListener("pointerdown", () => { step(kind, dir); t1 = setTimeout(() => { t2 = setInterval(() => step(kind, dir), 110); }, 450); });
      ["pointerup", "pointerleave", "pointercancel"].forEach((e) => b.addEventListener(e, end));
      return b;
    };
    const picker = h("div", { class: "ag-timebox" },
      h("div", { class: "ed-picker ag-picker", role: "group", "aria-label": "Hora" },
        h("div", { class: "ed-col" }, stepper("h", 1, "Subir hora"), hVal, stepper("h", -1, "Bajar hora")),
        h("span", { class: "ed-colon" }, ":"),
        h("div", { class: "ed-col" }, stepper("m", 1, "Subir minutos"), mVal, stepper("m", -1, "Bajar minutos"))),
      h("div", { class: "ed-col ag-durcol" }, h("span", { class: "ed-hint" }, "Duración"), stepper("d", 1, "Más tiempo"), dVal, stepper("d", -1, "Menos tiempo")));

    const sw = h("button", { class: "switch", type: "button", role: "switch", "aria-checked": "false", "aria-label": "Todo el día",
      onclick: () => { allDay = !allDay; sw.setAttribute("aria-checked", String(allDay)); picker.hidden = allDay; } });

    async function save(btn) {
      const text = title.value.trim();
      if (!text) { title.focus(); return N.toast("Escribe un título"); }
      btn.disabled = true;
      const startMin = hh * 60 + mm, endMin = Math.min(startMin + dur, 23 * 60 + 59);
      const body = { who: person, title: text, date: sel };
      if (!allDay) { body.start = `${pad(hh)}:${pad(mm)}`; body.end = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`; }
      try {
        await N.api("/api/agenda/events", { method: "POST", body });
        N.toast("Evento añadido");
        N.refreshAgenda();
        await load().catch(() => {});
        if (sheet) render();
      } catch (e) { btn.disabled = false; N.toast("No he podido guardarlo" + (e && e.message ? ": " + e.message : "")); }
    }

    const saveBtn = h("button", { class: "btn primary", type: "button" }, "Guardar");
    saveBtn.addEventListener("click", () => save(saveBtn));
    sheet.firstChild.replaceChildren(
      h("header", { class: "sheet-head" },
        h("h2", {}, "Nuevo evento · " + cap(fLong.format(new Date(sel + "T12:00:00Z")))),
        h("button", { class: "btn ghost", type: "button", onclick: render }, "Volver")),
      h("div", { class: "ag-form" },
        h("label", { class: "ed-field" }, h("span", { class: "ed-cap" }, "Qué"), title),
        h("div", { class: "ed-field" }, h("span", { class: "ed-cap" }, "De quién"), h("div", { class: "ag-filters" }, ...personBtns)),
        h("div", { class: "ed-row" }, h("span", { class: "ed-cap" }, "Todo el día"), sw),
        picker),
      h("footer", { class: "sheet-foot" }, h("span"), saveBtn));
    setTimeout(() => title.focus(), 50);
  }

  function init(ctx) {
    N = ctx;
    const panel = document.getElementById("agenda");
    panel.setAttribute("role", "button");
    panel.setAttribute("tabindex", "0");
    panel.setAttribute("aria-label", "Abrir la agenda");
    panel.addEventListener("click", open);
  }

  window.NexusAgenda = { init, open };
})();
