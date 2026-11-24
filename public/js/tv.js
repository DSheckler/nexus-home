// NEXUS Home - control de la tele a través de la TV Box Android (Google TV) de la casa.
// La app de la tablet le habla a la TV Box por la red (ADB) y la TV Box enciende o apaga la
// tele por HDMI-CEC. La dirección de la TV Box se busca sola la primera vez y se recuerda.
(function () {
  "use strict";

  let N = null;
  const pending = new Map();
  let seq = 0;
  const bridge = () => window.NexusAndroid && window.NexusAndroid.tvCommand ? window.NexusAndroid : null;
  const getIp = () => { try { return localStorage.getItem("nexus.tvip") || ""; } catch { return ""; } };
  const setIp = (v) => { try { if (v) localStorage.setItem("nexus.tvip", v); else localStorage.removeItem("nexus.tvip"); } catch { /* */ } };

  // Respuesta de la app: done(id, ok, texto)
  function done(id, ok, text) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    (ok ? p.resolve : p.reject)(ok ? text : new Error(text || "La TV Box no responde"));
  }
  function call(fn, ...args) {
    return new Promise((resolve, reject) => {
      const id = "tv" + (++seq);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("La TV Box no responde")); }, 75000);
      pending.set(id, { resolve, reject, timer });
      let ok = true;
      try { ok = fn(...args, id); } catch (e) { ok = false; }
      if (ok === false) { clearTimeout(timer); pending.delete(id); reject(new Error("Orden no válida")); }
    });
  }

  async function find() {
    const b = bridge();
    if (!b) throw new Error("Solo funciona en la app de la tablet");
    const ip = await call((id) => { b.tvFind(id); return true; });
    setIp(ip);
    return ip;
  }

  // action: on | off | volup | voldown | mute | playpause | home | back | up | down | left | right | ok | app | search | state
  async function run(action, arg = "") {
    const b = bridge();
    if (!b) throw new Error("El control de la tele solo funciona en la app de la tablet");
    let ip = getIp() || await find();
    try {
      return await call((a, c, d, id) => b.tvCommand(a, c, d, id), ip, action, String(arg));
    } catch (e) {
      // Puede haber cambiado de dirección: se busca otra vez y se reintenta una vez
      if (action === "on" || /Orden no válida/.test(e.message)) throw e;
      const again = await find().catch(() => "");
      if (!again || again === ip) throw e;
      return call((a, c, d, id) => b.tvCommand(a, c, d, id), again, action, String(arg));
    }
  }

  async function isOn() {
    try { return /Awake/.test(await run("state")); } catch { return false; }
  }

  const LABEL = {
    on: "Encendiendo la tele", off: "Apagando la tele", volup: "Subiendo el volumen", voldown: "Bajando el volumen",
    mute: "Silencio", playpause: "Pausa / reanudar", home: "Inicio",
  };
  const APPS = { youtube: "YouTube", netflix: "Netflix", disney: "Disney+", music: "YouTube Music", spotify: "Spotify" };

  // Orden que viene del asistente o de la voz: { action, arg }
  async function fromVoice(o) {
    if (!o || !o.action) return;
    try {
      await run(o.action, o.arg || "");
      if (o.action === "off") N.toast("Tele apagada. Para encenderla, usa el control (la TV Box se desconecta en reposo).");
    } catch (e) { N.toast("Tele: " + e.message); }
  }

  // Control remoto en pantalla (hoja «Tele»): buscador para todas las apps, flechas en círculo,
  // pausa grande, volumen y apps. «Apagar» va abajo y discreto para no tocarlo sin querer.
  function open() {
    const h = N.h;
    const status = h("p", { class: "sheet-sub tv-state" }, "Para encenderla usa el control de la tele.");
    const go = (action, arg) => async (e) => {
      const el = e.currentTarget; el.disabled = true;
      try { await run(action, arg); status.textContent = action === "off" ? "Tele apagada." : "Listo."; }
      catch (err) { status.textContent = "Tele: " + err.message; }
      el.disabled = false;
    };
    const k = (cls, label, action, arg, aria) => h("button", { class: cls, type: "button", "aria-label": aria || null, onclick: go(action, arg) }, label);
    const q = h("input", { class: "ed-input", type: "search", maxlength: "80", placeholder: "¿Qué quieren ver?", "aria-label": "Qué quieren ver" });
    const yt = h("input", { type: "checkbox" });
    const form = h("form", { class: "tv-search" }, q, h("button", { class: "btn primary", type: "submit" }, "Buscar"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = q.value.trim(); if (!text) return;
      try { await run(yt.checked ? "ytsearch" : "search", text); status.textContent = "Buscando «" + text + "»."; q.value = ""; q.blur(); }
      catch (err) { status.textContent = "Tele: " + err.message; }
    });
    const remote = h("div", { class: "remote" },
      h("div", { class: "dpad" },
        k("dk up", "▲", "up", "", "Arriba"), k("dk left", "‹", "left", "", "Izquierda"),
        k("dk ok", "OK", "ok"), k("dk right", "›", "right", "", "Derecha"), k("dk down", "▼", "down", "", "Abajo")),
      h("div", { class: "rk-col" },
        h("div", { class: "rk-row" },
          k("rk", "Atrás", "back"), k("rk big", "Pausa / Play", "playpause"), k("rk", "Inicio", "home")),
        h("div", { class: "vol" }, k("", "−", "voldown", "2", "Bajar volumen"), k("mute", "Silencio", "mute"), k("", "+", "volup", "2", "Subir volumen")),
        h("div", { class: "tvapps" }, k("tvapp yt", "YouTube", "app", "youtube"), k("tvapp nf", "Netflix", "app", "netflix"), k("tvapp dp", "Disney+", "app", "disney"), k("tvapp ym", "Música", "app", "music")),
        k("off", "Apagar la tele", "off")));
    window.NexusHome.openSheet("Tele", form, h("label", { class: "tv-yt" }, yt, " Solo en YouTube"), remote, status);
    if (!getIp()) find().catch(() => { status.textContent = "No encontré la TV Box. ¿Está encendida y con la depuración por red activada?"; });
  }

  function init(ctx) { N = ctx; }
  window.NexusTV = { init, run, find, isOn, open, done, fromVoice, available: () => !!bridge(), APPS };
})();
