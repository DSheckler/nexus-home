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

  // Control remoto en pantalla (hoja «Tele»)
  function open(back) {
    const h = N.h;
    const status = h("p", { class: "sheet-sub" }, getIp() ? "TV Box en " + getIp() : "Buscando la TV Box en la red…");
    const btn = (label, action, arg, cls = "") => h("button", { class: "btn ghost tv-k " + cls, type: "button", onclick: async (e) => {
      const el = e.currentTarget; el.disabled = true;
      try { await run(action, arg); if (LABEL[action] && (action === "on" || action === "off")) N.toast(LABEL[action]); }
      catch (err) { N.toast("Tele: " + err.message); status.textContent = err.message; }
      el.disabled = false;
    } }, label);
    const pad = h("div", { class: "tv-pad" },
      h("span"), btn("Arriba", "up"), h("span"),
      btn("‹", "left"), btn("OK", "ok", "", "primary"), btn("›", "right"),
      btn("Atrás", "back"), btn("Abajo", "down"), btn("Inicio", "home"));
    const row1 = h("div", { class: "tv-row" }, btn("Encender", "on", "", "primary"), btn("Apagar", "off"), btn("Pausa / Play", "playpause"));
    const row2 = h("div", { class: "tv-row" }, btn("Vol −", "voldown", "2"), btn("Silencio", "mute"), btn("Vol +", "volup", "2"));
    const apps = h("div", { class: "tv-row" }, ...Object.entries(APPS).slice(0, 4).map(([k, v]) => btn(v, "app", k)));
    window.NexusHome.openSheet("Tele", status, row1, row2, pad, apps,
      h("p", { class: "sheet-sub" }, "Por voz: «Oye NEXUS, pon YouTube en la tele», «pausa la tele», «sube el volumen», «apaga la tele»."));
    if (!getIp()) find().then((ip) => { status.textContent = "TV Box en " + ip; }).catch(() => { status.textContent = "No encontré la TV Box. ¿Está encendida y con la depuración por red activada?"; });
  }

  function init(ctx) { N = ctx; }
  window.NexusTV = { init, run, find, isOn, open, done, fromVoice, available: () => !!bridge(), APPS };
})();
