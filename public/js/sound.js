// NEXUS Home - salida de sonido.
// En la app Android (1.5 o más) todo suena con el reproductor nativo: en la Tab A con Android 11
// y WebView 140 la salida de audio de la página se desconecta a los pocos milisegundos y la voz o
// la alarma salían a trozos. Los sonidos sintetizados (alarma, avisos) se generan antes con
// OfflineAudioContext, que no usa la salida de audio, y se pasan como WAV.
// En un navegador normal (PC, celular) se usa <audio>, que funciona bien.
(function () {
  "use strict";

  const A = () => window.NexusAndroid;
  const native = () => !!(A() && A().playAudio);
  const waiting = new Map();   // id -> resolve
  let seq = 0;
  const players = new Set();   // <audio> en navegador normal

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // Reproduce un MP3/WAV y resuelve al terminar (o al detenerlo)
  async function playBlob(blob, { volume = 1 } = {}) {
    if (!blob) return;
    if (native()) {
      const id = "s" + (++seq);
      const b64 = await blobToBase64(blob);
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        let ok = false;
        try { ok = A().playAudio(b64, id, volume); } catch { ok = false; }
        if (!ok) { waiting.delete(id); resolve(); }
      });
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.volume = volume;
      players.add(a);
      const done = () => { players.delete(a); URL.revokeObjectURL(url); resolve(); };
      a.onended = a.onerror = done;
      a.__done = done;
      a.play().catch(done);
    });
  }

  // Lo llama la app Android cuando termina un sonido o una frase
  function ended(id) {
    const r = waiting.get(id);
    if (r) { waiting.delete(id); r(); }
  }

  function stop() {
    if (native()) { try { A().stopAudio(); } catch { /* sin app */ } }
    for (const a of [...players]) { a.pause(); a.__done(); }
    for (const [id, r] of [...waiting]) { waiting.delete(id); r(); }
  }

  // Sintetiza un sonido sin tocar la salida de audio: build(ctx, destino) programa las notas
  async function render(seconds, build, rate = 24000) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, Math.ceil(seconds * rate), rate);
    build(ctx, ctx.destination);
    return ctx.startRendering();
  }

  function wavBlob(buffer) {
    const data = buffer.getChannelData(0), rate = buffer.sampleRate, len = data.length;
    const v = new DataView(new ArrayBuffer(44 + len * 2));
    const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    s(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); s(8, "WAVE"); s(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    s(36, "data"); v.setUint32(40, len * 2, true);
    for (let i = 0, o = 44; i < len; i++, o += 2) {
      const x = Math.max(-1, Math.min(1, data[i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([v.buffer], { type: "audio/wav" });
  }

  // Sintetiza y reproduce: lo que usan la alarma, el temporizador y los avisos
  async function synth(seconds, build) {
    try { return await playBlob(wavBlob(await render(seconds, build))); } catch { /* sin audio */ }
  }

  // Voz de Android (gratis). Resuelve false si no está disponible.
  function hasDeviceVoice() {
    try { return !!(A() && A().ttsAvailable && A().ttsAvailable()); } catch { return false; }
  }
  function deviceSpeak(text) {
    if (!(A() && A().speak)) return Promise.resolve(false);
    const id = "t" + (++seq);
    return new Promise((resolve) => {
      waiting.set(id, () => resolve(true));
      let ok = false;
      try { ok = A().speak(text, id); } catch { ok = false; }
      if (!ok) { waiting.delete(id); resolve(false); }
    });
  }

  // Prepara la voz de Android al arrancar (tarda un momento en cargarse)
  setTimeout(hasDeviceVoice, 1500);

  window.NexusSound = { native, playBlob, stop, ended, render, wavBlob, synth, hasDeviceVoice, deviceSpeak };
})();
