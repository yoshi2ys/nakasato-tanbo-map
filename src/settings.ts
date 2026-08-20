import { OVERLAY_IDS, type OverlayId } from './overlays';

/**
 * 設定の保存。田んぼの中身とは別のキーに置く（書き出したファイルに設定を混ぜない）。
 */

const STORAGE_KEY = 'tanbo-map.settings';

export interface OverlaySetting {
  on: boolean;
  /** 0〜1。写真の上に重ねるので、既定は薄め。 */
  opacity: number;
}

/** 文字の大きさ。畑では明るさも姿勢も一定でないので、その場で選べるようにする。 */
export type TextScale = 'small' | 'medium' | 'large';

export const TEXT_SCALES: TextScale[] = ['small', 'medium', 'large'];

/** 既定に対する倍率。 */
export const TEXT_SCALE_FACTOR: Record<TextScale, number> = {
  small: 0.88,
  medium: 1,
  large: 1.25,
};

export interface Settings {
  overlays: Record<OverlayId, OverlaySetting>;
  /** 画面まわりの文字。 */
  uiScale: TextScale;
  /** 地図に出る文字（計測の長さなど）。 */
  labelScale: TextScale;
  /** 畳んである一覧のグループ名。畳んだままにしておけるよう、設定として残す。 */
  collapsedGroups: string[];
  /**
   * まとめて隠してあるグループ名。1 つずつの `visible` とは別に持つので、
   * また出したときに元の出し入れがそのまま戻る。畳んだ状態と同じ「今の見え方」なので、
   * 書き出す GeoJSON には混ぜない。
   */
  hiddenGroups: string[];
  /**
   * 作ったグループの名前。中身が空でも見出しを出すために持つ。
   * 田んぼのファイル（書き出す GeoJSON）には混ぜない——あちらは地図に置いたものだけ。
   */
  groups: string[];
  /**
   * 手で並べたグループの並び。作っただけでは載らない（載せると、作った順が
   * 名前順を追い出してしまう）。ここに無い名前は名前順で後ろに続く。
   */
  groupOrder: string[];
}

const DEFAULT_OPACITY: Record<OverlayId, number> = {
  std: 0.5,
  pale: 0.5,
  hillshade: 0.4,
};

export function defaultSettings(): Settings {
  return build(() => undefined, {});
}

function readScale(value: unknown): TextScale {
  return TEXT_SCALES.includes(value as TextScale) ? (value as TextScale) : 'medium';
}

/**
 * 読み出した設定の形。何が入っているかは信じられないので、値はすべて unknown で受ける。
 * 「フォルダ」と呼んでいた頃のキーも並べてある。
 */
interface StoredSettings {
  overlays?: Record<string, unknown>;
  uiScale?: unknown;
  labelScale?: unknown;
  collapsedGroups?: unknown;
  collapsedFolders?: unknown;
  hiddenGroups?: unknown;
  groups?: unknown;
  folders?: unknown;
  groupOrder?: unknown;
}

/** 保存されている値（無ければ既定）から組み立てる。 */
function build(read: (id: OverlayId) => unknown, stored: StoredSettings): Settings {
  const overlays = {} as Record<OverlayId, OverlaySetting>;
  for (const id of OVERLAY_IDS) overlays[id] = readOverlay(read(id), id);
  return {
    overlays,
    uiScale: readScale(stored.uiScale),
    labelScale: readScale(stored.labelScale),
    // 「フォルダ」と呼んでいた頃の設定も拾う。作った名前を消さないため。
    collapsedGroups: readNames(stored.collapsedGroups ?? stored.collapsedFolders),
    hiddenGroups: readNames(stored.hiddenGroups),
    groups: readNames(stored.groups ?? stored.folders),
    groupOrder: readNames(stored.groupOrder),
  };
}

/** 文字列の配列だけを通す。壊れた設定で一覧が出なくなるより、空で始めるほうがまし。 */
function readNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];
}

function readOverlay(value: unknown, id: OverlayId): OverlaySetting {
  const record = (value ?? {}) as Partial<OverlaySetting>;
  const opacity = typeof record.opacity === 'number' && record.opacity >= 0 && record.opacity <= 1
    ? record.opacity
    : DEFAULT_OPACITY[id];
  return { on: record.on === true, opacity };
}

export function loadSettings(): Settings {
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    return defaultSettings();
  }
  if (text === null) return defaultSettings();

  try {
    const parsed = JSON.parse(text) as StoredSettings;
    return build((id) => parsed?.overlays?.[id], parsed ?? {});
  } catch {
    // 壊れた設定で起動できなくなるより、既定で始めるほうがまし。
    return defaultSettings();
  }
}

export function storeSettings(settings: Settings): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
