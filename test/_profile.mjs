import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const OUT = [];
const log = (...a) => OUT.push(a.join(' '));
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['physics.js', 'canyon.js']) {
  new Function('globalThis', readFileSync(path.join(dir, f), 'utf8'))(globalThis);
}
const CY = globalThis.Canyon;
const D2R = Math.PI / 180;

function prof(X0, X1, label) {
  let maxFloorGrad = 0, maxCeilGrad = 0, minGap = Infinity, minW = Infinity;
  let maxBank = 0;
  const h = 25;
  for (let X = X0; X <= X1; X += 25) {
    const f = CY.floorAlt(X), c = CY.ceilAlt(X);
    const fg = (CY.floorAlt(X + h) - CY.floorAlt(X - h)) / (2 * h);
    const cg = (CY.ceilAlt(X + h) - CY.ceilAlt(X - h)) / (2 * h);
    maxFloorGrad = Math.max(maxFloorGrad, Math.abs(Math.atan(fg)) / D2R);
    maxCeilGrad = Math.max(maxCeilGrad, Math.abs(Math.atan(cg)) / D2R);
    minGap = Math.min(minGap, c - f);
    minW = Math.min(minW, CY.halfWidth(X));
    const cl0 = CY.centerline(X);
    const yp = (CY.centerline(X + h) - CY.centerline(X - h)) / (2 * h);
    const ypp = (CY.centerline(X + h) - 2 * cl0 + CY.centerline(X - h)) / (h * h);
    const kappa = ypp / Math.pow(1 + yp * yp, 1.5);
    maxBank = Math.max(maxBank, Math.abs(Math.atan((293.8 * 293.8 * kappa) / 9.81)) / D2R);
  }
  log(`${label}: floorGrad=${maxFloorGrad.toFixed(1)}deg ceilGrad=${maxCeilGrad.toFixed(1)}deg minGap=${minGap.toFixed(0)}m minHalfW=${minW.toFixed(0)}m maxBank=${maxBank.toFixed(1)}deg`);
}

const STAGE_BOUNDS = [7000, 13000, 19000, 26000, 32000, 40000];
for (let lap = 0; lap < 5; lap++) {
  const X0 = CY.INTRO + lap * CY.LAP;
  prof(X0, X0 + CY.LAP, `lap${lap} (d=${(Math.min(1.6, 1 + 0.12 * lap)).toFixed(2)})`);
  let prev = X0;
  for (const s of STAGE_BOUNDS) {
    const name = CY.stageAt(prev + 100).name;
    prof(prev + 200, X0 + s - 200, `  ${name}`);
    prev = X0 + s;
  }
}
let bad = 0;
for (let X = 0; X <= 250000; X += 100) {
  const f = CY.floorAlt(X), c = CY.ceilAlt(X);
  if (c - f < 300) { if (bad === 0) log('GAP<300 at X=' + X + ' gap=' + (c - f).toFixed(1)); bad++; }
}
log('gap<300m count = ' + bad);
let inTunnel = 0;
for (let n = 0; n < 300; n++) {
  const rk = CY.rockAt(n);
  if (rk) { const st = CY.stageAt(rk.X); if (st.idx === 3) inTunnel++; }
}
log('rocks in tunnel = ' + inTunnel);
// ステージ名確認
for (const u of [1000, 6000, 11000, 17000, 24000, 29000, 36000, 45000]) {
  const st = CY.stageAt(CY.INTRO === 0 ? u : (u < CY.INTRO ? u : u));
  log(`stageAt(${u}) = ${st.name} lap=${st.lap} d=${st.d.toFixed(2)}`);
}
writeFileSync(path.join(dir, 'test', '_profile_out.txt'), OUT.join('\n') + '\n');
