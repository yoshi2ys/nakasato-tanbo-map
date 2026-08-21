# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリ

航空写真の上に田んぼの輪郭を描いて面積（㎡・反・畝）を出すブラウザツール。Vite + vanilla TypeScript、フレームワークなし。GitHub Pages（`/nakasato-tanbo-map/` 配下）に公開し、圏外の田んぼでも使えるよう PWA + タイルキャッシュで動く。

## コマンド

```bash
npm run dev          # Vite dev サーバ（http://localhost:5173/nakasato-tanbo-map/）
npm run build        # type-check してから vite build
npm run type-check   # tsc --noEmit（src）+ tsconfig.test.json（tests / 設定ファイル）
npm test             # Playwright（Chromium、dev サーバを自動起動）
npm run test:dist    # build 済み dist を preview で配って同じテスト。SW とオフラインの確認用
```

テストを絞るとき: `npx playwright test tests/detect.spec.ts`、`npx playwright test -g "頂点を削除"`。

型検査は 2 本立て。`tsconfig.json` は `types: []` で、ブラウザのコードに Node の型が紛れ込まないようにしてある（`process` などが型を通ると実行時に落ちる）。テストと設定ファイルだけ `tsconfig.test.json` で `types: ["node"]`。

## 全体の作り

`src/main.ts` → `src/app.ts` の `startApp()` が入口。app.ts が状態（items、選択、モード、道具、設定）を全部持ち、各モジュールに配る配線役。**モジュール側は app を読まない**。参照は常に app → 部品の一方向で、部品どうしの共有は `geometry.ts` / `units.ts` / `hints.ts` のような純関数に寄せてある。

- モデル: `items.ts` — 田んぼ・計測・ピンを `Item` 1 つの型でまとめる。保存も書き出しも GeoJSON（`localStorage` の `tanbo-map.paddies`、書き込みは 400ms のデバウンス）。設定は別キー `tanbo-map.settings`（`settings.ts`）。グループは `Item.group`（1 段だけ、未設定は「未分類」）。一覧の並びは名前順（`Intl.Collator('ja', { numeric: true })`）で、手で並べ替えたグループだけ `Item.order` を持つ。グループ自体の並び・空のグループ名・畳んだ状態は設定側（`settings.ts` の `groupOrder` / `groups` / `collapsedGroups`）。`groupOrder` は手で並べたときだけ書く（作った順を混ぜると名前順が消える）。書き出す GeoJSON には並びを `groupOrder`（FeatureCollection 直下）で同梱し、読むのは取り込みのときだけ——手元の並びが先で、ファイルで初めて出た名前を末尾に足す。並び順を決める関数は `orderGroups` 1 つで、一覧も書き出しもここを通す。
- 地図: `map.ts` — MapLibre のスタイル生成。写真タイルは地理院オルソ（全国、z18）＋ 十日町市の航空写真（市域のみ、z20、TMS、`bounds` 必須）の 2 枚重ね。`?c=経度,緯度` で開始位置を変えられる（テストの固定にも使う）。開いたときの位置とホームのボタンで戻る先は `settings.home`（決めていなければ既定の十日町）で、`homeView()` 1 か所から出す。`?c=` は一時の指定なのでホームより先に効く。ホームは端末ごとの覚え書きなので、書き出す GeoJSON には入れない。
- 描画レイヤー: 保存済みは `itemLayer.ts`（面・線）と `pins.ts`（HTML Marker）、編集中は `editor.ts`、検出の下見は `preview.ts`、計測のラベルは `measureLabels.ts`。重ね順は `editor.ts` の `EDIT_FILL_LAYER_ID` を基準に組む。
- 編集: `editor.ts` — polygon / line / point を 1 つのクラスで扱う自前実装（mapbox-gl-draw は使わない）。頂点ドラッグ、中点ゴーストでの追加、スナップ閉合、自己交差の判定。
- 自動検出: `detect.ts` — 表示中の canvas を読んで OpenCV.js でフラッドフィル → モルフォロジー → `findContours` → `approxPolyDP`。閾値はピクセルではなく**地上距離（m）**で持つ（ズームや画像ソースで 1px の意味が変わるため）。OpenCV.js は 13MB あるので初回の検出まで読み込まない。
- オフライン: `tileCache.ts` — `tanbo://` の独自プロトコルを maplibre に登録し、タイルを IndexedDB に ArrayBuffer で貯める（Blob は Safari で入らない）。Service Worker（vite.config.ts の VitePWA）はアプリ本体だけを見て、タイルには触らない。この役割分担を混ぜない。
- UI: `src/ui/` — `sidebar.ts`（左の一覧。検索と種別の絞り込みはここが持つ）、`panel.ts`（地図の右上に浮かべる情報パネル。読むものだけ）、`detailSheet.ts`（名前・色・アイコン・削除）、`settingsSheet.ts`（設定シート。重ねる地図、文字の大きさ、書き出しと読み込み、オフライン用の地図）、`dom.ts`（`element()` などの小物）。DOM は `index.html` に固定 id で書いてあり、各クラスが `element('...')` で拾う。id を変えるときは HTML と両方直す。
- 向き: 回転は表示モードだけ（`map.ts` の `setRotationEnabled`）。編集に入るときは北へ戻す。傾き（pitch）は `maxPitch: 0` でどの経路からも塞いである（検出が真上からの縮尺を前提にしている）。
- 画像の書き出し: `snapshot.ts` — 表示中の canvas を枠の形に切り、ピン・距離のラベル・出典を 2D で描き足す（HTML の Marker は canvas に写らない）。枠と比率・形式の UI は `ui/cropBar.ts`。
- 画面下の 1 行は `hints.ts` の純関数。状態から文字列を作るだけで、状態を読みに行かせない。

## テストの前提

Playwright だけで、単体テストは置いていない（地図タイルと OpenCV.js を含めて確かめたいため）。`tests/helpers.ts` の `PADDY_SEEDS` は `openApp` が `?c=` で固定する開始位置（十日町）の圃場に当たる**固定座標**なので、`TEST_CENTER` を動かすと取り直しになる。`playwright.config.ts` の viewport（1460×800、`deviceScaleFactor: 1`）や `MAP_LEFT = 260`（左の一覧の幅）を変えるとテストの意味が変わる。`projects` に `devices` を入れると viewport が上書きされるので入れない。ワーカーは 1 本（公共のタイルサーバへ並列に投げない）。

## 書き方の決まり

- コメントは日本語で、**なぜそうしたか**を書く。定数には必ず根拠（実測値、制約、失敗した代案）を添える。既存の書き方に合わせる。
- コミットの件名は英語の平叙文（`Fit the map in a hand` のような調子）。
- `tasks/todo.md` はコミットする。
- タイルの出典表記は必須。十日町市の写真は私的使用の範囲内のみ（営利不可）なので、出典まわりを消さない。
