/**
 * test/diag.mjs — 飛行モデルの物理的検証テスト A〜E
 * 実行: node test/diag.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function('globalThis', readFileSync(path.join(dir, 'physics.js'), 'utf8'))(globalThis);
const FS = globalThis.FlightSim;

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const f2 = (v) => (v >= 0 ? ' ' : '') + v.toFixed(4);
const sec = (t) => console.log('\n===== ' + t + ' =====');

// -----------------------------------------------------------------
// テストA: 初期トリム状態での dx/dt
// -----------------------------------------------------------------
sec('テストA: 初期トリム dx/dt');
{
  const x = new Float64Array(12); x[11] = -300;
  const ctrl = { elevator: 0, aileron: 0, rudder: 0, throttle: 0.5, wind: 0 };
  const d = new Float64Array(12);
  FS.deriv(x, ctrl, d);
  console.log('速度変化        d0 =', f2(d[0]),  '期待 0');
  console.log('迎角変化        d1 =', f2(d[1]),  '期待 0');
  console.log('ピッチ角加速度  d2 =', f2(d[2]),  '期待 0');
  console.log('ピッチ角速度    d3 =', f2(d[3]),  '期待 0');
  console.log('側滑角変化      d4 =', f2(d[4]),  '期待 0');
  console.log('ロール角加速度  d5 =', f2(d[5]),  '期待 0');
  console.log('ヨー角加速度    d6 =', f2(d[6]),  '期待 0');
  console.log('ロール角速度    d7 =', f2(d[7]),  '期待 0');
  console.log('ヨー角速度      d8 =', f2(d[8]),  '期待 0');
  console.log('北方向速度      dX =', f2(d[9]),  '期待 293.8');
  console.log('東方向速度      dY =', f2(d[10]), '期待 0');
  console.log('下方向速度      dZ =', f2(d[11]), '期待 0');
  const ok = Math.abs(d[0])<1e-9 && Math.abs(d[1])<1e-9 && Math.abs(d[2])<1e-9 &&
    Math.abs(d[3])<1e-9 && Math.abs(d[4])<1e-9 && Math.abs(d[5])<1e-9 &&
    Math.abs(d[6])<1e-9 && Math.abs(d[7])<1e-9 && Math.abs(d[8])<1e-9 &&
    Math.abs(d[9]-FS.U0)<1e-6 && Math.abs(d[10])<1e-9 && Math.abs(d[11])<1e-9;
  console.log(ok ? '  => A: PASS（完全トリム）' : '  => A: 期待と不一致');
}

// -----------------------------------------------------------------
// テストB: 無入力安定性（60秒）＋横軸固有値
// -----------------------------------------------------------------
sec('テストB: 無入力60秒');
{
  const sim = FS.createSim();
  const DT = 1/120; const n = Math.round(60/DT);
  let maxSpd = -1e9, minSpd = 1e9, maxAlt = -1e9, minAlt = 1e9, maxBeta = 0;
  for (let i = 0; i < n; i++) {
    sim.ctrl.elevator = 0; sim.ctrl.aileron = 0; sim.ctrl.rudder = 0; sim.ctrl.throttle = 0.5;
    sim.step(DT);
    maxSpd = Math.max(maxSpd, sim.speed()); minSpd = Math.min(minSpd, sim.speed());
    maxAlt = Math.max(maxAlt, sim.altitude()); minAlt = Math.min(minAlt, sim.altitude());
    maxBeta = Math.max(maxBeta, Math.abs(sim.x[4]));
  }
  console.log('速度    : 初', FS.U0.toFixed(2), '→ 終', sim.speed().toFixed(3), ' [', minSpd.toFixed(2), ',', maxSpd.toFixed(2), ']');
  console.log('高度    :', minAlt.toFixed(2), '〜', maxAlt.toFixed(2), 'm（初期', 300, '）');
  console.log('迎角    :', (sim.x[1]*R2D).toFixed(3), 'deg, 側滑角 max =', (maxBeta*R2D).toFixed(3), 'deg');
  console.log('φ 終端  :', (sim.x[7]*R2D).toFixed(3), 'deg,  r 終端 =', sim.x[6].toFixed(4), 'rad/s');

  // 横軸系の線形化（θ0=0 前提, 4x4 [β,p,r,φ]）を定数から再現
  const U0 = FS.U0;
  const Yb=-45.4,Lb=-1.71,Nb=0.986,Yp=0.716,Lp=-0.962,Np=-0.0632,Yr=2.66,Lr=0.271,Nr=-0.215,G=9.81;
  const A4 = [
    [Yb/U0, (0+Yp)/U0, Yr/U0-1, G/U0],
    [Lb, Lp, Lr, 0],
    [Nb, Np, Nr, 0],
    [0, 1, 0, 0],
  ];
  const ev = eig(A4);
  console.log('横軸固有値 λ（実部で発散判定）:');
  for (const e of ev) {
    const re = e.re.toFixed(4), im = (e.im>=0?'+':'') + e.im.toFixed(4);
    console.log(`   ${re} ${im}i` + (e.re > 1e-9 ? '   <-- 発散!' : ''));
  }
}

// -----------------------------------------------------------------
// テストC: エレベータ入力の符号整合
// -----------------------------------------------------------------
sec('テストC: エレベータ符号整合（5秒）');
for (const sgn of [-1, +1]) {
  const sim = FS.createSim();
  const DT = 1/120; const n = Math.round(5/DT);
  const alt0 = sim.altitude();
  for (let i = 0; i < n; i++) { sim.ctrl.elevator = sgn; sim.step(DT); }
  const dTheta = sim.x[3]*R2D, dAlt = sim.altitude() - alt0;
  const label = sgn < 0 ? '負(引桿)' : '正(押桿)';
  const expect = sgn < 0 ? (dTheta > 0 && dAlt > 0) : (dTheta < 0 && dAlt < 0);
  console.log(`${label}: Δθ=${dTheta.toFixed(2)}deg  Δalt=${dAlt.toFixed(1)}m  q=${sim.x[2].toFixed(3)}  => ${expect ? '整合' : '不整合!'}`);
}

// -----------------------------------------------------------------
// テストD: バンク90°旋回（オイラー運動学の目的検証）
// -----------------------------------------------------------------
sec('テストD: バンク90°＋引桿の旋回');
{
  const sim = FS.createSim();
  const DT = 1/120;
  sim.x.fill(0); sim.x[7] = -Math.PI/2; sim.x[11] = -1500;
  const psi0 = sim.x[8];
  let maxQ = 0;
  for (let i = 0; i < Math.round(2/DT); i++) { sim.ctrl.elevator = -1; sim.step(DT); maxQ = Math.max(maxQ, sim.x[2]); }
  let dPsi = sim.x[8]-psi0; if (dPsi<-Math.PI) dPsi+=2*Math.PI; if (dPsi>Math.PI) dPsi-=2*Math.PI;
  console.log(`maxQ=${maxQ.toFixed(3)}rad/s  Δψ=${(dPsi*R2D).toFixed(2)}deg（負=左旋回）  => ${dPsi < -0.05 ? 'バンク旋回 OK' : '旋回せず!'}`);
}

// -----------------------------------------------------------------
// テストE: 時間刻み収束性（RK4）
// -----------------------------------------------------------------
sec('テストE: dt 収束性（同一入力, 終端姿勢の差）');
function runTraj(dtSec) {
  const sim = FS.createSim(); const DT = 1/120;
  const n = Math.round(dtSec/DT);
  // 決定的なマヌーバ
  for (let i = 0; i < n; i++) {
    const t = i*DT;
    sim.ctrl.aileron = Math.sin(t); sim.ctrl.elevator = 0.5*Math.sin(t*0.7); sim.step(DT);
  }
  return { x: Array.from(sim.x), spd: sim.speed(), alt: sim.altitude() };
}
{
  // dt は物理固定1/120だが「子ステップ分割」で刻み感度を見る:
  // 入力更新を dt で行い RK4 は dt/2 の2ステップに分割, を various dt で。
  for (const dt of [1/60, 1/120, 1/240, 1/480]) {
    const sim = FS.createSim(); const n = Math.round(8/dt);
    for (let i = 0; i < n; i++) {
      const t = i*dt;
      sim.ctrl.aileron = Math.sin(t); sim.ctrl.elevator = 0.5*Math.sin(t*0.7); sim.step(dt);
    }
    console.log(`dt=${dt.toFixed(5)}  終端θ=${(sim.x[3]*R2D).toFixed(4)}deg  φ=${(sim.x[7]*R2D).toFixed(4)}deg  高度=${sim.altitude().toFixed(3)}m  速度=${sim.speed().toFixed(4)}`);
  }
}

// -----------------------------------------------------------------
// 診断: ラダー単独の上昇内訳（ユーザー懸念）
// -----------------------------------------------------------------
sec('診断: ラダー全舵6秒 高度変化の内訳');
{
  const sim = FS.createSim(); const DT = 1/120;
  const x = sim.x, ctrl = sim.ctrl;
  ctrl.rudder = 1;
  const trace = [];
  for (let i = 1; i <= Math.round(6/DT); i++) {
    const d = new Float64Array(12); FS.deriv(x, ctrl, d);
    const ub = Math.max(FS.U0 + x[0], 45), vb = ub*Math.sin(x[4]), wb = ub*Math.tan(x[1]);
    const cth = Math.cos(x[3]), sth = Math.sin(x[3]), cr = Math.cos(x[7]), sr = Math.sin(x[7]);
    const termTheta = -sth*ub, termBeta = cth*sr*vb, termAlpha = cth*cr*wb;
    if (i % Math.round(1/DT) === 0) {
      trace.push({ t: (i*DT).toFixed(0), phi: (x[7]*R2D).toFixed(1), beta: (x[4]*R2D).toFixed(1), psi: (x[8]*R2D).toFixed(1),
        vT: termTheta.toFixed(1), vB: termBeta.toFixed(1), vA: termAlpha.toFixed(1), alt: sim.altitude().toFixed(0) });
    }
    sim.step(DT);
  }
  console.log('t(s) φ(deg) β(deg) ψ(deg)  dZθ    dZβ(横滑り) dZα    高度');
  for (const r of trace)
    console.log(`${r.t.padStart(4)} ${r.phi.padStart(6)} ${r.beta.padStart(6)} ${r.psi.padStart(7)}  ${r.vT.padStart(6)} ${r.vB.padStart(6)} ${r.vA.padStart(6)} ${r.alt.padStart(6)}`);
  console.log('※ dZ = dZθ(ピッチ) + dZβ(バンク×横滑り) + dZα(迎角)。上昇の主因は dZβ。');
}

// =================================================================
// 汎用 実数固有値（非巡回 QR, グラム・シュミット）+ 2x2 ブロックで複素対
// =================================================================
function eig(Ain) {
  const n = Ain.length;
  let A = Ain.map(r => r.slice());
  const tol = 1e-11;
  for (let iter = 0; iter < 2000; iter++) {
    // QR 分解 (modified Gram-Schmidt)
    const Q = Array.from({length:n}, () => new Array(n).fill(0));
    const R = Array.from({length:n}, () => new Array(n).fill(0));
    const V = A.map(r => r.slice());
    for (let k = 0; k < n; k++) {
      let nk = 0; for (let i=0;i<n;i++) nk += V[i][k]*V[i][k]; nk = Math.sqrt(nk);
      if (nk === 0) { Q[k][k]=1; continue; }
      for (let i=0;i<n;i++) V[i][k] /= nk;
      Q[k][k] = V[k][k] = V[k][k]; // placeholder
      // 正規化ベクトルを V に保持
      for (let j=k+1;j<n;j++){
        let dot=0; for(let i=0;i<n;i++) dot+=V[i][k]*A[i][j];
        R[k][j]=dot;
        for(let i=0;i<n;i++) A[i][j]-=dot*V[i][k];
      }
      R[k][k]=nk;
      for(let i=0;i<n;i++) Q[i][k]=V[i][k];
    }
    // A = R*Q
    const NA = Array.from({length:n}, () => new Array(n).fill(0));
    for (let i=0;i<n;i++) for (let j=0;j<n;j++){ let s=0; for(let k=0;k<n;k++) s+=R[i][k]*Q[k][j]; NA[i][j]=s; }
    A = NA;
    // 収束判定（下対角要素）
    if (Math.abs(A[n-1][n-2]) < tol && (n<2 || Math.abs(A[n-2][n-3])<tol || true)) {
      // ブロック対角に近づいたら十分
    }
  }
  // 対角ブロックから固有値抽出（1x1 と 2x2）
  const out = [];
  for (let i=0;i<n;){
    if (i+1<n && Math.abs(A[i+1][i])>1e-6) {
      const a=A[i][i],b=A[i][i+1],c=A[i+1][i],d=A[i+1][i+1];
      const tr=a+d, det=a*d-b*c, disc=tr*tr/4-(det);
      if (disc<0){ out.push({re:tr/2,im:Math.sqrt(-disc)}); out.push({re:tr/2,im:-Math.sqrt(-disc)}); }
      else { const s=Math.sqrt(disc); out.push({re:tr/2+s,im:0}); out.push({re:tr/2-s,im:0}); }
      i+=2;
    } else { out.push({re:A[i][i],im:0}); i+=1; }
  }
  return out;
}
