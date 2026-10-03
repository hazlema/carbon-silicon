import { POCKET_QUERY } from './pocket';

export { POCKET_QUERY, isPocket } from './pocket';

class Pocket {
  /** The screen is a pocket screen right now (follows rotation and resizing). */
  screen = $state(false);
  /** The table page asks the layout to hide the site header and the corner lattice. */
  chromeHidden = $state(false);
  #stop: (() => void) | null = null;

  start(): () => void {
    if (this.#stop || typeof window === 'undefined') return this.#stop ?? (() => {});
    const mq = matchMedia(POCKET_QUERY);
    const set = () => (this.screen = mq.matches);
    set();
    mq.addEventListener('change', set);
    this.#stop = () => {
      mq.removeEventListener('change', set);
      this.#stop = null;
    };
    return this.#stop;
  }
}

export const pocket = new Pocket();
