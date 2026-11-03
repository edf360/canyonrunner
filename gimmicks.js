/**
 * gimmicks.js — 動くオブジェクト10種（決定的・時刻 t の純関数）
 *
 *  0 振れ球      谷底から吊るされた巨大球が左右に振れる（hazard/赤）
 *  1 ピストン    床から周期的に突き出す柱（hazard/赤）
 *  2 タービン    高度軸まわりに回される3枚羽根。上下へ高度を振って回避（caution/黄）
 *  3 動く門      上下にスライドする開口付き全幅障壁（caution/黄）
 *  4 哨戒ドローン 左右の壁間を往復（hazard/赤）
 *  5 追跡ドローン 接近する機体の Y をゆっくり追う（hazard/赤）
 *  6 浮遊機雷    上下に浮沈しながら漂う（hazard/赤）
 *  7 走査レーザー 床⇔天井をスイープするビーム面（hazard/赤）
 *  8 ボーナスリング 揺れるリングをくぐると +250 m（bonus/cyan）
 *  9 突風帯      横風で機体を流す（wind/緑淡、衝突なし）
 *
 *  設計不変条件:
 *   - 位置はすべて f(配置i, t[, plane]) の純関数（メッシュ走査・状態非依存）
 *   - どの位相でも峡谷を塞がずに通れる（テスト9で全位相スキャン検証）
 *   - TUNNEL 内・巨岩付近には配置しない
 *  canyon.js 読み込み後にクラシックスクリプトとして読むこと。
 */
(function (global) {
  'use strict';
  const CY = global.Canyon;
  const TAU = Math.PI * 2;

  const START = 6000;    // 出現開始距離 [m]
  const SPACING = 1500;  // スロット平均間隔 [m]
  const BONUS = 250;     // リング通過ボーナス [m]

  // ---- 配置ハッシュ（canyon とは独立のシード）----
  let seed = 4242;
  if (typeof location !== 'undefined' && location.hash) {
    const m = location.hash.match(/seed=(\d+)/);
    if (m) seed = parseInt(m[1], 10) | 0;
  }
  function hash(n) {
    let t = (seed + Math.imul(n | 0, 2654435761)) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // -1..1 の三角波
  function tri(x) {
    const u = x - Math.floor(x);
    return 4 * Math.abs(u - 0.5) - 1;
  }

  // ---- スロット i のギミック定義（無ければ null）--------------------
  function at(i) {
    if (i < 0) return null;
    const X = START + i * SPACING + (hash(9000 + i) - 0.5) * 700;
    const st = CY.stageAt(X);
    if (st.idx === 3) return null; // TUNNEL 内は置かない
    const appear = Math.min(0.95, 0.5 + 0.15 * st.lap); // 周回で密度↑
    if (hash(9100 + i) > appear) return null;
    if (CY.rockHit(X, CY.centerline(X))) return null; // 巨岩とは重複しない
    const c = CY.centerline(X);
    const w = CY.halfWidth(X);
    const f = CY.floorAlt(X);
    const cl = CY.ceilAlt(X);
    if (cl - f < 1300) return null; // 狭すぎる区間はスキップ
    return {
      i,
      kind: Math.floor(hash(9200 + i) * 10),
      X, c, w, f, cl,
      ph: hash(9300 + i) * TAU,
      T: 5 + hash(9400 + i) * 6,
      dY: (hash(9500 + i) * 2 - 1),
      rA: (hash(9600 + i) * 2 - 1) * 300,
      alt: f + 700 + hash(9700 + i) * 450,
      dir: hash(9800 + i) < 0.5 ? -1 : 1,
    };
  }

  // ---- 部分位置関数 ---------------------------------------------------
  // 振れ球の球心
  function pendCenter(g, t) {
    const L = (g.cl - g.f) * 0.55;
    const th = 0.16 * Math.sin(TAU * t / g.T + g.ph);
    return { y: g.c + L * Math.sin(th), alt: g.cl - L * Math.cos(th), L };
  }
  // ピストン上面高度
  function pistonTop(g, t) {
    return g.f + 160 + 460 * (0.5 + 0.5 * Math.sin(TAU * t / g.T + g.ph));
  }
  // タービン軸高度
  function turbineAxis(g) { return g.f + 620; }
  // 門の開口下端
  function gateOpenA(g, t) {
    return g.f + 160 + (g.cl - g.f - 980) * (0.5 + 0.5 * Math.sin(TAU * t / g.T + g.ph));
  }
  const GATE_H = 660; // 開口高さ（常時）
  // ドローン位置（4=哨戒、5=追跡）
  function dronePos(g, t, plane) {
    const base = g.c + g.w * 0.6 * tri(t / g.T + g.ph);
    if (g.kind === 5 && plane) {
      const dx = g.X - plane.x; // 機体の前方にいれば正
      if (dx > -500 && dx < 2600) {
        const k = Math.max(0, Math.min(0.75, 0.75 * (1 - Math.max(0, dx - 700) / 1900)));
        const y = base + (plane.y - base) * k;
        return {
          y: Math.max(g.c - g.w * 0.8, Math.min(g.c + g.w * 0.8, y)),
          alt: g.alt,
        };
      }
    }
    return { y: base, alt: g.alt };
  }
  // 浮遊機雷
  function minePos(g, t) {
    return {
      y: g.c + g.dY * g.w * 0.55,
      alt: g.f + (g.cl - g.f) * 0.45 + 340 * Math.sin(TAU * t / g.T + g.ph),
    };
  }
  // 走査レーザーの高度
  function laserAlt(g, t) {
    return g.f + 120 + (g.cl - g.f - 240) *
      (0.5 + 0.5 * Math.sin(TAU * t / (g.T + 4) + g.ph));
  }
  // ボーナスリング中心
  function ringCenter(g, t) {
    return {
      y: g.c + g.dY * g.w * 0.28 + 90 * Math.sin(t / 2.1 + g.ph),
      alt: g.f + 760 + g.rA * 0.4 + 110 * Math.sin(t / 1.7 + g.ph * 2),
      R: 180,
    };
  }

  // ---- リング取得状態（ゲーム内状態。reset() で消去）-----------------
  const collected = new Set();
  function reset() { collected.clear(); }

  function nearSlots(X) {
    const i0 = Math.floor((X - START) / SPACING) - 1;
    return [i0, i0 + 1, i0 + 2];
  }
  function sphHit(X, Y, alt, cx, cy, ca, r) {
    const dx = X - cx, dy = Y - cy, da = alt - ca;
    return dx * dx + dy * dy + da * da < r * r;
  }

  // ---- 衝突・取得判定 --------------------------------------------------
  //  plane = { x, y, alt, px, py, palt }（追跡ドローンとリング横断に使む）
  //  返り値: null=セーフ / 'hit' / { bonus, i }
  function check(X, Y, alt, t, plane) {
    if (X < START - 800) return null;
    const pl = plane || { x: X, y: Y, alt, px: X, py: Y, palt: alt };
    for (const i of nearSlots(X)) {
      const g = at(i);
      if (!g || Math.abs(g.X - X) > 1600) continue;
      switch (g.kind) {
        case 0: { // 振れ球
          const p = pendCenter(g, t);
          if (sphHit(X, Y, alt, g.X, p.y, p.alt, 66)) return 'hit';
          break;
        }
        case 1: { // ピストン
          const top = pistonTop(g, t);
          const dx = X - g.X, dy = Y - g.c;
          if (alt < top && dx * dx + dy * dy < 100 * 100) return 'hit';
          break;
        }
        case 2: { // タービン
          const ax = turbineAxis(g);
          if (Math.abs(alt - ax) < 62) {
            const dx = X - g.X, dy = Y - g.c;
            const r = Math.hypot(dx, dy);
            if (r < g.w * 0.98) {
              const a = Math.atan2(dx, dy);
              for (let k = 0; k < 3; k++) {
                let d = a - (TAU * t / g.T + g.ph + k * TAU / 3);
                d = Math.atan2(Math.sin(d), Math.cos(d));
                if (Math.abs(d) < Math.atan2(40, Math.max(70, r))) return 'hit';
              }
            }
          }
          break;
        }
        case 3: { // 動く門
          if (Math.abs(X - g.X) < 34) {
            const oA = gateOpenA(g, t);
            if (alt < oA || alt > oA + GATE_H) return 'hit';
          }
          break;
        }
        case 4: case 5: { // 哨戒・追跡ドローン
          const p = dronePos(g, t, pl);
          if (sphHit(X, Y, alt, g.X, p.y, p.alt, 28)) return 'hit';
          break;
        }
        case 6: { // 浮遊機雷
          const p = minePos(g, t);
          if (sphHit(X, Y, alt, g.X, p.y, p.alt, 36)) return 'hit';
          break;
        }
        case 7: { // 走査レーザー
          if (Math.abs(X - g.X) < 260 && Math.abs(alt - laserAlt(g, t)) < 17) return 'hit';
          break;
        }
        case 8: { // ボーナスリング
          if (collected.has(g.i)) break;
          const vx = X - pl.px;
          if (vx === 0) break;
          const u = (g.X - pl.px) / vx;
          if (u >= 0 && u <= 1) {
            const yc = pl.py + (Y - pl.py) * u;
            const ac = pl.palt + (alt - pl.palt) * u;
            const rc = ringCenter(g, t);
            const dy = yc - rc.y, da = ac - rc.alt;
            if (dy * dy + da * da < rc.R * rc.R) {
              collected.add(g.i);
              return { bonus: BONUS, i: g.i };
            }
          }
          break;
        }
        case 9: break; // 突風は衝突なし
      }
    }
    return null;
  }

  // ---- 突風（横加速度 [m/s²]）----------------------------------------
  function windAt(X, t) {
    if (X < START - 800) return 0;
    for (const i of nearSlots(X)) {
      const g = at(i);
      if (!g || g.kind !== 9) continue;
      const d = Math.abs(X - g.X);
      if (d < 320) {
        const env = 1 - d / 320; // 縁で減衰
        return g.dir * 14 * env * (0.75 + 0.25 * Math.sin(t * 3 + g.ph));
      }
    }
    return 0;
  }

  // ---- 描画メッシュ（地表座標 [X, Y, alt, ...] の頂点組）--------------
  // cat: 0=hazard赤 / 1=caution黄 / 2=bonus cyan / 3=wind緑淡
  function line(p, a, b, c, x, y, al) { p.push(a, b, c, x, y, al); }
  function circleH(p, cx, cy, ca, r, seg) { // 水平面（X,Y）円
    for (let k = 0; k < seg; k++) {
      const a1 = (k / seg) * TAU, a2 = ((k + 1) / seg) * TAU;
      line(p, cx + Math.sin(a1) * r * 0.4, cy + Math.cos(a1) * r, ca,
        cx + Math.sin(a2) * r * 0.4, cy + Math.cos(a2) * r, ca);
    }
  }
  function circleVA(p, cx, cy, ca, r, seg) { // 鉛直 Y-alt 面円
    for (let k = 0; k < seg; k++) {
      const a1 = (k / seg) * TAU, a2 = ((k + 1) / seg) * TAU;
      line(p, cx, cy + Math.sin(a1) * r, ca + Math.cos(a1) * r,
        cx, cy + Math.sin(a2) * r, ca + Math.cos(a2) * r);
    }
  }
  function sphere(p, cx, cy, ca, r) {
    circleH(p, cx, cy, ca, r, 8);
    circleVA(p, cx, cy, ca, r, 8);
    circleVA(p, cx + r * 0.3, cy, ca, r, 6);
  }
  function box(p, cx, cy, ca, sx, sy, sa) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const a0 = ca - sa / 2, a1 = ca + sa / 2;
    for (const a of [a0, a1]) {
      line(p, x0, y0, a, x1, y0, a); line(p, x1, y0, a, x1, y1, a);
      line(p, x1, y1, a, x0, y1, a); line(p, x0, y1, a, x0, y0, a);
    }
    line(p, x0, y0, a0, x0, y0, a1); line(p, x1, y0, a0, x1, y0, a1);
    line(p, x1, y1, a0, x1, y1, a1); line(p, x0, y1, a0, x0, y1, a1);
  }

  function buildAll(t, x0, x1, plane) {
    const out = [];
    const i0 = Math.max(0, Math.floor((x0 - START) / SPACING) - 1);
    const i1 = Math.floor((x1 - START) / SPACING) + 1;
    for (let i = i0; i <= i1; i++) {
      const g = at(i);
      if (!g || g.X < x0 - 600 || g.X > x1 + 600) continue;
      const p = [];
      let cat = 0;
      switch (g.kind) {
        case 0: {
          const pc = pendCenter(g, t);
          line(p, g.X - 8, g.c, g.cl, g.X - 8, pc.y, pc.alt + 58);
          line(p, g.X + 8, g.c, g.cl, g.X + 8, pc.y, pc.alt + 58);
          sphere(p, g.X, pc.y, pc.alt, 58);
          break;
        }
        case 1: {
          const top = pistonTop(g, t);
          box(p, g.X, g.c, (g.f + top) / 2, 140, 180, top - g.f);
          break;
        }
        case 2: {
          cat = 1;
          const ax = turbineAxis(g);
          circleH(p, g.X, g.c, ax, 130, 10);
          for (let k = 0; k < 3; k++) {
            const a = TAU * t / g.T + g.ph + k * TAU / 3;
            const sx = Math.sin(a), sy = Math.cos(a);
            const r0 = 70, r1 = g.w * 0.95, hw = 38;
            const bx = g.X + sx * r0, by = g.c + sy * r0;
            const tx = g.X + sx * r1, ty = g.c + sy * r1;
            const px = Math.cos(a) * hw, py = -Math.sin(a) * hw;
            line(p, bx + px, by + py, ax, tx + px, ty + py, ax);
            line(p, bx - px, by - py, ax, tx - px, ty - py, ax);
            line(p, tx + px, ty + py, ax, tx - px, ty - py, ax);
          }
          break;
        }
        case 3: {
          cat = 1;
          const oA = gateOpenA(g, t);
          box(p, g.X, g.c, (g.f + oA) / 2, 40, 2 * g.w, Math.max(40, oA - g.f));
          box(p, g.X, g.c, (oA + GATE_H + g.cl) / 2, 40, 2 * g.w,
            Math.max(40, g.cl - oA - GATE_H));
          for (const a of [oA, oA + GATE_H]) {
            line(p, g.X, g.c - g.w, a, g.X, g.c + g.w, a);
          }
          break;
        }
        case 4: case 5: {
          const d = dronePos(g, t, plane);
          const X = g.X, Y = d.y, A = d.alt;
          line(p, X + 26, Y, A, X - 18, Y + 20, A - 14);
          line(p, X + 26, Y, A, X - 18, Y - 20, A - 14);
          line(p, X + 26, Y, A, X - 8, Y, A + 24);
          line(p, X - 18, Y + 20, A - 14, X - 18, Y - 20, A - 14);
          line(p, X - 18, Y + 20, A - 14, X - 8, Y, A + 24);
          line(p, X - 18, Y - 20, A - 14, X - 8, Y, A + 24);
          break;
        }
        case 6: {
          const m = minePos(g, t);
          sphere(p, g.X, m.y, m.alt, 30);
          for (let k = 0; k < 3; k++) {
            const a = k * Math.PI / 3;
            const dx = Math.cos(a) * 48, da = Math.sin(a) * 48;
            line(p, g.X - dx, m.y, m.alt - da, g.X + dx, m.y, m.alt + da);
          }
          break;
        }
        case 7: {
          const la = laserAlt(g, t);
          for (const off of [-160, 0, 160]) {
            line(p, g.X + off, g.c - g.w, la, g.X + off, g.c + g.w, la);
          }
          box(p, g.X - 260, g.c - g.w + 40, la, 60, 80, 80);
          box(p, g.X + 260, g.c + g.w - 40, la, 60, 80, 80);
          break;
        }
        case 8: {
          if (collected.has(g.i)) break;
          cat = 2;
          const rc = ringCenter(g, t);
          circleVA(p, g.X, rc.y, rc.alt, rc.R, 16);
          circleVA(p, g.X, rc.y, rc.alt, rc.R - 24, 16);
          for (let k = 0; k < 4; k++) {
            const a = k * Math.PI / 2 + t * 0.5;
            line(p, g.X, rc.y + Math.sin(a) * (rc.R - 24), rc.alt + Math.cos(a) * (rc.R - 24),
              g.X, rc.y + Math.sin(a) * rc.R, rc.alt + Math.cos(a) * rc.R);
          }
          break;
        }
        case 9: {
          cat = 3;
          for (let k = 0; k < 6; k++) {
            const y = g.c + (hash(7000 + i * 10 + k) * 2 - 1) * g.w * 0.85;
            const a = g.f + 200 + hash(7500 + i * 10 + k) * (g.cl - g.f - 400);
            const drift = 120 * Math.sin(t * 1.5 + k * 1.3 + g.ph);
            line(p, g.X - 300 + drift, y, a, g.X + 300 + drift, y, a);
          }
          break;
        }
      }
      if (p.length) out.push({ cat, pts: p });
    }
    return out;
  }

  global.Gimmicks = {
    START, SPACING, BONUS,
    at, check, windAt, buildAll, reset,
    collected,
    kinds: ['PENDULUM', 'PISTON', 'TURBINE', 'GATE', 'SENTRY',
      'SEEKER', 'MINE', 'LASER', 'RING', 'GUST'],
  };
})(globalThis);
