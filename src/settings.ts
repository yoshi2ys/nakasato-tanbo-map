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

/**
 * 一覧の幅の下限と上限（px）。
 * 下限はタブレット幅での既定と同じ 200px——見出しの題名と歯車がここまでは並ぶ。
 * 上限は 1460px の窓（テストの viewport と同じ）で地図に 900px 残る幅。名前が長い田んぼを
 * 折り返さずに読める一方、これ以上広げても一覧に足せるものがない。
 * 狭い窓ではこの上限に届く前に MIN_MAP_WIDTH が効く。
 */
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 560;

/**
 * 一覧をどれだけ広げても地図に残す幅（px）。
 * 821px（タブレットの横向き）で一覧を上限まで広げると地図が 261px しか残らず、
 * 田んぼ 1 枚と周りの畦がやっと入る程度になる。写真として使える下限をここに置く。
 */
export const MIN_MAP_WIDTH = 420;

/**
 * ホーム。開いたときに出る位置で、ホームのボタンで戻る先。
 * 端末ごとの覚え書きなので、書き出す GeoJSON には入れない。
 */
export interface HomePoint {
  lng: number;
  lat: number;
  zoom: number;
}

/**
 * 地図の拡大の上限。十日町市の写真が z20 まであるので、地図側は 19 まで等倍で見られる。
 * 覚えたホームもこれを超えていたら捨てる（地図が受け付けない画から始めない）。
 */
export const MAX_ZOOM = 21;

/** 地図の中心として通せる値か。`?c=` で渡された値もこれで見る。 */
export function isCenter(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 85
  );
}

export interface Settings {
  overlays: Record<OverlayId, OverlaySetting>;
  /** 決めていなければ null。そのときは地図側の既定（中里支所）に落ちる。 */
  home: HomePoint | null;
  /**
   * 手で決めた一覧の幅（px）。触っていなければ null で、そのときは CSS の既定に落ちる
   * （画面幅で 260px / 200px が切り替わる）。端末ごとの見え方なので書き出しには混ぜない。
   */
  sidebarWidth: number | null;
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
  sidebarWidth?: unknown;
  uiScale?: unknown;
  labelScale?: unknown;
  collapsedGroups?: unknown;
  collapsedFolders?: unknown;
  hiddenGroups?: unknown;
  home?: unknown;
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
    home: readHome(stored.home),
    sidebarWidth: readSidebarWidth(stored.sidebarWidth),
    uiScale: readScale(stored.uiScale),
    labelScale: readScale(stored.labelScale),
    // 「フォルダ」と呼んでいた頃の設定も拾う。作った名前を消さないため。
    collapsedGroups: readNames(stored.collapsedGroups ?? stored.collapsedFolders),
    hiddenGroups: readNames(stored.hiddenGroups),
    groups: readNames(stored.groups ?? stored.folders),
    groupOrder: readNames(stored.groupOrder),
  };
}

/**
 * 壊れたホームは無かったことにする（既定に落ちる）。
 * ここを通さないと、開いた瞬間に地図が海の上へ飛ぶ。
 */
function readHome(value: unknown): HomePoint | null {
  const record = value as Partial<HomePoint> | null | undefined;
  if (record === null || record === undefined) return null;
  const { lng, lat, zoom } = record;
  if (typeof lng !== 'number' || typeof lat !== 'number' || typeof zoom !== 'number') return null;
  if (!isCenter(lng, lat) || !Number.isFinite(zoom) || zoom < 0 || zoom > MAX_ZOOM) return null;
  return { lng, lat, zoom };
}

/**
 * 壊れた値は「決めていない」に倒す（既定の幅で開く）。
 * 範囲の外は捨てずに挟む——上限を後から下げたとき、覚えた幅を消すより端に寄せるほうがいい。
 */
function readSidebarWidth(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value));
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
