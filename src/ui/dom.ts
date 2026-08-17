import { iconSvg } from '../icons';

/** id で引く。無ければ組み立ての間違いなので、その場で落とす。 */
export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} が見つかりません`);
  return found as T;
}

/** アイコンだけのボタンの中身を差し替える。 */
export function setIcon(button: HTMLElement, name: string, sizePx = 18): void {
  button.replaceChildren(iconSvg(name, sizePx));
}
