// NEXUS Home - panel del tiempo interactivo (se abre al tocar el widget del clima).
// 7 días a elegir; para cada uno: resumen, detalles y gráfica hora a hora
// (temperatura, icono y probabilidad de lluvia).
(function () {
  "use strict";

  let N = null;
  let detail = null;
  let detailAt = 0;
  let sheet = null;
  const DAYNAMES = { Dom: "Domingo", Lun: "Lunes", Mar: "Martes", "Mié": "Miércoles", Jue: "Jueves", Vie: "Viernes", "Sáb": "Sábado" };

  async function load() {
    if (detail && Date.now() - detailAt < 10 * 60 * 1000) return detail;
    detail = await N.api("/api/weather/detail");
    detailAt = Date.now();
    return detail;
  }

  function close() { if (sheet) sheet.remove(); sheet = null; }

  async function open(dayIndex = 0) {
    close();
    const h = N.h;
    sheet = h("div", { class: "sheet-wrap", onclick: (e) => { if (e.target === sheet) close(); } },
      h("div", { class: "sheet wide wx-sheet" }, h("p", { class: "sheet-sub" }, "Cargando el tiempo…")));
    document.body.append(sheet);
    try { await load(); } catch { sheet.firstChild.replaceChildren(h("p", { class: "empty" }, "No pude cargar el pronóstico.")); return; }
    if (sheet) render(dayIndex);
  }

  // Horas a mostrar: hoy, desde la hora actual las próximas 24; otros días, el día entero
  function hoursFor(i) {
    if (i > 0) return detail.days[i].hours;
    const nowH = detail.now.time.slice(11, 13);
    const today = detail.days[0].hours.filter((x) => x.h >= nowH);
    const tomorrow = (detail.days[1] && detail.days[1].hours) || [];
    return today.concat(tomorrow).slice(0, 24);
  }

  function chart(hours) {
    const SVGNS = "http://www.w3.org/2000/svg";
    const el = (tag, attrs, text) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
    const W = hours.length * 10, H = 34;
    const temps = hours.map((x) => x.temp);
    const max = Math.max(...temps), min = Math.min(...temps);
    const y = (t) => (max === min ? H / 2 : 6 + (1 - (t - min) / (max - min)) * (H - 14));
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "wx-curve", preserveAspectRatio: "none" });
    const pts = hours.map((x, i) => `${i * 10 + 5},${y(x.temp).toFixed(1)}`);
    svg.append(el("polyline", { points: pts.join(" "), class: "wx-line" }));
    hours.forEach((x, i) => {
      svg.append(el("circle", { cx: i * 10 + 5, cy: y(x.temp), r: 0.9, class: "wx-pt" }));
    });
    return svg;
  }

  function render(i) {
    const h = N.h;
    const day = detail.days[i];
    const today = i === 0;
    const hours = hoursFor(i);

    const chips = detail.days.map((d, k) => h("button", {
      class: "wx-chip", type: "button", "aria-pressed": String(k === i), onclick: () => render(k),
    }, h("span", { class: "wx-chip-d" }, k === 0 ? "Hoy" : k === 1 ? "Mañana" : d.d),
      h("span", { html: N.ICON[d.code] || N.ICON.cloudy }),
      h("span", { class: "wx-chip-t" }, `${d.max}°`, h("small", {}, ` ${d.min}°`))));

    const n = detail.now;
    const big = today
      ? [h("span", { class: "wx-big-t" }, `${n.temp}°`), h("span", { class: "wx-big-s" }, `${n.text}. Sensación ${n.feels}°`)]
      : [h("span", { class: "wx-big-t" }, `${day.max}°`, h("small", {}, ` / ${day.min}°`)), h("span", { class: "wx-big-s" }, day.text)];

    const facts = [
      today ? ["Humedad", `${n.humidity}%`] : ["Lluvia", `${day.rainProb}%`],
      today ? ["Viento", `${n.wind} m/s` + (n.gusts > n.wind + 2 ? ` · ráfagas ${n.gusts}` : "")] : ["Viento máx.", `${day.wind} m/s`],
      ["Precipitación", `${day.rain} mm`],
      ["Sol", `${day.sunrise} – ${day.sunset}`],
    ].map(([k, v]) => h("div", { class: "wx-fact" }, h("span", { class: "wx-fact-k" }, k), h("span", { class: "wx-fact-v" }, v)));

    const cols = hours.map((x) => h("div", { class: "wx-col", title: x.text },
      h("span", { class: "wx-col-t" }, `${x.temp}°`),
      h("span", { class: "wx-col-i", html: N.ICON[x.code] || N.ICON.cloudy }),
      h("span", { class: "wx-rain" }, h("i", { style: `height:${Math.max(2, x.rainProb)}%` })),
      h("span", { class: "wx-col-p" + (x.rainProb >= 40 ? " wet" : "") }, x.rainProb ? `${x.rainProb}%` : ""),
      h("span", { class: "wx-col-h" }, x.h)));

    sheet.firstChild.replaceChildren(
      h("header", { class: "sheet-head" },
        h("h2", {}, today ? `El tiempo en ${detail.location}` : `${DAYNAMES[day.d] || day.d} en ${detail.location}`),
        h("button", { class: "btn ghost", type: "button", onclick: close }, "Cerrar")),
      h("div", { class: "wx-chips" }, ...chips),
      h("div", { class: "wx-hero" },
        h("span", { class: "wx-big-i", html: N.ICON[today ? n.code : day.code] || N.ICON.cloudy }),
        h("div", { class: "wx-big" }, ...big),
        h("div", { class: "wx-facts" }, ...facts)),
      h("p", { class: "wx-cap" }, today ? "Próximas 24 horas" : "Hora a hora"),
      h("div", { class: "wx-hours" }, h("div", { class: "wx-curve-wrap" }, chart(hours)), h("div", { class: "wx-cols", style: `grid-template-columns:repeat(${hours.length},1fr)` }, ...cols)),
      h("p", { class: "wx-src" }, "Datos: Open-Meteo. Barras azules: probabilidad de lluvia."));
  }

  function init(ctx) {
    N = ctx;
    const panel = document.getElementById("weather");
    panel.setAttribute("role", "button");
    panel.setAttribute("tabindex", "0");
    panel.setAttribute("aria-label", "Ver el pronóstico detallado");
    panel.addEventListener("click", (e) => {
      // Tocar un día del pronóstico abre ese día
      const dayEl = e.target.closest(".wx-day");
      const days = [...panel.querySelectorAll(".wx-day")];
      open(dayEl ? days.indexOf(dayEl) + 1 : 0);
    });
  }

  window.NexusWeather = { init, open };
})();
