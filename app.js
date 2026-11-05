/* ============================================================
   乌铜走银 · 虚拟展览   核心逻辑
   依赖：three.js r147 (UMD)
   ============================================================ */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var LOADER = $('#loader'), LDBAR = $('#ldBar'), LDSUB = $('#ldSub');
  function progress(p, msg) {
    if (LDBAR) LDBAR.style.width = Math.round(p * 100) + '%';
    if (msg && LDSUB) LDSUB.textContent = msg;
  }

  if (!window.THREE) {
    progress(1, 'Three.js 载入失败 · 请检查网络');
    return;
  }
  var T = THREE;

  /* ---------- 数学工具 ---------- */
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, v) { var t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function map(v, a, b, c, d) { return c + (d - c) * clamp01((v - a) / (b - a)); }

  /* 轻量补间：每帧推进，回调拿到 0→1 的进度 */
  var anims = [];
  function anim(dur, fn, done) { anims.push({ t: 0, dur: dur, fn: fn, done: done }); }

  /* ============================================================
     1. 渲染器 / 场景 / 相机
     ============================================================ */
  var canvas = $('#gl');
  var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setClearAlpha(0);

  var scene = new T.Scene();
  var camera = new T.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 120);
  camera.position.set(0, 0.9, 4.6);

  var rig = {
    pos: new T.Vector3(0, 0.9, 4.6),
    target: new T.Vector3(0, 0.22, 0),
    mx: 0, my: 0, mxT: 0, myT: 0,
    shake: 0
  };

  /* ============================================================
     2. 环境贴图（程序化，不依赖 HDR 文件）
     ============================================================ */
  function buildEnvironment() {
    var pmrem = new T.PMREMGenerator(renderer);
    var es = new T.Scene();

    var c = document.createElement('canvas'); c.width = 8; c.height = 256;
    var cx = c.getContext('2d');
    var grd = cx.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0.00, '#15100c');
    grd.addColorStop(0.36, '#4a3a2c');
    grd.addColorStop(0.50, '#a3805c');
    grd.addColorStop(0.56, '#2b221b');
    grd.addColorStop(1.00, '#070605');
    cx.fillStyle = grd; cx.fillRect(0, 0, 8, 256);
    var domeTex = new T.CanvasTexture(c);
    domeTex.encoding = T.sRGBEncoding;
    var dome = new T.Mesh(
      new T.SphereGeometry(40, 32, 24),
      new T.MeshBasicMaterial({ map: domeTex, side: T.BackSide })
    );
    es.add(dome);

    // 柔和光箱：金属高光的来源
    function softbox(w, h, x, y, z, rx, ry, col) {
      var m = new T.Mesh(
        new T.PlaneGeometry(w, h),
        new T.MeshBasicMaterial({ color: col, side: T.DoubleSide })
      );
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, 0);
      es.add(m);
    }
    softbox(9, 9, 0, 9, 2, Math.PI / 2, 0, new T.Color(3.4, 3.15, 2.8));
    softbox(6, 8, -9, 2, 3, 0, Math.PI / 2, new T.Color(0.55, 0.62, 0.75));
    softbox(5, 5, 8, 3, -7, 0, -Math.PI / 4, new T.Color(1.5, 1.05, 0.72));
    softbox(12, 4, 0, -6, 0, -Math.PI / 2, 0, new T.Color(0.10, 0.09, 0.085));

    var rt = pmrem.fromScene(es, 0.02);
    pmrem.dispose();
    return rt.texture;
  }
  scene.environment = buildEnvironment();

  /* ---------- 灯光（补光为主，反射靠环境贴图） ---------- */
  scene.add(new T.HemisphereLight(0x9aa8bc, 0x140f0c, 0.42));

  var keyLight = new T.DirectionalLight(0xffe3c6, 1.15);
  keyLight.position.set(3.4, 5, 3.4);
  scene.add(keyLight);

  var rimLight = new T.DirectionalLight(0xa8c2e2, 0.85);
  rimLight.position.set(-3.6, 2.2, -3.2);
  scene.add(rimLight);

  var fillLight = new T.DirectionalLight(0xffc79a, 0.3);
  fillLight.position.set(-1.5, 1, 4);
  scene.add(fillLight);

  /* ============================================================
     3. 纹样绘制（Canvas → 贴图）
     ============================================================ */
  function newCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return { c: c, x: c.getContext('2d') };
  }
  function texOf(c, wrap) {
    var t = new T.CanvasTexture(c);
    t.wrapS = t.wrapT = wrap ? T.RepeatWrapping : T.ClampToEdgeWrapping;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    t.encoding = T.LinearEncoding;
    return t;
  }

  /* ---------- 器物纹样 ---------- */
  /* 万字锦地：平铺密排回旋单元，横纵无缝 */
  function drawLattice(x, w, h, cell, lw) {
    x.lineWidth = lw;
    var nc = Math.ceil(w / cell), nr = Math.ceil(h / cell);
    for (var j = 0; j < nr; j++) {
      for (var i = 0; i < nc; i++) {
        var x0 = i * cell, y0 = j * cell;
        x.strokeRect(x0 + cell * 0.24, y0 + cell * 0.24, cell * 0.52, cell * 0.52);
        x.strokeRect(x0 + cell * 0.40, y0 + cell * 0.40, cell * 0.20, cell * 0.20);
      }
    }
    for (var a = 0; a <= nc; a++) {
      x.beginPath(); x.moveTo(a * cell, 0); x.lineTo(a * cell, nr * cell); x.stroke();
    }
    for (var b = 0; b <= nr; b++) {
      x.beginPath(); x.moveTo(0, b * cell); x.lineTo(nc * cell, b * cell); x.stroke();
    }
  }

  /* 万字锦地贴图（可平铺） */
  function maskMeander(w, h) {
    var o = newCanvas(w, h), x = o.x;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#fff';
    drawLattice(x, w, h, w * 0.1, w * 0.007);
    return o.c;
  }

  function maskInkLid(w, h) {
    var o = newCanvas(w, h), x = o.x;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round';

    function rr(px, py, pw, ph, r, lw) {
      x.lineWidth = lw;
      x.beginPath();
      x.moveTo(px + r, py);
      x.lineTo(px + pw - r, py); x.quadraticCurveTo(px + pw, py, px + pw, py + r);
      x.lineTo(px + pw, py + ph - r); x.quadraticCurveTo(px + pw, py + ph, px + pw - r, py + ph);
      x.lineTo(px + r, py + ph); x.quadraticCurveTo(px, py + ph, px, py + ph - r);
      x.lineTo(px, py + r); x.quadraticCurveTo(px, py, px + r, py);
      x.closePath(); x.stroke();
    }
    rr(w * 0.035, h * 0.035, w * 0.93, h * 0.93, w * 0.075, w * 0.009);
    rr(w * 0.055, h * 0.055, w * 0.89, h * 0.89, w * 0.06, w * 0.0032);

    function ridge(x0, x1, base, amp, seed) {
      x.beginPath();
      x.moveTo(x0, base);
      var n = 26, s = seed;
      for (var i = 1; i <= n; i++) {
        var px = lerp(x0, x1, i / n);
        s = (s * 9301 + 49297) % 233280;
        var rnd = s / 233280;
        var py = base - Math.sin((i / n) * Math.PI) * amp * (0.35 + rnd * 0.85);
        x.lineTo(px, py);
      }
      x.stroke();
    }

    // 远山（上带）+ 山上树
    x.lineWidth = w * 0.0045;
    ridge(w * 0.30, w * 0.95, h * 0.34, h * 0.13, 7);
    x.lineWidth = w * 0.0022;
    ridge(w * 0.34, w * 0.92, h * 0.40, h * 0.07, 23);
    x.lineWidth = w * 0.0028;
    for (var t = 0; t < 12; t++) {
      var tx = w * (0.38 + t * 0.048);
      x.beginPath();
      x.moveTo(tx, h * 0.335 - Math.sin((0.38 + t * 0.048 - 0.3) / 0.65 * Math.PI) * h * 0.10);
      x.lineTo(tx + w * 0.008, h * 0.30);
      x.stroke();
    }

    // 飞鸟
    x.lineWidth = w * 0.0026;
    [[0.58, 0.115], [0.63, 0.14], [0.67, 0.10]].forEach(function (p) {
      x.beginPath();
      x.moveTo(w * p[0] - w * 0.014, h * p[1]);
      x.quadraticCurveTo(w * p[0], h * (p[1] - 0.012), w * p[0] + w * 0.014, h * p[1]);
      x.stroke();
    });

    // 水波
    x.lineWidth = w * 0.0024;
    for (var j = 0; j < 5; j++) {
      var y = h * (0.545 + j * 0.028);
      x.beginPath();
      for (var k = 0; k <= 30; k++) {
        var px2 = w * 0.10 + (w * 0.52) * (k / 30);
        var py2 = y + Math.sin(k * 1.1 + j * 1.9) * h * 0.006;
        k ? x.lineTo(px2, py2) : x.moveTo(px2, py2);
      }
      x.stroke();
    }

    // 小舟
    x.lineWidth = w * 0.0032;
    x.beginPath();
    x.moveTo(w * 0.585, h * 0.685);
    x.quadraticCurveTo(w * 0.615, h * 0.705, w * 0.655, h * 0.685);
    x.stroke();
    x.beginPath();
    x.moveTo(w * 0.622, h * 0.685);
    x.lineTo(w * 0.622, h * 0.645);
    x.stroke();
    x.beginPath();
    x.moveTo(w * 0.622, h * 0.645);
    x.lineTo(w * 0.645, h * 0.662);
    x.stroke();

    // 花树（右侧主树，团簇点花）
    function blossom(bx, by, br) {
      for (var a = 0; a < 6; a++) {
        var ang = a / 6 * Math.PI * 2;
        x.beginPath();
        x.arc(bx + Math.cos(ang) * br, by + Math.sin(ang) * br * 0.85, br * 0.62, 0, Math.PI * 2);
        x.stroke();
      }
    }
    x.lineWidth = w * 0.005;
    x.beginPath();
    x.moveTo(w * 0.84, h * 0.90);
    x.bezierCurveTo(w * 0.80, h * 0.72, w * 0.86, h * 0.58, w * 0.76, h * 0.44);
    x.stroke();
    x.lineWidth = w * 0.0032;
    [[0.79, 0.62, 0.10, 0.55], [0.77, 0.50, 0.86, 0.40], [0.75, 0.44, 0.66, 0.36]].forEach(function (b) {
      x.beginPath();
      x.moveTo(w * 0.80, h * 0.60);
      x.quadraticCurveTo(w * b[0], h * b[1], w * b[2], h * b[3]);
      x.stroke();
    });
    x.lineWidth = w * 0.0022;
    [[0.72, 0.40], [0.66, 0.37], [0.70, 0.33], [0.80, 0.37], [0.84, 0.42], [0.63, 0.42],
     [0.58, 0.47], [0.55, 0.52], [0.61, 0.53], [0.68, 0.50], [0.74, 0.56], [0.78, 0.50]].forEach(function (p) {
      blossom(w * p[0], h * p[1], w * 0.011);
    });

    // 底部山石
    x.lineWidth = w * 0.0035;
    x.beginPath();
    x.moveTo(w * 0.10, h * 0.90);
    for (var r2 = 0; r2 <= 10; r2++) {
      var px3 = w * (0.10 + r2 * 0.082);
      x.quadraticCurveTo(px3 - w * 0.03, h * (0.84 - (r2 % 2) * 0.025), px3, h * 0.90);
    }
    x.stroke();
    x.lineWidth = w * 0.0022;
    for (var h2 = 0; h2 < 9; h2++) {
      var hx = w * (0.13 + h2 * 0.075);
      x.beginPath();
      x.moveTo(hx, h * 0.885);
      x.lineTo(hx + w * 0.018, h * 0.925);
      x.stroke();
    }

    // 题款（竖排，自右向左）+ 朱印
    var cols = [['溪', '静'], ['风', '不', '过'], ['树', '深']];
    var colX = [w * 0.165, w * 0.118, w * 0.078];
    x.fillStyle = '#fff';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    cols.forEach(function (col, ci) {
      var size = h * 0.05;
      x.font = Math.round(size) + 'px "Kaiti SC","KaiTi","STKaiti","Noto Serif SC",serif';
      col.forEach(function (ch, ri) {
        x.fillText(ch, colX[ci], h * 0.115 + ri * size * 1.22);
      });
    });
    x.fillStyle = 'rgba(148,40,30,.92)';
    x.fillRect(w * 0.062, h * 0.115 + 3 * h * 0.05 * 1.22 + h * 0.012, w * 0.042, w * 0.042);
    x.fillStyle = '#fff';

    return o.c;
  }

  /* 酒壶：柱面展开，v 按高度分布（团龙开光 / 肩云 / 回纹带 / 足部波涛） */
  function maskEwer(w, h) {
    var o = newCanvas(w, h), x = o.x;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round';

    function cloud(cx, cy, s) {
      x.beginPath(); x.arc(cx, cy, s, Math.PI * 0.25, Math.PI * 1.75); x.stroke();
      x.beginPath(); x.arc(cx + s * 0.9, cy + s * 0.25, s * 0.62, Math.PI * 1.2, Math.PI * 2.7); x.stroke();
      x.beginPath(); x.moveTo(cx + s * 1.7, cy + s * 0.6); x.lineTo(cx + s * 2.6, cy + s * 0.6); x.stroke();
    }

    // 足部波涛
    x.lineWidth = w * 0.003;
    for (var r = 0; r < 3; r++) {
      for (var i = 0; i < 14; i++) {
        var ax = w * (i + 0.5) / 14 * 2;
        x.beginPath();
        x.arc((ax % 2) * w * 0.5 + (i % 2) * w * 0.0, h * (0.075 + r * 0.018), w * 0.024, Math.PI, Math.PI * 2);
        x.stroke();
      }
    }

    // 团龙开光
    (function dragon(cx, cy, rx, ry) {
      x.save();
      x.translate(cx, cy);
      x.scale(rx, ry);
      x.lineWidth = 0.06;
      x.beginPath(); x.arc(0, 0, 1, 0, Math.PI * 2); x.stroke();
      x.lineWidth = 0.038;
      x.beginPath(); x.arc(0, 0, 0.87, 0, Math.PI * 2); x.stroke();
      x.lineWidth = 0.035;
      for (var a = 0; a < 22; a++) {
        var an = a / 22 * Math.PI * 2;
        x.beginPath();
        x.moveTo(Math.cos(an) * 0.9, Math.sin(an) * 0.9);
        x.lineTo(Math.cos(an) * 0.97, Math.sin(an) * 0.97);
        x.stroke();
      }
      // 盘龙身：阿基米德螺线
      x.lineWidth = 0.115;
      x.beginPath();
      var pts = [];
      for (var t2 = 0; t2 <= 60; t2++) {
        var tt = t2 / 60;
        var th = -0.9 + tt * 4.4;
        var rr = 0.70 - tt * 0.46;
        var px = Math.cos(th) * rr, py = Math.sin(th) * rr;
        t2 ? x.lineTo(px, py) : x.moveTo(px, py);
        pts.push([px, py, th]);
      }
      x.stroke();
      // 鳞
      x.lineWidth = 0.022;
      for (var s2 = 2; s2 < pts.length - 4; s2 += 3) {
        var p0 = pts[s2];
        x.beginPath();
        x.arc(p0[0], p0[1], 0.055, p0[2] + 1.2, p0[2] + 2.6);
        x.stroke();
      }
      // 龙首（外端）
      var hp = pts[0];
      x.lineWidth = 0.07;
      x.beginPath();
      x.moveTo(hp[0], hp[1]);
      x.lineTo(hp[0] + 0.16, hp[1] - 0.10);
      x.lineTo(hp[0] + 0.30, hp[1] - 0.02);
      x.lineTo(hp[0] + 0.16, hp[1] + 0.06);
      x.closePath();
      x.stroke();
      x.beginPath(); x.arc(hp[0] + 0.22, hp[1] - 0.03, 0.026, 0, Math.PI * 2); x.stroke();
      x.lineWidth = 0.045;
      x.beginPath();
      x.moveTo(hp[0] + 0.12, hp[1] - 0.10);
      x.quadraticCurveTo(hp[0] + 0.10, hp[1] - 0.30, hp[0] - 0.06, hp[1] - 0.34);
      x.stroke();
      x.beginPath();
      x.moveTo(hp[0] + 0.28, hp[1] - 0.04);
      x.quadraticCurveTo(hp[0] + 0.46, hp[1] - 0.12, hp[0] + 0.42, hp[1] + 0.10);
      x.stroke();
      // 爪
      x.lineWidth = 0.04;
      [[0.45], [0.72]].forEach(function (tp) {
        var pp = pts[Math.floor(tp[0] * 60)];
        for (var c2 = 0; c2 < 3; c2++) {
          x.beginPath();
          x.moveTo(pp[0], pp[1]);
          x.lineTo(pp[0] + Math.cos(pp[2] + 1.5 + c2 * 0.4) * 0.16, pp[1] + Math.sin(pp[2] + 1.5 + c2 * 0.4) * 0.16);
          x.stroke();
        }
      });
      // 尾焰
      var ep = pts[60];
      x.lineWidth = 0.045;
      for (var f = 0; f < 3; f++) {
        x.beginPath();
        x.moveTo(ep[0], ep[1]);
        x.quadraticCurveTo(ep[0] + 0.10 + f * 0.05, ep[1] + 0.06 - f * 0.05, ep[0] + 0.22 + f * 0.07, ep[1] - 0.02 + f * 0.06);
        x.stroke();
      }
      x.restore();
    })(w * 0.5, h * 0.305, w * 0.215, h * 0.185);

    // 肩部云纹
    x.lineWidth = w * 0.0035;
    cloud(w * 0.36, h * 0.485, w * 0.030);
    cloud(w * 0.60, h * 0.49, w * 0.034);

    // 颈部回纹带
    x.lineWidth = w * 0.0035;
    var bandY0 = h * 0.645, bandY1 = h * 0.685;
    x.beginPath(); x.moveTo(0, bandY0); x.lineTo(w, bandY0); x.stroke();
    x.beginPath(); x.moveTo(0, bandY1); x.lineTo(w, bandY1); x.stroke();
    var nMe = 16, mw = w / nMe;
    for (var m2 = 0; m2 < nMe; m2++) {
      var mx = m2 * mw;
      x.beginPath();
      x.moveTo(mx + mw * 0.15, bandY1 - h * 0.006);
      x.lineTo(mx + mw * 0.15, bandY0 + h * 0.006);
      x.lineTo(mx + mw * 0.85, bandY0 + h * 0.006);
      x.lineTo(mx + mw * 0.85, bandY1 - h * 0.024);
      x.lineTo(mx + mw * 0.42, bandY1 - h * 0.024);
      x.stroke();
    }

    // 口沿双箍线
    x.lineWidth = w * 0.005;
    x.beginPath(); x.moveTo(0, h * 0.845); x.lineTo(w, h * 0.845); x.stroke();
    x.beginPath(); x.moveTo(0, h * 0.872); x.lineTo(w, h * 0.872); x.stroke();

    // 盖座回纹
    x.lineWidth = w * 0.0028;
    var g0 = h * 0.915, g1 = h * 0.945;
    x.beginPath(); x.moveTo(0, g0); x.lineTo(w, g0); x.stroke();
    x.beginPath(); x.moveTo(0, g1); x.lineTo(w, g1); x.stroke();
    for (var m3 = 0; m3 < 22; m3++) {
      var gx = m3 * w / 22;
      x.beginPath();
      x.moveTo(gx + w * 0.008, g1 - h * 0.004);
      x.lineTo(gx + w * 0.008, g0 + h * 0.004);
      x.lineTo(gx + w * 0.036, g0 + h * 0.004);
      x.stroke();
    }

    // 盖面莲瓣
    x.lineWidth = w * 0.003;
    for (var p2 = 0; p2 < 10; p2++) {
      var px4 = w * (p2 + 0.5) / 10;
      x.beginPath();
      x.moveTo(px4, h * 0.985);
      x.quadraticCurveTo(px4 + w * 0.02, h * 0.955, px4, h * 0.955);
      x.quadraticCurveTo(px4 - w * 0.02, h * 0.955, px4, h * 0.985);
      x.stroke();
    }

    return o.c;
  }

  /* 香炉：回纹锦地 + 开光松竹（走金）+ 盖面云纹 */
  function maskCenser(w, h) {
    var o = newCanvas(w, h), x = o.x;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#fff';

    drawLattice(x, w, h, w * 0.052, w * 0.0035);

    x.lineCap = 'round'; x.lineJoin = 'round';

    function medallion(cx, cy, rx, ry, goldDraw) {
      // 挖黑
      x.fillStyle = '#000';
      x.beginPath(); x.ellipse(cx, cy, rx * 1.08, ry * 1.08, 0, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#fff'; x.lineWidth = w * 0.005;
      x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); x.stroke();
      x.strokeStyle = '#00ff00'; x.lineWidth = w * 0.004;
      goldDraw(cx, cy, rx, ry);
      x.fillStyle = '#fff';
    }

    // 松（金色）—— 接缝开光
    function pine(cx, cy, rx, ry) {
      x.strokeStyle = '#00ff00';
      x.lineWidth = w * 0.007;
      x.beginPath();
      x.moveTo(cx - rx * 0.75, cy + ry * 0.8);
      x.bezierCurveTo(cx - rx * 0.2, cy + ry * 0.35, cx + rx * 0.15, cy + ry * 0.1, cx - rx * 0.05, cy - ry * 0.72);
      x.stroke();
      x.lineWidth = w * 0.004;
      x.beginPath();
      x.moveTo(cx - rx * 0.28, cy + ry * 0.18);
      x.lineTo(cx + rx * 0.62, cy - ry * 0.12);
      x.stroke();
      x.beginPath();
      x.moveTo(cx + rx * 0.05, cy - ry * 0.30);
      x.lineTo(cx + rx * 0.66, cy - ry * 0.55);
      x.stroke();
      // 松针扇
      [[-0.15, -0.55, 0.30], [0.45, -0.42, 0.26], [0.62, -0.10, 0.22], [-0.05, 0.05, 0.30], [0.30, -0.15, 0.24]].forEach(function (p) {
        var fx = cx + rx * p[0], fy = cy + ry * p[1];
        for (var n = 0; n < 7; n++) {
          var an = -Math.PI * 0.85 + n * Math.PI * 0.28;
          x.beginPath();
          x.moveTo(fx, fy);
          x.lineTo(fx + Math.cos(an) * rx * 0.24, fy + Math.sin(an) * ry * 0.22);
          x.stroke();
        }
      });
    }
    // 竹（金色）—— 背面开光
    function bamboo(cx, cy, rx, ry) {
      x.strokeStyle = '#00ff00';
      x.lineWidth = w * 0.007;
      x.beginPath();
      x.moveTo(cx - rx * 0.3, cy + ry * 0.85);
      x.bezierCurveTo(cx - rx * 0.42, cy + ry * 0.3, cx - rx * 0.18, cy - ry * 0.2, cx - rx * 0.32, cy - ry * 0.85);
      x.stroke();
      x.lineWidth = w * 0.0045;
      for (var n = 1; n < 5; n++) {
        var ny = cy + ry * (0.85 - n * 0.32);
        x.beginPath();
        x.moveTo(cx - rx * 0.40, ny);
        x.lineTo(cx - rx * 0.18, ny);
        x.stroke();
      }
      [[0.1, 0.35], [-0.05, -0.1], [0.18, -0.45]].forEach(function (p, k) {
        var lx = cx + rx * p[0], ly = cy + ry * p[1];
        for (var l = 0; l < 3; l++) {
          x.beginPath();
          x.moveTo(lx, ly + l * ry * 0.06);
          x.quadraticCurveTo(lx + rx * 0.3, ly - ry * 0.10 + l * ry * 0.05, lx + rx * 0.55, ly - ry * 0.02 + l * ry * 0.08);
          x.stroke();
        }
      });
    }

    medallion(w * 0.5, h * 0.46, w * 0.16, h * 0.155, bamboo);
    medallion(0, h * 0.46, w * 0.16, h * 0.155, pine);
    medallion(w, h * 0.46, w * 0.16, h * 0.155, pine);

    // 颈带云纹（两箍之间）
    x.fillStyle = '#000';
    x.fillRect(0, h * 0.655, w, h * 0.065);
    x.strokeStyle = '#fff'; x.lineWidth = w * 0.003;
    for (var c3 = 0; c3 < 8; c3++) {
      var cx3 = w * (c3 + 0.5) / 8, cy3 = h * 0.688;
      x.beginPath(); x.arc(cx3, cy3, w * 0.024, Math.PI * 0.9, Math.PI * 2.1); x.stroke();
      x.beginPath(); x.arc(cx3 + w * 0.03, cy3 + h * 0.008, w * 0.013, Math.PI * 1.3, Math.PI * 2.6); x.stroke();
    }

    // 盖面：挖黑 + 莲瓣/云纹
    x.fillStyle = '#000';
    x.fillRect(0, h * 0.755, w, h * 0.245);
    x.strokeStyle = '#fff';
    x.lineWidth = w * 0.0032;
    for (var p3 = 0; p3 < 12; p3++) {
      var px5 = w * (p3 + 0.5) / 12;
      x.beginPath();
      x.moveTo(px5 - w * 0.02, h * 0.80);
      x.quadraticCurveTo(px5, h * 0.775, px5 + w * 0.02, h * 0.80);
      x.lineTo(px5 + w * 0.012, h * 0.86);
      x.quadraticCurveTo(px5, h * 0.845, px5 - w * 0.012, h * 0.86);
      x.closePath();
      x.stroke();
    }
    x.lineWidth = w * 0.0028;
    [[0.3, 0.92], [0.7, 0.90]].forEach(function (p) {
      x.beginPath(); x.arc(w * p[0], h * p[1], w * 0.028, Math.PI * 0.3, Math.PI * 1.8); x.stroke();
      x.beginPath(); x.arc(w * p[0] + w * 0.03, h * (p[1] + 0.008), w * 0.016, Math.PI * 1.2, Math.PI * 2.6); x.stroke();
    });

    // 足部如意瓣
    x.fillStyle = '#000';
    x.fillRect(0, h * 0.02, w, h * 0.145);
    x.strokeStyle = '#fff'; x.lineWidth = w * 0.0035;
    for (var f2 = 0; f2 < 9; f2++) {
      var fx2 = w * (f2 + 0.5) / 9;
      x.beginPath();
      x.moveTo(fx2 - w * 0.028, h * 0.145);
      x.quadraticCurveTo(fx2 - w * 0.012, h * 0.075, fx2, h * 0.062);
      x.quadraticCurveTo(fx2 + w * 0.012, h * 0.075, fx2 + w * 0.028, h * 0.145);
      x.stroke();
    }

    return o.c;
  }

  function maskBands(w, h) {
    var o = newCanvas(w, h), x = o.x;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#fff'; x.lineCap = 'round';

    [0.16, 0.50, 0.84].forEach(function (cy, idx) {
      x.lineWidth = w * 0.0045;
      x.beginPath(); x.moveTo(0, h * (cy - 0.10)); x.lineTo(w, h * (cy - 0.10)); x.stroke();
      x.beginPath(); x.moveTo(0, h * (cy + 0.10)); x.lineTo(w, h * (cy + 0.10)); x.stroke();

      x.lineWidth = w * 0.0055;
      var n = 7;
      for (var i = 0; i < n; i++) {
        var cx0 = w * (i + 0.5) / n;
        x.beginPath();
        x.arc(cx0, h * cy, w * 0.026, Math.PI * 0.15, Math.PI * 1.35);
        x.stroke();
        x.beginPath();
        x.arc(cx0 + w * 0.032, h * cy - h * 0.012, w * 0.014, Math.PI * 0.9, Math.PI * 2.2);
        x.stroke();
      }
    });
    return o.c;
  }

  function maskBeast(w, h) {
    var o = newCanvas(w, h), x = o.x;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round';

    // 回纹带
    x.lineWidth = w * 0.005;
    for (var b = 0; b < 2; b++) {
      var baseY = h * (b ? 0.86 : 0.12);
      for (var i = 0; i < 10; i++) {
        var x0 = w * 0.06 + i * w * 0.093;
        x.beginPath();
        x.moveTo(x0, baseY + h * (b ? -0.045 : 0.045));
        x.lineTo(x0, baseY + h * (b ? -0.005 : 0.005));
        x.lineTo(x0 + w * 0.05, baseY + h * (b ? -0.005 : 0.005));
        x.lineTo(x0 + w * 0.05, baseY + h * (b ? -0.035 : 0.035));
        x.stroke();
      }
    }

    // 中央双睛
    var cy = h * 0.5;
    [-1, 1].forEach(function (s) {
      x.lineWidth = w * 0.007;
      x.beginPath();
      x.arc(w * 0.5 + s * w * 0.14, cy, w * 0.052, 0, Math.PI * 2);
      x.stroke();
      x.lineWidth = w * 0.005;
      x.beginPath();
      x.arc(w * 0.5 + s * w * 0.14, cy, w * 0.026, Math.PI * 0.2, Math.PI * 1.9);
      x.stroke();
    });
    x.lineWidth = w * 0.006;
    x.beginPath();
    x.moveTo(w * 0.5, cy - h * 0.11);
    x.lineTo(w * 0.5, cy + h * 0.11);
    x.stroke();
    return o.c;
  }

  function maskFlora(w, h) {
    var o = newCanvas(w, h), x = o.x;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round';

    // 上下边框
    x.lineWidth = w * 0.007;
    [0.06, 0.94].forEach(function (y) {
      x.beginPath(); x.moveTo(w * 0.05, h * y); x.lineTo(w * 0.95, h * y); x.stroke();
    });

    // 竹竿
    x.lineWidth = w * 0.006;
    [0.2, 0.5, 0.8].forEach(function (px) {
      x.beginPath();
      x.moveTo(w * px, h * 0.14);
      x.bezierCurveTo(w * (px + 0.012), h * 0.4, w * (px - 0.012), h * 0.66, w * (px + 0.008), h * 0.9);
      x.stroke();
      for (var i = 1; i < 5; i++) {
        var yy = h * (0.14 + i * 0.16);
        x.lineWidth = w * 0.005;
        x.beginPath(); x.moveTo(w * (px - 0.03), yy); x.lineTo(w * (px + 0.03), yy); x.stroke();
        x.lineWidth = w * 0.006;
      }
      // 叶
      x.lineWidth = w * 0.004;
      for (var k = 0; k < 3; k++) {
        var by = h * (0.2 + k * 0.14);
        x.beginPath();
        x.moveTo(w * px, by);
        x.quadraticCurveTo(w * (px + 0.06), by - h * 0.05, w * (px + 0.1), by - h * 0.02);
        x.stroke();
      }
    });

    // 梅
    x.lineWidth = w * 0.005;
    x.beginPath();
    x.moveTo(w * 0.1, h * 0.62);
    x.bezierCurveTo(w * 0.22, h * 0.55, w * 0.3, h * 0.66, w * 0.42, h * 0.58);
    x.stroke();
    [[0.18, 0.58], [0.3, 0.63], [0.4, 0.57]].forEach(function (p) {
      x.lineWidth = w * 0.004;
      for (var a = 0; a < 5; a++) {
        var ang = a / 5 * Math.PI * 2 - Math.PI / 2;
        x.beginPath();
        x.arc(w * p[0] + Math.cos(ang) * w * 0.014, h * p[1] + Math.sin(ang) * w * 0.014, w * 0.011, 0, Math.PI * 2);
        x.stroke();
      }
    });
    return o.c;
  }

  var PATTERN_FACTORY = {
    landscape: maskInkLid,
    bands: maskBands,
    beast: maskBeast,
    flora: maskFlora
  };

  /* ============================================================
     4. 材质：一炉两色（乌铜 ↔ 白银）
     ============================================================ */
  var C_SILVER = new T.Color(0xe4eaf2);
  var C_COPPER_FRESH = new T.Color(0xc27a4e);
  var C_COPPER_PATINA = new T.Color(0x0e0a09);

  var craftMaterials = [];

  function craftMaterial(maskTex, opt) {
    opt = opt || {};
    var m = new T.MeshStandardMaterial({
      map: maskTex,
      bumpMap: opt.bump || maskTex,
      bumpScale: opt.bumpScale !== undefined ? opt.bumpScale : 0.0045,
      metalness: 0.9,
      roughness: 0.35,
      envMapIntensity: 1.15,
      side: opt.side || T.FrontSide
    });

    m.onBeforeCompile = function (sh) {
      sh.uniforms.uSilver = { value: new T.Color().copy(C_SILVER) };
      sh.uniforms.uCopperF = { value: new T.Color().copy(C_COPPER_FRESH) };
      sh.uniforms.uCopperP = { value: new T.Color().copy(C_COPPER_PATINA) };
      sh.uniforms.uPatina = { value: opt.patina !== undefined ? opt.patina : 1 };
      sh.uniforms.uSilverBoost = { value: opt.silverBoost !== undefined ? opt.silverBoost : 1 };
      sh.uniforms.uGold = { value: new T.Color(0xd2a558) };
      sh.uniforms.uGoldAmt = { value: opt.gold ? 1 : 0 };

      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', [
          'uniform vec3 uSilver;',
          'uniform vec3 uCopperF;',
          'uniform vec3 uCopperP;',
          'uniform float uPatina;',
          'uniform float uSilverBoost;',
          'uniform vec3 uGold;',
          'uniform float uGoldAmt;',
          'void main() {'
        ].join('\n'))
        .replace('#include <map_fragment>', [
          '#include <map_fragment>',
          'float mSilver = clamp( diffuseColor.r * uSilverBoost, 0.0, 1.0 );',
          'float mGold = clamp( diffuseColor.g * ( 1.0 - diffuseColor.r ) * uGoldAmt, 0.0, 1.0 );',
          'vec3 copperCol = mix( uCopperF, uCopperP, uPatina );'
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>',
          'float roughnessFactor = mix( mix( 0.30, 0.46, uPatina ), 0.11, max( mSilver, mGold * 0.55 ) );')
        .replace('#include <metalnessmap_fragment>', [
          'float metalnessFactor = mix( 0.80, 1.0, max( mSilver, mGold ) );',
          'diffuseColor.rgb = mix( copperCol, uSilver, mSilver );',
          'diffuseColor.rgb = mix( diffuseColor.rgb, uGold, mGold );'
        ].join('\n'));

      m.userData.sh = sh;
    };
    m.userData.uniforms = function () { return m.userData.sh && m.userData.sh.uniforms; };
    craftMaterials.push(m);
    return m;
  }

  function setPatina(mat, v) {
    var u = mat.userData.uniforms();
    if (u) u.uPatina.value = v;
  }

  /* ============================================================
     5. 器物
     ============================================================ */
  function planarUV(geo, w, d) {
    var pos = geo.attributes.position, uv = geo.attributes.uv;
    for (var i = 0; i < pos.count; i++) {
      uv.setXY(i,
        pos.getX(i) / w + 0.5,
        pos.getZ(i) / d + 0.5
      );
    }
    uv.needsUpdate = true;
  }

  function roundedBox(w, h, d, r) {
    var s = new T.Shape();
    var hw = w / 2, hd = d / 2;
    r = Math.min(r, hw * 0.9, hd * 0.9);
    s.moveTo(-hw + r, -hd);
    s.lineTo(hw - r, -hd); s.quadraticCurveTo(hw, -hd, hw, -hd + r);
    s.lineTo(hw, hd - r); s.quadraticCurveTo(hw, hd, hw - r, hd);
    s.lineTo(-hw + r, hd); s.quadraticCurveTo(-hw, hd, -hw, hd - r);
    s.lineTo(-hw, -hd + r); s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);

    var depth = Math.max(0.004, h - r * 2);
    var g = new T.ExtrudeGeometry(s, {
      depth: depth, bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.85,
      bevelSegments: 3, curveSegments: 10, steps: 1
    });
    g.rotateX(-Math.PI / 2);
    g.computeBoundingBox();
    var bb = g.boundingBox;
    g.translate(0, -(bb.max.y + bb.min.y) / 2, 0);
    planarUV(g, w, d);
    g.computeVertexNormals();
    return g;
  }

  var plainCopper = new T.MeshStandardMaterial({
    color: 0x120e0c, metalness: 0.88, roughness: 0.44, envMapIntensity: 1.0
  });
  var silverTrim = new T.MeshStandardMaterial({
    color: 0xd6dbe2, metalness: 1.0, roughness: 0.2, envMapIntensity: 1.3
  });
  var trimDark = new T.MeshStandardMaterial({
    color: 0x878c93, metalness: 1.0, roughness: 0.34, envMapIntensity: 1.15
  });
  var amberMat = new T.MeshStandardMaterial({
    color: 0xc25e0a, metalness: 0.25, roughness: 0.16,
    emissive: 0x481f00, envMapIntensity: 1.4
  });
  var redBeadMat = new T.MeshStandardMaterial({
    color: 0x8e1a12, metalness: 0.3, roughness: 0.12,
    emissive: 0x2a0402, envMapIntensity: 1.4
  });

  function lathe(profile, seg) {
    var pts = profile.map(function (p) { return new T.Vector2(p[0], p[1]); });
    return new T.LatheGeometry(pts, seg || 72);
  }

  /* Lathe 的 v 默认按点序分布；改为按高度分布，便于按 y 定位纹带 */
  function latheUVByY(geo) {
    geo.computeBoundingBox();
    var bb = geo.boundingBox;
    var hh = Math.max(0.0001, bb.max.y - bb.min.y);
    var pos = geo.attributes.position, uv = geo.attributes.uv;
    for (var i = 0; i < pos.count; i++) {
      uv.setY(i, (pos.getY(i) - bb.min.y) / hh);
    }
    uv.needsUpdate = true;
  }

  /* 圆角方环截面挤出（盒身侧墙），侧墙 UV 以周向角为 u、高度为 v */
  function ringBox(w, h, t) {
    var r = w * 0.075;
    function rrect(hw, rr) {
      var s = new T.Shape();
      s.moveTo(-hw + rr, -hw);
      s.lineTo(hw - rr, -hw); s.quadraticCurveTo(hw, -hw, hw, -hw + rr);
      s.lineTo(hw, hw - rr); s.quadraticCurveTo(hw, hw, hw - rr, hw);
      s.lineTo(-hw + rr, hw); s.quadraticCurveTo(-hw, hw, -hw, hw - rr);
      s.lineTo(-hw, -hw + rr); s.quadraticCurveTo(-hw, -hw, -hw + rr, -hw);
      return s;
    }
    var outer = rrect(w / 2, r);
    outer.holes.push(rrect(w / 2 - t * 1.7, Math.max(0.012, r - t * 1.7)));
    var g2 = new T.ExtrudeGeometry(outer, { depth: h, bevelEnabled: false, curveSegments: 8, steps: 1 });
    g2.rotateX(-Math.PI / 2);
    var pos = g2.attributes.position, uv = g2.attributes.uv;
    for (var i = 0; i < pos.count; i++) {
      uv.setXY(i,
        Math.atan2(pos.getZ(i), pos.getX(i)) / (Math.PI * 2) + 0.5,
        pos.getY(i) / h
      );
    }
    uv.needsUpdate = true;
    g2.translate(0, -h / 2, 0);
    g2.computeVertexNormals();
    return g2;
  }

  function buildInkbox() {
    var g = new T.Group();

    // 盒身：环形挤出，侧墙满錾万字锦地
    var sideMask = texOf(maskMeander(512, 512), true);
    sideMask.repeat.set(7, 2);
    var sideMat = craftMaterial(sideMask, { patina: 1, bumpScale: 0.0035 });
    var body = new T.Mesh(ringBox(1.42, 0.30, 0.10), sideMat);
    body.position.y = 0.16;
    g.add(body);

    // 上下两道亮银口沿
    var rimT = new T.Mesh(ringBox(1.49, 0.018, 0.045), silverTrim);
    rimT.position.y = 0.318;
    var rimB = new T.Mesh(ringBox(1.43, 0.016, 0.045), silverTrim);
    rimB.position.y = 0.016;
    g.add(rimT);
    g.add(rimB);

    // 盒盖：山水 + 题款 + 朱印
    var lidMask = texOf(maskInkLid(1024, 1024));
    var lidMat = craftMaterial(lidMask, { patina: 1, bumpScale: 0.007 });
    var lid = new T.Mesh(roundedBox(1.52, 0.16, 1.52, 0.07), lidMat);
    lid.position.y = 0.42;
    g.add(lid);

    return { obj: g, anchors: [[0.30, 0.47, 0.22], [-0.52, 0.42, 0.10], [0.10, 0.16, 0.62]] };
  }

  function buildWinepot() {
    var g = new T.Group();
    var mask = texOf(maskEwer(1024, 1024));
    var mat = craftMaterial(mask, { patina: 1, bumpScale: 0.004 });

    // 壶身：高足喇叭口 + 梨形腹 + 长颈 + 穹盖（团龙开光朝前）
    var body = new T.Mesh(lathe([
      [0.00, 0.00], [0.17, 0.00], [0.215, 0.015], [0.235, 0.055], [0.225, 0.10],
      [0.195, 0.125], [0.19, 0.145],
      [0.25, 0.165], [0.315, 0.23], [0.345, 0.32], [0.345, 0.40], [0.315, 0.50],
      [0.255, 0.60], [0.205, 0.685], [0.18, 0.775], [0.172, 0.88], [0.185, 0.99],
      [0.205, 1.05], [0.21, 1.075], [0.175, 1.085],
      [0.175, 1.14], [0.135, 1.20], [0.075, 1.245], [0.00, 1.25]
    ], 80), mat);
    latheUVByY(body.geometry);
    body.rotation.y = Math.PI;
    g.add(body);

    // 银口双箍
    [1.058, 1.088].forEach(function (yy, k) {
      var ring = new T.Mesh(new T.TorusGeometry(0.212 - k * 0.014, 0.011, 10, 60), silverTrim);
      ring.position.y = yy;
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
    });

    // 盖顶：银托 + 琥珀珠 + 挂环
    var cap = new T.Mesh(new T.CylinderGeometry(0.036, 0.052, 0.036, 20), silverTrim);
    cap.position.y = 1.268;
    g.add(cap);
    var bead = new T.Mesh(new T.SphereGeometry(0.054, 24, 18), amberMat);
    bead.position.y = 1.335;
    g.add(bead);
    var loop = new T.Mesh(new T.TorusGeometry(0.018, 0.006, 8, 24), silverTrim);
    loop.position.y = 1.395;
    g.add(loop);

    // S 形长流（整料锻出，银尖头）
    var spoutCurve = new T.CatmullRomCurve3([
      new T.Vector3(0.22, 0.30, 0), new T.Vector3(0.42, 0.46, 0),
      new T.Vector3(0.52, 0.72, 0), new T.Vector3(0.545, 0.98, 0),
      new T.Vector3(0.60, 1.16, 0)
    ]);
    var spout = new T.Mesh(new T.TubeGeometry(spoutCurve, 40, 0.034, 12, false), plainCopper);
    g.add(spout);
    var tip = new T.Mesh(new T.CylinderGeometry(0.012, 0.034, 0.09, 12), silverTrim);
    tip.position.set(0.618, 1.20, 0);
    tip.rotation.z = -0.28;
    g.add(tip);

    // S 形鋬（尾端内卷）
    var handleCurve = new T.CatmullRomCurve3([
      new T.Vector3(-0.17, 1.02, 0), new T.Vector3(-0.38, 0.94, 0),
      new T.Vector3(-0.48, 0.74, 0), new T.Vector3(-0.44, 0.52, 0),
      new T.Vector3(-0.33, 0.44, 0), new T.Vector3(-0.27, 0.50, 0),
      new T.Vector3(-0.345, 0.565, 0), new T.Vector3(-0.385, 0.50, 0)
    ]);
    var handle = new T.Mesh(new T.TubeGeometry(handleCurve, 60, 0.027, 12, false), plainCopper);
    g.add(handle);

    return { obj: g, anchors: [[0.02, 0.36, 0.36], [0.47, 0.80, 0.04], [0.02, 1.26, 0.13]] };
  }

  function buildCenser() {
    var g = new T.Group();
    var mask = texOf(maskCenser(1024, 1024), true);
    var mat = craftMaterial(mask, { patina: 1, bumpScale: 0.005, gold: true });

    // 炉身：莲瓣足 + 鼓腹 + 束颈双箍 + 穹顶盖（开光朝前）
    var body = new T.Mesh(lathe([
      [0.00, 0.02], [0.21, 0.02], [0.25, 0.05], [0.265, 0.095], [0.245, 0.135],
      [0.21, 0.155], [0.205, 0.175],
      [0.27, 0.19], [0.335, 0.25], [0.375, 0.335], [0.385, 0.425], [0.37, 0.50],
      [0.345, 0.545], [0.315, 0.575], [0.30, 0.60], [0.31, 0.625], [0.325, 0.645],
      [0.315, 0.665], [0.285, 0.675],
      [0.28, 0.69], [0.272, 0.74], [0.235, 0.80], [0.16, 0.845], [0.08, 0.868], [0.00, 0.872]
    ], 80), mat);
    latheUVByY(body.geometry);
    body.rotation.y = Math.PI;
    g.add(body);

    // 颈部银箍两道
    [0.588, 0.628].forEach(function (yy, k) {
      var ring = new T.Mesh(new T.TorusGeometry(0.306 - k * 0.004, 0.012, 10, 60), silverTrim);
      ring.position.y = yy;
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
    });

    // 盖顶：银座 + 朱红顶珠
    var beadSeat = new T.Mesh(new T.CylinderGeometry(0.022, 0.034, 0.032, 16), silverTrim);
    beadSeat.position.y = 0.892;
    g.add(beadSeat);
    var bead = new T.Mesh(new T.SphereGeometry(0.047, 24, 18), redBeadMat);
    bead.position.y = 0.945;
    g.add(bead);

    // 狮首衔环（左右）
    [-1, 1].forEach(function (s) {
      var head = new T.Mesh(new T.SphereGeometry(0.075, 20, 16), trimDark);
      head.scale.set(1, 1.15, 0.55);
      head.position.set(s * 0.375, 0.44, 0);
      g.add(head);
      var ring = new T.Mesh(new T.TorusGeometry(0.052, 0.009, 8, 30), silverTrim);
      ring.position.set(s * 0.402, 0.335, 0);
      ring.rotation.y = Math.PI / 2;
      g.add(ring);
    });

    return { obj: g, anchors: [[0.02, 0.40, 0.37], [0.375, 0.45, 0.10], [0.05, 0.74, 0.22]] };
  }

  function buildBrushpot() {
    var g = new T.Group();
    var mask = texOf(maskFlora(1024, 1024));
    var mat = craftMaterial(mask, { patina: 1, bumpScale: 0.0035, side: T.DoubleSide });

    var body = new T.Mesh(new T.CylinderGeometry(0.335, 0.345, 1.06, 64, 1, true), mat);
    body.position.y = 0.53;
    g.add(body);

    var bottom = new T.Mesh(new T.CylinderGeometry(0.345, 0.345, 0.02, 48), plainCopper);
    bottom.position.y = 0.01;
    g.add(bottom);

    var lip = new T.Mesh(new T.TorusGeometry(0.335, 0.012, 8, 64), plainCopper);
    lip.position.y = 1.06; lip.rotation.x = Math.PI / 2;
    g.add(lip);

    return { obj: g, anchors: [[0.10, 0.92, 0.32], [-0.32, 0.60, 0.12], [0.26, 0.28, 0.20]] };
  }

  var ARTIFACTS = [
    {
      key: 'inkbox', name: '山水纹墨盒', meta: '当代 · 边长 8.5cm · 万字锦地', build: buildInkbox,
      desc: '盖面以银线作山水，题「溪静风不过」，旁钤朱印；盒身满錾万字锦地。最细的银线不足半毫米——錾刀一滑，整块铜胎作废。',
      hot: [
        { i: 0, label: '山水题款 · 錾刻', step: 2, t: '錾刻', d: '盖面山水与题款由数百条短錾线组成，山石用连续的“披麻”走线，深浅必须一致；一处失手，整盖作废。' },
        { i: 1, label: '万字锦地 · 走银', step: 3, t: '锦地走银', d: '盒身一圈万字锦地由上百个回旋单元连续排布，银水沿细槽一次走完，接头必须藏在转折里。' },
        { i: 2, label: '银边合口 · 锻制', step: 1, t: '合缝', d: '盖沿与盒口的亮银边先錾出细槽再填银抛光；盖盒公差靠手工锉配，偏 0.1mm 扣合就会翘边。' }
      ]
    },
    {
      key: 'winepot', name: '祥龙献瑞酒壶', meta: '当代 · 通高 23cm · 限量 19 把', build: buildWinepot,
      desc: '团龙盘于双圈开光之中，长流高鋬皆作 S 形。以乌铜为胎錾刻龙纹，银块高温熔炼填入纹路，黑白相间、精美雅致——此壶仅发行 19 把。',
      hot: [
        { i: 0, label: '团龙开光 · 走银', step: 3, t: '团龙纹', d: '团龙盘于回纹开光之内，鳞片与鬃发全是细錾槽。弧面走银时银水会顺势下淌，须匀速转壶、分段升温填满。' },
        { i: 1, label: 'S 形长流 · 锻制', step: 1, t: '长流', d: '长流与鋬皆整料锻出 S 形，壁厚不足 1mm；弧度差一点，出水就偏。' },
        { i: 2, label: '顶珠莲瓣 · 捂黑', step: 4, t: '捂黑', d: '壶盖回纹带与莲瓣顶饰錾后填银，顶珠为琥珀。捂黑时银件附件须拆下单独处理，避免温差留痕。' }
      ]
    },
    {
      key: 'censer', name: '松竹开光香炉', meta: '当代 · 高 11cm · 乌铜走金银', build: buildCenser,
      desc: '狮首衔环，回纹锦地满工，开光内松竹以金入槽；穹顶云纹，顶珠丹红。同一件器物上，银白与鎏金各走各的火候。',
      hot: [
        { i: 0, label: '开光松竹 · 走金', step: 3, t: '走金', d: '开光内松、竹以金入槽——同一炉火，金比银更挑温度。这是乌铜走银的姊妹技艺「乌铜走金」。' },
        { i: 1, label: '狮首衔环 · 锻制', step: 1, t: '兽首', d: '狮首双目、卷鬃、衔环皆锤揲成型后焊上炉身；焊口若氧化，捂黑后会留下一道灰线。' },
        { i: 2, label: '回纹锦地 · 錾刻', step: 2, t: '锦地', d: '炉身满工回纹锦地作底，开光嵌于其间。锦地每个回旋都要等距，手一抖整片就花。' }
      ]
    },
    {
      key: 'brushpot', name: '四君子笔筒', meta: '民国 · 高 12.8cm', build: buildBrushpot,
      desc: '梅兰竹菊分四面，银线沿筒壁垂直走。收口处最易崩裂——铜壁被錾得太薄，银水一烫就塌。',
      hot: [
        { i: 0, label: '竹枝 · 錾刻', step: 2, t: '垂直走线', d: '垂直纹样看似简单，实则全程手腕悬空，稍有抖动，银线就歪。' },
        { i: 1, label: '筒壁 · 走银', step: 3, t: '曲面填银', d: '筒身是等径曲面，银水靠毛细作用上行，温度低了就停在半路。' },
        { i: 2, label: '底足 · 捂黑', step: 4, t: '捂黑', d: '捂黑要整器一起做，手握的位置不同，氧化程度就会有细微差别。' }
      ]
    }
  ];

  var hall1Group = new T.Group();
  scene.add(hall1Group);

  var artPivot = new T.Group();          // 旋转轴（绕自身中心）
  hall1Group.add(artPivot);

  var artifactNodes = [];   // {group, anchors}
  var currentArt = 0;

  ARTIFACTS.forEach(function (data) {
    var built = data.build();
    var g = built.obj;

    // 归一化：最大边 1.55，底部落在 y=0，水平居中
    var box = new T.Box3().setFromObject(g);
    var size = box.getSize(new T.Vector3());
    var s = 1.55 / Math.max(size.x, size.y, size.z);
    var ctr = box.getCenter(new T.Vector3());

    var holder = new T.Group();
    g.scale.setScalar(s);
    g.position.set(-ctr.x * s, -box.min.y * s, -ctr.z * s);
    holder.add(g);

    var anchors = built.anchors.map(function (a) {
      return new T.Vector3((a[0] - ctr.x) * s, (a[1] - box.min.y) * s, (a[2] - ctr.z) * s);
    });

    holder.visible = false;
    artPivot.add(holder);
    artifactNodes.push({ holder: holder, anchors: anchors, data: data });
  });

  /* 器物接触阴影 */
  function shadowTexture() {
    var o = newCanvas(256, 256), x = o.x;
    var grd = x.createRadialGradient(128, 128, 4, 128, 128, 124);
    grd.addColorStop(0, 'rgba(0,0,0,.85)');
    grd.addColorStop(0.45, 'rgba(0,0,0,.45)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = grd; x.fillRect(0, 0, 256, 256);
    var t = new T.CanvasTexture(o.c);
    t.encoding = T.sRGBEncoding;
    return t;
  }
  var shadowMat = new T.MeshBasicMaterial({
    map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.9
  });
  var contactShadow = new T.Mesh(new T.PlaneGeometry(3.2, 2.4), shadowMat);
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = 0.002;
  hall1Group.add(contactShadow);

  /* ============================================================
     6. 工坊厅：一块铜的五道工序
     ============================================================ */
  var hall2Group = new T.Group();
  scene.add(hall2Group);

  var PLATE_W = 2.2, PLATE_D = 1.5;
  var PC_W = 1000, PC_H = Math.round(1000 * PLATE_D / PLATE_W);

  /* ---------- 纹样路径 ---------- */
  function buildStrokes() {
    var W = PC_W, H = PC_H;
    var strokes = [];

    function push(pts) { if (pts.length > 1) strokes.push(pts); }
    function rect(a, b, c, d) {
      push([[a, b], [c, b], [c, d], [a, d], [a, b]]);
    }
    function ridge(x0, x1, baseY, amp, n, seed) {
      var pts = [], s = seed;
      for (var i = 0; i <= n; i++) {
        s = (s * 9301 + 49297) % 233280;
        var r = s / 233280;
        var px = lerp(x0, x1, i / n);
        var py = baseY - Math.sin((i / n) * Math.PI) * amp * (0.3 + r * 0.9);
        pts.push([px, py]);
      }
      push(pts);
    }
    function circle(cx, cy, r, n) {
      var pts = [];
      var seg = n || 48;
      for (var i = 0; i <= seg; i++) {
        var a = i / seg * Math.PI * 2;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      push(pts);
    }
    function wave(y, x0, x1, amp, n) {
      var pts = [];
      for (var i = 0; i <= n; i++) {
        var px = lerp(x0, x1, i / n);
        pts.push([px, y + Math.sin(i * 0.85) * amp]);
      }
      push(pts);
    }

    // 双线框
    rect(W * 0.045, H * 0.07, W * 0.955, H * 0.93);
    rect(W * 0.062, H * 0.098, W * 0.938, H * 0.902);

    // 主峰与次峰
    ridge(W * 0.09, W * 0.62, H * 0.60, H * 0.30, 26, 11);
    ridge(W * 0.38, W * 0.93, H * 0.66, H * 0.20, 22, 47);

    // 皴线
    for (var i = 0; i < 14; i++) {
      var bx = W * (0.14 + (i / 14) * 0.7);
      var by = H * (0.50 + (i % 4) * 0.035);
      push([[bx, by], [bx + W * 0.014, by + H * 0.055]]);
    }

    // 水波
    wave(H * 0.755, W * 0.08, W * 0.92, H * 0.009, 46);
    wave(H * 0.80, W * 0.10, W * 0.90, H * 0.008, 40);
    wave(H * 0.845, W * 0.14, W * 0.86, H * 0.007, 34);

    // 月
    circle(W * 0.80, H * 0.21, W * 0.042, 40);

    // 松枝
    push([[W * 0.15, H * 0.645], [W * 0.168, H * 0.55], [W * 0.162, H * 0.47], [W * 0.195, H * 0.40]]);
    for (var m = 0; m < 6; m++) {
      var yy = H * (0.42 + m * 0.038);
      push([[W * 0.182, yy], [W * 0.245, yy - H * 0.018]]);
    }
    return strokes;
  }

  var STROKES = buildStrokes();
  var strokeLens = [], STROKE_TOTAL = 0;
  STROKES.forEach(function (s) {
    var len = 0;
    for (var i = 1; i < s.length; i++) {
      len += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]);
    }
    strokeLens.push(len);
    STROKE_TOTAL += len;
  });

  function drawStrokes(ctx, prog, width, color, blur) {
    ctx.clearRect(0, 0, PC_W, PC_H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, PC_W, PC_H);
    if (prog <= 0) return;

    var budget = prog * STROKE_TOTAL;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }

    for (var i = 0; i < STROKES.length; i++) {
      if (budget <= 0) break;
      var s = STROKES[i];
      ctx.beginPath();
      ctx.moveTo(s[0][0], s[0][1]);
      var acc = 0;
      for (var j = 1; j < s.length; j++) {
        var seg = Math.hypot(s[j][0] - s[j - 1][0], s[j][1] - s[j - 1][1]);
        if (acc + seg >= budget) {
          var k = (budget - acc) / seg;
          ctx.lineTo(lerp(s[j - 1][0], s[j][0], k), lerp(s[j - 1][1], s[j][1], k));
          acc = budget;
          break;
        }
        acc += seg;
        ctx.lineTo(s[j][0], s[j][1]);
      }
      budget -= strokeLens[i];
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  function pointAt(prog) {
    var budget = prog * STROKE_TOTAL;
    for (var i = 0; i < STROKES.length; i++) {
      if (budget <= strokeLens[i]) {
        var s = STROKES[i], acc = 0;
        for (var j = 1; j < s.length; j++) {
          var seg = Math.hypot(s[j][0] - s[j - 1][0], s[j][1] - s[j - 1][1]);
          if (acc + seg >= budget) {
            var k = (budget - acc) / seg;
            return [lerp(s[j - 1][0], s[j][0], k), lerp(s[j - 1][1], s[j][1], k)];
          }
          acc += seg;
        }
        return [s[s.length - 1][0], s[s.length - 1][1]];
      }
      budget -= strokeLens[i];
    }
    return [PC_W / 2, PC_H / 2];
  }

  /* ---------- 两张画布 ---------- */
  var engraveCv = newCanvas(PC_W, PC_H);
  var silverCv = newCanvas(PC_W, PC_H);
  var engraveTex = texOf(engraveCv.c);
  var silverTex = texOf(silverCv.c);

  function redrawEngrave(p) {
    drawStrokes(engraveCv.x, p, 5, '#ffffff', 0);
    engraveTex.needsUpdate = true;
  }
  function redrawSilver(p) {
    drawStrokes(silverCv.x, p, 13, '#ffffff', 0);
    silverTex.needsUpdate = true;
  }
  redrawEngrave(0);
  redrawSilver(0);

  /* ---------- 铜坯 / 铜片 ---------- */
  var ingotGeo = new T.BoxGeometry(0.9, 0.52, 0.9, 10, 8, 10);
  (function jitter(geo, amp) {
    var pos = geo.attributes.position;
    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      var n = Math.sin(x * 9.1) * Math.cos(z * 7.7) * Math.sin(y * 11.3);
      pos.setXYZ(i, x + n * amp, y + n * amp * 0.5, z + n * amp);
    }
    geo.computeVertexNormals();
  })(ingotGeo, 0.008);

  var ingotMat = new T.MeshStandardMaterial({
    color: 0x9e5b34, metalness: 0.92, roughness: 0.34,
    emissive: new T.Color(0xff5a1e), emissiveIntensity: 0.5, envMapIntensity: 1.2
  });
  var ingot = new T.Mesh(ingotGeo, ingotMat);
  ingot.position.y = 0.28;
  hall2Group.add(ingot);

  var plateGeo = new T.PlaneGeometry(PLATE_W, PLATE_D, 64, 44);
  (function hammer(g) {
    var pos = g.attributes.position;
    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i), y = pos.getY(i);
      var n = Math.sin(x * 11.0 + y * 3.0) * Math.cos(y * 13.0 - x * 2.0);
      pos.setZ(i, n * 0.006);
    }
    g.computeVertexNormals();
  })(plateGeo);

  var plateMat = craftMaterial(silverTex, {
    bump: engraveTex, bumpScale: 0.02, patina: 0, side: T.DoubleSide
  });
  plateMat.map = silverTex;

  var plate = new T.Mesh(plateGeo, plateMat);
  plate.rotation.x = -Math.PI / 2;
  plate.position.y = 0.006;
  hall2Group.add(plate);

  var plateSideMat = new T.MeshStandardMaterial({
    color: 0x3a2418, metalness: 0.9, roughness: 0.35, envMapIntensity: 1.1
  });
  var plateSide = new T.Mesh(new T.BoxGeometry(PLATE_W, 0.05, PLATE_D), plateSideMat);
  plateSide.position.y = -0.036;
  hall2Group.add(plateSide);

  /* 錾子 */
  var chisel = new T.Mesh(
    new T.ConeGeometry(0.018, 0.14, 8),
    new T.MeshStandardMaterial({ color: 0xd8dde4, metalness: 1, roughness: 0.18 })
  );
  chisel.rotation.x = Math.PI;
  chisel.visible = false;
  hall2Group.add(chisel);

  var fireLight = new T.PointLight(0xff6a24, 0, 5, 2);
  fireLight.position.set(0, 0.45, 0);
  hall2Group.add(fireLight);

  var plateShadow = new T.Mesh(new T.PlaneGeometry(3.6, 2.8), shadowMat.clone());
  plateShadow.material.opacity = 0.7;
  plateShadow.rotation.x = -Math.PI / 2;
  plateShadow.position.y = -0.045;
  hall2Group.add(plateShadow);

  hall2Group.visible = false;

  /* ============================================================
     7. 传承厅：银线谱系
     ============================================================ */
  var hall3Group = new T.Group();
  scene.add(hall3Group);
  (function () {
    var mat = new T.MeshStandardMaterial({
      color: 0xb9c3d0, metalness: 1, roughness: 0.28,
      transparent: true, opacity: 0.16, envMapIntensity: 1.4
    });
    for (var i = 0; i < 7; i++) {
      var r = 1.5 + i * 0.09;
      var ring = new T.Mesh(new T.TorusGeometry(r, 0.004, 6, 128), mat);
      ring.rotation.set(
        Math.PI / 2 + Math.sin(i * 1.7) * 0.7,
        i * 0.42,
        Math.cos(i * 1.3) * 0.6
      );
      hall3Group.add(ring);
    }
    hall3Group.position.y = 0.55;
  })();
  hall3Group.visible = false;

  /* ============================================================
     8. 状态机
     ============================================================ */
  var SEG = {
    melt: [0.00, 0.16],
    forge: [0.16, 0.30],
    engrave: [0.30, 0.52],
    silver: [0.52, 0.84],
    patina: [0.84, 1.00]
  };
  var SEGMENT_META = [
    { key: 'melt', name: '炼铜合金', temp: '约 1030℃', tool: '坩埚 · 风箱', risk: '铜液氧化，杂质会让乌铜发灰' },
    { key: 'forge', name: '锻制铜片', temp: '常温 · 反复退火', tool: '铁锤 · 砧', risk: '厚薄不匀，0.5 毫米是底线' },
    { key: 'engrave', name: '錾刻纹样', temp: '常温', tool: '錾子 · 松香板', risk: '过浅银水填不满，过深穿透铜片' },
    { key: 'silver', name: '走银', temp: '960.8℃ → 1030℃', tool: '吹管 · 硼砂', risk: '越过 1030℃，铜坯塌陷，前功尽弃' },
    { key: 'patina', name: '捂黑', temp: '常温 · 掌温', tool: '掌心 · 药水', risk: '捂不透则底色发花，捂过头银线失光' }
  ];

  var state = {
    hall: -1,
    t: 0,
    silverP: 0,
    playing: false,
    temp: 940,
    target: 940,
    assist: false,
    damage: 0,
    failing: false,
    failT: 0,
    spin: 0.35,
    dragging: false
  };

  function stepAt(t) {
    for (var i = 0; i < SEGMENT_META.length; i++) {
      var r = SEG[SEGMENT_META[i].key];
      if (t < r[1] || i === SEGMENT_META.length - 1) return i;
    }
    return 0;
  }

  /* ---------- 材质与网格随进度变化 ---------- */
  var lastEngraveP = -1, lastSilverP = -1;

  function applyCraft(dt) {
    var t = state.t;

    /* 1 熔炼 */
    var meltK = clamp01(t / SEG.melt[1]);
    var squash = smoothstep(0.155, 0.275, t);
    var ingotOn = t < 0.30;

    ingot.visible = ingotOn;
    if (ingotOn) {
      ingot.scale.set(1 + squash * 1.0, Math.max(0.02, 1 - squash * 0.96), 1 + squash * 0.55);
      ingot.position.y = lerp(0.26, 0.03, squash);
      ingot.rotation.y = t * 0.9;
      var heat = 0.25 + meltK * 0.95;
      ingotMat.emissiveIntensity = heat * (1 - squash * 0.55);
      ingotMat.color.setRGB(
        lerp(0.42, 0.95, meltK),
        lerp(0.22, 0.42, meltK),
        lerp(0.14, 0.18, meltK)
      );
    }
    fireLight.intensity = ingotOn ? 3.4 * meltK * (1 - squash * 0.8) : 0;

    /* 2 锻制 */
    var plateOn = t > 0.175;
    plate.visible = plateOn;
    plateSide.visible = plateOn;
    plateShadow.visible = plateOn;
    if (plateOn) {
      var pk = easeOut(clamp01((t - 0.175) / 0.115));
      plate.scale.setScalar(lerp(0.55, 1, pk));
      plateSide.scale.set(lerp(0.55, 1, pk), 1, lerp(0.55, 1, pk));
    }

    /* 3 錾刻 */
    var eP = clamp01((t - 0.305) / 0.195);
    if (Math.abs(eP - lastEngraveP) > 0.0015 || (eP === 0 && lastEngraveP !== 0)) {
      redrawEngrave(eP);
      lastEngraveP = eP;
    }
    chisel.visible = eP > 0.002 && eP < 0.999;
    if (chisel.visible) {
      var pt = pointAt(eP);
      var lx = (pt[0] / PC_W - 0.5) * PLATE_W;
      var lz = -((pt[1] / PC_H) - 0.5) * PLATE_D;
      chisel.position.set(lx * plate.scale.x, 0.02 + Math.sin(performance.now() * 0.03) * 0.012, lz * plate.scale.z);
      chisel.rotation.z = Math.PI + Math.sin(performance.now() * 0.012) * 0.08;
    }

    /* 4 走银 */
    var sP = state.silverP;
    if (Math.abs(sP - lastSilverP) > 0.0015) {
      redrawSilver(sP);
      lastSilverP = sP;
    }

    /* 5 捂黑 */
    var patina = clamp01((t - 0.855) / 0.125);
    setPatina(plateMat, patina);
    var inSilver = t >= SEG.silver[0] && t < SEG.silver[1];
    var hot = inSilver ? smoothstep(940, 1010, state.temp) * 0.14 : 0;
    plateMat.emissiveIntensity = hot;
    if (hot > 0) plateMat.emissive.setRGB(1, 0.42, 0.14);

    /* 失败抖动 */
    if (state.failing) {
      var f = state.failT;
      plate.rotation.z = Math.sin(f * 34) * 0.05 * (1 - clamp01(f / 1.4));
      plate.rotation.x = -Math.PI / 2 + Math.sin(f * 27) * 0.04 * (1 - clamp01(f / 1.4));
      plate.position.y = 0.006 + Math.sin(f * 46) * 0.006 * (1 - clamp01(f / 1.4));
    } else {
      plate.rotation.z = 0;
      plate.rotation.x = -Math.PI / 2;
      plate.position.y = 0.006;
    }
  }

  /* ---------- 进度推进 ---------- */
  var SEG_SPEED = { melt: 0.085, forge: 0.075, engrave: 0.055, patina: 0.062 };
  var FLOW_MAX = 0.155;

  function flowFactor(temp) {
    if (temp <= 962 || temp >= 1026) return 0;
    return smoothstep(962, 978, temp) * (1 - smoothstep(1012, 1026, temp));
  }

  function advance(dt) {
    if (state.failing) {
      state.failT += dt;
      if (state.failT > 1.5) {
        state.failing = false;
        state.damage = 0;
        state.silverP = 0;
        state.t = SEG.silver[0] + 0.002;
        state.temp = 950; state.target = 950;
        document.getElementById('tempRange').value = 950;
        lastSilverP = -1;
        $('#toast').classList.remove('on');
      }
      return;
    }

    /* 温度跟随 */
    state.temp += clamp(state.target - state.temp, -70 * dt, 70 * dt);

    if (state.assist) state.target = 995;

    if (!state.playing) return;

    var t = state.t;

    if (t < SEG.silver[0] - 0.0005) {
      var idx = stepAt(t);
      var sp = SEG_SPEED[SEGMENT_META[idx].key] || 0.06;
      state.t = Math.min(SEG.silver[0] - 0.0005, t + sp * dt);
    } else if (t < SEG.silver[1] - 0.0005) {
      var f = flowFactor(state.temp);
      if (f > 0) {
        state.silverP = clamp01(state.silverP + FLOW_MAX * f * dt);
        state.t = SEG.silver[0] + (SEG.silver[1] - SEG.silver[0]) * state.silverP;
      }
      if (state.temp > 1027) {
        state.damage += dt * (1 + (state.temp - 1027) * 0.06);
        if (state.damage > 0.95) triggerFail();
      } else {
        state.damage = Math.max(0, state.damage - dt * 0.6);
      }
    } else {
      state.t = Math.min(1, t + (SEG_SPEED.patina) * dt);
      if (state.t >= 1) { state.t = 1; state.playing = false; syncPlayBtn(); }
    }
  }

  function triggerFail() {
    state.failing = true;
    state.failT = 0;
    state.playing = false;
    state.temp = 1050;
    state.target = 1050;
    $('#toast').classList.add('on');
    syncPlayBtn();
    rig.shake = 1;
  }

  /* ============================================================
     9. UI 绑定
     ============================================================ */
  /* ---------- 器物切换 ---------- */
  var thumbStrip = $('#thumbStrip');
  var hsLayer = $('#hotspots');
  var hsCard = document.createElement('div');
  hsCard.className = 'hs-card';
  document.body.appendChild(hsCard);

  ARTIFACTS.forEach(function (a, i) {
    var b = document.createElement('button');
    b.className = 'thumb';
    b.innerHTML = '<b>0' + (i + 1) + '</b><span>' + a.name + '</span>';
    b.addEventListener('click', function () { selectArt(i); });
    thumbStrip.appendChild(b);
  });

  var hsEls = [];

  function selectArt(i) {
    if (i === currentArt && artifactNodes[i].holder.visible) return;
    currentArt = i;
    $$('.thumb').forEach(function (el, k) { el.classList.toggle('on', k === i); });

    artifactNodes.forEach(function (n, k) {
      if (k === i) {
        n.holder.visible = true;
        if (REDUCE) {
          n.holder.scale.setScalar(1);
          n.holder.position.y = 0;
        } else {
          n.holder.scale.setScalar(0.86);
          anim(0.75, function (p) {
            var e = easeOut(p);
            n.holder.scale.setScalar(lerp(0.86, 1, e));
            n.holder.position.y = lerp(-0.12, 0, e);
          });
        }
      } else {
        n.holder.visible = false;
        n.holder.scale.setScalar(1);
        n.holder.position.y = 0;
      }
    });

    var d = ARTIFACTS[i];
    $('#acName').textContent = d.name;
    $('#acMeta').textContent = d.meta;
    $('#acDesc').textContent = d.desc;
    $('#acIdx').textContent = '0' + (i + 1) + ' / 04';

    rebuildHotspots(i);
    hsCard.classList.remove('on');
  }

  function rebuildHotspots(i) {
    hsEls.forEach(function (e) { e.el.remove(); });
    hsEls = [];
    ARTIFACTS[i].hot.forEach(function (h, k) {
      var el = document.createElement('div');
      el.className = 'hotspot';
      el.innerHTML = '<div class="hs-ring"></div><button class="hs-btn" aria-label="' + h.label + '"></button>' +
        '<span class="hs-label">' + h.label + '</span>';
      el.querySelector('.hs-btn').addEventListener('click', function (ev) {
        ev.stopPropagation();
        showHsCard(h, ev.currentTarget);
      });
      hsLayer.appendChild(el);
      hsEls.push({ el: el, idx: h.i, h: h });
    });
  }

  function showHsCard(h, anchorEl) {
    var r = anchorEl.getBoundingClientRect();
    hsCard.innerHTML = '<p class="hc-tag">工序 0' + (h.step + 1) + ' · ' + SEGMENT_META[h.step].name + '</p>' +
      '<h5>' + h.t + '</h5><p>' + h.d + '</p>' +
      '<button>查看这道工序 →</button>';
    hsCard.classList.add('on');
    var x = Math.min(window.innerWidth - 270, r.left + 26);
    var y = Math.min(window.innerHeight - 190, r.top - 10);
    hsCard.style.left = x + 'px';
    hsCard.style.top = y + 'px';
    hsCard.querySelector('button').onclick = function () {
      hsCard.classList.remove('on');
      goHall(2);
      setTimeout(function () { setT(SEG[SEGMENT_META[h.step].key][0] + 0.004, true); }, 620);
    };
  }

  document.addEventListener('click', function (e) {
    if (!hsCard.contains(e.target) && !e.target.closest('.hotspot')) hsCard.classList.remove('on');
  });

  /* ---------- 拖拽旋转 ---------- */
  var drag = { on: false, x: 0, y: 0, ry: 0, rx: 0, vy: 0 };
  var surf = $('#dragSurface');

  function ptr(e) { return e.touches ? e.touches[0] : e; }

  function onDown(e) {
    drag.on = true;
    drag.x = ptr(e).clientX; drag.y = ptr(e).clientY;
    drag.vy = 0;
  }
  function onMove(e) {
    if (!drag.on) return;
    var p = ptr(e);
    var dx = p.clientX - drag.x, dy = p.clientY - drag.y;
    drag.x = p.clientX; drag.y = p.clientY;
    drag.ry += dx * 0.0075;
    drag.rx = clamp(drag.rx + dy * 0.005, -0.5, 0.5);
    drag.vy = dx * 0.0075;
    if (e.cancelable) e.preventDefault();
  }
  function onUp() { drag.on = false; }

  surf.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  surf.addEventListener('touchstart', onDown, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);

  window.addEventListener('mousemove', function (e) {
    rig.mxT = (e.clientX / window.innerWidth - 0.5) * 2;
    rig.myT = (e.clientY / window.innerHeight - 0.5) * 2;
  });

  /* ---------- 工坊厅 UI ---------- */
  var steplist = $('#steplist');
  SEGMENT_META.forEach(function (s, i) {
    var li = document.createElement('li');
    li.className = 'step';
    li.innerHTML = '<b>0' + (i + 1) + '</b><span>' + s.name + '</span><em>' + s.temp + '</em>';
    li.addEventListener('click', function () {
      state.playing = false; syncPlayBtn();
      setT(SEG[s.key][0] + 0.004, true);
    });
    steplist.appendChild(li);
  });

  var tlTrack = $('#tlTrack'), tlFill = $('#tlFill'), tlHead = $('#tlHead'),
    tlNodes = $('#tlNodes'), tlLabels = $('#tlLabels');

  SEGMENT_META.forEach(function (s, i) {
    var r = SEG[s.key];
    var mid = (r[0] + r[1]) / 2 * 100;
    var n = document.createElement('i');
    n.className = 'tl-node';
    n.style.left = mid + '%';
    n.dataset.i = i;
    tlNodes.appendChild(n);

    var l = document.createElement('span');
    l.style.left = mid + '%';
    l.textContent = s.name;
    l.dataset.i = i;
    tlLabels.appendChild(l);
  });

  function syncPlayBtn() {
    $('#playBtn').classList.toggle('playing', state.playing);
  }

  $('#playBtn').addEventListener('click', function () {
    if (state.failing) return;
    if (state.t >= 0.999) setT(0, true);
    state.playing = !state.playing;
    if (state.playing && state.t < SEG.silver[0]) {
      // 进入走银前，温度默认偏低，提示观众
    }
    syncPlayBtn();
  });

  $('#resetBtn').addEventListener('click', function () {
    state.playing = false; syncPlayBtn();
    state.failing = false; state.failT = 0; state.damage = 0;
    $('#toast').classList.remove('on');
    state.silverP = 0; lastSilverP = -1;
    state.t = 0; state.temp = 940; state.target = 940;
    $('#tempRange').value = 940;
  });

  $('#assistBtn').addEventListener('click', function () {
    state.assist = !state.assist;
    $('#assistBtn').classList.toggle('on', state.assist);
    if (state.assist) { state.target = 995; $('#tempRange').value = 995; }
  });

  var tempRange = $('#tempRange');
  tempRange.addEventListener('input', function () {
    state.target = parseFloat(tempRange.value);
    state.assist = false;
    $('#assistBtn').classList.remove('on');
  });

  function setT(t, fromScrub) {
    state.t = clamp(t, 0, 1);
    if (fromScrub) {
      if (state.t >= SEG.silver[1]) state.silverP = 1;
      else if (state.t >= SEG.silver[0]) {
        state.silverP = (state.t - SEG.silver[0]) / (SEG.silver[1] - SEG.silver[0]);
      } else state.silverP = 0;
      lastSilverP = -1;
    }
  }

  var scrubbing = false;
  function scrubFromEvent(e) {
    var r = tlTrack.getBoundingClientRect();
    var p = ptr(e);
    var x = clamp((p.clientX - r.left) / r.width, 0, 1);
    setT(x, true);
  }
  tlTrack.addEventListener('pointerdown', function (e) {
    scrubbing = true; state.playing = false; syncPlayBtn();
    tlTrack.setPointerCapture && tlTrack.setPointerCapture(e.pointerId);
    scrubFromEvent(e);
  });
  window.addEventListener('pointermove', function (e) { if (scrubbing) scrubFromEvent(e); });
  window.addEventListener('pointerup', function () { scrubbing = false; });

  /* ---------- 每帧同步 HUD ---------- */
  var uiCache = {};

  var GAUGE_VERTICAL = true;
  function layoutNeedle(temp) {
    var n = $('#gNeedle');
    if (!n) return;
    if (GAUGE_VERTICAL) {
      n.style.top = (100 - map(temp, 900, 1050, 0, 100)) + '%';
      n.style.left = '';
    } else {
      n.style.left = map(temp, 900, 1050, 0, 100) + '%';
      n.style.top = '';
    }
  }
  function layoutGauge() {
    GAUGE_VERTICAL = window.innerWidth > 1100;
    var lo = map(962, 900, 1050, 0, 100);
    var hi = map(1024, 900, 1050, 0, 100);
    var win = $('#gWindow');
    if (win) {
      if (GAUGE_VERTICAL) {
        win.style.left = '-3px'; win.style.width = '7px';
        win.style.top = (100 - hi) + '%'; win.style.height = (hi - lo) + '%';
      } else {
        win.style.top = '-3px'; win.style.height = '7px';
        win.style.left = lo + '%'; win.style.width = (hi - lo) + '%';
      }
    }
    layoutNeedle(state.temp);
  }

  function syncHUD() {
    var t = state.t;
    var idx = stepAt(t);

    if (uiCache.t !== t) {
      tlFill.style.width = (t * 100) + '%';
      tlHead.style.left = (t * 100) + '%';
      uiCache.t = t;
    }

    if (uiCache.idx !== idx) {
      uiCache.idx = idx;
      $$('.step').forEach(function (el, k) { el.classList.toggle('on', k === idx); });
      $$('.tl-node').forEach(function (el, k) { el.classList.toggle('on', k <= idx); });
      $$('.tl-labels span').forEach(function (el, k) { el.classList.toggle('on', k === idx); });
      var s = SEGMENT_META[idx];
      $('#siTemp').textContent = s.temp;
      $('#siTool').textContent = s.tool;
      $('#siRisk').textContent = s.risk;
    }

    /* 温度 */
    var temp = state.temp;
    var tr = Math.round(temp * 10) / 10;
    if (uiCache.temp !== tr) {
      uiCache.temp = tr;
      $('#gRead').textContent = tr.toFixed(1);
      layoutNeedle(temp);
    }

    var inSilver = t >= SEG.silver[0] - 0.001 && t < SEG.silver[1];
    var gauge = $('#gauge');
    gauge.classList.toggle('live', inSilver);
    var win = $('#gWindow');
    var f = flowFactor(temp);
    win.classList.toggle('ok', inSilver && f > 0.15);
    win.classList.toggle('bad', inSilver && temp > 1027);

    var note;
    if (!inSilver) note = '五道工序 · 拖动时间轴逐段推进';
    else if (temp < 962) note = '银已凝固 —— 温度不够，纹路填不满';
    else if (temp > 1027) note = '危险：铜坯正在塌陷';
    else if (f > 0.6) note = '窗口内 —— 银水正在沿凹槽流动';
    else note = '接近窗口边缘，银水流速变慢';
    if (uiCache.note !== note) { uiCache.note = note; $('#gNote').textContent = note; }
  }

  /* ============================================================
     10. 展厅切换
     ============================================================ */
  var PRESETS = [
    { pos: [0.60, 0.95, 4.20], target: [-1.15, 0.26, 0] }, // 序
    { pos: [0.55, 1.02, 3.85], target: [-0.52, 0.30, 0] },  // 壹
    { pos: [0.95, 1.72, 2.75], target: [-0.42, 0.02, 0] },  // 贰
    { pos: [0, 0.72, 4.30], target: [0, 0.55, 0] },         // 叁
    { pos: [0, 0.72, 4.90], target: [0, 0.55, 0] }          // 注
  ];

  var camAnim = null;
  var REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var SECTIONS = $$('.hall');

  function showSection(i) {
    SECTIONS.forEach(function (el, k) {
      var on = k === i;
      el.classList.toggle('on', on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
      if (!on) el.scrollTop = 0;
    });
    $$('.col-item').forEach(function (a, k) { a.classList.toggle('on', k === i); });
  }

  function goHall(i) {
    if (i === state.hall) return;
    state.hall = i;

    if (i !== 2 && state.playing) { state.playing = false; syncPlayBtn(); }

    var p = PRESETS[i];
    var fromPos = rig.pos.clone(), toPos = new T.Vector3().fromArray(p.pos);
    var fromTar = rig.target.clone(), toTar = new T.Vector3().fromArray(p.target);

    if (camAnim) { anims.splice(anims.indexOf(camAnim), 1); camAnim = null; }

    var rec = {
      t: 0, dur: REDUCE ? 0.001 : 1.25,
      fn: function (k) {
        var e = easeInOut(k);
        rig.pos.lerpVectors(fromPos, toPos, e);
        rig.target.lerpVectors(fromTar, toTar, e);
      },
      done: function () { camAnim = null; }
    };
    anims.push(rec); camAnim = rec;

    hall1Group.visible = i <= 1;
    hall2Group.visible = i === 2;
    hall3Group.visible = i === 3;

    if (i === 1 && !artifactNodes[currentArt].holder.visible) selectArt(currentArt);

    showSection(i);
    hsCard.classList.remove('on');
  }

  /* ---------- 专栏切换（点击 / 键盘，页面本身不滚动） ---------- */
  $$('[data-hall]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      var i = parseInt(el.getAttribute('data-hall'), 10);
      if (isNaN(i)) return;
      goHall(i);
      try { history.replaceState(null, '', '#' + SECTIONS[i].id); } catch (err) {}
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault(); goHall(Math.min(SECTIONS.length - 1, state.hall + 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault(); goHall(Math.max(0, state.hall - 1));
    } else if (e.key >= '1' && e.key <= '5') {
      goHall(parseInt(e.key, 10) - 1);
    }
  });

  /* ---------- 滚动检测 ---------- */
  /* ---------- 热点投影 ---------- */
  var v3 = new T.Vector3();
  function updateHotspots() {
    if (state.hall !== 1) {
      hsEls.forEach(function (e) { e.el.classList.remove('show'); });
      return;
    }
    var node = artifactNodes[currentArt];
    var rect = hsLayer.getBoundingClientRect();
    var W = window.innerWidth, H = window.innerHeight;

    hsEls.forEach(function (item, k) {
      var a = node.anchors[item.idx];
      if (!a) { item.el.classList.remove('show'); return; }
      v3.copy(a).applyMatrix4(node.holder.matrixWorld).project(camera);
      var x = (v3.x * 0.5 + 0.5) * W - rect.left;
      var y = (-v3.y * 0.5 + 0.5) * H - rect.top;
      var visible = v3.z < 1 && x > -40 && x < rect.width + 40 && y > -40 && y < rect.height + 40;
      item.el.classList.toggle('show', visible);
      if (visible) {
        item.el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      }
    });
  }

  /* ============================================================
     11. 传承厅 · 纹样墙
     ============================================================ */
  var MOTIFS = [
    {
      k: '梅', en: 'PRUNUS', art: '四君子笔筒', step: 2,
      d: '五瓣梅花在乌铜走银里是最简的母题，也是最难的一种——花瓣只有五条弧线，每一条都必须一口气走完。'
    },
    {
      k: '兰', en: 'ORCHID', art: '四君子笔筒', step: 2,
      d: '兰叶讲“撇”，錾子从粗到细收锋，靠的是手腕逐渐抬起，而不是换刀。'
    },
    {
      k: '竹', en: 'BAMBOO', art: '四君子笔筒', step: 3,
      d: '竹节是垂直走线的试金石。银水在等径筒壁上靠毛细上行，温度低一点就停在半路。'
    },
    {
      k: '菊', en: 'CHRYSANTHEMUM', art: '四君子笔筒', step: 2,
      d: '菊花瓣多而密，是检验錾刻间距控制力的母题：密而不乱，疏而不散。'
    },
    {
      k: '麒麟吐书', en: 'QILIN', art: '山水纹墨盒', step: 0,
      d: '麒麟吐书讲的是祥瑞与文脉。这类叙事性纹样在乌铜走银里多见于文房器，寓意“书香传家”。'
    },
    {
      k: '缠枝莲', en: 'LOTUS SCROLL', art: '祥龙献瑞酒壶', step: 3,
      d: '缠枝是连续纹样，考验的是“接”——壶身一圈走完，接头必须落在花头里，肉眼看不出来。'
    },
    {
      k: '回纹', en: 'MEANDER', art: '松竹开光香炉', step: 2,
      d: '回纹锦地满工铺底，每一个回旋单元都要等距等深。这是最考验手稳的纹样，也是乌铜走银最常用的底饰。'
    },
    {
      k: '云雷', en: 'CLOUD-THUNDER', art: '祥龙献瑞酒壶', step: 1,
      d: '云雷纹多用于肩部与口沿。弧形排列时，回旋方向必须左右对称，否则整器失衡。'
    },
    {
      k: '花鸟', en: 'BIRD & FLOWER', art: '山水纹墨盒', step: 4,
      d: '花鸟讲“留白”。乌铜走银的银线不能铺满，留出的乌黑底色才是画面的呼吸。'
    }
  ];

  function drawMotif(ctx, key, S) {
    ctx.clearRect(0, 0, S, S);
    ctx.strokeStyle = '#e9dfd2';
    ctx.lineWidth = S * 0.014;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var c = S / 2;

    function arc(x, y, r, a0, a1) { ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.stroke(); }
    function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

    if (key === '梅') {
      ctx.beginPath();
      ctx.moveTo(S * 0.1, S * 0.82);
      ctx.bezierCurveTo(S * 0.34, S * 0.72, S * 0.4, S * 0.5, S * 0.66, S * 0.42);
      ctx.stroke();
      [[0.3, 0.68], [0.52, 0.52], [0.72, 0.4]].forEach(function (p) {
        for (var i = 0; i < 5; i++) {
          var a = i / 5 * Math.PI * 2 - Math.PI / 2;
          arc(S * p[0] + Math.cos(a) * S * 0.05, S * p[1] + Math.sin(a) * S * 0.05, S * 0.042, 0, Math.PI * 2);
        }
      });
    } else if (key === '兰') {
      for (var i = 0; i < 4; i++) {
        var sgn = i % 2 ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(c, S * 0.84);
        ctx.bezierCurveTo(c + sgn * S * 0.38, S * 0.62, c + sgn * S * 0.1, S * 0.34, c + sgn * S * 0.3, S * 0.16);
        ctx.stroke();
      }
      arc(c - S * 0.1, S * 0.3, S * 0.035, 0, Math.PI * 2);
      arc(c + S * 0.14, S * 0.26, S * 0.035, 0, Math.PI * 2);
    } else if (key === '竹') {
      line(S * 0.34, S * 0.12, S * 0.4, S * 0.9);
      line(S * 0.68, S * 0.16, S * 0.62, S * 0.86);
      [0.3, 0.48, 0.66, 0.82].forEach(function (y) {
        line(S * (0.36 - y * 0.03), S * y, S * (0.42 - y * 0.03), S * y);
      });
      [0.26, 0.42, 0.58].forEach(function (y, k) {
        ctx.beginPath();
        ctx.moveTo(S * 0.74, S * y);
        ctx.quadraticCurveTo(S * 0.9, S * (y - 0.1), S * 0.94, S * (y - 0.04));
        ctx.stroke();
      });
    } else if (key === '菊') {
      for (var j = 0; j < 14; j++) {
        var a2 = j / 14 * Math.PI * 2;
        line(c + Math.cos(a2) * S * 0.1, c + Math.sin(a2) * S * 0.1,
          c + Math.cos(a2) * S * 0.34, c + Math.sin(a2) * S * 0.34);
      }
      arc(c, c, S * 0.1, 0, Math.PI * 2);
    } else if (key === '麒麟吐书') {
      ctx.beginPath();
      ctx.moveTo(S * 0.3, S * 0.78);
      ctx.bezierCurveTo(S * 0.16, S * 0.56, S * 0.34, S * 0.3, S * 0.56, S * 0.32);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(S * 0.56, S * 0.32);
      ctx.lineTo(S * 0.72, S * 0.24);
      ctx.lineTo(S * 0.74, S * 0.4);
      ctx.closePath();
      ctx.stroke();
      ctx.strokeRect(S * 0.44, S * 0.46, S * 0.28, S * 0.2);
      line(S * 0.5, S * 0.56, S * 0.66, S * 0.56);
    } else if (key === '缠枝莲') {
      ctx.beginPath();
      ctx.moveTo(S * 0.08, S * 0.68);
      ctx.bezierCurveTo(S * 0.3, S * 0.4, S * 0.5, S * 0.86, S * 0.72, S * 0.5);
      ctx.stroke();
      arc(S * 0.24, S * 0.56, S * 0.06, 0, Math.PI * 1.6);
      arc(S * 0.68, S * 0.6, S * 0.06, Math.PI, Math.PI * 2.6);
      arc(S * 0.52, S * 0.3, S * 0.11, 0, Math.PI * 2);
      arc(S * 0.52, S * 0.3, S * 0.05, 0, Math.PI * 2);
    } else if (key === '回纹') {
      for (var r = 0; r < 2; r++) {
        for (var q = 0; q < 3; q++) {
          var ox = S * (0.1 + q * 0.28), oy = S * (0.16 + r * 0.4);
          ctx.beginPath();
          ctx.moveTo(ox, oy + S * 0.22);
          ctx.lineTo(ox, oy);
          ctx.lineTo(ox + S * 0.18, oy);
          ctx.lineTo(ox + S * 0.18, oy + S * 0.14);
          ctx.lineTo(ox + S * 0.07, oy + S * 0.14);
          ctx.lineTo(ox + S * 0.07, oy + S * 0.07);
          ctx.stroke();
        }
      }
    } else if (key === '云雷') {
      for (var m = 0; m < 3; m++) {
        var cx = S * (0.24 + m * 0.26), cy = S * (m % 2 ? 0.36 : 0.62);
        ctx.beginPath();
        for (var n = 0; n < 60; n++) {
          var t2 = n / 60 * Math.PI * 3.4;
          var rr = S * 0.02 + t2 * S * 0.026;
          var px = cx + Math.cos(t2) * rr, py = cy + Math.sin(t2) * rr;
          n ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
    } else {
      // 花鸟
      arc(S * 0.34, S * 0.36, S * 0.11, 0, Math.PI * 2);
      for (var p2 = 0; p2 < 6; p2++) {
        var aa = p2 / 6 * Math.PI * 2;
        arc(S * 0.34 + Math.cos(aa) * S * 0.16, S * 0.36 + Math.sin(aa) * S * 0.16, S * 0.05, 0, Math.PI * 2);
      }
      ctx.beginPath();
      ctx.moveTo(S * 0.5, S * 0.72);
      ctx.bezierCurveTo(S * 0.68, S * 0.6, S * 0.74, S * 0.8, S * 0.88, S * 0.68);
      ctx.stroke();
      line(S * 0.86, S * 0.68, S * 0.94, S * 0.64);
      line(S * 0.62, S * 0.74, S * 0.64, S * 0.84);
      line(S * 0.7, S * 0.72, S * 0.72, S * 0.82);
    }
  }

  var wall = $('#patternWall');
  var detail = $('#patternDetail');
  var activeMotif = -1;

  MOTIFS.forEach(function (m, i) {
    var b = document.createElement('button');
    b.className = 'pat';
    var cvs = document.createElement('canvas');
    cvs.width = 120; cvs.height = 120;
    b.appendChild(cvs);
    var em = document.createElement('em');
    em.textContent = m.k;
    b.appendChild(em);
    drawMotif(cvs.getContext('2d'), m.k, 120);
    b.addEventListener('click', function () { pickMotif(i); });
    wall.appendChild(b);
  });

  function pickMotif(i) {
    activeMotif = i;
    $$('.pat').forEach(function (el, k) { el.classList.toggle('on', k === i); });
    var m = MOTIFS[i];
    detail.innerHTML =
      '<div class="pd-block">' +
      '<p class="pd-sub">' + m.en + ' / MOTIF 0' + (i + 1) + '</p>' +
      '<h4>' + m.k + '</h4>' +
      '<p>' + m.d + '</p>' +
      '</div>' +
      '<div class="pd-links">' +
      '<span class="pd-sub">在这条脉络里</span>' +
      '<button class="pd-link" data-a="' + m.art + '"><i></i>文物厅 · ' + m.art + '</button>' +
      '<button class="pd-link" data-s="' + m.step + '"><i></i>工坊厅 · ' + SEGMENT_META[m.step].name + '</button>' +
      '</div>';

    detail.querySelectorAll('.pd-link').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.a) {
          var idx = ARTIFACTS.findIndex(function (a) { return a.name === btn.dataset.a; });
          goHall(1);
          if (idx >= 0) setTimeout(function () { selectArt(idx); }, 420);
        } else {
          var s = parseInt(btn.dataset.s, 10);
          goHall(2);
          setTimeout(function () { state.playing = false; syncPlayBtn(); setT(SEG[SEGMENT_META[s].key][0] + 0.004, true); }, 560);
        }
      });
    });
  }

  /* ============================================================
     12. 主循环
     ============================================================ */
  var clock = new T.Clock();

  function tick() {
    requestAnimationFrame(tick);
    var dt = Math.min(clock.getDelta(), 0.05);

    /* 补间 */
    for (var i = anims.length - 1; i >= 0; i--) {
      var a = anims[i];
      a.t += dt;
      var k = Math.min(1, a.t / a.dur);
      a.fn(k);
      if (k >= 1) { anims.splice(i, 1); if (a.done) a.done(); }
    }

    /* 状态推进 */
    advance(dt);

    /* 器物旋转 */
    if (!drag.on) {
      drag.ry += (drag.vy + 0.0022) * (state.hall === 1 ? 1 : 0.6);
      drag.vy *= 0.94;
      drag.rx += (-0.06 - drag.rx) * 0.02;
    }
    artPivot.rotation.y = drag.ry;
    artPivot.rotation.x = drag.rx;

    /* 工坊动画 */
    if (state.hall === 2) applyCraft(dt);

    /* 传承厅缓慢旋转 */
    if (state.hall === 3) {
      hall3Group.rotation.y += dt * 0.06;
      hall3Group.rotation.x = Math.sin(clock.elapsedTime * 0.15) * 0.12;
    }

    /* 相机 + 视差 + 震动 */
    rig.mx += (rig.mxT - rig.mx) * 0.05;
    rig.my += (rig.myT - rig.my) * 0.05;

    rig.shake *= 0.9;
    var sh = rig.shake * 0.02;

    camera.position.set(
      rig.pos.x + rig.mx * 0.14 + (Math.random() - 0.5) * sh,
      rig.pos.y - rig.my * 0.08 + (Math.random() - 0.5) * sh,
      rig.pos.z
    );
    camera.lookAt(rig.target);

    /* 热点 */
    scene.updateMatrixWorld();
    updateHotspots();

    /* HUD */
    if (state.hall === 2) syncHUD();

    renderer.render(scene, camera);
  }

  /* ============================================================
     13. 启动
     ============================================================ */
  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 窄屏拉远，保证器物完整
    var scale = w < 760 ? 1.35 : w < 1100 ? 1.12 : 1;
    PRESETS.forEach(function (p) {
      p._base = p._base || { pos: p.pos.slice(), target: p.target.slice() };
      p.pos[2] = p._base.pos[2] * scale;
      p.pos[1] = p._base.pos[1];
    });
    layoutGauge();
  }
  window.addEventListener('resize', resize);

  progress(0.6, '正在錾刻纹样');
  selectArt(0);
  goHall(0);
  resize();

  var enterBtn = $('#enterBtn');
  if (enterBtn) enterBtn.addEventListener('click', function () { goHall(1); });

  setTimeout(function () {
    progress(1, '开馆');
    LOADER.classList.add('off');
    setTimeout(function () { LOADER.style.display = 'none'; }, 1000);
  }, 420);

  /* 深链：#hall1 / #hall2 / #hall3 / #notes，或 ?hall=0..4 */
  (function () {
    var target = -1;
    if (location.hash) {
      var el = document.querySelector(location.hash);
      if (el && el.classList.contains('hall')) target = parseInt(el.getAttribute('data-index'), 10);
    }
    if (target < 0) {
      var qh = parseInt(new URLSearchParams(location.search).get('hall'), 10);
      if (qh >= 0 && qh < SECTIONS.length) target = qh;
    }
    if (target > 0) goHall(target);

    var qa = parseInt(new URLSearchParams(location.search).get('art'), 10);
    if (qa >= 0 && qa < ARTIFACTS.length && qa !== currentArt) selectArt(qa);
  })();

  tick();
})();
