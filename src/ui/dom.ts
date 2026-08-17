import { iconSvg } from '../icons';

/** id で引く。無ければ組み立ての間違いなので、その場で落とす。 */
export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} が見つかりません`);
  return found as T;
}

/** アイコンだけのボタンの中身を差し替える。 */
export function setIcon(button: HTMLElement, name: string): void {
  button.replaceChildren(iconSvg(name, 18));
}

/**
 * 入力欄に文字を打っているところか。
 *
 * 名前を打っている最中の Backspace が頂点の削除に化けると、気づかないうちに形が変わる。
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName);
}
