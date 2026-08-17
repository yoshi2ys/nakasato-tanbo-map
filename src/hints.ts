import type { EditState } from './editor';

/**
 * 地図の下に出す 1 行。いま何ができるか、いま何が起きているかを書く。
 *
 * 状態から文字列を作るだけの純関数にしてある。ここが状態を読みに行くと、
 * 「どの状態でどう出るか」を確かめるのに画面を動かす必要が出てくる。
 */

export const EDIT_HINT =
  '頂点をドラッグで移動、中点をクリックで追加。削除は右クリック、または選択して Delete';
export const EDIT_HINT_MIN = '頂点をドラッグで移動、中点をクリックで追加（これ以上は減らせません）';

export type AppMode = 'view' | 'edit';
export type Tool = 'manual' | 'auto' | 'measure' | 'pin';

export type Detection =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'failed'; message: string };

export interface HintInput {
  ready: boolean;
  mode: AppMode;
  tool: Tool;
  edit: EditState;
  detection: Detection;
  notice: string | null;
  itemCount: number;
  hasSelection: boolean;
}

function editingHint(edit: EditState): string {
  return edit.canDeleteVertex ? EDIT_HINT : EDIT_HINT_MIN;
}

function manualHint(edit: EditState): string {
  if (edit.selfIntersecting) return '輪郭が交差しています。この面積は当てになりません';
  if (edit.phase === 'editing') return editingHint(edit);
  if (edit.vertexCount >= 3) return '開始点をクリック / ダブルクリック / Enter で閉じる';
  if (edit.vertexCount >= 1) return 'クリックで頂点を追加（Esc で最初からやり直す）';
  return 'クリックで頂点を追加';
}

function measureHint(edit: EditState): string {
  if (edit.phase === 'editing') return editingHint(edit);
  if (edit.vertexCount === 0) return 'クリックした点から点までの距離を測ります';
  // 1 点だけでは Enter もダブルクリックも効かない。効かない操作を案内しない。
  if (edit.vertexCount === 1) return 'もう 1 点クリックすると距離が出ます（Esc で消去）';
  return 'クリックで点を継ぎ足し、ダブルクリック / Enter で終了（Esc で消去）';
}

export function hintText(input: HintInput): string {
  if (!input.ready) return '読み込み中…';
  if (input.detection.status === 'running') return '検出中…';
  if (input.detection.status === 'failed') return input.detection.message;
  if (input.notice !== null) return input.notice;

  if (input.mode === 'view') {
    if (input.itemCount === 0) return '「編集」に切り替えると、田んぼを描けます';
    if (input.hasSelection) return '「編集」に切り替えると、選んだものを直せます';
    return '地図か一覧から選ぶと、詳しい内容が右に出ます';
  }

  switch (input.tool) {
    case 'auto':
      return '田んぼの中にカーソルを合わせると輪郭が出ます。クリックで確定します';
    case 'pin':
      return input.edit.phase === 'editing'
        ? 'ピンをドラッグで動かせます'
        : 'クリックした場所にピンを置きます';
    case 'measure':
      return measureHint(input.edit);
    default:
      return manualHint(input.edit);
  }
}
