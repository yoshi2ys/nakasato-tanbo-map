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
  /** 畳んである一覧のフォルダ名。畳んだままにしておけるよう、設定として残す。 */
  collapsedFolders: string[];
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

/** 保存されている値（無ければ既定）から組み立てる。 */
function build(
  read: (id: OverlayId) => unknown,
  stored: { uiScale?: unknown; labelScale?: unknown; collapsedFolders?: unknown }
): Settings {
  const overlays = {} as Record<OverlayId, OverlaySetting>;
  for (const id of OVERLAY_IDS) overlays[id] = readOverlay(read(id), id);
  return {
    overlays,
    uiScale: readScale(stored.uiScale),
    labelScale: readScale(stored.labelScale),
    collapsedFolders: Array.isArray(stored.collapsedFolders)
      ? stored.collapsedFolders.filter((name): name is string => typeof name === 'string')
      : [],
  };
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
    const parsed = JSON.parse(text) as {
      overlays?: Record<string, unknown>;
      uiScale?: unknown;
      labelScale?: unknown;
      collapsedFolders?: unknown;
    };
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
