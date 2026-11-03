/**
 * test/input-test.mjs — input.js（スティック WS クライアント & 仮想コックピット）の
 * ノード実行テスト（DOM/ブラウザはスタブ）。
 * 実行: node test/input-test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(dir, 'input.js'), 'utf8');

let failures = 0;
const out = [];
function assert(ok, msg, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  out.push(`  [${tag}] ${msg}${detail ? '  (' + detail + ')' : ''}`);
}

// ---------------- DOM / ブラウザスタブ ----------------
class FakeWS {
  constructor(url) { FakeWS.instances.push(this); this.url = url; this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}
FakeWS.instances = []; FakeWS.OPEN = 1;

// ウィジェット別の当たり判定矩形（input.js の CSS レイアウトに対応するテスト値）
const RECTS = {
  'virt vth': { left: 24, top: 100, right: 68, bottom: 260 },   // w=44 h=160
  'virt vru': { left: 24, top: 300, right: 168, bottom: 344 },  // w=144 h=44
  'virt vsj': { left: 600, top: 200, right: 704, bottom: 304 }, // w=h=104
};
const winListeners = {};
const win = {
  innerWidth: 800,
  addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f); },
};
const madeEls = [];
function makeEl() {
  const el = {
    className: '', style: {}, children: [],
    appendChild(c) { this.children.push(c); },
    getBoundingClientRect() {
      const r = RECTS[this.className] || { left: 0, top: 0, right: 0, bottom: 0 };
      return { ...r, width: r.right - r.left, height: r.bottom - r.top };
    },
  };
  madeEls.push(el);
  return el;
}
const doc = { createElement: makeEl, body: { appendChild() {} } };

new Function('window', 'location', 'document', 'WebSocket', 'setTimeout', src)(
  win, { hostname: '' }, doc, FakeWS, () => {});
const GI = win.GameInput;

// ================================================================
console.log('テスト1: FlightStickClient — 接続 URL / state / hello / sendFF');
{
  const stick = GI.createStickClient();
  const ws = FakeWS.instances[FakeWS.instances.length - 1];
  assert(ws.url === 'ws://localhost:8765/ws', 'WS_URL が正しい', ws.url);
  assert(stick.connected === false, '接続前は connected=false');

  ws.onopen();
  assert(stick.connected === true, 'onopen で connected=true');

  ws.onmessage({ data: JSON.stringify({ t: 'hello', caps: { present: false, name: 'TestStick' } }) });
  assert(stick.name === 'TestStick', 'hello でデバイス名取得');
  assert(stick.present === false, 'caps.present=false なら present=false');

  ws.onmessage({ data: JSON.stringify({ t: 'state', seq: 1, axes: [0.5, -0.25, 1, 0, 0, 0], hatx: 0, haty: 0, buttons: 0b101 }) });
  assert(stick.axes[0] === 0.5 && stick.axes[1] === -0.25 && stick.axes[2] === 1, 'axes が反映される');
  assert(stick.buttons === 0b101, 'buttons が反映される');
  assert(stick.present === true, '軸が動いたら present 自動確立');

  stick.sendFF('impact', 0.9, 250);
  const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
  assert(msg.t === 'ff' && msg.effect === 'impact' && msg.intensity === 0.9 && msg.duration_ms === 250,
    'sendFF が ff プロトコルで送信', ws.sent[ws.sent.length - 1]);

  ws.close();
  assert(stick.connected === false, 'onclose で connected=false');
  stick.sendFF('warning', 0.5, 100);
  assert(true, '切断中の sendFF は例外なし');
}

// ================================================================
console.log('テスト2: 仮想コックピット — 3ウィジェット常時表示・ドラッグ・位置保持（ラッチ）');
{
  const fire = (type, ev) => {
    const e = { preventDefault() { this.pd = true; }, ...ev };
    for (const f of (winListeners[type] || [])) f(e);
    return e;
  };
  const P = (id, x, y, extra = {}) => ({
    pointerId: id, clientX: x, clientY: y, pointerType: 'touch', ...extra,
  });

  const touch = GI.createTouchControls();

  // ウィジェットが 3 つ生成されている（常時表示 = DOM 生成済み・display 制御なし）
  const virts = madeEls.filter((el) => el.className.startsWith('virt '));
  assert(virts.length === 3, 'スロットル/ラダー/操縦桿の 3 ウィジェットを生成', `${virts.length}個`);
  const thKnob = madeEls[madeEls.findIndex((el) => el.className === 'virt vth') + 2]; // vtrack, vknob
  assert(typeof touch.onAction !== 'undefined', 'onAction フックが存在');
  assert(typeof touch.setDisplay === 'function', 'setDisplay（連動表示）が存在');
  let actions = 0;
  touch.onAction = () => { actions++; };

  // 初期位置: スロットル中央(top=72px), ラダー中立(left=54px), 操縦桿中央(38,38)
  assert(thKnob.style.top === '72px', 'スロットル初期位置=中央', thKnob.style.top);

  // --- スロットル（絶対値・離しても保持） ---
  // rect: top=100 bottom=260 → clientY=148 → v=(260-148)/160=0.7
  fire('pointerdown', P(1, 46, 148));
  assert(touch.thr.active && Math.abs(touch.thr.value - 0.7) < 1e-9, 'スロットル: 位置で絶対値決定', `v=${touch.thr.value}`);
  assert(actions === 1, 'pointerdown で onAction 1回');
  fire('pointermove', P(1, 46, 228)); // v=(260-228)/160=0.2
  assert(Math.abs(touch.thr.value - 0.2) < 1e-9, 'スロットル: ドラッグで追従', `v=${touch.thr.value}`);
  fire('pointerup', P(1, 46, 228));
  assert(!touch.thr.active && touch.thr.value === 0.2, 'スロットル: 離しても現在値を保持');

  // --- ラダー（位置保持・ラッチ／遊びなし: デッドゾーン 0） ---
  // 微小ドラッグ 1px から比例応答（細かい操縦調整が可能）
  fire('pointerdown', P(2, 97, 322)); // dx=+1
  assert(Math.abs(touch.rud.value - 1 / 54) < 1e-9, 'ラダー: 遊びなし 1px でも比例応答', `v=${touch.rud.value}`);
  fire('pointermove', P(2, 126, 322)); // dx=+30 → 30/54
  assert(Math.abs(touch.rud.value - 30 / 54) < 1e-9, 'ラダー: 右ドラッグ=+（比例）', `v=${touch.rud.value}`);
  fire('pointermove', P(2, 160, 322)); // dx=64 ≥ 全舵54 → +1
  assert(touch.rud.value === 1, 'ラダー: 全舵で +1');
  fire('pointerup', P(2, 160, 322));
  assert(touch.rud.value === 1 && !touch.rud.active, 'ラダー: 離しても全舵位置を保持（ラッチ）');
  // ノブを正確な中央へドラッグすると 0 に戻る
  fire('pointerdown', P(20, 96, 322));
  assert(touch.rud.value === 0, 'ラダー: 中央で中立復帰');
  fire('pointerup', P(20, 96, 322));

  // --- 操縦桿（2D・位置保持・ラッチ） ---
  // rect 中央 (652,252): 右+44 → x=+1、上-50 → y=+1（上=押し=機首下げ側）
  fire('pointerdown', P(3, 700, 200));
  assert(touch.sj.active, '操縦桿: 押下で active');
  assert(touch.sj.x === 1 && touch.sj.y === 1, '操縦桿: 右上ドラッグで x=+1,y=+1', `x=${touch.sj.x},y=${touch.sj.y}`);
  fire('pointermove', P(3, 604, 304)); // 左下 → -1,-1
  assert(touch.sj.x === -1 && touch.sj.y === -1, '操縦桿: 左下ドラッグで x=-1,y=-1');

  // --- マルチフィンガー: 操縦桿を保ったままラダーを同時操作 ---
  fire('pointerdown', P(4, 126, 322));
  assert(touch.sj.active && touch.rud.active, '操縦桿+ラダー同時操作可');
  fire('pointerup', P(4, 126, 322));
  assert(Math.abs(touch.rud.value - 30 / 54) < 1e-9, 'ラダー解放後も押下位置を保持', `v=${touch.rud.value}`);
  fire('pointerdown', P(23, 96, 322)); // 中立へ戻す
  fire('pointerup', P(23, 96, 322));
  assert(touch.rud.value === 0, 'ラダー: 中央ドラッグで中立復帰（2回目）');
  fire('pointerup', P(3, 604, 304));
  assert(touch.sj.x === -1 && touch.sj.y === -1, '操縦桿: 離しても左下位置を保持（ラッチ）');
  assert(!touch.active, '全解除で active=false');
  // ノブを中央へドラッグして中立復帰
  fire('pointerdown', P(21, 652, 252));
  assert(touch.sj.x === 0 && touch.sj.y === 0, '操縦桿: 中央ドラッグで中立復帰');
  fire('pointerup', P(21, 652, 252));

  // --- マウス（pointerType='mouse'） ---
  fire('pointerdown', P(10, 652, 252, { pointerType: 'mouse', button: 0 }));
  fire('pointermove', P(10, 652, 212, { pointerType: 'mouse' })); // 上40px → y=+1
  assert(touch.sj.active && touch.sj.y === 1, 'マウス: 操縦桿をドラッグ可能', `y=${touch.sj.y}`);
  fire('pointerup', P(10, 652, 212, { pointerType: 'mouse' }));
  fire('pointerdown', P(11, 652, 252, { pointerType: 'mouse', button: 2 }));
  assert(!touch.sj.active, 'マウス右クリックでは開始しない');

  // --- 画面其他地方のタップも離陸トリガ（onAction）になる ---
  const a0 = actions;
  fire('pointerdown', P(12, 400, 100));
  assert(actions === a0 + 1 && !touch.active, '何もないタップ: 操作なし・onAction のみ');

  // --- スライダー上は無視（onAction も発火しない） ---
  const a1 = actions;
  fire('pointerdown', P(13, 400, 700, { target: { closest: (sel) => (sel === '#speedCtl' ? {} : null) } }));
  assert(actions === a1 && !touch.active, '#speedCtl 上のタッチは無視');

  // --- blur でポインタ解除（値とノブ位置は保持されたまま） ---
  fire('pointerdown', P(14, 700, 200)); // 右上 → x=+1,y=+1
  assert(touch.sj.active, 'blur 用に操縦桿押下');
  fire('blur', {});
  assert(!touch.sj.active && touch.sj.x === 1 && touch.sj.y === 1, 'blur: ポインタ解除・位置は保持');
  fire('pointerdown', P(22, 652, 252)); // 中央へ戻す
  fire('pointerup', P(22, 652, 252));

  // --- setDisplay（スティック/キーボード入力の連動表示） ---
  touch.setDisplay({ elevator: -1, aileron: 1, rudder: -1, throttle: 1 });
  const sjKnob = madeEls[madeEls.findIndex((el) => el.className === 'virt vsj') + 1];
  const ruKnob = madeEls[madeEls.findIndex((el) => el.className === 'virt vru') + 2];
  assert(thKnob.style.top === '0px', 'setDisplay: スロットル全開=ノブ最上', thKnob.style.top);
  assert(ruKnob.style.left === '108px', 'setDisplay: 右ヨー=ラダーノブ右', ruKnob.style.left);
  // elevator=-1（引桿）→ 実機どおりノブは下（手前）= top 76px、aileron=+1 → 右 76px
  assert(sjKnob.style.left === '76px' && sjKnob.style.top === '76px',
    'setDisplay: 右ロール+引桿=ノブ右下（引く=下）', `l=${sjKnob.style.left},t=${sjKnob.style.top}`);

  // ドラッグ中は setDisplay に上書きされない
  fire('pointerdown', P(15, 652, 252));
  fire('pointermove', P(15, 690, 252)); // 右全舵 → ノブ left=76px
  touch.setDisplay({ elevator: 1, aileron: -1, rudder: 0, throttle: 0.5 });
  assert(sjKnob.style.left === '76px', 'ドラッグ中は setDisplay に上書きされない', sjKnob.style.left);
  fire('pointerup', P(15, 690, 252));

  // --- 仮想スロットルの外部操作（キーボード Shift/Ctrl 用 API） ---
  // 現在の thr.value は 0.2（テスト冒頭でラッチした値）
  touch.nudgeThrottle(0.25);
  assert(Math.abs(touch.thr.value - 0.45) < 1e-9, 'nudgeThrottle: 現在値から加算', `v=${touch.thr.value}`);
  touch.setThrottle(0.3);
  assert(touch.thr.value === 0.3 && thKnob.style.top === String(Math.round(0.7 * 144)) + 'px',
    'setThrottle: ノブ表示も追随', `top=${thKnob.style.top}`);
  touch.setThrottle(2);
  assert(touch.thr.value === 1, 'setThrottle: 上は 1 にクランプ');

  // --- resetPositions（リスタート時の全ウィジェット中央復帰） ---
  fire('pointerdown', P(24, 160, 322)); // ラダー全舵
  fire('pointerup', P(24, 160, 322));
  fire('pointerdown', P(25, 700, 200)); // 操縦桿右上
  fire('pointerup', P(25, 700, 200));
  touch.resetPositions();
  assert(touch.thr.value === 0.5 && touch.rud.value === 0 && touch.sj.x === 0 && touch.sj.y === 0,
    'resetPositions: スロットル=0.5・ラダー/操縦桿=中立', `thr=${touch.thr.value}`);
  assert(thKnob.style.top === '72px' && ruKnob.style.left === '54px' &&
         sjKnob.style.left === '38px' && sjKnob.style.top === '38px',
    'resetPositions: ノブ表示も中央へ復帰');
}

console.log(out.join('\n'));
console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURES`);
if (failures) process.exitCode = 1;
