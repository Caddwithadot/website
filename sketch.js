/* Pencil sketching on the graph paper.

   Marks are generated procedurally and drawn stroke by stroke onto a canvas,
   so the leading edge reads as a pencil tip moving. Old marks fade out slowly
   so the page never fills up.

   Everything is randomised per mark: position, size, rotation, stroke weight,
   opacity, and the jitter applied to every vertex. Nothing repeats.

   Note on the brief: this is decorative animation and JavaScript, both of
   which the design brief argues against. It is here at the client's explicit
   request, twice asked. It is isolated in this one file: delete the script tag
   and the canvas and nothing else changes.

   Accessibility and cost:
   - canvas is aria-hidden, pointer-events none, z-index -1
   - prefers-reduced-motion draws one static set and stops
   - pauses entirely when the tab is hidden
   - incremental drawing, so each frame draws only the new segment
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
  var W = 0, H = 0, dpr = 1;
  var CELL = 40;
  var active = [];
  var raf = null, last = 0, fadeTick = 0, spawnWait = 0;

  var PENCIL = "82,75,88";

  /* ---------- small random helpers ---------- */
  function r(a, b) { return a + Math.random() * (b - a); }
  function ri(a, b) { return Math.floor(r(a, b + 1)); }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function chance(p) { return Math.random() < p; }

  /* Resample a straight run into a bowed, jittered polyline. Real pencil lines
     are never straight and never land exactly on their endpoint. */
  function handLine(x1, y1, x2, y2, wob) {
    wob = wob === undefined ? 1 : wob;
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.hypot(dx, dy);
    var steps = Math.max(2, Math.round(len / 14));
    var nx = -dy / (len || 1), ny = dx / (len || 1);
    var bow = r(-1.6, 1.6) * wob;
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var arc = Math.sin(t * Math.PI) * bow;
      var j = (i === 0 || i === steps) ? 0.6 : 1.4;
      pts.push([
        x1 + dx * t + nx * arc + r(-j, j) * wob,
        y1 + dy * t + ny * arc + r(-j, j) * wob
      ]);
    }
    // overshoot or fall short of the endpoint
    var o = r(-3, 4);
    pts[pts.length - 1][0] += (dx / (len || 1)) * o;
    pts[pts.length - 1][1] += (dy / (len || 1)) * o;
    return pts;
  }

  function arcPts(cx, cy, rx, ry, a0, a1, wob) {
    var steps = Math.max(6, Math.round(Math.abs(a1 - a0) * 7));
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var a = a0 + (a1 - a0) * (i / steps);
      pts.push([
        cx + Math.cos(a) * rx + r(-1.5, 1.5) * wob,
        cy + Math.sin(a) * ry + r(-1.5, 1.5) * wob
      ]);
    }
    return pts;
  }

  /* ---------- hand-drawn digits, unit box, stroked as polylines ---------- */
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
    var slant = r(-0.16, 0.16);
    for (var i = 0; i < text.length; i++) {
      var g = GLYPH[text[i]];
      if (!g) { cx += size * 0.5; continue; }
      var h = size * r(0.88, 1.14);      // digits vary in height
      var w = size * r(0.5, 0.66);
      for (var s = 0; s < g.length; s++) {
        var pts = [];
        for (var p = 0; p < g[s].length; p++) {
          var px = cx + g[s][p][0] * w + (1 - g[s][p][1]) * slant * h;
          var py = y + g[s][p][1] * h;
          pts.push([px + r(-1.3, 1.3), py + r(-1.3, 1.3)]);
        }
        strokes.push(pts);
      }
      cx += w + size * r(0.12, 0.3);
    }
    return strokes;
  }

  /* ---------- mark generators, each returns an array of strokes ---------- */
  var MARKS = [
    function tracedCell(x, y) {                        // boxed-out room
      var w = CELL * ri(1, 4), h = CELL * ri(1, 3), s = [];
      var gap = function () { return chance(0.4) ? r(2, 10) : 0; };
      s.push(handLine(x + gap(), y, x + w + r(-4, 6), y));
      s.push(handLine(x + w, y + gap(), x + w, y + h + r(-4, 6)));
      s.push(handLine(x + w + r(-6, 4), y + h, x - r(0, 5), y + h));
      s.push(handLine(x, y + h + r(-6, 3), x, y - r(0, 4)));
      if (chance(0.3)) s.push(handLine(x + r(0, 6), y + r(2, 8), x + w, y + r(2, 8), 1.4));
      return s;
    },
    function scribbleOut(x, y) {                       // crossed-through cell
      var w = CELL * ri(1, 3), h = CELL * ri(1, 2), s = [], pts = [];
      var rows = Math.max(3, Math.round(h / r(7, 12)));
      for (var i = 0; i <= rows; i++) {
        var yy = y + (h * i) / rows + r(-3, 3);
        var l = i % 2 ? x + w + r(-6, 4) : x + r(-4, 6);
        var rgt = i % 2 ? x + r(-4, 6) : x + w + r(-6, 4);
        pts.push([l, yy], [rgt, yy + r(-2, 2)]);
      }
      s.push(pts);
      return s;
    },
    function hatch(x, y) {                             // shaded-out area
      var w = CELL * ri(1, 3), h = CELL * ri(1, 2), s = [];
      var step = r(7, 14), ang = pick([0.7, 0.9, -0.7, 2.3]);
      for (var o = -h; o < w + h; o += step) {
        var x1 = x + o, y1 = y, x2 = x + o + h / Math.tan(ang), y2 = y + h;
        x1 = Math.max(x, Math.min(x + w, x1));
        x2 = Math.max(x, Math.min(x + w, x2));
        if (Math.abs(x2 - x1) < 2 && Math.abs(y2 - y1) < 2) continue;
        s.push(handLine(x1, y1 + r(0, 5), x2, y2 - r(0, 5), 0.8));
      }
      if (chance(0.35)) {                              // second pass, crosshatch
        for (var o2 = -h; o2 < w + h; o2 += step * r(1.2, 2)) {
          s.push(handLine(
            Math.max(x, Math.min(x + w, x + o2)), y + h,
            Math.max(x, Math.min(x + w, x + o2 + h)), y, 0.8));
        }
      }
      return s;
    },
    function arrow(x, y) {
      var len = r(45, 130), a = r(-0.9, 0.9) + (chance(0.5) ? 0 : Math.PI);
      var ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
      var s = [handLine(x, y, ex, ey, 1.3)];
      var hl = r(11, 20);
      s.push(handLine(ex, ey, ex - Math.cos(a - r(0.4, 0.75)) * hl, ey - Math.sin(a - r(0.4, 0.75)) * hl));
      s.push(handLine(ex, ey, ex - Math.cos(a + r(0.4, 0.75)) * hl, ey - Math.sin(a + r(0.4, 0.75)) * hl));
      return s;
    },
    function route(x, y) {                             // wandering path
      var pts = [[x, y]], n = ri(3, 6), cx = x, cy = y;
      for (var i = 0; i < n; i++) {
        cx += r(-70, 110); cy += r(-70, 90);
        var prev = pts[pts.length - 1];
        var mid = handLine(prev[0], prev[1], cx, cy, 1.6);
        pts = pts.concat(mid.slice(1));
      }
      return [pts];
    },
    function cross(x, y) {
      var d = r(16, 40);
      return [
        handLine(x, y, x + d + r(-5, 6), y + d + r(-5, 6), 1.2),
        handLine(x + d + r(-4, 4), y + r(-3, 3), x + r(-4, 4), y + d + r(-3, 3), 1.2)
      ];
    },
    function ring(x, y) {                              // circled point of interest
      var rx = r(16, 38), ry = rx * r(0.6, 1.25), s = [];
      var start = r(0, 6.2);
      s.push(arcPts(x, y, rx, ry, start, start + r(5.6, 7.4), 1.2));
      if (chance(0.3)) s.push(arcPts(x, y, rx * r(0.9, 1.15), ry * r(0.9, 1.15), start + r(0, 1), start + r(4, 7), 1.4));
      return s;
    },
    function bracket(x, y) {
      var h = r(30, 90), w = r(8, 16);
      return [
        [].concat(handLine(x + w, y, x, y + r(3, 9)), handLine(x, y + 8, x, y + h - 8), handLine(x, y + h - r(3, 9), x + w, y + h)),
        handLine(x, y + h / 2, x + r(20, 55), y + h / 2 + r(-4, 4), 1.2)
      ];
    },
    function tick(x, y) {
      return [[].concat(handLine(x, y, x + r(7, 13), y + r(9, 15)), handLine(x + 10, y + 12, x + r(20, 34), y - r(14, 26)))];
    },
    function number(x, y) {
      return digits(x, y, r(13, 26), String(ri(1, 96)));
    },
    function dimension(x, y) {                         // measurement line
      var len = CELL * ri(2, 5), s = [];
      s.push(handLine(x, y, x + len, y, 0.9));
      s.push(handLine(x, y - 6, x, y + 6, 0.8));
      s.push(handLine(x + len, y - 6, x + len, y + 6, 0.8));
      return s.concat(digits(x + len / 2 - 8, y - r(24, 32), r(12, 19), String(Math.round(len / CELL))));
    },
    function underline(x, y) {
      var len = r(50, 150), s = [handLine(x, y, x + len, y + r(-4, 4), 1.8)];
      if (chance(0.5)) s.push(handLine(x + r(-6, 8), y + r(4, 9), x + len + r(-10, 6), y + r(3, 10), 1.8));
      return s;
    },
    function tally(x, y) {
      var n = ri(3, 5), s = [], h = r(20, 34);
      for (var i = 0; i < n; i++) s.push(handLine(x + i * r(7, 11), y, x + i * r(7, 11) + r(-3, 3), y + h, 0.9));
      if (chance(0.6)) s.push(handLine(x - 4, y + h * 0.75, x + n * 9 + 4, y + h * 0.25, 1.1));
      return s;
    },
    function corner(x, y) {                            // L bracket on a cell
      var d = r(14, 30);
      return [[].concat(handLine(x, y + d, x, y), handLine(x, y, x + d, y))];
    },
    function star(x, y) {                              // asterisk emphasis
      var s = [], n = ri(3, 4), rad = r(9, 18);
      for (var i = 0; i < n; i++) {
        var a = r(0, 3.14);
        s.push(handLine(x - Math.cos(a) * rad, y - Math.sin(a) * rad, x + Math.cos(a) * rad, y + Math.sin(a) * rad, 0.8));
      }
      return s;
    },
    function dots(x, y) {                              // waypoint cluster
      var s = [], n = ri(3, 7), cx = x, cy = y;
      for (var i = 0; i < n; i++) {
        cx += r(14, 34); cy += r(-14, 14);
        s.push([[cx, cy], [cx + r(-2, 2), cy + r(-2, 2)]]);
      }
      return s;
    }
  ];

  /* ---------- build one mark, snapped to the cell grid ---------- */
  function spawn() {
    var x = Math.round(r(30, W - 120) / CELL) * CELL;
    var y = Math.round(r(30, H - 120) / CELL) * CELL;
    var strokes = pick(MARKS)(x, y).filter(function (s) { return s && s.length > 1; });
    if (!strokes.length) return null;
    return {
      strokes: strokes,
      si: 0, pi: 0, carry: 0,
      lift: 0,
      width: r(0.9, 2.1),
      alpha: r(0.18, 0.44),
      speed: r(260, 620)
    };
  }

  /* ---------- advance one mark by dt, drawing what it covers ---------- */
  function advance(m, dt) {
    if (m.lift > 0) { m.lift -= dt; return false; }
    var budget = m.speed * dt + m.carry;
    ctx.strokeStyle = "rgba(" + PENCIL + "," + m.alpha + ")";
    ctx.lineWidth = m.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    while (budget > 0) {
      var stroke = m.strokes[m.si];
      if (!stroke) return true;
      var a = stroke[m.pi], b = stroke[m.pi + 1];
      if (!b) {                                  // end of stroke, lift the pencil
        m.si++; m.pi = 0;
        if (m.si >= m.strokes.length) return true;
        m.lift = r(0.04, 0.22);
        m.carry = budget;
        return false;
      }
      var seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (seg > budget) {                        // partial segment
        var t = budget / seg;
        var mx = a[0] + (b[0] - a[0]) * t, my = a[1] + (b[1] - a[1]) * t;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(mx, my); ctx.stroke();
        stroke[m.pi] = [mx, my];
        m.carry = 0;
        return false;
      }
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      budget -= seg;
      m.pi++;
    }
    m.carry = 0;
    return false;
  }

  function drawWhole(m) {                        // reduced-motion path
    ctx.strokeStyle = "rgba(" + PENCIL + "," + m.alpha + ")";
    ctx.lineWidth = m.width;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (var s = 0; s < m.strokes.length; s++) {
      var st = m.strokes[s];
      ctx.beginPath(); ctx.moveTo(st[0][0], st[0][1]);
      for (var p = 1; p < st.length; p++) ctx.lineTo(st[p][0], st[p][1]);
      ctx.stroke();
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = (now - last) / 1000; last = now;
    if (!(dt > 0) || dt > 0.1) dt = 0.016;

    // slow erase so marks accumulate then clear, roughly two minutes to gone
    if (++fadeTick % 6 === 0) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.0025)";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    }

    for (var i = active.length - 1; i >= 0; i--) {
      if (advance(active[i], dt)) active.splice(i, 1);
    }

    spawnWait -= dt;
    if (spawnWait <= 0 && active.length < 2) {
      var m = spawn();
      if (m) active.push(m);
      spawnWait = r(0.5, 2.6);
    }
  }

  function staticSet() {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < 26; i++) { var m = spawn(); if (m) drawWhole(m); }
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
    active.length = 0;
    if (reduce.matches) staticSet();
  }

  function start() { if (raf === null && !reduce.matches) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } }

  var rt = null;
  window.addEventListener("resize", function () {
    clearTimeout(rt); rt = setTimeout(resize, 200);
  }, { passive: true });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else start();
  });

  function motionPref() {
    stop(); resize();
    if (!reduce.matches) start();
  }
  if (reduce.addEventListener) reduce.addEventListener("change", motionPref);
  else if (reduce.addListener) reduce.addListener(motionPref);

  resize();
  start();
})();
