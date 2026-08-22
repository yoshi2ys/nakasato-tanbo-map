import { MAX_SIDEBAR_WIDTH, MIN_MAP_WIDTH, MIN_SIDEBAR_WIDTH } from '../settings';
import { element } from './dom';

/**
 * 一覧の幅を掴んで変える。
 *
 * 幅は CSS 変数で効かせる（グリッドの 1 列目）。画面幅で既定が 260px / 200px と
 * 変わるので、手で決めていないあいだは変数を置かず、CSS の既定に任せる。
 * 動かしているあいだは幅を直に当て、手を離したときだけ `onSettled` に渡す
 * （動かすたびに保存すると、書き込みが指の動きぶん続く）。
 */
export function initSidebarResize(initial: number | null, onSettled: (width: number) => void): void {
  const app = element('app');
  const handle = element('sidebar-resize');

  /*
   * 変数は `#app` に置く。読むのはここの grid-template-columns だけで、
   * :root に置くと引きずるたびに文書全体の style を無効化することになる。
   */
  function apply(width: number): void {
    app.style.setProperty('--sidebar-width', `${width}px`);
  }

  // 覚えた幅も今の窓で締め直す。広い画面で決めた幅のまま狭い窓を開くと、地図が潰れる。
  if (initial !== null) apply(clamp(initial));

  // 掴んでいる指。2 本目が乗っても混ぜない（別々の幅を当てて取り合いになる）。
  let dragging: number | null = null;

  handle.addEventListener('pointerdown', (event: PointerEvent) => {
    if (dragging !== null) return;
    // 掴んだまま動かすと、一覧の文字が選択されて青く染まる。
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    dragging = event.pointerId;

    // 動かさずに離したときは何も覚えない（掴みしろを押しただけで保存が走る）。
    let width: number | null = null;

    const move = (moved: PointerEvent): void => {
      if (moved.pointerId !== dragging) return;
      // 一覧は画面の左端にあるので、ポインタの x がそのまま幅になる。
      width = clamp(moved.clientX);
      apply(width);
    };

    const end = (finished: PointerEvent): void => {
      if (finished.pointerId !== dragging) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('dragging');
      dragging = null;
      if (width !== null) onSettled(width);
    };

    handle.addEventListener('pointermove', move);
    // pointercancel も拾う。取りこぼすと、離した後も幅がポインタについてくる。
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

function clamp(x: number): number {
  const max = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MIN_MAP_WIDTH));
  return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, Math.round(x)));
}
