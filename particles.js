/* ============================================================
   Background particle field
   Slow drifting motes, loosely inspired by the Signiflyers from
   KnightLight: small lights that hang in the dark and drift.

   Notes for future edits:
   - The canvas is created here, so a page only needs the script tag.
   - It sits at z-index -1 and is pointer-events:none, so it can never
     intercept a click. The affordance rules in style.css still hold.
   - Honors prefers-reduced-motion: renders one static frame, no loop.
   - Pauses entirely when the tab is hidden.
   - Colors are read from the CSS tokens, so re-theming :root in
     style.css re-themes the particles too.
   ============================================================ */
(function () {
  "use strict";

  var canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.id = "fx-canvas";
  var ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  document.body.appendChild(canvas);

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var particles = [];
  var w = 0, h = 0, dpr = 1;
  var rafId = null;
  var lastTime = 0;
  var pointerX = 0, pointerY = 0;   // normalized -0.5..0.5
  var driftX = 0, driftY = 0;       // eased pointer parallax
  var sprites = {};

  /* ---------- colors ---------- */
  function token(name, fallback) {
    var v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  }

  function buildSprite(color) {
    // Pre-render one soft dot per color. Much cheaper than shadowBlur
    // or a gradient per particle per frame.
    var size = 64;
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, "transparent");
    g.globalAlpha = 1;
    g.fillStyle = grad;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  function buildPalette() {
    var accent = token("--accent", "#a78bfa");
    var warm = token("--warm", "#f0b352");
    var cool = token("--cool", "#6bc5e0");
    sprites = {
      accent: buildSprite(accent),
      warm: buildSprite(warm),
      cool: buildSprite(cool)
    };
    // Weighted so the field reads violet first, with warm and cool as accents.
    return ["accent", "accent", "accent", "accent", "accent", "warm", "warm", "cool"];
  }

  var palette = buildPalette();

  /* ---------- particles ---------- */
  function targetCount() {
    var area = w * h;
    // Roughly one mote per 26k px, capped so large monitors stay cheap.
    return Math.max(18, Math.min(64, Math.round(area / 26000)));
  }

  function makeParticle(seeded) {
    return {
      x: Math.random() * w,
      y: seeded ? Math.random() * h : h + Math.random() * 60,
      r: 1.1 + Math.random() * 2.4,
      // Slow upward drift with a slight horizontal bias.
      vy: -(2 + Math.random() * 7),
      vx: (Math.random() - 0.5) * 3,
      depth: 0.35 + Math.random() * 0.65,
      baseAlpha: 0.18 + Math.random() * 0.4,
      phase: Math.random() * Math.PI * 2,
      swayAmp: 4 + Math.random() * 14,
      swaySpeed: 0.12 + Math.random() * 0.3,
      twinkle: 0.25 + Math.random() * 0.5,
      color: palette[(Math.random() * palette.length) | 0]
    };
  }

  function seed() {
    particles.length = 0;
    var n = targetCount();
    for (var i = 0; i < n; i++) particles.push(makeParticle(true));
  }

  /* ---------- sizing ---------- */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    if (reduceMotion.matches) drawStatic();
  }

  /* ---------- drawing ---------- */
  function drawParticle(p, alpha) {
    var sprite = sprites[p.color];
    if (!sprite) return;
    var d = p.r * 6;
    var sway = Math.sin(p.phase) * p.swayAmp;
    var px = p.x + sway + driftX * p.depth * 26;
    var py = p.y + driftY * p.depth * 26;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(sprite, px - d / 2, py - d / 2, d, d);
  }

  function drawStatic() {
    ctx.clearRect(0, 0, w, h);
    for (var i = 0; i < particles.length; i++) {
      drawParticle(particles[i], particles[i].baseAlpha * 0.75);
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    rafId = window.requestAnimationFrame(frame);

    var dt = (now - lastTime) / 1000;
    lastTime = now;
    // Guard against huge jumps after a background tab or a stall.
    if (!(dt > 0) || dt > 0.1) dt = 0.016;

    // Ease the pointer parallax so it never snaps.
    driftX += (pointerX - driftX) * Math.min(1, dt * 2.2);
    driftY += (pointerY - driftY) * Math.min(1, dt * 2.2);

    ctx.clearRect(0, 0, w, h);

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.y += p.vy * p.depth * dt;
      p.x += p.vx * p.depth * dt;
      p.phase += p.swaySpeed * dt;

      // Wrap around the edges rather than respawning, so density holds.
      if (p.y < -40) {
        p.y = h + 20;
        p.x = Math.random() * w;
      }
      if (p.x < -40) p.x = w + 20;
      else if (p.x > w + 40) p.x = -20;

      var alpha = p.baseAlpha * (1 - p.twinkle * 0.5 + Math.sin(p.phase * 1.7) * p.twinkle * 0.5);
      drawParticle(p, alpha);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- lifecycle ---------- */
  function start() {
    if (rafId !== null || reduceMotion.matches) return;
    lastTime = performance.now();
    rafId = window.requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId === null) return;
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* ---------- events ---------- */
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 150);
  }, { passive: true });

  window.addEventListener("pointermove", function (e) {
    pointerX = e.clientX / window.innerWidth - 0.5;
    pointerY = e.clientY / window.innerHeight - 0.5;
  }, { passive: true });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else start();
  });

  function onMotionPrefChange() {
    if (reduceMotion.matches) {
      stop();
      drawStatic();
    } else {
      start();
    }
  }
  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener("change", onMotionPrefChange);
  } else if (reduceMotion.addListener) {
    reduceMotion.addListener(onMotionPrefChange);
  }

  resize();
  if (reduceMotion.matches) drawStatic();
  else start();
})();
