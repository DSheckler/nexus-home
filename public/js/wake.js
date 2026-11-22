// NEXUS Home - escucha en espera: "Oye NEXUS".
// Usa el micrófono compartido (mic.js). Solo cuando detecta voz envía esa frase corta
// a Whisper y comprueba si dice "NEXUS". Nada se graba de forma continua ni se guarda.
(function () {
  "use strict";

  // Variantes con las que Whisper puede escribir "NEXUS"
  const WAKE = /\b(?:oye|hey|ey|oiga|o)?[\s,]*(nexus|nexos|nexo|nexuz|nexis|nexxus|neksus|lexus|next us|nexu)\b[\s,.!?¿¡]*/i;

  let N = null, V = null;
  let enabled = true;
  let paused = false;
  let pausedUntil = 0;
  let busy = 0;              // fragmentos en análisis (hasta 2 a la vez: no se pierde "Oye NEXUS" por un ruido previo)
  const MAX_PARALLEL = 2;
  // Tope de fragmentos enviados: si hay ruido constante (tele, música, obras)
  // no se gasta la cuota del día en analizarlo.
  const WINDOW_MS = 10 * 60 * 1000, MAX_PER_WINDOW = 20;
  let sent = [];

  const $ = (id) => document.getElementById(id);
  const fold = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  function load() { try { return localStorage.getItem("nexus.wake") !== "off"; } catch { return true; } }
  function store(v) { try { localStorage.setItem("nexus.wake", v ? "on" : "off"); } catch { /* sin almacenamiento */ } }

  function renderButton() {
    const b = $("micBtn");
    b.innerHTML = enabled ? N.ICON.mic : N.ICON.micOff;
    b.setAttribute("aria-pressed", String(enabled));
    b.classList.toggle("on", enabled && window.NexusMic.isOpen());
    b.title = enabled ? "Escuchando «Oye NEXUS». Toca para desactivar" : "«Oye NEXUS» desactivado. Toca para activar";
  }

  function toggle() {
    enabled = !enabled;
    store(enabled);
    if (enabled) { N.toast("Di «Oye NEXUS» para hablar"); start(); }
    else { window.NexusMic.close(); N.toast("Micrófono desactivado"); renderButton(); }
  }

  async function start() {
    if (!enabled || paused || Date.now() < pausedUntil) return renderButton();
    await window.NexusMic.listenWake(analyse);
    renderButton();
  }

  async function analyse(frames) {
    if (busy >= MAX_PARALLEL || paused) return;
    // De noche (pantalla en modo noche) no se analiza nada: para despertarla, tocar la pantalla
    if (document.body.classList.contains("night")) return;
    const now = Date.now();
    sent = sent.filter((t) => now - t < WINDOW_MS);
    if (sent.length >= MAX_PER_WINDOW) return;
    sent.push(now);
    busy++;
    try {
      const res = await fetch("/api/transcribe?wake=1", {
        method: "POST",
        headers: { Authorization: "Bearer " + N.token(), "Content-Type": "audio/wav" },
        body: window.NexusMic.toWavBlob(frames),
      });
      if (res.status === 429) return quotaPause();
      const j = await res.json();
      if (!j.ok || !j.text || paused) return;
      const m = WAKE.exec(fold(j.text));
      if (!m) return;
      const rest = j.text.slice(m.index + m[0].length).replace(/^[\s,.!?¿¡]+/, "").trim();
      chime();
      if (rest.split(/\s+/).filter(Boolean).length >= 2) V.startWith(rest);
      else V.start();
    } catch { /* sin red: se ignora */ }
    finally { busy--; }
  }

  function quotaPause() {
    const t = new Date();
    pausedUntil = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
    window.NexusMic.close();
    renderButton();
    N.toast("«Oye NEXUS» en pausa hasta mañana (cuota diaria). La esfera sigue funcionando.");
  }

  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1318.5].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), at = ctx.currentTime + i * 0.1;
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
        o.connect(g).connect(ctx.destination);
        o.start(at); o.stop(at + 0.25);
      });
      setTimeout(() => ctx.close(), 700);
    } catch { /* sin audio */ }
  }

  // Durante la conversación el micrófono sigue abierto, pero no busca "Oye NEXUS"
  function pause() { paused = true; }
  function resume() {
    paused = false;
    if (enabled) start();
    else window.NexusMic.close(); // solo estaba abierto para la conversación
  }

  function init(ctx, voice) {
    N = ctx;
    V = voice;
    enabled = load();
    $("micBtn").addEventListener("click", toggle);
    renderButton();
    start();
    document.addEventListener("pointerup", () => { if (enabled && !paused && !window.NexusMic.isOpen()) start(); }, { passive: true });
    // Con Spotify/YouTube delante se suelta el micrófono (no escucha la música ni gasta cuota)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { if (!paused) start(); }
      else if (!paused) { window.NexusMic.close(); renderButton(); }
    });
  }

  window.NexusWake = { init, pause, resume };
})();
