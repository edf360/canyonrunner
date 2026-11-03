/**
 * physics.js — P2V-7 線形飛行モデル
 *
 * 状態ベクトル x[12]（地表座標系・Z下向き正）:
 *   [0] u      前進速度の摂動 [m/s]（対気速度 = U0 + u）
 *   [1] alpha  迎角 [rad]
 *   [2] q      ピッチ角速度 [rad/s]
 *   [3] theta  ピッチ角（機首上げ正）[rad]
 *   [4] beta   側滑角 [rad]
 *   [5] p      ロール角速度（右翼下げ正）[rad/s]
 *   [6] r      ヨー角速度（機首右正）[rad/s]
 *   [7] phi    ロール角（右翼下げ正）[rad]
 *   [8] psi    ヨー角（方角）[rad]
 *   [9] X      北方向位置 [m]（本作では「峡谷の奥行き＝スコア方向」）
 *   [10] Y     東方向位置 [m]
 *   [11] Z     下向き正位置 [m]（高度 = -Z）
 *
 * クラシックスクリプト共有方式: ブラウザは <script src>、
 * Node ヘッドレステストは readFileSync + new Function で同一コードを検証する。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------
  // 定数・有次元安定微係数（レポート §3.3 の値をそのまま）
  // ---------------------------------------------------------------
  const G = 9.81;
  const U0 = 293.8;
  const W0 = 0.0;
  const THETA0 = 0.0;

  // 縦
  const Xu = -0.0215, Zu = -0.227, Mu = 0.0;
  const Xa = 14.7, Za = -236.0, Ma = -3.78, Madot = -0.28;
  const Zq = -5.76, Mq = -0.992;
  const Zde = -12.9, Zdt = 0.0, Mde = -2.48, Mdt = 0.0, Xdt = 0.0;

  // 横・方向
  const Yb = -45.4, Lb = -1.71, Nb = 0.986;
  const Yp = 0.716, Lp = -0.962, Np = -0.0632;
  const Yr = 2.66, Lr = 0.271, Nr = -0.215;
  const Lda = 1.72, Nda = -0.0436;
  const Ydr = 9.17, Ldr = 0.244, Ndr = -0.666;

  // スロットル拡張（レポート §5.1）: throttle=0.5 がつり合い
  const THROTTLE_GAIN = 1.6;

  // 初期条件
  const START_ALT = 300.0; // m（床に近い超低空で離陸 — 迫力重視）

  // 舵面の最大舵角 [rad]（フライトシミュレーター2 input.js SURFACE_LIMIT に統一）
  const ELEV_MAX = 0.35; // エレベータ
  const AIL_MAX = 0.50;  // エルロン
  // ラダーは Ydr=9.17 [m/s²/rad] が強く、0.5 rad 全舵は線形領域（β=数度）を
  // 大きく超えて側滑→発散ロール→見かけの上昇を起こすため、
  // 線形モデルの有効域に収まる 0.30 rad に抑える。
  const RUD_MAX = 0.30;  // ラダー

  // セーフガード（レポート §5.3）
  const U_MIN = 45.0 - U0; // 対気速度下限 45 m/s
  const U_MAX = 250.0;     // u 摂動の上限 [m/s]（V2 準拠: 対気速度 ≤ 543.8 m/s）
  const LIM = {
    alpha: 0.35, q: 2.5, theta: 1.45,
    beta: 0.22, p: 3.0, r: 1.5, // β は約12.6° でクリップ（線形領域の保護）
  };

  // ---------------------------------------------------------------
  // 定数行列（LTI なのでモジュール初期化時に一度だけ組む）
  // ---------------------------------------------------------------
  const ct0 = Math.cos(THETA0), st0 = Math.sin(THETA0);
  const tan0 = Math.tan(THETA0);

  // 縦 A（4x4, row-major）
  const AL = [
    Xu, Xa, -W0, -G * ct0,
    Zu / U0, Za / U0, 1 + Zq / U0, (G / U0) * st0,
    Mu + Madot * (Zu / U0), Ma + Madot * (Za / U0),
    Mq + Madot * (1 + Zq / U0), (Madot * G / U0) * st0,
    0, 0, 1, 0,
  ];
  // 縦 B（4x2, 入力の列は [δe, δt]。δt 項はスロットル補強で代替するため
  // 1列目（δe）のみ使用し、推力は THROTTLE_GAIN 項で与える）
  const B1 = [
    Xdt,
    Zde / U0,
    Mde + Madot * (Zde / U0),
    0,
  ];

  // 横・方向 A（5x5, 状態 [β,p,r,φ,ψ]）
  const AT = [
    Yb / U0, (W0 + Yp) / U0, Yr / U0 - 1, (G * ct0) / U0, 0,
    Lb, Lp, Lr, 0, 0,
    Nb, Np, Nr, 0, 0,
    0, 1, tan0, 0, 0,
    0, 0, 1 / ct0, 0, 0,
  ];
  // 横・方向 B（5x2, 入力の列は [δa, δr]）
  const BT = [
    0, Ydr / U0,
    Lda, Ldr,
    Nda, Ndr,
    0, 0,
    0, 0,
  ];

  // ---------------------------------------------------------------
  // 導関数 dx/dt = f(x, ctrl)
  // ---------------------------------------------------------------
  const _t1 = new Float64Array(12);
  const _t2 = new Float64Array(12);
  const _t3 = new Float64Array(12);
  const _t4 = new Float64Array(12);
  const _tmp = new Float64Array(12);

  // 線形上限ガード: 上限に達していてさらに外へ押す微分量のみゼロにする
  // （内側への運動は許可 — レポート §5.3）
  function guard(x, d) {
    if (x[0] < U_MIN && d[0] < 0) d[0] = 0;
    if (x[0] > U_MAX && d[0] > 0) d[0] = 0;
    if (x[1] > LIM.alpha && d[1] > 0) d[1] = 0;
    else if (x[1] < -LIM.alpha && d[1] < 0) d[1] = 0;
    if (x[2] > LIM.q && d[2] > 0) d[2] = 0;
    else if (x[2] < -LIM.q && d[2] < 0) d[2] = 0;
    if (x[3] > LIM.theta && d[3] > 0) d[3] = 0;
    else if (x[3] < -LIM.theta && d[3] < 0) d[3] = 0;
    if (x[4] > LIM.beta && d[4] > 0) d[4] = 0;
    else if (x[4] < -LIM.beta && d[4] < 0) d[4] = 0;
    if (x[5] > LIM.p && d[5] > 0) d[5] = 0;
    else if (x[5] < -LIM.p && d[5] < 0) d[5] = 0;
    if (x[6] > LIM.r && d[6] > 0) d[6] = 0;
    else if (x[6] < -LIM.r && d[6] < 0) d[6] = 0;
  }

  /** x, ctrl から dx/dt を out に書く（ガード適用後） */
  function deriv(x, ctrl, out) {
    const x0 = x[0], x1 = x[1], x2 = x[2], x3 = x[3];
    const x4 = x[4], x5 = x[5], x6 = x[6], x7 = x[7], x8 = x[8];

    const de = ctrl.elevator * ELEV_MAX; // 負値で機首上げ
    const da = ctrl.aileron * AIL_MAX;   // 正値で右ロール
    const dr = ctrl.rudder * RUD_MAX;    // 正値で機首左ヨー

    // ---- 縦（状態 0..3, 入力 δe + スロットル補強）----
    let d0 = AL[0] * x0 + AL[1] * x1 + AL[2] * x2 + AL[3] * x3;
    let d1 = AL[4] * x0 + AL[5] * x1 + AL[6] * x2 + AL[7] * x3;
    let d2 = AL[8] * x0 + AL[9] * x1 + AL[10] * x2 + AL[11] * x3;

    // ---- 姿勢運動学: 完全3-2-1オイラー ----------------------------------
    // 参考記事（Qiita「飛行機の運動をシミュレートするプログラムをつくる」）の
    // 回転行列 R = Rz(ψ)·Ry(θ)·Rx(φ) と同一規約の正確な姿勢運動学。
    // 線形近似（θ̇=q・φ̇=p・ψ̇=r）では バンク状態で操縦桿を引いた時の
    // 旋回（q·sinφ 項）が失われ「バンク90°で引いても旋回しない」ため、
    // 微小角では線形と一致した完全形式を使う。
    const sphi = Math.sin(x7), cphi = Math.cos(x7);
    const sin3 = Math.sin(x3);
    const cthK = Math.max(Math.cos(x3), 0.05); // θ は ±83° 制限なので発散保険
    const om = x2 * sphi + x6 * cphi;          // q·sinφ + r·cosφ（水平面内の旋回角速度）
    const d3 = x2 * cphi - x6 * sphi;          // θ̇ = q·cosφ − r·sinφ

    // スロットル拡張: 全開(1.0)で +1.6 m/s²、全閉(0.0)で -1.6 m/s²
    d0 += THROTTLE_GAIN * (ctrl.throttle - 0.5) * 2;
    d1 += B1[1] * de;
    d2 += B1[2] * de;

    // ---- 横・方向（状態 4..8, 入力 δa, δr）----
    const d4 = AT[0] * x4 + AT[1] * x5 + AT[2] * x6 + AT[3] * x7 + AT[4] * x8
      + BT[1] * dr;
    const d5 = AT[5] * x4 + AT[6] * x5 + AT[7] * x6 + BT[2] * da + BT[3] * dr;
    const d6 = AT[10] * x4 + AT[11] * x5 + AT[12] * x6 + BT[4] * da + BT[5] * dr;
    const d7 = x5 + om * (sin3 / cthK); // φ̇ = p + (q·sinφ + r·cosφ)·tanθ
    const d8 = om / cthK;               // ψ̇ = (q·sinφ + r·cosφ)/cosθ

    // ---- 位置の積分（機体座標系速度 → 地表座標系, レポート §3.4・§4）----
    const ub = Math.max(U0 + x0, 45.0);
    const vb = ub * Math.sin(x4);
    const wb = ub * Math.tan(x1);
    const cp = Math.cos(x8), sp = Math.sin(x8);
    const cth = Math.cos(x3), sth = Math.sin(x3);
    const cr = Math.cos(x7), sr = Math.sin(x7);

    const dX = (cp * cth) * ub + (cp * sth * sr - sp * cr) * vb + (cp * sth * cr + sp * sr) * wb;
    const dY = (sp * cth) * ub + (sp * sth * sr + cp * cr) * vb + (sp * sth * cr - cp * sr) * wb;
    // 鉛直速度 dZ から横滑り×バンク結合項 (cth*sr)*vb を除去した。
    // この項は「バンク時に横滑り速度 vb が鉛直へ射影」されて見かけ上の上昇・
    // 下降を生む（検証テストの診断でヨー入力の上昇の主因と特定）。
    // 実機では風向安定により定常 β が小さく影響は軽微だが、線形モデルは
    // 大きな定常 β を許すため除去する。水平面の dX/dY は不変なので
    // 旋回・バンク旋回の軌跡は維持される（超急態度の厳密性はわずかに低下）。
    const dZ = (-sth) * ub + (cth * cr) * wb;

    out[0] = d0; out[1] = d1; out[2] = d2; out[3] = d3;
    out[4] = d4; out[5] = d5; out[6] = d6; out[7] = d7; out[8] = d8;
    // ctrl.wind: 突風による地表系の東方向気流速度 [m/s]（Gimmicks が設定）
    out[9] = dX; out[10] = dY + (ctrl.wind || 0); out[11] = dZ;

    guard(x, out);
  }

  // 角度のラップ（-π, π]
  function wrap2pi(a) {
    if (a > Math.PI) return a - 2 * Math.PI;
    if (a < -Math.PI) return a + 2 * Math.PI;
    return a;
  }

  function clampState(x) {
    if (x[0] < U_MIN) x[0] = U_MIN;
    if (x[0] > U_MAX) x[0] = U_MAX;
    if (x[1] > LIM.alpha) x[1] = LIM.alpha; else if (x[1] < -LIM.alpha) x[1] = -LIM.alpha;
    if (x[2] > LIM.q) x[2] = LIM.q; else if (x[2] < -LIM.q) x[2] = -LIM.q;
    if (x[3] > LIM.theta) x[3] = LIM.theta; else if (x[3] < -LIM.theta) x[3] = -LIM.theta;
    if (x[4] > LIM.beta) x[4] = LIM.beta; else if (x[4] < -LIM.beta) x[4] = -LIM.beta;
    if (x[5] > LIM.p) x[5] = LIM.p; else if (x[5] < -LIM.p) x[5] = -LIM.p;
    if (x[6] > LIM.r) x[6] = LIM.r; else if (x[6] < -LIM.r) x[6] = -LIM.r;
    x[7] = wrap2pi(x[7]);
    x[8] = wrap2pi(x[8]);
  }

  /**
   * 1 ステップ RK4 積分（レポート §5.2: 固定 dt の RK4）
   * ctrl は一定とみなす。
   */
  function rk4Step(x, ctrl, dt) {
    const h = dt, h2 = dt * 0.5;
    deriv(x, ctrl, _t1);
    for (let i = 0; i < 12; i++) _tmp[i] = x[i] + h2 * _t1[i];
    deriv(_tmp, ctrl, _t2);
    for (let i = 0; i < 12; i++) _tmp[i] = x[i] + h2 * _t2[i];
    deriv(_tmp, ctrl, _t3);
    for (let i = 0; i < 12; i++) _tmp[i] = x[i] + h * _t3[i];
    deriv(_tmp, ctrl, _t4);
    for (let i = 0; i < 12; i++) x[i] += (h / 6) * (_t1[i] + 2 * _t2[i] + 2 * _t3[i] + _t4[i]);
    clampState(x);
  }

  // ---------------------------------------------------------------
  // シミュレータ
  // ---------------------------------------------------------------
  function createSim() {
    const x = new Float64Array(12);
    const ctrl = { elevator: 0, aileron: 0, rudder: 0, throttle: 0.5, wind: 0 };

    function reset() {
      x.fill(0);
      x[11] = -START_ALT; // 高度 START_ALT
      ctrl.elevator = 0;
      ctrl.aileron = 0;
      ctrl.rudder = 0;
      ctrl.throttle = 0.5;
      ctrl.wind = 0;
    }
    reset();

    return {
      x,
      ctrl,
      reset,
      /** 物理を 1 歩（dt 秒）進める。メインループ側で 1/120 s 固定で呼ぶ */
      step(dt) { rk4Step(x, ctrl, dt); },
      speed() { return U0 + x[0]; },   // 対気速度 [m/s]
      altitude() { return -x[11]; },   // 高度 [m]
    };
  }

  // ---------------------------------------------------------------
  // 公開
  // ---------------------------------------------------------------
  const FlightSim = {
    createSim,
    G, U0, START_ALT, THROTTLE_GAIN,
    ELEV_MAX, AIL_MAX, RUD_MAX,
    LIM, U_MIN, U_MAX,
    deriv, wrap2pi,
  };
  global.FlightSim = FlightSim;
})(globalThis);
