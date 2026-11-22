// NEXUS Home - micrófono compartido.
// Una sola captura de audio (16 kHz) que sirve para "Oye NEXUS" y para la conversación.
// Mantiene medio segundo de audio previo, así nunca se corta el principio de lo que dices,
// y no hay que volver a abrir el micrófono entre la palabra de activación y la pregunta.
(function () {
  "use strict";

  const RATE = 16000;
  const FRAME = 4096;             // ~256 ms por bloque
  const PREROLL_FRAMES = 2;       // ~0,5 s previo
  const MIN_LEVEL = 0.025;        // umbral mínimo de voz
  const NOISE_FACTOR = 2.6;       // la voz debe superar ~2,6 veces el ruido de fondo

  // Ajustes por modo: silencio que cierra la frase y duración máxima
  const MODES = {
    wake: { silenceMs: 450, maxMs: 5000, minVoiceMs: 250 },
    command: { silenceMs: 850, maxMs: 15000, minVoiceMs: 250 },
  };

  let audio = null;               // { stream, ctx, node }
  let mode = "off";               // off | wake | command
  let onSegment = null;           // callback(frames) del modo actual
  let noSpeechTimer = null;
  let opening = null;

  async function open() {
    if (audio) return true;
    if (opening) return opening;
    opening = (async () => {
      try {
        // Sin cancelación de eco ni supresión de ruido: NEXUS no escucha mientras habla,
        // y ese procesado es lo que más CPU consume en esta tablet.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
        const source = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(FRAME, 1, 1);
        const sink = ctx.createGain();
        sink.gain.value = 0;
        source.connect(node); node.connect(sink); sink.connect(ctx.destination);

        const pre = [];
        let seg = null, noise = 0.01;
        node.onaudioprocess = (e) => {
          const buf = new Float32Array(e.inputBuffer.getChannelData(0));
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const level = Math.sqrt(sum / buf.length);
          const now = performance.now();
          const loud = level > Math.max(MIN_LEVEL, noise * NOISE_FACTOR);
          const cfg = MODES[mode];

          if (!cfg) { seg = null; pre.length = 0; return; }
          if (!seg) {
            noise = noise * 0.95 + level * 0.05;
            pre.push(buf);
            if (pre.length > PREROLL_FRAMES) pre.shift();
            if (loud && !document.querySelector(".ring")) {
              seg = { frames: pre.splice(0), start: now, lastVoice: now, voiced: 0 };
              if (mode === "command") clearTimeout(noSpeechTimer);
            }
            return;
          }
          seg.frames.push(buf);
          if (loud) { seg.lastVoice = now; seg.voiced += (FRAME / RATE) * 1000; }
          if (now - seg.lastVoice > cfg.silenceMs || now - seg.start > cfg.maxMs) {
            const done = seg;
            seg = null;
            if (done.voiced >= cfg.minVoiceMs && onSegment) onSegment(done.frames);
          }
        };
        audio = { stream, ctx, node };
        return true;
      } catch {
        return false;
      } finally {
        opening = null;
      }
    })();
    return opening;
  }

  function close() {
    clearTimeout(noSpeechTimer);
    mode = "off";
    onSegment = null;
    if (!audio) return;
    audio.node.onaudioprocess = null;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close().catch(() => {});
    audio = null;
  }

  // Escucha "Oye NEXUS": cada frase detectada llega a cb(frames)
  async function listenWake(cb) {
    if (!(await open())) return false;
    clearTimeout(noSpeechTimer);
    mode = "wake";
    onSegment = cb;
    return true;
  }

  // Escucha una orden: resuelve con los fragmentos de audio, o null si nadie habla
  async function listenCommand(noSpeechMs) {
    if (!(await open())) return { error: "mic" };
    return new Promise((resolve) => {
      mode = "command";
      onSegment = (frames) => { clearTimeout(noSpeechTimer); mode = "off"; onSegment = null; resolve({ frames }); };
      clearTimeout(noSpeechTimer);
      noSpeechTimer = setTimeout(() => { mode = "off"; onSegment = null; resolve({ frames: null }); }, noSpeechMs);
    });
  }

  // Termina antes de tiempo lo que se esté escuchando (toque en la esfera)
  function finishCommand() {
    if (mode === "command" && onSegment) { const cb = onSegment; clearTimeout(noSpeechTimer); cb([]); }
  }

  function pause() { clearTimeout(noSpeechTimer); mode = "off"; onSegment = null; }
  const isOpen = () => !!audio;

  // Audio WAV de 16 bits a partir de los bloques
  function toWavBase64(frames) {
    const len = frames.reduce((n, f) => n + f.length, 0);
    const out = new DataView(new ArrayBuffer(44 + len * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); out.setUint32(4, 36 + len * 2, true); str(8, "WAVE");
    str(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    str(36, "data"); out.setUint32(40, len * 2, true);
    let o = 44;
    for (const f of frames) for (let i = 0; i < f.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, f[i]));
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const bytes = new Uint8Array(out.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function toWavBlob(frames) {
    const b64 = toWavBase64(frames);
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: "audio/wav" });
  }

  window.NexusMic = { open, close, listenWake, listenCommand, finishCommand, pause, isOpen, toWavBase64, toWavBlob };
})();
