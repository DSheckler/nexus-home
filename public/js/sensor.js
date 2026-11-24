// NEXUS Home - sensor de presencia con la cámara frontal (como el Nest Hub o el Echo Show).
// Todo se procesa en la tablet: cada ~0,7 s se compara una imagen diminuta (40×30 en grises)
// con la anterior. No se guarda ni se envía ninguna imagen.
//  - De noche: si alguien se acerca, la pantalla sube un poco el brillo durante 20 s.
//  - De día: si nadie pasa por delante ni toca la pantalla en 10 min, se atenúa; al volver, se ilumina.
// Solo funciona en la app de la tablet y se puede apagar en Casa → Sensor de presencia.
(function () {
  "use strict";

  const W = 40, H = 30, EVERY_MS = 700;
  const NIGHT_PEEK = 0.15, NIGHT_PEEK_MS = 20000;   // de noche: brillo al acercarse
  const DAY_IDLE_MS = 10 * 60 * 1000, DAY_DIM = 0.12; // de día: atenuar sin nadie
  let N = null, stream = null, video = null, ctx = null, prev = null, timer = null;
  let lastMotion = Date.now(), lastTouch = Date.now(), state = "normal"; // normal | peek | dim
  let noise = 2, peekTimer = null;

  const enabled = () => { try { return localStorage.getItem("nexus.sensor") !== "off"; } catch { return true; } };
  const isApp = () => !!(window.NexusAndroid && window.NexusAndroid.setBrightness);
  const night = () => document.body.classList.contains("night");
  const busy = () => !!document.querySelector(".ring, .cook");

  async function start() {
    if (stream || !enabled() || !isApp() || !navigator.mediaDevices) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 160 }, height: { ideal: 120 }, frameRate: { ideal: 5, max: 8 } }, audio: false });
    } catch (e) {
      if (window.NexusLog) window.NexusLog({ type: "sensor", msg: String(e && e.name || e) });
      stream = null; return;
    }
    video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    try { await video.play(); } catch { /* sigue igual */ }
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    ctx = c.getContext("2d", { willReadFrequently: true });
    timer = setInterval(tick, EVERY_MS);
  }

  function stop() {
    clearInterval(timer); timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; video = null; prev = null;
    restore();
  }

  function tick() {
    if (!video || video.readyState < 2 || document.hidden) return;
    ctx.drawImage(video, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const g = new Uint8Array(W * H);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    if (prev) {
      // Diferencia media y cuántos puntos cambian de verdad (un cambio de luz general no cuenta)
      let sum = 0, moved = 0;
      for (let j = 0; j < g.length; j++) { const x = Math.abs(g[j] - prev[j]); sum += x; if (x > 18) moved++; }
      const mean = sum / g.length;
      const motion = moved > g.length * 0.04 && mean > noise * 2.2 && moved < g.length * 0.85;
      noise = noise * 0.97 + Math.min(mean, 6) * 0.03;
      if (motion) onMotion();
    }
    prev = g;
    check();
  }

  function onMotion() {
    lastMotion = Date.now();
    if (busy()) return;
    if (night()) {
      // Se acerca alguien de noche: un poco más de luz para ver la hora
      if (state !== "peek") { setB(NIGHT_PEEK); state = "peek"; }
      clearTimeout(peekTimer);
      peekTimer = setTimeout(() => { if (state === "peek") restore(); }, NIGHT_PEEK_MS);
    } else if (state === "dim") restore();
  }

  function check() {
    if (busy() || night() || state !== "normal") return;
    if (Date.now() - Math.max(lastMotion, lastTouch) > DAY_IDLE_MS && !document.querySelector(".sheet-wrap, body.talking")) { setB(DAY_DIM); state = "dim"; }
  }

  function setB(v) { try { window.NexusAndroid.setBrightness(v); } catch { /* sin app */ } }
  function restore() {
    clearTimeout(peekTimer);
    if (state === "normal") return;
    state = "normal";
    if (N && N.applyMode) N.applyMode(true); else setB(-1); // vuelve el brillo que toque (noche o día)
  }

  function init(ctxN) {
    N = ctxN;
    document.addEventListener("pointerdown", () => { lastTouch = Date.now(); if (state === "dim") restore(); }, { passive: true, capture: true });
    // Con Spotify/YouTube delante se suelta la cámara
    document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else start(); });
    start();
  }

  function setEnabled(on) {
    try { localStorage.setItem("nexus.sensor", on ? "on" : "off"); } catch { /* */ }
    if (on) start(); else stop();
  }

  window.NexusSensor = { init, setEnabled, enabled, active: () => !!stream, available: isApp };
})();
