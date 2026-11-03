/**
 * canyon.js — 手続き生成ワイヤフレーム峡谷（共有モジュール）周回ステージ版
 *
 * 地表座標系（X=北=峡谷の奥行き/スコア方向, Y=東, 下=高度）。
 *  衝突はすべて解析的（メッシュ走査不要）:
 *    - 床:   高度 <= floorAlt(X)
 *    - 天井: 高度 >= ceilAlt(X)（トンネル区間では天井が床まで下りてくる）
 *    - 壁:   |Y - centerline(X)| > halfWidth(X)
 *    - 岩:   巨岩柱（円柱）中心からの水平距離 < radius + margin
 *
 *  描画用の崖壁・床・天井ポリラインも同じ関数群から生成するため、
 *  見た目と当たり判定は常に一致する。
 *
 * ---- 周回ステージ ---------------------------------------------------
 *  発進直線 4km の後、1周 40km を「緩急ついた 6 ステージ」で構成し、
 *  周回ごとに難易度係数 d = min(1.6, 1 + 0.12·周回) が振幅を強める。
 *
 *    CANYON(7km)  緩い蛇行でウォームアップ
 *    ROLLING(6km) 床が大きくうねる（升降舵の練習）
 *    NEEDLES(6km) 巨岩回避＋緩い起伏
 *    TUNNEL(7km)  天井が床まで下りる管。低空精密飛行
 *    BIG UP(6km)  床が高度300m超級まで登る丘。高度エネルギーの管理
 *    THE SLOT(8km) 狭い壁＋局所的な低い天井。総合力試し
 *
 *  すべて smoothstep エンベロープ（境界で値0・傾き0）でブレンドするため、
 *  ステージ境界に段差・曲率の跳ねが発生しない。
 *
 * クラシックスクリプト共有方式（physics.js と同じ）。
 */
(function (global) {
  'use strict';

  // ---- 峡谷パラメータ --------------------------------------------
  // 巡航 293.8 m/s・低速域でも追従できる緩やかな蛇行を基本に、
  // 小波で見た目と難しさの揺らぎを出す。
  const CHUNK = 600;        // チャンク長 [m]（ストリーミング単位）
  const SAMPLE = 25;        // 崖壁のサンプル間隔 [m]
  const CLIFF_H = 2000;     // 崖の高さ [m]（天井の基準）
  const ROCK_H = 3000;      // 巨岩柱の高さ [m]（天井より高く、横に避けるしかない）
  const ROCK_START = 6000;  // 巨岩の出現開始距離 [m]（序盤 CANYON から現れる）
  const ROCK_STRIDE = 1800; // 巨岩の平均間隔 [m]
  const ROCK_MARGIN = 8;    // 巨岩衝突マージン [m]（機体ハーフサイズ程度）

  // 曲率予算 κ ≒ A(2π/L)²。巡航 293.8 m/s で 25° バンクに相当する
  // κ ≒ 2.4e-5 [1/m] に収まるよう振幅を抑える（数値検証で <28° を確認）。
  const A1 = 2200, L1 = 90000;
  const A2 = 450,  L2 = 45000;
  const A3 = 90,   L3 = 20000;

  const WIDTH_BASE = 520;   // 峡谷半幅の基準 [m]
  const WIDTH_VAR = 380;    // 半幅のうねり幅 [m]（半幅 520〜900 → 全幅 1040〜1800）

  // ---- 周回ステージ表 ---------------------------------------------
  const INTRO = 4000;   // 発進直線 [m]
  const LAP = 40000;    // 1周 [m]
  const STAGES = [
    { name: 'CANYON',   end: 7000  },
    { name: 'ROLLING',  end: 13000 },
    { name: 'NEEDLES',  end: 19000 },
    { name: 'TUNNEL',   end: 26000 },
    { name: 'BIG UP',   end: 32000 },
    { name: 'THE SLOT', end: 40000 },
  ];

  // ステージ情報 {idx:-1..5, u:0..1, d:難易度, lap:周回, name, len}
  function stageAt(X) {
    if (X < INTRO) return { idx: -1, u: 0, d: 1, lap: 0, name: 'LAUNCH', len: INTRO };
    const t = X - INTRO;
    const lap = Math.floor(t / LAP);
    const u_l = t - lap * LAP;
    let idx = 0;
    while (idx < STAGES.length - 1 && u_l >= STAGES[idx].end) idx++;
    const start = idx === 0 ? 0 : STAGES[idx - 1].end;
    const len = STAGES[idx].end - start;
    const d = Math.min(1.6, 1 + 0.12 * lap);
    return { idx, u: (u_l - start) / len, d, lap, name: STAGES[idx].name, len };
  }

  // ---- シード付き乱数 ---------------------------------------------
  let seed = 1337;
  if (typeof location !== 'undefined' && location.hash) {
    const m = location.hash.match(/seed=(\d+)/);
    if (m) seed = parseInt(m[1], 10) | 0;
  }
  function setCanyonSeed(s) { seed = s | 0; }

  // 整数ハッシュ [0,1)（再現性必須・float 誤差に依存しない整数演算のみ）
  function hash(n) {
    let t = (seed + n) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // 1D 値ノイズ（コサイン補間）
  function vnoise(x, step, salt) {
    const i = Math.floor(x / step);
    const f = (x - i * step) / step;
    const a = hash(salt + i * 2 + 1);
    const b = hash(salt + i * 2 + 3);
    const s = (1 - Math.cos(f * Math.PI)) * 0.5;
    return a + (b - a) * s;
  }

  // ---- センターライン ----------------------------------------------
  function ramp(X) {
    if (X <= 0) return 0;
    if (X >= 5000) return 1;
    const t = X / 5000;
    return t * t * (3 - 2 * t);
  }

  // センターライン: A·σ·(1-cos(2πX/L)) 形の和。
  //   - X=0 で値 0・傾き 0（真北へ発進してそのまま滑らかにカーブに入れる）
  //   - 曲率の絶対値上限は Σ A_i(2π/L_i)² ≒ 2.8e-5 [1/m]（半径約 36km）で、
  //     巡航 293.8 m/s でも必要バンクは約 14° 以内（ramp 由来の交差項がない）
  //   - σ はシード付きの符号で波の向きにばらつきを出す
  function sigma(salt) {
    return hash(salt) < 0.5 ? 1 : -1;
  }

  function centerline(X) {
    if (X <= 0) return 0;
    return (
      A1 * sigma(11) * (1 - Math.cos((2 * Math.PI * X) / L1)) +
      A2 * sigma(22) * (1 - Math.cos((2 * Math.PI * X) / L2)) +
      A3 * sigma(33) * (1 - Math.cos((2 * Math.PI * X) / L3))
    );
  }

  // ---- 半幅（THE SLOT で局所的に狭まる） ----------------------------
  // 両端で値0・傾き0の C1 エンベロープ
  function env(u, fe) {
    if (fe === undefined) fe = 0.16;
    const a = Math.min(1, Math.max(0, u / fe));
    const b = Math.min(1, Math.max(0, (1 - u) / fe));
    const sa = a * a * (3 - 2 * a);
    const sb = b * b * (3 - 2 * b);
    return sa * sb;
  }

  function halfWidth(X) {
    if (X <= 0) return WIDTH_BASE + WIDTH_VAR;
    const n = vnoise(X, 3500, 5000); // ゆったり うねる 半幅
    let w = WIDTH_BASE + WIDTH_VAR * n + (1 - ramp(X)) * 300;
    if (X >= INTRO) {
      const st = stageAt(X);
      if (st.idx === 5) { // THE SLOT: 半幅 150m 前後まで絞る
        const e = env(st.u, 0.14);
        const narrow = Math.min(0.7, e * (0.6 + 0.16 * (st.d - 1)));
        w = w * (1 - narrow) + narrow * 150;
      }
    }
    return w;
  }

  // ---- 床高度 -------------------------------------------------------
  // 各ステージは env で包まれた波。波はステージ長に整列（u が波の位相）
  // なので境界で値0・傾き0、接続は C1。
  // 傾き予算: 最大勾配 ≤ tan14° ≈ 0.25 を目標（テスト7で実測検証）。
  // 巡航 ~294 m/s でも追従できる緩やかな波形（波長 ≥ 一段階）。
  // BIG UP の丘（最大勾配 ~22°）は「減速を要求する」意図的な挑戦。
  const FLOOR_W = [
    null,
    { A: 90, n: 1, fe: 0.25 },   // ROLLING: 波長6km のうねり
    { A: 110, n: 1, fe: 0.25 },  // NEEDLES: 緩いうねり
    { A: 120, n: 1, fe: 0.3 },   // TUNNEL: 管内の緩やかな起伏
    { A: 240, n: 1, fe: 0.3 },   // BIG UP: 単一の丘（頂まで約240·d m）
    { A: 80, n: 1, fe: 0.2 },    // THE SLOT: 低いうねり
  ];
  function floorAlt(X) {
    if (X < INTRO) return 0;
    const st = stageAt(X);
    const w = FLOOR_W[st.idx];
    if (!w) return 0;
    const u = st.u;
    // BIG UP は単一山（u=0.5 で頂）、他は n 個の full 波
    if (st.idx === 4) {
      const s = Math.sin(Math.PI * u);
      return env(u, w.fe) * w.A * st.d * s * s;
    }
    return env(u, w.fe) * w.A * st.d * 0.5 * (1 - Math.cos(2 * Math.PI * w.n * u));
  }

  // ---- 天井高度 -----------------------------------------------------
  // 通常は CLIFF_H。
  //  勾配予算: 高度変化率 ≤ ~25°（294 m/s で降下・上昇可能な範囲）。
  //  TUNNEL: ポータル（入口・出口）を 3.5km の緩やかな降下斜面にして
  //  中央で天井が床上方 900-100(d-1) m まで下りる。管内は天井が揺れる。
  //  THE SLOT: u=0.25/0.75 の 2 箇所で天井が 1200m 前後まで下りる。
  function ceilAlt(X) {
    if (X < INTRO) return CLIFF_H;
    const st = stageAt(X);
    const f = floorAlt(X);
    const hf = CLIFF_H - f;
    if (st.idx === 3) {
      const e = env(st.u, 0.5);
      const minGap = 900 - 100 * (st.d - 1);
      const ripple = e * 90 * Math.sin(4 * Math.PI * st.u);
      return f + (hf - e * (hf - minGap)) + ripple;
    }
    if (st.idx === 5) {
      const s = Math.sin(2 * Math.PI * st.u);
      const e = s * s; // 値0・傾き0（u=0,0.5,1 で 0、u=0.25/0.75 で峰）
      const minGap = 1200;
      return f + (hf - e * (hf - minGap));
    }
    return CLIFF_H;
  }

  // ---- 巨岩柱 ------------------------------------------------------
  // 巨岩 n (n>=0) の位置・寸法（決定論的）。
  // 約 6km（CANYON ステージ）以降、トンネル区間を除く全ステージに出現する。
  // トンネル内は天井と干渉するため除外（床〜天井が管になるため）。
  // 通路余裕保証: |Y-c| ≤ hw/2 - r - 70 なので常に 70m+α の隙間が残る。
  function rockAt(n) {
    if (n < 0) return null;
    const X = ROCK_START + n * ROCK_STRIDE + (hash(1000 + n) - 0.5) * 900;
    const st = stageAt(X);
    if (st.idx === 3) return null; // TUNNEL 内には巨岩を置かない
    const c = centerline(X);
    const w = halfWidth(X);
    const r = 60 + hash(3000 + n) * 70; // 半径 60〜130 m
    const span = Math.max(0, w * 0.5 - r - 70);
    const Y = c + (hash(2000 + n) * 2 - 1) * span;
    return { X, Y, r, h: ROCK_H };
  }

  // X 付近の巨岩を走査して衝突を返す（なければ null）
  function rockHit(X, Y) {
    if (X < ROCK_START - 300) return null;
    const n0 = Math.max(0, Math.floor((X - ROCK_START) / ROCK_STRIDE) - 1);
    for (let n = n0; n <= n0 + 3; n++) {
      const rk = rockAt(n);
      if (!rk) continue;
      if (Math.abs(rk.X - X) > rk.r + 400) continue;
      const dx = X - rk.X, dy = Y - rk.Y;
      if (dx * dx + dy * dy < (rk.r + ROCK_MARGIN) * (rk.r + ROCK_MARGIN)) {
        return rk;
      }
    }
    return null;
  }

  // ---- 総合衝突判定 -------------------------------------------------
  // 返り値: null=セーフ / 'ground' / 'ceiling' / 'wall' / 'rock'
  function checkCollision(X, Y, alt) {
    if (alt <= floorAlt(X)) return 'ground';
    if (alt >= ceilAlt(X)) return 'ceiling';
    const c = centerline(X);
    const w = halfWidth(X);
    if (Math.abs(Y - c) > w) return 'wall';
    if (rockHit(X, Y)) return 'rock';
    return null;
  }

  // ---- 描画用ジオメトリ生成 ----------------------------------------
  // 返り値は地表座標系の頂点列 (X, alt, Y)。index.html 側で
  // three.js 座標 (Y, alt, -X) へ変換して LineSegments にする。

  // チャンク k の崖壁（左右）・床グリッド・トンネル天井の
  // LineSegments 用頂点配列
  function buildWallChunk(k) {
    const x0 = k * CHUNK;
    const x1 = x0 + CHUNK;
    const left = [];
    const right = [];
    const floor = [];
    const ceil = [];
    const H = CLIFF_H;

    let px = null; // 前サンプル (x, c, w, f, cl)
    let si = 0;    // サンプルインデックス

    for (let x = x0; x <= x1 + 1e-6; x += SAMPLE, si++) {
      const c = centerline(x);
      const w = halfWidth(x);
      const f = floorAlt(x);
      const cl = ceilAlt(x);
      const yl = c - w;
      const yr = c + w;

      // 崖壁 垂直線（床〜崖上）
      left.push(x, f, yl, x, H, yl);
      right.push(x, f, yr, x, H, yr);

      // 床グリッド 横断線（100m ごと）
      if (si % 4 === 0) {
        floor.push(x, f, yl, x, f, yr);
      }

      // トンネル（天井が崖より十分低い区間）
      const inTunnel = cl < H - 20;
      if (inTunnel) {
        // 天井の縁（縦断線）を前後サンプルで結ぶ
        if (px !== null && px.cl < H - 20) {
          ceil.push(px.x, px.cl, px.l, x, cl, yl);
          ceil.push(px.x, px.cl, px.r, x, cl, yr);
        }
        // リブ（横断輪郭）とプラグ線（150m ごと）
        if (si % 6 === 0) {
          ceil.push(x, cl, yl, x, cl, yr);
          ceil.push(x, cl, yl, x, H, yl);
          ceil.push(x, cl, yr, x, H, yr);
        }
      }

      if (px !== null) {
        // 崖壁 水平線（裾・中段・天辺）
        for (let li = 0; li < 3; li++) {
          const h = [0, H * 0.55, H][li];
          left.push(px.x, h, px.l, x, h, yl);
          right.push(px.x, h, px.r, x, h, yr);
        }
        // 対角 brace（ワイヤーフレームに奥行き感）
        left.push(px.x, f, px.l, x, H, yl);
        right.push(px.x, H, px.r, x, f, yr);
        // 床グリッド 縦断線（5本）
        for (let li = 0; li < 5; li++) {
          const t0 = li / 4;
          floor.push(
            px.x, px.f, px.l + (px.r - px.l) * t0,
            x, f, yl + (yr - yl) * t0
          );
        }
      }
      px = { x, l: yl, r: yr, f, cl };
    }
    return {
      left: new Float32Array(left),
      right: new Float32Array(right),
      floor: new Float32Array(floor),
      ceil: new Float32Array(ceil),
    };
  }

  // 巨岩 n のワイヤーフレーム円柱の頂点配列（地表座標系）
  function buildRock(n) {
    const rk = rockAt(n);
    if (!rk) return null;
    const base = floorAlt(rk.X);
    const seg = 10;
    const rings = 6;
    const pts = [];
    // 縦線
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 0.5) / seg) * Math.PI * 2;
      const x0 = rk.X + Math.cos(a0) * rk.r, y0 = rk.Y + Math.sin(a0) * rk.r;
      const x1 = rk.X + Math.cos(a1) * rk.r, y1 = rk.Y + Math.sin(a1) * rk.r;
      pts.push(x0, base, y0, x1, rk.h, y1); // 交差する斜線
    }
    // 水平リング
    for (let j = 0; j <= rings; j++) {
      const h = base + (rk.h - base) * (j / rings);
      const wv = 1 + 0.18 * Math.sin(j * 2.4 + n); // 岩ぼこ
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        pts.push(
          rk.X + Math.cos(a0) * rk.r * wv, h, rk.Y + Math.sin(a0) * rk.r * wv,
          rk.X + Math.cos(a1) * rk.r * wv, h, rk.Y + Math.sin(a1) * rk.r * wv
        );
      }
    }
    return { rock: rk, pos: new Float32Array(pts) };
  }

  // ---- 公開 ----------------------------------------------------------
  const Canyon = {
    CHUNK, SAMPLE, CLIFF_H, ROCK_H, ROCK_START, ROCK_STRIDE, INTRO, LAP,
    setCanyonSeed,
    stageAt,
    centerline, halfWidth, floorAlt, ceilAlt,
    rockAt, rockHit, checkCollision,
    buildWallChunk, buildRock,
  };
  global.Canyon = Canyon;
})(globalThis);
