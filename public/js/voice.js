// NEXUS Home - asistente por voz, en conversación continua.
// Tocar la esfera (o decir "Oye NEXUS") inicia la conversación: escucha, responde
// hablando y vuelve a escuchar solo. Termina si nadie habla o al despedirse.
(function () {
  "use strict";

  const FIRST_NO_SPEECH_MS = 7000;   // primer turno: tiempo para empezar a hablar
  const FOLLOW_NO_SPEECH_MS = 6000;  // turnos siguientes: si nadie habla, fin
  const CAPTION_HIDE_MS = 8000;
  const HISTORY_RESET_MS = 5 * 60 * 1000;
  const TYPE_IDLE_MS = 30000;
  const GOODBYE = /\b(gracias|adi[oó]s|chao|chau|hasta luego|eso es todo|nada m[aá]s|ya est[aá])\b/i;

  let N = null;
  let state = "idle";                // idle | listening | thinking | speaking
  let talking = false;
  let endAfterReply = false;
  let history = [];
  let lastTurnAt = 0;
  let hideTimer = null;
  let typeTimer = null;
  const player = new Audio();

  const $ = (id) => document.getElementById(id);
  const MIC = () => window.NexusMic;
  const wake = (fn) => { if (window.NexusWake) window.NexusWake[fn](); };

  // ---------- estado visual ----------
  const LABELS = {
    idle: "Toca para hablar con NEXUS",
    listening: "Te escucho…",
    thinking: "Pensando…",
    speaking: "Toca para interrumpir",
  };

  function setState(s) {
    state = s;
    $("assistant").dataset.state = s;
    $("assistantText").textContent = s === "listening" && talking ? "Te escucho… toca para terminar" : LABELS[s];
  }

  function showCaption() {
    clearTimeout(hideTimer);
    document.body.classList.add("talking");
  }

  function hideCaptionLater(ms = CAPTION_HIDE_MS) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (state !== "idle" || talking || !$("capForm").hidden) return;
      document.body.classList.remove("talking");
    }, ms);
  }

  function caption(user, reply, kind) {
    showCaption();
    if (user !== undefined) $("capUser").textContent = user;
    if (reply !== undefined) {
      const el = $("capReply");
      el.textContent = reply;
      el.className = "cap-reply" + (kind ? " " + kind : "");
    }
  }

  // ---------- conversación ----------
  function startConversation() {
    if (talking) return;
    if (N.wakePanel) N.wakePanel(); // de noche, hablar enciende el panel
    wake("pause");
    talking = true;
    endAfterReply = false;
    $("capForm").hidden = true;
    caption("", "Te escucho…", "hint");
    listen(FIRST_NO_SPEECH_MS);
  }

  // "Oye NEXUS, ¿qué tiempo hará?": la pregunta llega ya transcrita
  function startWith(text) {
    if (talking) return;
    if (N.wakePanel) N.wakePanel();
    wake("pause");
    talking = true;
    endAfterReply = GOODBYE.test(text) && text.length < 40;
    $("capForm").hidden = true;
    ask(text);
  }

  function endConversation(message) {
    const wasTalking = talking;
    talking = false;
    stopSpeaking();
    if (MIC()) MIC().pause();
    setState("idle");
    if (message) caption(undefined, message, "hint");
    hideCaptionLater(message ? 4000 : 2500);
    if (wasTalking) wake("resume");
  }

  async function listen(noSpeechMs) {
    if (!talking) return;
    setState("listening");
    const r = await MIC().listenCommand(noSpeechMs);
    if (!talking) return;
    if (r.error) {
      caption(undefined, "No tengo acceso al micrófono. Permite el micrófono para esta página.", "error");
      return endConversation();
    }
    if (!r.frames || !r.frames.length) {
      return endConversation(history.length || r.frames ? undefined : "No te escuché. Toca la esfera y habla cerca de la tablet.");
    }
    voiceTurn(r.frames);
  }

  // Turno completo en una sola petición: audio -> texto -> respuesta
  async function voiceTurn(frames) {
    if (Date.now() - lastTurnAt > HISTORY_RESET_MS) history = [];
    setState("thinking");
    caption("…", "Pensando…", "hint");
    try {
      const j = await N.api("/api/voice", { method: "POST", body: { audio: MIC().toWavBase64(frames), history, cooking: cooking() } });
      if (!j.text) {
        caption("", "No te entendí. Repítelo, por favor.", "hint");
        return listen(FOLLOW_NO_SPEECH_MS);
      }
      if (j.end || (GOODBYE.test(j.text) && j.text.length < 40)) endAfterReply = true;
      await handleReply(j.text, j);
    } catch (e) {
      caption(undefined, failText(e, "No pude responder ahora. Revisa la conexión."), "error");
      endConversation();
    }
  }

  // Mensaje claro según el error: cuota diaria gratuita agotada o fallo de red
  function failText(e, fallback) {
    if (e && e.message === "quota") {
      const reset = new Date(); reset.setUTCHours(24, 0, 0, 0); // la cuota se renueva a las 00:00 UTC
      const at = reset.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
      return "Hoy ya usé toda mi cuota gratuita de inteligencia artificial. Vuelvo a estar disponible a las " + at + ".";
    }
    return fallback;
  }

  // Pregunta escrita o ya transcrita
  async function ask(text) {
    if (Date.now() - lastTurnAt > HISTORY_RESET_MS) history = [];
    caption(text, "Pensando…", "hint");
    setState("thinking");
    try {
      const j = await N.api("/api/assistant", { method: "POST", body: { text, history, cooking: cooking() } });
      await handleReply(text, j);
    } catch (e) {
      caption(undefined, failText(e, "No pude responder ahora. Inténtalo de nuevo en un momento."), "error");
      endConversation();
    }
  }

  // Modo cocina abierto: el servidor entiende "siguiente", "repite"… sin gastar IA
  const cooking = () => !!(window.NexusCook && window.NexusCook.active());

  async function handleReply(text, j) {
    const ck = j.changed && j.changed.cook;
    if (typeof ck === "string" && window.NexusCook) { // orden de cocina: la receta dice el paso
      endConversation();
      window.NexusCook.command(ck);
      return;
    }
    if (ck && ck.start && window.NexusCook) window.NexusCook.start(ck.start, { silent: true });
    if (j.changed && j.changed.tv && window.NexusTV) window.NexusTV.fromVoice(j.changed.tv);
    history.push({ role: "user", text }, { role: "assistant", text: j.reply });
    history = history.slice(-8);
    lastTurnAt = Date.now();
    caption(text, j.reply);
    const ch = j.changed || {};
    if (ch.agenda) N.refreshAgenda();
    if (ch.alarms) N.refreshAlarms();
    if (ch.home && window.NexusHome) window.NexusHome.refresh();
    await speak(j.reply);
    if (ch.open && window.NexusHome) { // abrir Spotify/YouTube termina la conversación
      endConversation();
      window.NexusHome.openApp(ch.open.app, ch.open.query);
      return;
    }
    if (talking && !endAfterReply) {
      listen(FOLLOW_NO_SPEECH_MS);
    } else {
      const typed = !talking;
      endConversation();
      if (typed) hideCaptionLater(CAPTION_HIDE_MS);
    }
  }

  // ---------- voz: natural (Aura-2) por frases, con la de la tablet como reserva ----------
  // Se pide el audio de todas las frases a la vez y se empieza a hablar en cuanto
  // llega la primera: la primera frase corta tarda mucho menos que la respuesta entera.
  const LONG_TEXT = 260;
  let speakToken = 0;
  let speakDone = null;

  function sentences(text) {
    const parts = text.match(/[^.!?¡¿]+[.!?]+|[^.!?]+$/g) || [text];
    const out = [];
    for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
      if (out.length && out[out.length - 1].length < 25) out[out.length - 1] += " " + p;
      else out.push(p);
    }
    return out;
  }

  function ttsFetch(text) {
    return fetch("/api/speak", {
      method: "POST",
      headers: { Authorization: "Bearer " + N.token(), "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
  }

  const SND = () => window.NexusSound;
  function playBlob(blob, token) {
    if (SND() && SND().native()) { // app Android: reproductor nativo (la salida de la página falla)
      if (token !== speakToken) return Promise.resolve();
      return SND().playBlob(blob);
    }
    return new Promise((resolve) => {
      if (token !== speakToken) return resolve();
      const url = URL.createObjectURL(blob);
      speakDone = () => { URL.revokeObjectURL(url); resolve(); };
      player.onended = player.onerror = () => speakDone && speakDone();
      player.src = url;
      player.play().catch(() => speakDone && speakDone());
    });
  }

  // Reproduce el audio mientras llega (el servidor empieza a enviarlo en ~0,4 s)
  const CAN_STREAM = window.MediaSource && MediaSource.isTypeSupported("audio/mpeg");

  async function playStreaming(text, token) {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { Authorization: "Bearer " + N.token(), "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) return false;
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    return new Promise((resolve) => {
      let finished = false;
      const end = (ok) => { if (finished) return; finished = true; URL.revokeObjectURL(url); resolve(ok); };
      speakDone = () => { res.body.cancel().catch(() => {}); end(true); };
      player.onended = () => end(true);
      player.onerror = () => end(false);
      ms.addEventListener("sourceopen", async () => {
        try {
          const sb = ms.addSourceBuffer("audio/mpeg");
          const reader = res.body.getReader();
          let started = false;
          for (;;) {
            const { done, value } = await reader.read();
            if (token !== speakToken) return end(true);
            if (done) break;
            if (sb.updating) await new Promise((r) => sb.addEventListener("updateend", r, { once: true }));
            sb.appendBuffer(value);
            await new Promise((r) => sb.addEventListener("updateend", r, { once: true }));
            if (!started) { started = true; player.play().catch(() => end(false)); }
          }
          if (ms.readyState === "open") ms.endOfStream();
          if (!started) end(false);
        } catch { end(false); }
      }, { once: true });
      player.src = url;
    });
  }

  async function speak(text) {
    const token = ++speakToken;
    setState("speaking");
    wake("pause"); // que NEXUS no se escuche a sí mismo
    try {
      // Textos largos (resumen del día…) con la voz de la tablet: la voz natural
      // es lo que más cuota gasta y así queda para las respuestas cortas.
      if (text.length > LONG_TEXT) {
        const ok = await deviceSpeak(text, token);
        if (ok !== false || token !== speakToken) return;
        if (window.NexusLog) window.NexusLog({ type: "voz", msg: "voz del sistema no disponible: se usa la natural" });
      }
      const parts = sentences(text);
      // Las frases siguientes se piden ya, mientras suena la primera
      const rest = parts.slice(1).map(ttsFetch);
      const streamOk = CAN_STREAM && !(SND() && SND().native());
      let ok = streamOk ? await playStreaming(parts[0], token).catch(() => false) : false;
      if (token !== speakToken) return;
      if (!ok) {
        const blob = await ttsFetch(parts[0]);
        if (token !== speakToken) return;
        if (!blob) { await deviceSpeak(text, token); return; } // cuota o red: voz del sistema
        await playBlob(blob, token);
      }
      for (let i = 0; i < rest.length; i++) {
        const blob = await rest[i];
        if (token !== speakToken) return;
        if (!blob) { await deviceSpeak(parts.slice(i + 1).join(" "), token); break; }
        await playBlob(blob, token);
      }
    } finally {
      speakDone = null;
      if (!talking) wake("resume");
    }
  }

  let deviceVoice = null;
  function pickDeviceVoice() {
    if (!("speechSynthesis" in window)) return null;
    const lang = (v) => (v.lang || "").replace("_", "-");
    const voices = speechSynthesis.getVoices();
    // Español de Latinoamérica antes que el de España
    const pref = ["es-CL", "es-US", "es-419", "es-MX", "es-AR", "es-CO"];
    deviceVoice = pref.map((l) => voices.find((v) => lang(v) === l)).find(Boolean) || voices.find((v) => lang(v).startsWith("es") && lang(v) !== "es-ES") || voices.find((v) => lang(v).startsWith("es")) || null;
    return deviceVoice;
  }

  // Devuelve false si no hay voz del sistema disponible (quien llama usa otra voz)
  function deviceSpeak(text, token) {
    // App Android: voz del sistema (gratis). speechSynthesis no existe en WebView.
    if (SND() && SND().native()) {
      if (token !== speakToken) return Promise.resolve();
      if (!SND().hasDeviceVoice()) return Promise.resolve(false);
      return SND().deviceSpeak(text);
    }
    if (!("speechSynthesis" in window)) return Promise.resolve(false);
    return new Promise((resolve) => {
      if (token !== speakToken) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "es-CL";
      if (deviceVoice || pickDeviceVoice()) { u.voice = deviceVoice; u.lang = deviceVoice.lang.replace("_", "-"); }
      speakDone = resolve;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  function stopSpeaking() {
    speakToken++;
    player.pause();
    if (SND()) SND().stop();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (speakDone) { const d = speakDone; speakDone = null; d(); }
  }

  // ---------- controles ----------
  function onOrb() {
    if (state === "idle" && !talking) return startConversation();
    if (state === "listening") return endConversation();      // tocar mientras escucha: terminar
    if (state === "speaking") stopSpeaking();                  // interrumpir: vuelve a escuchar
  }

  function armTypeTimer() {
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => {
      const input = $("capInput");
      if ($("capForm").hidden || input.value.trim()) return;
      input.blur();
      $("capForm").hidden = true;
      if (state === "idle" && !talking) document.body.classList.remove("talking");
    }, TYPE_IDLE_MS);
  }

  function openKeyboard() {
    if (talking) endConversation();
    if (!$("capForm").hidden) {
      $("capForm").hidden = true;
      document.body.classList.remove("talking");
      return;
    }
    showCaption();
    $("capUser").textContent = "";
    caption(undefined, "Escribe tu pregunta.", "hint");
    $("capForm").hidden = false;
    $("capInput").focus();
    armTypeTimer();
  }

  function init(ctx) {
    N = ctx;
    setState("idle");
    $("assistant").addEventListener("click", onOrb);
    $("keyboardBtn").innerHTML = N.ICON.keyboard;
    $("keyboardBtn").addEventListener("click", openKeyboard);
    $("capInput").addEventListener("input", armTypeTimer);
    $("capForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("capInput");
      const text = input.value.trim();
      if (!text || state !== "idle") return;
      input.value = "";
      input.blur();
      $("capForm").hidden = true;
      await ask(text);
    });
    if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", pickDeviceVoice);
  }

  // Lee un texto en voz alta mostrándolo en la transcripción (resumen de buenos días)
  async function say(text) {
    if (talking || !text) return;
    caption("", text);
    await speak(text);
    setState("idle");
    hideCaptionLater(CAPTION_HIDE_MS);
  }

  window.NexusVoice = { init, ask, start: startConversation, startWith, say };
})();
