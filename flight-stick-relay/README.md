# Flight Stick Relay

USB フライトスティックの入力をローカル WebSocket（`ws://localhost:8765/ws`）経由で
HTML フライトゲームへ中継し、ゲームからの被弾・失速などのイベントで
スティックの**振動（rumble）**を駆動する Windows 用 C アプリです。
タスクトレイ常駐のネイティブ調整 UI（deadzone / gamma / 振動強度など）と
`config.json` への設定永続化を内蔵します。

## 対象機種（振動機能）

本アプリの振動機能は **Xbox 360用 ホリ フライトスティック EX**
（HORI「フライトスティック EX」Xbox 360 版）を想定した実装です。

- 振動は **XInput 経由**（`xinput1_4.dll` の `XInputSetState`）で駆動します。
  本機は DirectInput のフォースフィードバック効果を持たない
  （`GetEffects()` が 0 件）ため、DirectInput FF 経路は実装していません
  （検証記録: [`vib/README.md`](vib/README.md)）。
- 本機のモーターは **右モーターのみ** の 1 チャネルです。
  振動は「強さ（0〜1）+ 持続時間」のみで表現され、左右の区別はありません。
- 対応機器が接続されていない場合や XInput ランタイムが無い環境では、
  振動のみ無効（`noop` バックエンド）となり、入力のゲーム中継はそのまま動作します。

> その他の XInput 対応コントローラでも左右モーターの右側に振動が出力されるため
> 動作しますが、強度・動作は機器依存です。

## 動作環境

- Windows 10 / 11 (x64)
- 振動には Xbox 360用 ホリ フライトスティック EX（XInput 認識されること）

## 実行（配布 zip 利用）

```
run.bat
```

1. スティックを USB 接続
2. `run.bat`（または `flight_stick_relay.exe`）を起動
3. ブラウザで `http://localhost:8765/` を開く
   （同梱のデモゲーム `game/index.html` が配信されます）

起動ログに `[ffb] backend = xinput` と出れば振動バックエンドが有効です。
UI（Force Feedback パネル）で backend / intensity / curve を調整できます。

設定ファイル `config.json` は初回起動時にカレントディレクトリへ
自動生成されます。

## ビルド（ソース版）

```
cmake -S . -B build -G "MinGW Makefiles"
cmake --build build -j
```

- コンパイラ: MinGW-w64 (gcc) または MSVC
- 追加ライブラリはすべて CMakeLists.txt 指定済み
  （振動の XInput は実行時 `LoadLibrary` のため追加不要）

成果物: `build/flight_stick_relay.exe`

## 振動のテスト

リレー起動中に:

```
python tools/ws_probe.py 8765
```

`impact`（200ms・強度0.8）が送信され、右モーターが短く振動します。
ゲーム側は次にように送信します:

```json
{ "t": "ff", "effect": "impact", "intensity": 0.8, "duration_ms": 200 }
```

## 構成

| パス | 内容 |
|---|---|
| `src/` | アプリ本体（C11）。振動バックエンドは [`src/ffb_backends.c`](src/ffb_backends.c) |
| `game/` | デモ HTML ゲーム（WS クライアント） |
| `third_party/mongoose` | WS/HTTP サーバ |
| `third_party/microui` | ネイティブ UI |
| `tools/ws_probe.py` | WS スモークテスト |
| `vib/` | 振動経路の実機検証用 C# テストツール（リポジトリのみ。配布 zip には含まれません） |
| `plans/` | 設計書 |
