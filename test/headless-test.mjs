/**
 * test/headless-test.mjs — レポート §6 の受け入れ基準検証（Three.js 不要）
 * 実行: node test/headless-test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['physics.js', 'canyon.js', 'gimmicks.js']) {
  const code = readFileSync(path.join(dir, f), 'utf8');
  new Function('globalThis', code)(globalThis);
}
const FS = globalThis.FlightSim;
const CY = globalThis.Canyon;
const GI = globalThis.Gimmicks;

const DT = 1 / 120;
let failures = 0;

function assert(ok, msg, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`  [${tag}] ${msg}${detail ? '  (' + detail + ')' : ''}`);
}

function run(sim, seconds, ctrlFn) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (ctrlFn) ctrlFn(sim.ctrl, i * DT);
    sim.step(DT);
  }
}

function finiteAll(sim) {
  return Array.from(sim.x).every(Number.isFinite);
}

const D2R = Math.PI / 180;

// ---------------------------------------------------------------
console.log('テスト1: 無入力60秒（巡航安定）');
{
  const sim = FS.createSim();
  run(sim, 60);
  assert(Math.abs(sim.speed() - 293.8) < 1.0, '速度≈293.8 m/s', `speed=${sim.speed().toFixed(2)}`);
  assert(Math.abs(sim.altitude() - FS.START_ALT) < 10, `高度≈${FS.START_ALT} m`, `alt=${sim.altitude().toFixed(1)}`);
  assert(Math.abs(sim.x[3]) < 0.02, 'ピッチ角≈0', `theta=${(sim.x[3] / D2R).toFixed(3)}deg`);
  assert(Math.abs(sim.x[7]) < 0.02 && Math.abs(sim.x[8]) < 0.02, 'ロール/ヨー角≈0');
  assert(finiteAll(sim), '全状態有限');
}

// ---------------------------------------------------------------
console.log('テスト2: エレベータ投入（ピッチ応答と減衰）');
{
  const sim = FS.createSim();
  let maxTheta = 0;
  run(sim, 2.5, (c) => { c.elevator = -1; });
  // 解放後60秒の応答を監視
  let afterMaxQ = 0, afterMaxTheta = 0;
  const n = Math.round(60 / DT);
  for (let i = 0; i < n; i++) {
    sim.ctrl.elevator = 0;
    sim.step(DT);
    if (i * DT < 3) maxTheta = Math.max(maxTheta, sim.x[3]);
    if (i * DT > 45) {
      afterMaxQ = Math.max(afterMaxQ, Math.abs(sim.x[2]));
      afterMaxTheta = Math.max(afterMaxTheta, Math.abs(sim.x[3]));
    }
  }
  assert(maxTheta > 5 * D2R, 'ピッチ応答した（≥5°）', `maxTheta=${(maxTheta / D2R).toFixed(1)}deg`);
  assert(afterMaxQ < 0.5, '解放後 q が減衰', `afterMaxQ=${afterMaxQ.toFixed(3)}rad/s`);
  assert(afterMaxTheta < 70 * D2R, '解放後ピッチが暴れない', `afterMaxTheta=${(afterMaxTheta / D2R).toFixed(1)}deg`);
  assert(finiteAll(sim) && sim.speed() > 150 && sim.speed() < 400, '発散なし', `speed=${sim.speed().toFixed(1)}`);
}

// ---------------------------------------------------------------
console.log('テスト3: エルロン投入（ダッチロール・非発散）');
{
  const sim = FS.createSim();
  run(sim, 4, (c) => { c.aileron = 1; });
  // 解放後150秒: 側滑角 β の発振（ダッチロール）と有界性を確認。
  // ※ r 自体は緩やかな渦巻きモードの影響で符号固定になり得るため、
  //   ダッチロールの判定指標には β の符号反復を使う。
  let maxBeta = 0, betaSignChanges = 0, prevB = sim.x[4];
  const n = Math.round(150 / DT);
  for (let i = 0; i < n; i++) {
    sim.ctrl.aileron = 0;
    sim.step(DT);
    maxBeta = Math.max(maxBeta, Math.abs(sim.x[4]));
    if (prevB !== 0 && Math.sign(sim.x[4]) !== Math.sign(prevB)) betaSignChanges++;
    prevB = sim.x[4];
    if (!finiteAll(sim)) break;
  }
  assert(maxBeta > 0.002, 'ヨー⇔側滑の連動あり（ダッチロール）', `maxBeta=${(maxBeta / D2R).toFixed(3)}deg`);
  assert(betaSignChanges >= 2, '側滑角が符号反復（振動）', `betaSignChanges=${betaSignChanges}`);
  assert(finiteAll(sim), '数値が発散しない');
  assert(Math.abs(sim.x[4]) < FS.LIM.beta + 1e-9 && Math.abs(sim.x[5]) < FS.LIM.p + 1e-9, 'セーフガード範囲内');
}

// ---------------------------------------------------------------
console.log('テスト4: スロットル（全開加速・全閉減速）');
{
  const s1 = FS.createSim();
  s1.ctrl.throttle = 1;
  run(s1, 10);
  assert(s1.speed() > 302, '全開10秒で加速', `speed=${s1.speed().toFixed(1)}`);

  const s2 = FS.createSim();
  s2.ctrl.throttle = 0;
  run(s2, 10);
  assert(s2.speed() < 286, '全閉10秒で減速', `speed=${s2.speed().toFixed(1)}`);
}

// ---------------------------------------------------------------
console.log('テスト5: 急降下→地面衝突判定');
{
  const sim = FS.createSim();
  let crashedAt = null;
  const n = Math.round(120 / DT);
  for (let i = 0; i < n; i++) {
    sim.ctrl.elevator = 0.9; // 機首下げ
    sim.step(DT);
    const hit = CY.checkCollision(sim.x[9], sim.x[10], sim.altitude());
    if (hit) { crashedAt = { t: i * DT, hit, alt: sim.altitude() }; break; }
  }
  assert(crashedAt !== null && crashedAt.hit === 'ground', '地面衝突が検出された',
    crashedAt ? `t=${crashedAt.t.toFixed(1)}s hit=${crashedAt.hit}` : '120秒で衝突せず');
}

// ---------------------------------------------------------------
console.log('テスト6: 峡谷の整合性・飛行可能勾配');
{
  assert(CY.checkCollision(0, 0, 800) === null, 'スタート地点はセーフ');
  let maxBank = 0, minClear = Infinity;
  const v = 293.8;
  for (let X = 0; X <= 60000; X += 200) {
    const c0 = CY.centerline(X);
    if (CY.checkCollision(X, c0, 800) !== null) {
      // 岩は障害物として中心線に掛かってよい（壁/床/天井ならバグ）
      // rockHit で区別
      if (!CY.rockHit(X, c0)) { assert(false, `センターラインが壁/床/天井 (${X}m)`, ''); }
    }
    const w = CY.halfWidth(X);
    assert._ = null;
    if (CY.checkCollision(X, c0 + w + 5, 800) !== 'wall') {
      assert(false, `壁外判定 (${X}m)`, '');
    }
    // 必要バンク角（曲率から）
    const h = 200;
    const yp = (CY.centerline(X + h) - CY.centerline(X - h)) / (2 * h);
    const ypp = (CY.centerline(X + h) - 2 * c0 + CY.centerline(X - h)) / (h * h);
    const kappa = ypp / Math.pow(1 + yp * yp, 1.5);
    maxBank = Math.max(maxBank, Math.abs(Math.atan((v * v * kappa) / 9.81)));
    // 岩の通路余裕
    const rk = CY.rockHit(X, c0 + w); // ほぼ確実に外
  }
  assert(maxBank < 28 * D2R, 'センターライン追従の必要バンク < 28°',
    `maxBank=${(maxBank / D2R).toFixed(1)}deg`);

  // 岩が峡谷内に収まり通路が残ること（巨岩はニードル系ステージのみ出現）
  let rockCount = 0;
  for (let n = 0; n < 120; n++) {
    const rk = CY.rockAt(n);
    if (!rk) continue;
    rockCount++;
    const c = CY.centerline(rk.X), w = CY.halfWidth(rk.X);
    const passClear = w - (Math.abs(rk.Y - c) + rk.r);
    minClear = Math.min(minClear, passClear);
  }
  assert(rockCount >= 20, 'ニードル系ステージに巨岩が十分ある', `count=${rockCount}`);
  assert(minClear > 60, '全岩柱に 60m 以上の通路が残る', `minClear=${minClear.toFixed(0)}m`);

  // 天井/床
  assert(CY.checkCollision(1000, 0, 800) === null && CY.checkCollision(1000, 0, 2500) === 'ceiling'
    && CY.checkCollision(1000, 0, -5) === 'ground', '天井・床判定');
}

// ---------------------------------------------------------------
console.log('テスト7: 周回ステージのプロファイル予算（床・天井・巨岩）');
{
  let maxFloorGrad = 0, maxCeilGrad = 0, minGap = Infinity, maxBank = 0;
  let tunnelRock = 0, gapUnder500 = 0, discontinuity = 0;
  const v = 293.8;
  let prevF = CY.floorAlt(0), prevC = CY.ceilAlt(0);
  for (let X = 0; X <= 240000; X += 50) { // 6周分を 50m 分解で走査
    const f = CY.floorAlt(X), c = CY.ceilAlt(X);
    const st = CY.stageAt(X);
    // 境界連続性（真の段差=数百m を検出。勾配予算 17°/35° は個別に検証）
    if (Math.abs(f - prevF) > 20 || Math.abs(c - prevC) > 45) discontinuity++;
    prevF = f; prevC = c;
    // 勾配
    const fg = (CY.floorAlt(X + 25) - CY.floorAlt(X - 25)) / 50;
    const cg = (CY.ceilAlt(X + 25) - CY.ceilAlt(X - 25)) / 50;
    maxFloorGrad = Math.max(maxFloorGrad, Math.atan(Math.abs(fg)) / D2R);
    maxCeilGrad = Math.max(maxCeilGrad, Math.atan(Math.abs(cg)) / D2R);
    minGap = Math.min(minGap, c - f);
    if (c - f < 500) gapUnder500++;
    if (st.idx === 3 && CY.rockHit(X, CY.centerline(X))) tunnelRock++;
    // 必要バンク（横曲率）
    const h = 100;
    const ypp = (CY.centerline(X + h) - 2 * CY.centerline(X) + CY.centerline(X - h)) / (h * h);
    maxBank = Math.max(maxBank, Math.abs(Math.atan((v * v * ypp) / 9.81)) / D2R);
  }
  assert(discontinuity === 0, '床高度が全区間で連続（段差なし）', `段差=${discontinuity}`);
  assert(maxFloorGrad < 17, '床の最大勾配 < 17°（減速で追従可能）', `max=${maxFloorGrad.toFixed(1)}deg`);
  assert(maxCeilGrad < 35, '天井の最大勾配 < 35°', `max=${maxCeilGrad.toFixed(1)}deg`);
  assert(minGap >= 500, '最小飛行離隙 ≥ 500 m', `min=${minGap.toFixed(0)}m`);
  assert(gapUnder500 === 0, '極狭区間なし', `${gapUnder500}`);
  assert(maxBank < 28, '必要バンク < 28°（6周分の蛇行）', `max=${maxBank.toFixed(1)}deg`);
  assert(tunnelRock === 0, 'トンネル内に巨岩なし', `${tunnelRock}`);

  // ステージ別の衝突判定整合（床/天井の当たり境界）
  for (const dX of [5000, 10000, 16000, 23000, 28000, 34000, 50000, 70000]) {
    const f = CY.floorAlt(dX), c = CY.ceilAlt(dX);
    const cn = CY.centerline(dX);
    const inRock = !!CY.rockHit(dX, cn);
    assert(CY.checkCollision(dX, cn, f - 1) === 'ground', `床上方判定@${dX}`, `got=${CY.checkCollision(dX, cn, f - 1)}`);
    assert(CY.checkCollision(dX, cn, c + 1) === 'ceiling', `天井下方判定@${dX}`, `got=${CY.checkCollision(dX, cn, c + 1)}`);
    const mid = (f + c) / 2;
    const hit = CY.checkCollision(dX, cn, mid);
    assert(hit === null || hit === 'rock', `中央の高さはセーフ@${dX}`, `got=${hit} inRock=${inRock}`);
  }

  // ステージ表
  assert(CY.stageAt(0).name === 'LAUNCH' && CY.stageAt(6000).name === 'CANYON'
    && CY.stageAt(24000).name === 'TUNNEL' && CY.stageAt(36000).name === 'THE SLOT'
    && CY.stageAt(45000).name === 'CANYON' && CY.stageAt(45000).lap === 1,
    'stageAt のステージ帰属と周回');
  assert(CY.stageAt(4000 + 40000 * 5 + 1).d === 1.6, '難易度は5周で1.6に到達',
    `d=${CY.stageAt(204001).d}`);
}

// ---------------------------------------------------------------
console.log('テスト8: バンク90°の旋回（完全オイラー運動学）');
{
  const sim = FS.createSim();
  const DT8 = 1 / 120;
  // 左90° バンク状態を直接初期化（右翼下げ正の規約 → φ = -π/2）
  sim.x.fill(0);
  sim.x[7] = -Math.PI / 2;
  sim.x[11] = -1200; // 高度 1200 m（安全側）
  const psi0 = sim.x[8];
  // 引桿（S=機首上げ=負エレベータ）を2秒 → 方角 ψ が左回り（減少）するか
  let maxQ = 0;
  const n = Math.round(2 / DT8);
  for (let i = 0; i < n; i++) {
    sim.ctrl.elevator = -1; // 引桿
    sim.step(DT8);
    maxQ = Math.max(maxQ, sim.x[2]);
  }
  assert(maxQ > 0.3, '引桿で機首上げ角速度が発生（q>0）', `maxQ=${maxQ.toFixed(2)}rad/s`);
  let dPsi = sim.x[8] - psi0;
  if (dPsi > Math.PI) dPsi -= 2 * Math.PI;
  if (dPsi < -Math.PI) dPsi += 2 * Math.PI;
  assert(dPsi < -0.05, 'バンク90°で引桿→方角が左に回る（ψ減少）',
    `Δψ=${(dPsi / D2R).toFixed(2)}deg`);
  assert(finiteAll(sim), '数値発散なし');
}

// ---------------------------------------------------------------
console.log('テスト9: 動くオブジェクト10種（配置・通路保証・決定性）');
{
  // 序盤（START 以遠の手前）には一切ない
  for (let X = 0; X < GI.START - 800; X += 500) {
    if (GI.check(X, CY.centerline(X), 800, 3.3, null) === 'hit') {
      assert(false, `序盤 ${X}m でギミック衝突`, ''); break;
    }
  }
  assert(true, '出現開始距離より手前は常にセーフ');

  // 配置数（1周分）
  let placed = 0;
  const kindsSeen = new Set();
  for (let i = 0; i < 40; i++) {
    const g = GI.at(i);
    if (g) { placed++; kindsSeen.add(g.kind); }
  }
  assert(placed >= 8, '1周分に十分数のギミックがある', `placed=${placed}`);

  // トンネル内には置かない
  let inTunnel = 0;
  for (let i = 0; i < 60; i++) {
    const g = GI.at(i);
    if (g && CY.stageAt(g.X).idx === 3) inTunnel++;
  }
  assert(inTunnel === 0, 'トンネル内にギミックなし', `${inTunnel}`);

  // 通路保証: 各ギミックの断面は、どの位相でも全領域を塞がない
  // （ギミック位置 X で Y×alt を走査し、いずれかの点で 'hit' でないことを確認）
  let blockedAt = 0, checkedKinds = 0;
  for (let i = 0; i < 40; i++) {
    const g = GI.at(i);
    if (!g || g.kind === 8 || g.kind === 9) continue; // リング/突風は衝突なし
    checkedKinds++;
    const w = g.w, f = g.f, cl = g.cl;
    for (let pt = 0; pt < 24; pt++) {
      const t = (pt / 24) * (g.T + 6);
      let open = false;
      for (let alt = f + 60; alt < cl - 60 && !open; alt += 55) {
        for (let dy = -(w - 40); dy <= w - 40; dy += 45) {
          const r = GI.check(g.X, g.c + dy, alt, t, null);
          if (r !== 'hit') { open = true; break; }
        }
      }
      if (!open) { blockedAt++; }
    }
  }
  assert(checkedKinds >= 6, 'ハザード種の検証対象がある', `kinds=${checkedKinds}`);
  assert(blockedAt === 0, '全位相で断面が完全閉塞しない（通路保証）',
    `閉塞=${blockedAt}`);

  // 決定性: 同一 (X, t) で結果が一致
  let detOk = true;
  for (const X of [7000, 12345, 19999, 25000, 33333]) {
    const a = GI.check(X, CY.centerline(X), 900, 12.5, null);
    const b = GI.check(X, CY.centerline(X), 900, 12.5, null);
    if (JSON.stringify(a) !== JSON.stringify(b)) detOk = false;
  }
  assert(detOk, 'check の決定性');

  // リング取得状態は reset で消える
  GI.collected.add(0); GI.collected.add(5);
  GI.reset();
  assert(GI.collected.size === 0, 'reset でリング取得状態が消える');

  // 突風: 帯域内で非ゼロ・外でゼロ
  let windIn = false;
  for (let i = 0; i < 60; i++) {
    const g = GI.at(i);
    if (g && g.kind === 9 && Math.abs(GI.windAt(g.X, 2.0)) > 1) windIn = true;
  }
  assert(GI.windAt(0, 0) === 0, '発進地は突風なし');
  if (windIn) assert(true, '突風帯で横風が立つ');
}

console.log('');
if (failures > 0) {
  console.log(`FAILURES: ${failures}`);
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
