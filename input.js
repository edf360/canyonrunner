/*
 * input.js — CANYON RUNNER 入力拡張
 *
 *   1) createStickClient(): flight-stick-relay
 *      (ws://localhost:8765/ws,  protocol: flight-stick-relay-src/src/protocol.h)
 *      の WebSocket クライアント。
 *      - "state" メッセージでスティック状態 { axes[6](-1..1), buttons, hatx/haty } を購読
 *      - sendFF(effect, intensity, duration_ms) でスティック振動を駆動
 *      - 切断時は 1 秒間隔で自動再接続（リレー未起動でもエラーにならず待機する）
 *
 *   2) createTouchControls(): 常時表示の仮想コックピット（Pointer Events）
 *      - 左下: スロットル（縦レバー・絶対値） + ラダー（横スライダー・ばね戻し）
 *      - 右下: 操縦桿（2D スタイル: 縦=エレベータ / 横=エルロン・ばね戻し）
 *      - タッチ（マルチフィンガー）/ マウス のどちらでもドラッグ操作可能
 *      - ラダー・操縦桿は指を離すとバネで中央復帰（実機と同じ）
 *      - スロットルは指を離しても位置を保持（実機のレバーと同じ）
 *      - setDisplay() を毎フレーム呼ぶと、物理スティックやキーボードの
 *        入力も仮想ウィジェットにリアルタイムで連動表示される
 *
 * 出力（ゲーム制御単位のターゲット値）:
 *   thr.value : 0..1  スロットル絶対位置（保持）
 *   rud.value : -1..1 ラダー（右ドラッグ = +1、離すと 0）
 *   sj.x      : -1..1 操縦桿 X（右 = +1 → 右ロール、離すと 0）
 *   sj.y      : -1..1 操縦桿 Y（上 = +1 → 押す = 機首下げ。
 *               実機の操縦桿と同じで、引く（下ドラッグ）= 機首上げ。離すと 0）
 */
(function (global) {
  'use strict';

  // ==================================================================
  // FlightStickClient — flight-stick-relay WebSocket クライアント
  // ==================================================================
  const WS_URL = 'ws://' + (location.hostname || 'localhost') + ':8765/ws';

  function createStickClient() {
    const self = {
      connected: false, // リレー（WSサーバ）と接続済み
      present: false,   // スティック実在（hello.caps.present または軸/ボタンの信号で確信）
      name: '',
      axes: new Float32Array(6), // リレー側でデッドゾーン/gamma適用済みの -1..1
      buttons: 0,
      sendFF: null,
    };
    let ws = null;

    function sendFF(effect, intensity, durationMs) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          t: 'ff', effect: effect,
          intensity: intensity, duration_ms: durationMs,
        }));
      }
    }
    self.sendFF = sendFF;

    function connect() {
      let sock = null;
      try { sock = new WebSocket(WS_URL); } catch (e) { sock = null; }
      if (!sock) { setTimeout(connect, 1000); return; }
      ws = sock;
      ws.onopen = () => { self.connected = true; };
      ws.onclose = () => { self.connected = false; setTimeout(connect, 1000); };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* noop */ } };
      ws.onmessage = (ev) => {
        let m = null;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'hello' && m.caps) {
          if (m.caps.present) self.present = true;
          self.name = m.caps.name || '';
        } else if (m.t === 'state') {
          const a = m.axes;
          if (Array.isArray(a)) {
            for (let i = 0; i < self.axes.length && i < a.length; i++) {
              // 接続後にスティックを挿すケース: caps が false でも軸が動けば実在とみなす
              if (Math.abs(a[i]) > 0.1) self.present = true;
              self.axes[i] = a[i];
            }
          }
          self.buttons = m.buttons | 0;
          if (self.buttons) self.present = true;
        }
      };
    }
    connect();
    return self;
  }

  // ==================================================================
  // 仮想コックピット（スロットル / ラダー / 操縦桿）— 常時表示
  // ==================================================================
  function createTouchControls() {
    const PAD = 26;                        // ヒット判定の余白 [px]（指でも押しやすい）
    // タッチは遊び（デッドゾーン）ゼロ: 微小なドラッグから比例応答し、細かく操縦できる
    const RU_DEAD = 0, RU_RANGE = 54;      // ラダー: デッドゾーン / 全舵距離 [px]
    const SJ_DEAD = 0, SJ_RANGE = 38;      // 操縦桿: 同
    // 全舵距離（RANGE）も物理スティックより小さく、小さな指の動きで精细に調整できる
    const TH_TRAVEL = 144;                 // スロットルノブの移動範囲 [px]
    const RU_LEFT0 = 54, SJ_BASE = 38;     // ノブ基準位置（CSS と対応）

    function makeWidget(cls) {
      const el = document.createElement('div');
      el.className = cls;
      document.body.appendChild(el);
      return el;
    }
    function child(parent, cls, label) {
      const c = document.createElement('div');
      c.className = cls;
      if (label !== undefined) c.textContent = label;
      parent.appendChild(c);
      return c;
    }

    // --- DOM: スロットル（縦）/ ラダー（横）/ 操縦桿（2D） ---
    const thEl = makeWidget('virt vth');
    child(thEl, 'vtrack');
    const thKnob = child(thEl, 'vknob');
    child(thEl, 'vlbl', 'THRO');
    const ruEl = makeWidget('virt vru');
    child(ruEl, 'vtrack');
    const ruKnob = child(ruEl, 'vknob');
    child(ruEl, 'vlbl', 'RUDDER');
    const sjEl = makeWidget('virt vsj');
    const sjKnob = child(sjEl, 'vknob');
    child(sjEl, 'vlbl', 'STICK');

    const api = {
      thr: { active: false, value: 0.5, pid: -1 }, // スロットル 0..1（絶対位置・ラッチ保持）
      rud: { active: false, value: 0, pid: -1 },   // ラダー -1..1（右=+、離すと中立）
      sj: { active: false, x: 0, y: 0, pid: -1 },  // 操縦桿 2D（右/上が+、離すと中立）
      onAction: null, // anywhere タッチ時に 1 回呼ばれる（離陸トリガ用）
    };
    Object.defineProperty(api, 'active', {
      get: () => api.thr.active || api.rud.active || api.sj.active,
    });

    function placeTh(v) { thKnob.style.top = Math.round((1 - v) * TH_TRAVEL) + 'px'; }
    function placeRu(px) { ruKnob.style.left = Math.round(RU_LEFT0 + px) + 'px'; }
    function placeSj(px, py) {
      sjKnob.style.left = Math.round(SJ_BASE + px) + 'px';
      sjKnob.style.top = Math.round(SJ_BASE + py) + 'px';
    }
    placeTh(0.5); placeRu(0); placeSj(0, 0);

    function norm(d, dead, range) {
      const a = Math.abs(d);
      if (a <= dead) return 0;
      const v = (a - dead) / (range - dead);
      return (d > 0 ? 1 : -1) * Math.min(1, v);
    }
    function hit(el, x, y) {
      const r = el.getBoundingClientRect();
      return x >= r.left - PAD && x <= r.right + PAD &&
             y >= r.top - PAD && y <= r.bottom + PAD;
    }

    function move(e, w) {
      if (w === api.thr) {
        const r = thEl.getBoundingClientRect();
        const v = (r.bottom - e.clientY) / r.height; // 上端=1 / 下端=0
        api.thr.value = Math.min(1, Math.max(0, v));
        placeTh(api.thr.value);
      } else if (w === api.rud) {
        const r = ruEl.getBoundingClientRect();
        api.rud.value = norm(e.clientX - (r.left + r.width / 2), RU_DEAD, RU_RANGE);
        placeRu(api.rud.value * RU_RANGE);
      } else {
        const r = sjEl.getBoundingClientRect();
        api.sj.x = norm(e.clientX - (r.left + r.width / 2), SJ_DEAD, SJ_RANGE);
        api.sj.y = norm((r.top + r.height / 2) - e.clientY, SJ_DEAD, SJ_RANGE); // 上=+
        // 画面のノブは指に追従（y は「上が正」だが画面上は top が減少する方向）
        placeSj(api.sj.x * SJ_RANGE, -api.sj.y * SJ_RANGE);
      }
    }

    // Pointer Events でタッチ（1 指 = 1 pointer）とマウスを統一的に扱う。
    // スクロール/ピンチ抑止は CSS の touch-action:none に依存。
    function onDown(e) {
      // マウスは左ボタンのみ（右クリック/中クリックは無視）
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const tgt = e.target;
      if (tgt && tgt.closest && tgt.closest('#speedCtl')) return; // スライダー操作は入力に含めない
      const x = e.clientX, y = e.clientY;
      let w = null;
      if (hit(thEl, x, y)) w = api.thr;
      else if (hit(ruEl, x, y)) w = api.rud;
      else if (hit(sjEl, x, y)) w = api.sj;
      if (w) {
        if (w.pid !== -1) return; // 同一ウィジェットに 2 ポインタ目は無視
        w.pid = e.pointerId;
        w.active = true;
        move(e, w);
        e.preventDefault();
      }
      if (api.onAction) api.onAction(); // 画面のどこでも = 離陸トリガ
    }
    function onMove(e) {
      let done = false;
      if (e.pointerId === api.thr.pid) { move(e, api.thr); done = true; }
      else if (e.pointerId === api.rud.pid) { move(e, api.rud); done = true; }
      else if (e.pointerId === api.sj.pid) { move(e, api.sj); done = true; }
      if (done) e.preventDefault();
    }
    // ラダー・操縦桿は指を離すとバネ戻し（実機と同じで自動中立復帰）。
    // スロットルは最後の位置を保持する（実機のレバーと同じ）。
    function release(w) {
      w.pid = -1;
      w.active = false;
      if (w === api.rud) { w.value = 0; placeRu(0); }
      else if (w === api.sj) { w.x = 0; w.y = 0; placeSj(0, 0); }
    }
    function onUp(e) {
      if (e.pointerId === api.thr.pid) release(api.thr);
      else if (e.pointerId === api.rud.pid) release(api.rud);
      else if (e.pointerId === api.sj.pid) release(api.sj);
    }
    function clearAll() {
      release(api.thr); release(api.rud); release(api.sj);
    }

    // 物理スティック / キーボード / 現在の入力をウィジェットへ連動表示
    // （ドラッグ中のウィジェットは操作側の表示を優先）
    function setDisplay(s) {
      if (!api.thr.active) placeTh(Math.min(1, Math.max(0, s.throttle)));
      if (!api.rud.active) placeRu(-s.rudder * RU_RANGE);   // 右ヨー = -rudder → ノブ右
      // elevator 負=引く=機首上げ → 実機どおりノブは下（手前）へ
      if (!api.sj.active) placeSj(s.aileron * SJ_RANGE, -s.elevator * SJ_RANGE);
    }
    api.setDisplay = setDisplay;

    // スロットルの外部からの増減（キーボード Shift/Ctrl 用）。
    // 仮想レバーの値そのものを動かすので、ノブ表示も追随して保持される。
    api.setThrottle = (v) => {
      api.thr.value = Math.min(1, Math.max(0, v));
      placeTh(api.thr.value);
    };
    api.nudgeThrottle = (dv) => api.setThrottle(api.thr.value + dv);

    // リスタート時の初期化: 全ウィジェットを中央位置へ（スロットル=0.5・ラダー/操縦桿=中立）
    api.resetPositions = () => {
      api.setThrottle(0.5);
      api.rud.value = 0; placeRu(0);
      api.sj.x = 0; api.sj.y = 0; placeSj(0, 0);
    };

    window.addEventListener('pointerdown', onDown, { passive: false });
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', clearAll);
    return api;
  }

  global.GameInput = { createStickClient, createTouchControls };
})(window);
