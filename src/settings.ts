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

export interface Settings {
  overlays: Record<OverlayId, OverlaySetting>;
}

const DEFAULT_OPACITY: Record<OverlayId, number> = {
  std: 0.5,
  pale: 0.5,
  hillshade: 0.4,
};

export function defaultSettings(): Settings {
  const overlays = {} as Record<OverlayId, OverlaySetting>;
  for (const id of OVERLAY_IDS) overlays[id] = { on: false, opacity: DEFAULT_OPACITY[id] };
  return { overlays };
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
    const parsed = JSON.parse(text) as { overlays?: Record<string, unknown> };
    const overlays = {} as Record<OverlayId, OverlaySetting>;
    for (const id of OVERLAY_IDS) overlays[id] = readOverlay(parsed?.overlays?.[id], id);
    return { overlays };
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
