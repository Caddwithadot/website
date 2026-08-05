/* Pencil sketching on the graph paper.

   Marks are generated procedurally and drawn stroke by stroke, so the leading
   edge reads as a pencil tip moving. Each mark then holds for a while and
   fades out, so the page settles at a roughly constant density instead of
   filling up.

   Fading is done by redrawing every live mark each frame at its own opacity,
   not by compositing a translucent rectangle over the canvas. The composite
   trick fails here: canvas alpha is 8-bit, and multiplying a pixel at alpha 46
   by 0.9975 rounds straight back to 46, so faint marks never erase at all.

   Note on the brief: this is decorative animation and JavaScript, both of
   which the design brief argues against. It is here at the client's explicit
   request. It is isolated in this one file: delete the script tag and the
   canvas and nothing else changes.

   Accessibility and cost:
   - canvas is aria-hidden, pointer-events none, z-index -1
   - prefers-reduced-motion draws one static set and stops
   - pauses entirely when the tab is hidden
   - one path per mark per frame, so redraw cost is draw calls, not segments
*/
(function () {
  "use strict";

  var canvas = document.createElement("canvas");
  canvas.id = "sketch";
  canvas.setAttribute("aria-hidden", "true");
  var ctx = canvas.getContext("2d");
  if (!ctx) return;
  document.body.appendChild(canvas);

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- tuning ---------- */
  var WOBBLE   = 0.68;   // global hand-shake multiplier; lower is tidier
  var HOLD     = 10;     // seconds a finished mark stays at full strength
  var FADE     = 60;     // seconds it then takes to disappear
  var MAX_LIVE = 280;    // ceiling on marks alive anywhere on the sheet
  var CONCURRENT = 6;    // marks that can be mid-draw at the same time
  /* Marks spawn across a region this much larger than the window on each side,
     so the paper is already worked on before you pan or scroll onto it. It
     also means most marks are off-screen at any moment: at 0.6 the spawn area
     is about 4.8x the viewport, so only around a fifth are visible. The
     ceiling and the spawn rate are both sized against that, otherwise
     widening the area would just make the visible page quieter. */
  var SPAWN_MARGIN = 0.6;
  var CELL     = 40;
  var PENCIL   = "82,75,88";

  /* Camera. Marks live in world coordinates on a sheet much larger than the
     window; the camera decides which part of it you are looking at.
     Scrolling moves it at a fraction of page speed, so the paper reads as
     sitting behind the content, and the pointer nudges it a little further,
     like leaning over a desk. */
  /* 1.0 means the paper scrolls exactly with the page, so a mark stays beside
     whatever it was drawn next to. Anything less makes the marks slide against
     the content as you scroll, and because they are recognisable shapes rather
     than an abstract texture, that slip reads as a separate layer floating
     over the page instead of as the surface it is printed on. The pointer pan
     is what supplies the sense of a camera; it is small enough not to fight
     the attachment. */
  var SCROLL_P    = 1;     // paper travel per pixel of page scroll
  var MOUSE_RANGE = 14;    // furthest the pointer can push the camera, px
  var EASE        = 5;     // how quickly the pointer pan catches up

  var W = 0, H = 0, dpr = 1;
  var live = [];         // every mark currently on the page
  var raf = null, last = 0, spawnWait = 0;
  var camX = 0, camY = 0, panX = 0, panY = 0, mouseX = 0, mouseY = 0;
  var seedX = 0, seedY = 0;   // where the paper was last pre-populated
  var root = document.documentElement;

  function r(a, b) { return a + Math.random() * (b - a); }
  function ri(a, b) { return Math.floor(r(a, b + 1)); }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function chance(p) { return Math.random() < p; }

  /* Resample a straight run into a slightly bowed, jittered polyline. */
  function handLine(x1, y1, x2, y2, wob) {
    wob = (wob === undefined ? 1 : wob) * WOBBLE;
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.hypot(dx, dy) || 1;
    var steps = Math.max(2, Math.round(len / 16));
    var nx = -dy / len, ny = dx / len;
    var bow = r(-1.1, 1.1) * wob;
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var arc = Math.sin(t * Math.PI) * bow;
      var j = (i === 0 || i === steps) ? 0.4 : 0.95;
      pts.push([
        x1 + dx * t + nx * arc + r(-j, j) * wob,
        y1 + dy * t + ny * arc + r(-j, j) * wob
      ]);
    }
    var o = r(-2, 2.5) * WOBBLE;       // over or undershoot the endpoint
    pts[pts.length - 1][0] += (dx / len) * o;
    pts[pts.length - 1][1] += (dy / len) * o;
    return pts;
  }

  function arcPts(cx, cy, rx, ry, a0, a1, wob) {
    wob = (wob === undefined ? 1 : wob) * WOBBLE;
    var steps = Math.max(6, Math.round(Math.abs(a1 - a0) * 7));
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var a = a0 + (a1 - a0) * (i / steps);
      pts.push([cx + Math.cos(a) * rx + r(-1, 1) * wob, cy + Math.sin(a) * ry + r(-1, 1) * wob]);
    }
    return pts;
  }

  /* ---------- hand-drawn digits ---------- */
  var GLYPH = {
    0: [[[.5,0],[.16,.24],[.14,.74],[.5,1],[.86,.74],[.85,.24],[.5,0]]],
    1: [[[.22,.18],[.5,0],[.5,1]]],
    2: [[[.08,.22],[.5,0],[.86,.26],[.14,1],[.92,.98]]],
    3: [[[.1,.05],[.7,.04],[.36,.46]],[[.36,.46],[.82,.6],[.55,1],[.1,.88]]],
    4: [[[.72,0],[.08,.7],[.92,.7]],[[.66,.34],[.64,1]]],
    5: [[[.86,.03],[.2,.06],[.14,.46]],[[.14,.46],[.62,.4],[.82,.7],[.4,1],[.08,.9]]],
    6: [[[.82,.04],[.3,.3],[.14,.8],[.5,1],[.82,.74],[.5,.48],[.2,.64]]],
    7: [[[.08,.06],[.9,.04],[.4,1]]],
    8: [[[.5,.5],[.14,.28],[.5,.02],[.86,.28],[.5,.5],[.14,.76],[.5,1],[.86,.76],[.5,.5]]],
    9: [[[.76,.5],[.4,.56],[.18,.3],[.5,.04],[.8,.26],[.68,.76],[.38,1]]]
  };

  function digits(x, y, size, text) {
    var strokes = [], cx = x;
    var slant = r(-0.11, 0.11);
    for (var i = 0; i < text.length; i++) {
      var g = GLYPH[text[i]];
      if (!g) { cx += size * 0.5; continue; }
      var h = size * r(0.93, 1.08);
      var w = size * r(0.54, 0.63);
      for (var s = 0; s < g.length; s++) {
        var pts = [];
        for (var p = 0; p < g[s].length; p++) {
          pts.push([
            cx + g[s][p][0] * w + (1 - g[s][p][1]) * slant * h + r(-0.8, 0.8) * WOBBLE,
            y + g[s][p][1] * h + r(-0.8, 0.8) * WOBBLE
          ]);
        }
        strokes.push(pts);
      }
      cx += w + size * r(0.16, 0.26);
    }
    return strokes;
  }

  /* ---------- mark generators ---------- */
  var MARKS = [
    function tracedCell(x, y) {
      var w = CELL * ri(1, 4), h = CELL * ri(1, 3), s = [];
      var gap = function () { return chance(0.35) ? r(2, 8) : 0; };
      s.push(handLine(x + gap(), y, x + w + r(-3, 4), y));
      s.push(handLine(x + w, y + gap(), x + w, y + h + r(-3, 4)));
      s.push(handLine(x + w + r(-4, 3), y + h, x - r(0, 4), y + h));
      s.push(handLine(x, y + h + r(-4, 2), x, y - r(0, 3)));
      return s;
    },
    function scribbleOut(x, y) {
      var w = CELL * ri(1, 3), h = CELL * ri(1, 2), pts = [];
      var rows = Math.max(3, Math.round(h / r(8, 13)));
      for (var i = 0; i <= rows; i++) {
        var yy = y + (h * i) / rows + r(-2, 2);
        var l = i % 2 ? x + w + r(-5, 3) : x + r(-3, 5);
        var rg = i % 2 ? x + r(-3, 5) : x + w + r(-5, 3);
        pts.push([l, yy], [rg, yy + r(-1.5, 1.5)]);
      }
      return [pts];
    },
    function hatch(x, y) {
      var w = CELL * ri(1, 3), h = CELL * ri(1, 2), s = [];
      var step = r(8, 14), ang = pick([0.75, 0.95, -0.75, 2.35]);
      for (var o = -h; o < w + h; o += step) {
        var x1 = Math.max(x, Math.min(x + w, x + o));
        var x2 = Math.max(x, Math.min(x + w, x + o + h / Math.tan(ang)));
        if (Math.abs(x2 - x1) < 2) continue;
        s.push(handLine(x1, y + r(0, 4), x2, y + h - r(0, 4), 0.8));
      }
      if (chance(0.3)) {
        for (var o2 = -h; o2 < w + h; o2 += step * r(1.3, 2.1)) {
          s.push(handLine(Math.max(x, Math.min(x + w, x + o2)), y + h,
                          Math.max(x, Math.min(x + w, x + o2 + h)), y, 0.8));
        }
      }
      return s;
    },
    function arrow(x, y) {
      var len = r(45, 130), a = r(-0.85, 0.85) + (chance(0.5) ? 0 : Math.PI);
      var ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
      var s = [handLine(x, y, ex, ey, 1.15)], hl = r(11, 19);
      s.push(handLine(ex, ey, ex - Math.cos(a - r(0.42, 0.7)) * hl, ey - Math.sin(a - r(0.42, 0.7)) * hl));
      s.push(handLine(ex, ey, ex - Math.cos(a + r(0.42, 0.7)) * hl, ey - Math.sin(a + r(0.42, 0.7)) * hl));
      return s;
    },
    function route(x, y) {
      var pts = [[x, y]], n = ri(3, 5), cx = x, cy = y;
      for (var i = 0; i < n; i++) {
        cx += r(-65, 105); cy += r(-65, 85);
        var prev = pts[pts.length - 1];
        pts = pts.concat(handLine(prev[0], prev[1], cx, cy, 1.35).slice(1));
      }
      return [pts];
    },
    function cross(x, y) {
      var d = r(16, 38);
      return [handLine(x, y, x + d + r(-4, 4), y + d + r(-4, 4), 1.05),
              handLine(x + d + r(-3, 3), y + r(-2, 2), x + r(-3, 3), y + d + r(-2, 2), 1.05)];
    },
    function ring(x, y) {
      var rx = r(16, 36), ry = rx * r(0.65, 1.2), s = [], start = r(0, 6.2);
      s.push(arcPts(x, y, rx, ry, start, start + r(5.8, 7.2), 1.1));
      if (chance(0.25)) s.push(arcPts(x, y, rx * r(0.92, 1.12), ry * r(0.92, 1.12), start + r(0, 1), start + r(4, 6.8), 1.25));
      return s;
    },
    function bracket(x, y) {
      var h = r(30, 88), w = r(8, 15);
      return [[].concat(handLine(x + w, y, x, y + r(3, 8)), handLine(x, y + 8, x, y + h - 8), handLine(x, y + h - r(3, 8), x + w, y + h)),
              handLine(x, y + h / 2, x + r(20, 52), y + h / 2 + r(-3, 3), 1.05)];
    },
    function tick(x, y) {
      return [[].concat(handLine(x, y, x + r(8, 13), y + r(9, 14)), handLine(x + 10, y + 12, x + r(20, 32), y - r(14, 24)))];
    },
    function number(x, y) { return digits(x, y, r(13, 25), String(ri(1, 96))); },
    function dimension(x, y) {
      var len = CELL * ri(2, 5), s = [];
      s.push(handLine(x, y, x + len, y, 0.85));
      s.push(handLine(x, y - 6, x, y + 6, 0.7));
      s.push(handLine(x + len, y - 6, x + len, y + 6, 0.7));
      return s.concat(digits(x + len / 2 - 8, y - r(24, 31), r(12, 18), String(Math.round(len / CELL))));
    },
    function underline(x, y) {
      var len = r(50, 145), s = [handLine(x, y, x + len, y + r(-3, 3), 1.5)];
      if (chance(0.45)) s.push(handLine(x + r(-5, 6), y + r(4, 8), x + len + r(-8, 5), y + r(3, 9), 1.5));
      return s;
    },
    function tally(x, y) {
      var n = ri(3, 5), s = [], h = r(20, 32);
      for (var i = 0; i < n; i++) s.push(handLine(x + i * r(8, 11), y, x + i * r(8, 11) + r(-2, 2), y + h, 0.85));
      if (chance(0.6)) s.push(handLine(x - 4, y + h * 0.75, x + n * 9 + 4, y + h * 0.25, 1.0));
      return s;
    },
    function corner(x, y) {
      var d = r(14, 30);
      return [[].concat(handLine(x, y + d, x, y), handLine(x, y, x + d, y))];
    },
    function star(x, y) {
      var s = [], n = ri(3, 4), rad = r(9, 17);
      for (var i = 0; i < n; i++) {
        var a = r(0, 3.14);
        s.push(handLine(x - Math.cos(a) * rad, y - Math.sin(a) * rad, x + Math.cos(a) * rad, y + Math.sin(a) * rad, 0.8));
      }
      return s;
    },
    function dots(x, y) {
      var s = [], n = ri(3, 6), cx = x, cy = y;
      for (var i = 0; i < n; i++) {
        cx += r(15, 32); cy += r(-13, 13);
        s.push([[cx, cy], [cx + r(-1.5, 1.5), cy + r(-1.5, 1.5)]]);
      }
      return s;
    }
  ];

  /* ---------- build a mark and measure it, so drawing can be length-based ----------
     Placed in world coordinates near wherever the camera currently is, snapped
     to the cell grid so it lands on the printed ruling. As the camera moves,
     new marks appear in the newly exposed paper. */
  function spawn() {
    var mx = W * SPAWN_MARGIN, my = H * SPAWN_MARGIN;
    var x = Math.round((camX + r(-mx, W + mx)) / CELL) * CELL;
    var y = Math.round((camY + r(-my, H + my)) / CELL) * CELL;
    var strokes = pick(MARKS)(x, y).filter(function (s) { return s && s.length > 1; });
    if (!strokes.length) return null;

    var total = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < strokes.length; i++) {
      for (var p = 0; p < strokes[i].length; p++) {
        var pt = strokes[i][p];
        if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0];
        if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1];
        if (p < strokes[i].length - 1) {
          total += Math.hypot(strokes[i][p + 1][0] - pt[0], strokes[i][p + 1][1] - pt[1]);
        }
      }
    }
    return {
      strokes: strokes, total: total, drawn: 0,
      bx: x0, by: y0, bw: x1 - x0, bh: y1 - y0,
      speed: r(280, 620),
      width: r(0.9, 1.9),
      alpha: r(0.2, 0.42),
      age: 0, done: false
    };
  }

  /* One path per mark: cheap, and keeps the whole mark at one opacity. */
  function render(m, opacity) {
    ctx.strokeStyle = "rgba(" + PENCIL + "," + (m.alpha * opacity).toFixed(3) + ")";
    ctx.lineWidth = m.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();

    var budget = m.drawn;
    for (var i = 0; i < m.strokes.length; i++) {
      var st = m.strokes[i];
      if (budget <= 0) break;
      ctx.moveTo(st[0][0], st[0][1]);
      for (var p = 0; p < st.length - 1; p++) {
        var a = st[p], b = st[p + 1];
        var seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (seg <= budget) {
          ctx.lineTo(b[0], b[1]);
          budget -= seg;
        } else {
          var t = budget / (seg || 1);
          ctx.lineTo(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
          budget = 0;
          break;
        }
      }
    }
    ctx.stroke();
  }

  function opacityFor(m) {
    if (!m.done) return 1;
    if (m.age < HOLD) return 1;
    return Math.max(0, 1 - (m.age - HOLD) / FADE);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = (now - last) / 1000; last = now;
    if (!(dt > 0) || dt > 0.1) dt = 0.016;

    /* Scroll is applied straight through, pointer is eased. Running both
       through one ease made the paper visibly lag the page: scrolling is
       direct manipulation and should track exactly, whereas the pointer pan
       wants smoothing or it jitters with the mouse. */
    var k = Math.min(1, dt * EASE);
    panX += (mouseX * MOUSE_RANGE - panX) * k;
    panY += (mouseY * MOUSE_RANGE - panY) * k;
    camX = panX;
    camY = (window.pageYOffset || root.scrollTop || 0) * SCROLL_P + panY;

    /* The grid is periodic every 200px, so feeding it the camera wrapped to
       one tile is visually identical to the full offset and keeps the layer
       from ever travelling far. */
    root.style.setProperty("--cam-x", (-camX % 200).toFixed(2) + "px");
    root.style.setProperty("--cam-y", (-camY % 200).toFixed(2) + "px");

    // moved onto fresh paper? fill it in before it is looked at
    if (Math.abs(camY - seedY) > H * 0.55 || Math.abs(camX - seedX) > W * 0.55) {
      seedRegion(70);
      seedX = camX; seedY = camY;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(-camX, -camY);

    for (var i = live.length - 1; i >= 0; i--) {
      var m = live[i];
      if (!m.done) {
        m.drawn += m.speed * dt;
        if (m.drawn >= m.total) { m.drawn = m.total; m.done = true; }
      } else {
        m.age += dt;
      }
      var o = opacityFor(m);
      if (o <= 0) { live.splice(i, 1); continue; }
      // skip anything the camera has left behind
      if (m.bx + m.bw < camX - 80 || m.bx > camX + W + 80 ||
          m.by + m.bh < camY - 80 || m.by > camY + H + 80) continue;
      render(m, o);
    }

    /* Spawn rate and the ceiling interact: once MAX_LIVE is reached, new marks
       can only appear as old ones finish fading, so the ceiling divided by the
       total lifetime sets the real cadence. 280 marks over a 70s life is one
       starting roughly every quarter second, of which about a fifth land in
       view. */
    spawnWait -= dt;
    var drawing = 0;
    for (var k = 0; k < live.length; k++) if (!live[k].done) drawing++;
    if (spawnWait <= 0 && drawing < CONCURRENT && live.length < MAX_LIVE) {
      var n = spawn();
      if (n) live.push(n);
      spawnWait = r(0.15, 0.42);
    }
  }

  /* Now that the paper is fixed to the page, scrolling moves the camera onto
     paper that has never been drawn on. Waiting for the spawn loop to fill it
     leaves the view blank for ten seconds or more, since most spawns land
     off-screen. So whenever the camera reaches somewhere new, drop in a batch
     of already-finished marks at staggered ages: the paper you arrive at looks
     worked on, and live drawing continues on top of it. */
  function seedRegion(count) {
    for (var i = 0; i < count && live.length < MAX_LIVE; i++) {
      var m = spawn();
      if (!m) continue;
      m.drawn = m.total;
      m.done = true;
      m.age = r(0, HOLD + FADE * 0.55);   // mid-life, so they fade out staggered
      live.push(m);
    }
  }

  function staticSet() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(-camX, -camY);
    for (var i = 0; i < 22; i++) {
      var m = spawn();
      if (m) { m.drawn = m.total; render(m, 1); }
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = document.documentElement.clientWidth;
    H = document.documentElement.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    live.length = 0;
    camY = (window.pageYOffset || root.scrollTop || 0) * SCROLL_P;
    seedX = camX; seedY = camY;
    if (!reduce.matches) seedRegion(70);   // never show blank paper on load
    if (reduce.matches) {
      // no camera movement at all under reduced motion
      camX = 0; camY = 0; mouseX = 0; mouseY = 0;
      root.style.setProperty("--cam-x", "0px");
      root.style.setProperty("--cam-y", "0px");
      staticSet();
    }
  }

  function start() { if (raf === null && !reduce.matches) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } }

  /* Pointer only sets a target; the camera eases toward it in the frame loop,
     so this never does layout work per move event. */
  window.addEventListener("pointermove", function (e) {
    if (reduce.matches) return;
    mouseX = e.clientX / (W || 1) - 0.5;
    mouseY = e.clientY / (H || 1) - 0.5;
  }, { passive: true });

  var rt = null;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(resize, 200); }, { passive: true });
  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });

  function motionPref() { stop(); resize(); if (!reduce.matches) start(); }
  if (reduce.addEventListener) reduce.addEventListener("change", motionPref);
  else if (reduce.addListener) reduce.addListener(motionPref);

  resize();
  start();
})();
