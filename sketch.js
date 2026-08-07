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
  /* How many marks are mid-draw at once is spawn rate times how long a mark
     takes to draw, and the population is spawn rate times total lifetime. So
     raising the spawn rate alone just piles up marks. To roughly double the
     visible drawing without doubling the density, the lifetime comes down by
     about the same factor the rate goes up. */
  /* Size, frequency and lifetime all multiply into the same pool of ink, and
     all three are now turned up. Tripling mark size alone took coverage from
     5.7% to 18.4%, which is near the density that read as unusable, so the
     population is cut to pay for it. Frequency was kept as high as the budget
     allows and the lifetime absorbed most of the reduction.

     Total lifetime is HOLD + FADE, now 32s (was 45s). Because population is
     spawn rate times lifetime, shortening it thins the standing crowd of marks
     by the same proportion; the spawn rate below is deliberately unchanged, so
     marks turn over faster rather than appearing more often. */
  var HOLD     = 6;      // seconds a finished mark stays at full strength
  var FADE     = 26;     // seconds it then takes to disappear
  var MAX_LIVE = 280;    // ceiling on marks alive anywhere on the sheet
  var CONCURRENT = 12;   // marks that can be mid-draw at the same time
  /* Marks spawn across a region this much larger than the window on each side,
     so the paper is already worked on before you pan or scroll onto it. It
     also means most marks are off-screen at any moment: at 0.6 the spawn area
     is about 4.8x the viewport, so only around a fifth are visible. The
     ceiling and the spawn rate are both sized against that, otherwise
     widening the area would just make the visible page quieter. */
  var SPAWN_MARGIN = 0.6;
  var CELL     = 40;     // printed grid pitch; must match the CSS grid tile
  var PENCIL   = "82,75,88";

  /* Marks are generated at their natural size then scaled about their origin,
     so every generator grows without any of them knowing about it.

     This has to stay a whole number. Cell-based marks are built from multiples
     of CELL, and only an integer scale keeps those multiples landing on the
     printed ruling: 40 x 3 is still a grid line, 40 x 2.5 is not.
     Set per viewport in resize(), since 3x on a phone is most of the screen. */
  var SCALE = 3;
  var WIDTH_SCALE = 1.35;  // lines thicken far less than the marks grow, so
                           // they still read as the same pencil

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

  /* Trace a vertex list as hand-drawn edges. Each edge gets its own bow and
     jitter, and the outline is occasionally broken between edges so shapes
     look drawn in a few passes rather than one perfect loop. */
  function outline(pts, closed, breakUp) {
    var s = [], seq = closed ? pts.concat([pts[0]]) : pts, cur = [];
    for (var i = 0; i < seq.length - 1; i++) {
      var seg = handLine(seq[i][0], seq[i][1], seq[i + 1][0], seq[i + 1][1], 0.9);
      cur = cur.length ? cur.concat(seg.slice(1)) : seg;
      if (breakUp && i < seq.length - 2 && chance(0.22)) { s.push(cur); cur = []; }
    }
    if (cur.length > 1) s.push(cur);
    return s;
  }

  function ngonPts(x, y, n, rad, squash) {
    var pts = [], off = r(0, 6.28);
    for (var i = 0; i < n; i++) {
      var a = off + (i / n) * Math.PI * 2;
      pts.push([x + Math.cos(a) * rad, y + Math.sin(a) * rad * squash]);
    }
    return pts;
  }

  /* ---------- mark generators ---------- */
  var MARKS = [
    /* --- area fills: the scribbles that cover cells --- */
    function tracedCell(x, y) {
      var w = CELL * ri(1, 4), h = CELL * ri(1, 3), s = [];
      var gap = function () { return chance(0.35) ? r(2, 8) : 0; };
      s.push(handLine(x + gap(), y, x + w + r(-3, 4), y));
      s.push(handLine(x + w, y + gap(), x + w, y + h + r(-3, 4)));
      s.push(handLine(x + w + r(-4, 3), y + h, x - r(0, 4), y + h));
      s.push(handLine(x, y + h + r(-4, 2), x, y - r(0, 3)));
      return s;
    },
    function scribbleAcross(x, y) {
      var w = CELL * ri(1, 4), h = CELL * ri(1, 3), pts = [];
      var rows = Math.max(3, Math.round(h / r(7, 13)));
      for (var i = 0; i <= rows; i++) {
        var yy = y + (h * i) / rows + r(-2.5, 2.5);
        var a = i % 2 ? x + w + r(-6, 4) : x + r(-4, 6);
        var b = i % 2 ? x + r(-4, 6) : x + w + r(-6, 4);
        pts.push([a, yy], [b, yy + r(-2, 2)]);
      }
      return [pts];
    },
    function scribbleDown(x, y) {
      var w = CELL * ri(1, 3), h = CELL * ri(1, 3), pts = [];
      var cols = Math.max(3, Math.round(w / r(7, 13)));
      for (var i = 0; i <= cols; i++) {
        var xx = x + (w * i) / cols + r(-2.5, 2.5);
        var a = i % 2 ? y + h + r(-6, 4) : y + r(-4, 6);
        var b = i % 2 ? y + r(-4, 6) : y + h + r(-6, 4);
        pts.push([xx, a], [xx + r(-2, 2), b]);
      }
      return [pts];
    },
    function loopScribble(x, y) {
      var n = ri(4, 10), step = r(11, 22), rad = r(8, 18), pts = [];
      var tilt = r(-0.5, 0.5);
      for (var i = 0; i < n; i++) {
        for (var k = 0; k <= 11; k++) {
          var a = (k / 11) * Math.PI * 2 - Math.PI / 2;
          pts.push([
            x + i * step + Math.cos(a) * rad + r(-1.2, 1.2),
            y + Math.sin(a) * rad + i * step * tilt + r(-1.2, 1.2)
          ]);
        }
      }
      return [pts];
    },
    function spiralFill(x, y) {
      var turns = r(2.5, 5.5), steps = Math.round(turns * 15), rad = r(16, 42), pts = [];
      var squash = r(0.7, 1.1);
      for (var i = 0; i <= steps; i++) {
        var t = i / steps, a = t * turns * Math.PI * 2;
        pts.push([x + Math.cos(a) * rad * t + r(-1.2, 1.2), y + Math.sin(a) * rad * t * squash + r(-1.2, 1.2)]);
      }
      return [pts];
    },
    function walkFill(x, y) {
      var w = CELL * ri(1, 3), h = CELL * ri(1, 2), pts = [[x, y]], n = ri(16, 34);
      for (var i = 0; i < n; i++) {
        var p = pts[pts.length - 1];
        pts.push([
          Math.max(x, Math.min(x + w, p[0] + r(-28, 28))),
          Math.max(y, Math.min(y + h, p[1] + r(-22, 22)))
        ]);
      }
      return [pts];
    },
    function hatch(x, y) {
      var w = CELL * ri(1, 3), h = CELL * ri(1, 2), s = [];
      var step = r(7, 14), ang = pick([0.75, 0.95, -0.75, 2.35]);
      for (var o = -h; o < w + h; o += step) {
        var x1 = Math.max(x, Math.min(x + w, x + o));
        var x2 = Math.max(x, Math.min(x + w, x + o + h / Math.tan(ang)));
        if (Math.abs(x2 - x1) < 2) continue;
        s.push(handLine(x1, y + r(0, 4), x2, y + h - r(0, 4), 0.8));
      }
      if (chance(0.35)) {
        for (var o2 = -h; o2 < w + h; o2 += step * r(1.3, 2.1)) {
          s.push(handLine(Math.max(x, Math.min(x + w, x + o2)), y + h,
                          Math.max(x, Math.min(x + w, x + o2 + h)), y, 0.8));
        }
      }
      return s;
    },

    /* --- wireframe shapes --- */
    function triangle(x, y) {
      var w = CELL * ri(1, 3), h = CELL * ri(1, 3);
      return outline([[x, y + h], [x + w * r(0.35, 0.65), y], [x + w, y + h]], true, true);
    },
    function diamond(x, y) {
      var w = CELL * ri(1, 2), h = CELL * ri(1, 3);
      return outline([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], true, true);
    },
    function polygon(x, y) {
      return outline(ngonPts(x, y, ri(5, 8), r(18, 40), r(0.7, 1.1)), true, true);
    },
    function isoBox(x, y) {
      var w = CELL * ri(1, 2), d = w * r(0.35, 0.6), s = outline([[x, y], [x + w, y], [x + w, y + w], [x, y + w]], true, true);
      s.push(handLine(x, y, x + d, y - d * 0.75, 0.8));
      s.push(handLine(x + w, y, x + w + d, y - d * 0.75, 0.8));
      s.push(handLine(x + w, y + w, x + w + d, y + w - d * 0.75, 0.8));
      s.push(handLine(x + d, y - d * 0.75, x + w + d, y - d * 0.75, 0.8));
      s.push(handLine(x + w + d, y - d * 0.75, x + w + d, y + w - d * 0.75, 0.8));
      return s;
    },
    function stairs(x, y) {
      var n = ri(3, 6), st = CELL * r(0.5, 1), pts = [[x, y]];
      for (var i = 0; i < n; i++) {
        var p = pts[pts.length - 1];
        pts.push([p[0] + st, p[1]]);
        pts.push([p[0] + st, p[1] + st]);
      }
      return outline(pts, false, true);
    },
    function concentric(x, y) {
      var n = ri(2, 4), s = [], w = CELL * ri(1, 3), h = CELL * ri(1, 2);
      for (var i = 0; i < n; i++) {
        var p = i * r(5, 10);
        if (w - p * 2 < 12 || h - p * 2 < 12) break;
        s = s.concat(outline([[x + p, y + p], [x + w - p, y + p], [x + w - p, y + h - p], [x + p, y + h - p]], true, true));
      }
      return s;
    },
    function blockShape(x, y) {
      var u = CELL * r(0.6, 1.2);
      var forms = [
        [[0,0],[1,0],[1,2],[2,2],[2,3],[0,3]],                 // L
        [[0,0],[3,0],[3,1],[2,1],[2,3],[1,3],[1,1],[0,1]],     // T
        [[1,0],[2,0],[2,1],[3,1],[3,2],[2,2],[2,3],[1,3],[1,2],[0,2],[0,1],[1,1]], // plus
        [[0,0],[2,0],[2,1],[1,1],[1,2],[3,2],[3,3],[0,3],[0,2],[0,1]]              // Z
      ];
      return outline(pick(forms).map(function (p) { return [x + p[0] * u, y + p[1] * u]; }), true, true);
    },
    function zigzagBand(x, y) {
      var n = ri(4, 10), st = r(13, 26), amp = r(10, 28), pts = [];
      for (var i = 0; i <= n; i++) pts.push([x + i * st, y + (i % 2 ? amp : 0)]);
      return outline(pts, false, false);
    },

    /* --- doodles --- */
    function star(x, y) {
      var rad = r(15, 34), pts = [];
      for (var i = 0; i < 6; i++) {
        var a = -Math.PI / 2 + i * (4 * Math.PI / 5);
        pts.push([x + Math.cos(a) * rad, y + Math.sin(a) * rad]);
      }
      return outline(pts, false, chance(0.4));
    },

    /* --- annotation marks --- */
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
    function dimension(x, y) {
      var len = CELL * ri(2, 5), s = [];
      s.push(handLine(x, y, x + len, y, 0.85));
      s.push(handLine(x, y - 6, x, y + 6, 0.7));
      s.push(handLine(x + len, y - 6, x + len, y + 6, 0.7));
      return s;
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

    if (SCALE !== 1) {
      for (var si = 0; si < strokes.length; si++) {
        var st = strokes[si];
        for (var pi = 0; pi < st.length; pi++) {
          st[pi][0] = x + (st[pi][0] - x) * SCALE;
          st[pi][1] = y + (st[pi][1] - y) * SCALE;
        }
      }
    }

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
      speed: r(280, 620) * SCALE,   // longer paths, same time to draw
      width: r(0.9, 1.9) * WIDTH_SCALE,
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
      spawnWait = r(0.07, 0.22);
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
    SCALE = W < 640 ? 2 : 3;   // whole numbers only, see the note above
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

/* Footer year. This lives here only because sketch.js is the one script on
   every page. The markup ships a hardcoded year as the fallback, so if this
   file is ever removed the footer still reads correctly for a while. */
(function () {
  "use strict";
  var slot = document.getElementById("year");
  if (slot) slot.textContent = String(new Date().getFullYear());
})();
