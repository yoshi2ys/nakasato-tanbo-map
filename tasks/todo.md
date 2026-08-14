# 2026-08-14 — 田んぼ輪郭描画ツール 実装計画

航空写真上に田んぼの輪郭を手動・自動で描き、面積を表示するブラウザツール。ローカル実行のみ、デプロイなし。

## 技術選定

- **地図**: MapLibre GL JS + 国土地理院「全国最新写真（シームレス）」タイル
  `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg`（API キー不要、出典表記必須、ズーム 18 まで）
  - Mapbox 衛星が必要になったらスタイル URL 差し替えで移行可能。Google Maps は頂点編集の自由度が低いため不採用。
- **面積計算**: Turf.js `turf.area()`（㎡ → 反・畝換算も表示）
- **描画・頂点編集**: 自前実装(mapbox-gl-draw は MapLibre 対応が不安定、頂点増減 UI も要件と合わない）
- **自動検出**: OpenCV.js（WASM）をブラウザ内で実行
- **ビルド**: Vite + vanilla TS。`npm run dev` でローカル起動

## Plan

- [x] **Step 1 — 地図表示**: Vite + vanilla TS で MapLibre に国土地理院写真タイルを表示、出典クレジット付与。
      → verify: `npm run dev` でブラウザに航空写真が表示される。
- [x] **Step 2 — 手動ポリゴン描画**: クリックで頂点追加（GeoJSON ソース + レイヤー）。開始点から 12px 以内のクリックでスナップ閉合（`map.project()` でスクリーン座標比較）。ダブルクリック / Enter でも閉合。閉合時に `turf.area()` で面積を㎡・反・畝表示。
      → verify: 実際に輪郭を描いて閉じ、面積が妥当な値になる。
- [x] **Step 3 — 頂点編集**: 頂点ドラッグ移動（面積リアルタイム更新）、辺中点のゴースト頂点ドラッグで頂点追加、右クリック / Delete で頂点削除（3 頂点未満は不可）。
      → verify: 追加・移動・削除の各操作が動き、面積が追従する。
- [x] **Step 4 — 輪郭の自動検出**: 田んぼ内 1 クリック（シードポイント）→ 表示タイルを canvas 化 → OpenCV.js でフラッドフィル + モルフォロジー → `findContours` → `approxPolyDP`（epsilon は周長の 1〜2%）で 4〜15 点程度に間引き → `map.unproject()` で緯度経度化し、Step 3 と同じ編集可能ポリゴンとして表示。
      → verify: 実写真の田んぼで検出 → 頂点数が過剰でない → 手動調整できる。
- [ ] **Step 5 — 仕上げ**: 複数田んぼの管理（一覧・選択・削除）、GeoJSON エクスポート / インポート（または localStorage 保存）。
      → verify: 2 枚以上の田んぼを保存・再読み込みできる。

## リスク

- 自動検出精度は畦道のコントラスト依存。検出結果は常に「編集可能な下書き」として Step 3 に合流させ、手動調整で回収する設計。
- 国土地理院タイルは地域により撮影年次が古い場合あり。必要になった時だけ Mapbox 衛星へ切り替え。

## Review

### Step 1 — 地図表示（完了）

- 構成: `index.html` / `src/main.ts`（起動）/ `src/map.ts`（地図生成）/ `src/style.css`。Vite + vanilla TS、依存は maplibre-gl のみ。
- `src/map.ts` で国土地理院シームレス写真を raster source（`maxzoom: 18`、地図側 `maxZoom: 21` でオーバーズーム）として読み込み、出典を `attribution` に設定。頂点編集の誤操作を避けるため回転・傾斜は無効化。
- 初期表示は新潟市南区の水田地帯 `[139.033, 37.78]` / zoom 17。
- 検証: `npx tsc --noEmit` 通過。`npm run dev` + Playwright（headless Chromium）で読み込み → console エラー 0、タイル 30 件すべて 200、出典表記「国土地理院 全国最新写真（シームレス）」を確認。スクリーンショットで水田の航空写真を目視確認。

### Step 2 — 手動ポリゴン描画（完了）

- `src/draw.ts` に `PolygonDrawer`。GeoJSON ソース 1 つに頂点（Point）・折れ線（LineString）・面（Polygon）を入れ、`geometry-type` フィルタで 3 レイヤーに振り分ける。未閉合中は最後の頂点からカーソルまでラバーバンド表示。
- 閉合は 4 経路: 開始点から 12px 以内のクリック（`map.project()` で判定）、ダブルクリック（`originalEvent.detail >= 2`）、Enter、いずれも 3 頂点以上が条件。Esc で描きかけを破棄。
- `src/units.ts` で ㎡ / 反 / 畝 を換算（1 畝 = 30 坪、1 反 = 10 畝）。面積は `@turf/area`、3 頂点目から暫定値をリアルタイム表示。
- パネル UI は `index.html` + `src/style.css`。
- 途中で見つけた不具合 3 件:
  1. maplibre-gl は worker を「自分の `import.meta.url` の兄弟ファイル」として実行時に解決するため、バンドラが worker を出力できない。dev でも build でも worker のリクエストが失敗し、GeoJSON ソースが永久に未ロード＝描画が一切出ない状態だった。`setWorkerUrl()` に Vite が出力した URL を渡し、`vite.config.ts` は `worker: { format: 'es' }`（maplibre は `new Worker(url, { type: 'module' })` で起動する）だけにした。
  2. `#area { display: grid }` が `hidden` 属性を打ち消し、面積表示が消えなかった → `#area[hidden]` で明示的に打ち消し。
  3. 「新しく描く」ボタンにフォーカスが残ると、閉合したいときの Enter がボタンのクリックに化けて描きかけが消える → クリック後に `blur()`。キーボードで Tab した場合はボタンの操作が正しいので、`keydown` 側でボタンを対象から外す。
- レビュー: `/code-review` + `/simplify` の 4 観点。適用したのは上記 worker 修正のほか、`lngLat.toArray()` の利用、GeoJSON ソースをフィールド保持（`instanceof` ガードの削除）、`DrawState` を `vertexCount` に縮小、mousemove の再描画を rAF で 1 フレームに間引き、面積は頂点が変わったときだけ再計算、カーソル書き込みの重複回避、2 頂点で開始点をクリックしたときの重複頂点の防止、`@types/geojson` の明示的な devDependency 化、ボタンの初期 `disabled`。見送り: `#closed` → `#mode` 化と頂点への `index` 付与（Step 3 で必要になった時点で入れる）、`destroy()`（インスタンスは 1 つだけ）。
- 検証: `npx tsc --noEmit` / `npm run build` 通過。Playwright の smoke テスト 10 項目が dev / production build の両方で全 PASS（初期状態、1 頂点、2 頂点での開始点クリック無視、暫定面積、スナップ閉合、Enter 閉合、reset 直後の Enter 閉合、フォーカス時 Enter のやり直し、ダブルクリック閉合、Esc 破棄）、console / network エラー 0。100px 四方の正方形で 2,223 ㎡（zoom 17 / 緯度 37.78 の理論値 2,226 ㎡ と 0.1% 一致）。

### Step 3 — 頂点編集（完了）

- `PolygonDrawer` を `#closed: boolean` から `#mode: 'drawing' | 'editing'` に変更。閉合後は編集モードに入り、頂点ドラッグ、辺の中点ゴーストからの頂点追加、右クリック / 選択 + Delete での削除ができる。面積はドラッグ中も追従する。
- 当たり判定は `queryRenderedFeatures` をやめ、`map.project()` による画面座標の距離判定に変更。`setData` は worker 経由で非同期に反映されるため、描画済みフレームを見る `queryRenderedFeatures` は連続操作で古い頂点番号を返し、別の頂点を消してしまう。あわせて頂点をゴーストより優先し、重なっても頂点を掴めるようにした。
- 中点ゴーストは辺がスクリーン上 32px 未満なら出さない（ズームアウト時に頂点と重なり、掴んだつもりが頂点追加になるため）。ズームで条件が変わるので `zoomend` で引き直す。
- 交差した輪郭（bowtie）を検出して警告する。turf は交差したリングでも打ち消し合った値を黙って返すので、面積だけが成果物のこのツールでは黙って間違った数値を出すのが最悪の失敗になる。
- 実装中に見つけた不具合: MapLibre は右ボタンの `mousedown` で `preventDefault()` すると後続の `contextmenu` を握り潰す。ドラッグ開始を主ボタンのみに限定して解決（macOS の ctrl + クリックも同様に除外）。
- レビューで見つけて直した点: 地図の外（パネル上・ウィンドウ外）でボタンを離すとドラッグが終わらず、頂点がカーソルに追従し続けた → `mouseup` を `window` で待ち、`buttons === 0` の mousemove でも終了する。ドラッグ中の削除で `#dragging` の番号がずれる → ドラッグ中は削除しない。`MIN_VERTICES` の `3` が `main.ts` に複製されていた → `DrawState.canDeleteVertex` に集約。ほかに role 判定の三項演算子、`#edgeMidpoint` の重複、paint 式の `case` / `match` 混在を整理。
- 見送り: 編集中の Esc は選択解除のみ（閉合済みの輪郭を Esc で捨てると作業が消えるため、やり直しは「新しく描く」に一本化）。3 頂点での右クリックはネイティブメニューも出ないまま無反応になるが、パネルに「これ以上は減らせません」と出る以上の手当てはしない。複数ポリゴン対応（Step 5）に向けた source / layer の ID 化は、必要になってから。
- 検証: `npx tsc --noEmit` / `npm run build` 通過。Step 3 の smoke テスト 12 項目と Step 2 の 10 項目が dev / production build の両方で全 PASS、console エラー 0。Step 3 の項目は編集モード遷移、頂点ドラッグでの面積増加、ドラッグ中の面積追従、中点ドラッグでの頂点追加、右クリック削除、Delete キー削除、3 頂点でのヒント切り替え、3 頂点未満への削除拒否、地図外で離したときのドラッグ終了、交差の検出・表示・解消。

### Step 4 — 輪郭の自動検出（完了）

- パネルに「手動 / 自動検出」の切り替えを追加。自動検出モードで田んぼの中を 1 クリックすると、`src/detect.ts` が表示中の写真をフラッドフィルして輪郭を推定し、`PolygonDrawer.load()` に渡す。検出後は手動（編集）へ自動で戻すので、そのまま Step 3 の頂点編集で直せる。
- パイプライン: canvas 読み出し → `cvtColor(RGBA2RGB)` → `floodFill`（MASK_ONLY + FIXED_RANGE、4 近傍、許容差 18）→ モルフォロジー OPEN → CLOSE → `findContours(RETR_EXTERNAL)` → シードを含む輪郭を選択 → `approxPolyDP`（epsilon を周長の 1% から上げて 15 頂点以下に収める）→ `unproject`。
- OpenCV.js（13MB）は最初に自動検出モードへ切り替えた時点で読み込む。build では独立したチャンクに分かれ、手動描画しか使わなければ読み込まれない。
- 実装中に見つけた不具合 2 件:
  1. モルフォロジーを CLOSE → OPEN の順にすると、隣の田んぼへ漏れた首が太って切れず、輪郭に細い突起が残る。OPEN → CLOSE に変更。
  2. production build だけが `Promise.prototype.then called on incompatible receiver` で落ちた。opencv.js は CommonJS で `module.exports` に Promise を入れており、CJS → ESM 変換でその `then` が名前付き export になるため、`await import()` が名前空間オブジェクト自体を thenable とみなす。変換を挟まない script タグ読み込みに変更。
- レビュー 3 本（`/code-review high`、検出専用のレビュー、Codex）で見つけて直した点:
  - `contours.get()` は毎回ヒープに Mat を作るのに解放していなかった（検出のたびにリーク）。使わないものはその場で、選んだものは finally で解放する。
  - ローダの Promise が失敗を永久にキャッシュし、一度失敗すると再読み込みまで自動検出が使えなくなっていた。
  - 検出中にモードを往復すると 2 つの検出が重なり、2 回目が青いポリゴンごと写真として読んでいた。通し番号で古い結果を捨て、検出中はモード切り替えを無効にする。
  - タイル待ちと OpenCV 読み込みのあいだに地図を動かされると、シードの画面座標と写真がずれる。撮影はクリック直後に行い、クリック時・撮影時・`unproject` 時のカメラ（中心・ズーム・canvas サイズ）を突き合わせて、ずれていれば失敗として知らせる。
  - モルフォロジーのカーネルが device pixel 固定だったため、Retina では実効サイズが半分になっていた。CSS ピクセル基準にして `scale` 倍する。
  - シードを含む輪郭がないとき最大の輪郭で代用していた。ユーザが指していない田んぼの面積を、それと分からないまま出すことになるので廃止。
  - 端のクリックでシードが画像の外を指すと OpenCV が数値の例外を投げるだけだった。座標を丸めて範囲に収め、数値例外は `exceptionFromPtr` で読めるメッセージに変換する。
  - 地図の読み込み前からパネルを操作できてしまい、自動検出を選んでも手動のままだった。読み込みが済むまでコントロールを無効にする。
- 検証: `npx tsc --noEmit` / `npm run build` 通過。Step 4 の 11 項目、Step 3 の 12 項目、Step 2 の 10 項目が dev / production build の両方で全 PASS、console エラー 0。Step 4 は devicePixelRatio 1 と 2 の両方で実行し、同じ田んぼで 10,119 ㎡ と 10,144 ㎡（差 0.25%）と、解像度によらず一致することを確認。実写真の田んぼを 5 頂点で抽出、初回 2.0〜2.4 秒（13MB の読み込み込み）、以降 0.3〜1.0 秒。6 回連続の検出もすべて成功。
