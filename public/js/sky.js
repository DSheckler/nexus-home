// NEXUS Home - cielo animado detrás del cristal.
// Mañana, mediodía y atardecer: sol con rayos, nubes, bruma y pájaros. Noche: estrellas que
// titilan y alguna estrella fugaz. Lluvia y nieve según el tiempo real. Con aviso de auroras
// (NOAA Kp alto y cielo despejado), cortinas de aurora boreal detrás de las estrellas.
// Pensado para la tablet: lienzo de fondo a media resolución (va borroso tras el cristal),
// 30 fotogramas por segundo y en pausa con el modo noche, la pantalla oculta o una hoja abierta.
(function () {
  "use strict";
  const W = 1280, H = 800; // coordenadas de dibujo; los lienzos se escalan a la pantalla
  const back = document.getElementById("fx"), front = document.getElementById("fx2");
  if (!back || !front || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cx = back.getContext("2d"), cx2 = front.getContext("2d");
  const rnd = (a, b) => a + Math.random() * (b - a);
  let lite = false; // si la tablet va justa, menos partículas y sin capa delantera

  function size() {
    const qb = 0.5, qf = lite ? 0 : 0.75;
    back.width = Math.round(W * qb); back.height = Math.round(H * qb);
    cx.setTransform(qb, 0, 0, qb, 0, 0);
    front.width = Math.max(1, Math.round(W * qf)); front.height = Math.max(1, Math.round(H * qf));
    if (qf) cx2.setTransform(qf, 0, 0, qf, 0, 0);
    front.style.display = qf ? "" : "none";
  }

  // ---------- cielos de día ----------
  const SKY = {
    morning: { sun: [1110, 40], glow: "255,214,160", ray: .16, cloud: "255,244,236", ca: .75, clouds: 6, mist: "255,255,255", birds: false, early: 0 },
    day: { sun: [880, -60], glow: "255,246,200", ray: .2, cloud: "255,255,255", ca: .9, clouds: 7, mist: null, birds: true, early: 0 },
    dusk: { sun: [1040, 720], glow: "255,150,105", ray: .22, cloud: "255,182,196", ca: .7, clouds: 6, mist: "255,205,190", birds: true, early: 22 },
  };
  let mode = "day", cloudy = 0;
  let parts = [], fparts = [], clouds = [], early = [], splashes = [];
  let flock = null, nextFlock = 0, shoot = null, nextShoot = 0;

  function cloudSprite(rgb, a) {
    // Cada nube se pinta una vez en un lienzo aparte; luego solo se copia
    const w = Math.round(rnd(260, 460)), h = Math.round(w * .42), c = document.createElement("canvas");
    c.width = Math.round(w / 2); c.height = Math.round(h / 2);
    const g = c.getContext("2d"); g.scale(.5, .5);
    for (let i = 0; i < 9; i++) {
      const r = rnd(h * .28, h * .5), x = rnd(r, w - r), y = rnd(h * .45, h - r * .8);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(.6, `rgba(${rgb},${a * .55})`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.28); g.fill();
    }
    return { img: c, w, h };
  }

  function seed() {
    const k = lite ? .5 : 1;
    const n = Math.round(({ rain: 200, snow: 130, stars: 150 }[mode] || 0) * k);
    parts = Array.from({ length: n }, () => ({ x: rnd(0, W), y: rnd(0, H), z: rnd(.4, 1), p: rnd(0, 6.28), s: rnd(.6, 2.2) }));
    const f = lite ? 0 : ({ rain: 50, snow: 22 }[mode] || 0);
    fparts = Array.from({ length: f }, () => ({ x: rnd(0, W), y: rnd(0, H), z: rnd(.6, 1), p: rnd(0, 6.28) }));
    splashes = []; shoot = null; nextShoot = performance.now() + 3000;
    clouds = []; early = []; flock = null; nextFlock = performance.now() + 4000;
    const s = SKY[mode];
    if (!s) return;
    const nc = Math.round((s.clouds + cloudy * 4) * (lite ? .6 : 1));
    for (let i = 0; i < nc; i++) {
      const z = rnd(.45, 1);
      clouds.push({ ...cloudSprite(s.cloud, Math.min(1, s.ca * (.55 + .45 * z) + cloudy * .1)), x: rnd(-300, W), y: rnd(-40, 520), z, v: .2 + .6 * z });
    }
    clouds.sort((a, b) => a.z - b.z);
    for (let i = 0; i < s.early; i++) early.push({ x: rnd(0, 800), y: rnd(0, 260), p: rnd(0, 6.28), s: rnd(.7, 1.8) });
  }

  function drawDay(t) {
    const s = SKY[mode], [sx, sy] = s.sun, dim = 1 - cloudy * .6;
    const pulse = 1 + .06 * Math.sin(t / 2200);
    const glow = cx.createRadialGradient(sx, sy, 0, sx, sy, 520 * pulse);
    glow.addColorStop(0, `rgba(${s.glow},${.85 * dim})`); glow.addColorStop(.25, `rgba(${s.glow},${.4 * dim})`); glow.addColorStop(1, `rgba(${s.glow},0)`);
    cx.fillStyle = glow; cx.fillRect(0, 0, W, H);
    // Rayos de luz que giran muy despacio
    cx.save(); cx.translate(sx, sy); cx.rotate(t / 26000);
    const rg = cx.createRadialGradient(0, 0, 40, 0, 0, 900);
    rg.addColorStop(0, `rgba(${s.glow},${s.ray * dim})`); rg.addColorStop(1, `rgba(${s.glow},0)`);
    cx.fillStyle = rg;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.283, w = .05 + .04 * Math.sin(t / 3000 + i * 1.7);
      cx.beginPath(); cx.moveTo(0, 0); cx.arc(0, 0, 900, a - w, a + w); cx.closePath(); cx.fill();
    }
    cx.restore();
    for (const e of early) {
      cx.fillStyle = `rgba(255,255,255,${.15 + .45 * (.5 + .5 * Math.sin(t / (600 * e.s) + e.p))})`;
      cx.beginPath(); cx.arc(e.x, e.y, 1.2, 0, 6.28); cx.fill();
    }
    // Nubes: las cercanas pasan más rápido
    for (const c of clouds) {
      c.x += c.v;
      if (c.x > W + 20) { c.x = -c.w - rnd(0, 200); c.y = rnd(-40, 520); }
      cx.drawImage(c.img, c.x, c.y + Math.sin(t / 5000 + c.z * 9) * 6, c.w, c.h);
    }
    if (s.mist) {
      for (let i = 0; i < 2; i++) {
        const off = (t / (90 + i * 50)) % W, y = 640 + i * 70;
        const m = cx.createLinearGradient(0, y - 90, 0, y + 90);
        m.addColorStop(0, `rgba(${s.mist},0)`); m.addColorStop(.5, `rgba(${s.mist},.32)`); m.addColorStop(1, `rgba(${s.mist},0)`);
        cx.fillStyle = m;
        for (const dx of [-W, 0]) {
          cx.beginPath(); cx.moveTo(off + dx, y + 90);
          for (let x = 0; x <= W; x += 80) cx.lineTo(off + dx + x, y - 40 + Math.sin(x / 190 + i * 2) * 34);
          cx.lineTo(off + dx + W, y + 90); cx.closePath(); cx.fill();
        }
      }
    }
    if (s.birds) {
      if (!flock && t > nextFlock) {
        const n = 3 + Math.floor(rnd(0, 4));
        flock = { t0: t, d: rnd(14000, 20000), y0: rnd(60, 300), b: Array.from({ length: n }, (_, i) => ({ dx: -i * rnd(26, 40), dy: (i % 2 ? 1 : -1) * i * rnd(8, 14), p: rnd(0, 6.28), s: rnd(.8, 1.1) })) };
      }
      if (flock) {
        const k = (t - flock.t0) / flock.d;
        if (k >= 1) { flock = null; nextFlock = t + rnd(12000, 30000); }
        else {
          const bx = -120 + k * 1520, by = flock.y0 + Math.sin(k * 6) * 18;
          cx.strokeStyle = mode === "dusk" ? "rgba(70,40,70,.6)" : "rgba(60,75,100,.5)"; cx.lineWidth = 2.2; cx.lineCap = "round";
          for (const b of flock.b) {
            const x = bx + b.dx, y = by + b.dy, f = Math.sin(t / 140 + b.p) * 5 * b.s, w = 9 * b.s;
            cx.beginPath(); cx.moveTo(x - w, y - f); cx.quadraticCurveTo(x - w / 2, y - 4 - f / 2, x, y); cx.quadraticCurveTo(x + w / 2, y - 4 - f / 2, x + w, y - f); cx.stroke();
          }
        }
      }
    }
  }

  // ---------- aurora boreal ----------
  // Tres cortinas verdes con borde rosado que ondulan despacio, con rayos verticales.
  // "Posible" = más tenue; "alta" = más intensa. Se pinta en el lienzo de fondo (detrás del cristal).
  let aurora = 0; // 0 = no, 0.6 = posible, 1 = alta
  const BANDS = [
    { y: 250, h: 210, amp: 46, f: 1 / 260, sp: 1 / 9000, ph: 0, hue: [92, 255, 170] },
    { y: 200, h: 170, amp: 34, f: 1 / 330, sp: 1 / 12000, ph: 2.1, hue: [80, 240, 200] },
    { y: 300, h: 140, amp: 28, f: 1 / 210, sp: 1 / 7000, ph: 4.2, hue: [140, 255, 150] },
  ];
  function drawAurora(t) {
    const k = aurora;
    cx.save();
    cx.globalCompositeOperation = "lighter";
    for (const b of BANDS) {
      const [r, g, bl] = b.hue, breathe = .75 + .25 * Math.sin(t / 4000 + b.ph);
      const base = (x) => b.y + Math.sin(x * b.f + t * b.sp + b.ph) * b.amp + Math.sin(x * b.f * 2.7 + t * b.sp * 1.8) * b.amp * .35;
      // Cortina: más brillante abajo (verde) y difuminada hacia arriba (rosado tenue)
      for (let x = -20; x < W + 20; x += 16) {
        const y0 = base(x), top = y0 - b.h * (.75 + .25 * Math.sin(x / 90 + t / 3000 + b.ph));
        const ray = .55 + .45 * Math.sin(x / 23 + t / 1700 + b.ph * 3); // rayos verticales que se mueven
        const a = .26 * k * breathe * ray;
        const gr = cx.createLinearGradient(0, y0 + 14, 0, top);
        gr.addColorStop(0, `rgba(${r},${g},${bl},0)`);
        gr.addColorStop(.08, `rgba(${r},${g},${bl},${a * 1.4})`);
        gr.addColorStop(.45, `rgba(${r},${g},${bl},${a * .55})`);
        gr.addColorStop(.8, `rgba(200,110,220,${a * .25})`);
        gr.addColorStop(1, "rgba(200,110,220,0)");
        cx.fillStyle = gr;
        cx.fillRect(x, top, 17, y0 + 14 - top);
      }
    }
    // Resplandor verde sobre el horizonte
    const hz = cx.createLinearGradient(0, 620, 0, 240);
    hz.addColorStop(0, "rgba(70,220,150,0)"); hz.addColorStop(.35, `rgba(70,220,150,${.14 * k})`); hz.addColorStop(1, "rgba(70,220,150,0)");
    cx.fillStyle = hz; cx.fillRect(0, 240, W, 380);
    cx.restore();
  }

  function drawParts(t) {
    for (const q of parts) {
      if (mode === "rain") {
        q.y += 22 * q.z * 2; q.x -= 3.2 * q.z * 2; // ×2: 30 fotogramas por segundo
        if (q.y > H) { if (q.z > .75 && splashes.length < 30) splashes.push({ x: q.x, y: rnd(700, 790), r: 1, a: .5 }); q.y = rnd(-60, -10); q.x = rnd(0, W + 80); }
        cx.strokeStyle = `rgba(70,92,125,${.28 + .3 * q.z})`; cx.lineWidth = 1.6 + 2 * q.z;
        cx.beginPath(); cx.moveTo(q.x, q.y); cx.lineTo(q.x + 5 * q.z, q.y - 34 * q.z); cx.stroke();
      } else if (mode === "snow") {
        q.y += 2.2 * q.z; q.x += Math.sin(t / 1400 + q.p) * 1.2;
        if (q.y > H + 10) { q.y = -10; q.x = rnd(0, W); }
        const rr = 1.6 + 3 * q.z;
        cx.fillStyle = "rgba(110,130,165,.28)"; // halo gris: el copo se ve también sobre fondo claro
        cx.beginPath(); cx.arc(q.x, q.y + .6, rr + 1.2, 0, 6.28); cx.fill();
        cx.fillStyle = `rgba(255,255,255,${.75 + .25 * q.z})`;
        cx.beginPath(); cx.arc(q.x, q.y, rr, 0, 6.28); cx.fill();
      } else if (mode === "stars") {
        const tw = .5 + .5 * Math.sin(t / (500 * q.s) + q.p), a = (.18 + .82 * tw * tw) * q.z, y = q.y * .72;
        cx.fillStyle = `rgba(255,255,255,${a})`;
        cx.beginPath(); cx.arc(q.x, y, 1 + 1.4 * q.z, 0, 6.28); cx.fill();
        if (q.z > .88 && tw > .7) {
          const L = 8 * tw * q.z;
          cx.strokeStyle = `rgba(220,230,255,${a * .8})`; cx.lineWidth = 1.6;
          cx.beginPath(); cx.moveTo(q.x - L, y); cx.lineTo(q.x + L, y); cx.moveTo(q.x, y - L); cx.lineTo(q.x, y + L); cx.stroke();
        }
      }
    }
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i]; s.r += 2.8; s.a -= .06;
      if (s.a <= 0) { splashes.splice(i, 1); continue; }
      cx.strokeStyle = `rgba(70,92,125,${s.a})`; cx.lineWidth = 1.6;
      cx.beginPath(); cx.ellipse(s.x, s.y, s.r * 2, s.r * .6, 0, 0, 6.28); cx.stroke();
    }
  }

  function drawFront(t) {
    for (const q of fparts) {
      if (mode === "rain") {
        q.y += 60 * q.z; q.x -= 8.8 * q.z;
        if (q.y > H + 40) { q.y = rnd(-80, -20); q.x = rnd(0, W + 100); }
        cx2.strokeStyle = `rgba(255,255,255,${.22 * q.z})`; cx2.lineWidth = 1.4 * q.z;
        cx2.beginPath(); cx2.moveTo(q.x, q.y); cx2.lineTo(q.x + 7 * q.z, q.y - 48 * q.z); cx2.stroke();
      } else if (mode === "snow") {
        q.y += 3.2 * q.z; q.x += Math.sin(t / 1200 + q.p) * 1.8;
        if (q.y > H + 20) { q.y = -16; q.x = rnd(0, W); }
        const rr = 2.5 + 3 * q.z;
        cx2.fillStyle = `rgba(110,130,165,${.22 * q.z})`;
        cx2.beginPath(); cx2.arc(q.x, q.y + .8, rr + 1.4, 0, 6.28); cx2.fill();
        cx2.fillStyle = `rgba(255,255,255,${.7 * q.z})`;
        cx2.beginPath(); cx2.arc(q.x, q.y, rr, 0, 6.28); cx2.fill();
      }
    }
    if (mode !== "stars") return;
    if (!shoot && t > nextShoot) shoot = { x: rnd(200, 1100), y: rnd(20, 220), a: rnd(2.6, 2.9), v: rnd(15, 20), t0: t, d: rnd(900, 1300) };
    if (!shoot) return;
    const k = (t - shoot.t0) / shoot.d;
    if (k >= 1) { shoot = null; nextShoot = t + rnd(5000, 12000); return; }
    const dist = k * shoot.v * 60, hx = shoot.x + Math.cos(shoot.a) * dist, hy = shoot.y + Math.sin(shoot.a) * dist;
    const tail = 170 * Math.sin(Math.PI * k) + 20, tx = hx - Math.cos(shoot.a) * tail, ty = hy - Math.sin(shoot.a) * tail;
    const al = Math.sin(Math.PI * k), g = cx2.createLinearGradient(hx, hy, tx, ty);
    g.addColorStop(0, `rgba(255,255,255,${.95 * al})`); g.addColorStop(.3, `rgba(190,210,255,${.45 * al})`); g.addColorStop(1, "rgba(190,210,255,0)");
    cx2.strokeStyle = g; cx2.lineWidth = 2.2; cx2.lineCap = "round";
    cx2.beginPath(); cx2.moveTo(hx, hy); cx2.lineTo(tx, ty); cx2.stroke();
    cx2.fillStyle = `rgba(255,255,255,${al})`; cx2.beginPath(); cx2.arc(hx, hy, 2.2, 0, 6.28); cx2.fill();
  }

  // ---------- bucle ----------
  const STEP = 1000 / 30;
  let last = 0, slow = 0, samples = 0, running = false;
  function paused() {
    return document.hidden || document.body.classList.contains("night") || !!document.querySelector(".sheet-wrap, .ring, .cook");
  }
  function frame(t) {
    requestAnimationFrame(frame);
    if (t - last < STEP - 2) return;
    last = t;
    if (paused()) { if (running) { cx.clearRect(0, 0, W, H); cx2.clearRect(0, 0, W, H); running = false; } return; }
    running = true;
    const t0 = performance.now();
    cx.clearRect(0, 0, W, H);
    if (!lite) cx2.clearRect(0, 0, W, H);
    if (SKY[mode]) drawDay(t);
    if (aurora && mode === "stars") drawAurora(t);
    drawParts(t);
    if (!lite) drawFront(t);
    // Si dibujar tarda demasiado en esta tablet, se pasa a la versión ligera
    if (!lite) {
      samples++; if (performance.now() - t0 > 14) slow++;
      if (samples >= 150) { if (slow > 45) { lite = true; size(); seed(); } samples = 0; slow = 0; }
    }
  }

  window.NexusSky = {
    set(m, opts) {
      const c = (opts && opts.cloudy) || 0;
      if (m === mode && c === cloudy) return;
      mode = m; cloudy = c; seed();
    },
    // level: 0 (sin aurora), 0.6 (posible) o 1 (alta)
    setAurora(level) { aurora = Math.max(0, Math.min(1, Number(level) || 0)); },
    state: () => ({ mode, cloudy, lite, aurora }),
  };
  size();
  const pre = window.NEXUS_SKY;
  if (pre) { mode = pre.fx; cloudy = pre.cloudy || 0; }
  seed();
  // ?aurora=1 para previsualizar
  const qa = new URLSearchParams(location.search).get("aurora");
  if (qa) aurora = Number(qa) || 1;
  requestAnimationFrame(frame);
})();
