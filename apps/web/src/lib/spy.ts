/**
 * Which section of a page is being read: the last heading to have come within reach of the top of the window.
 * Calls `onChange` with that heading's id (or null above the first one) as the page scrolls.
 */
/** How far down the window (px) a heading counts as reached. */
const LINE = 120;

export function watchSections(headings: () => Iterable<HTMLElement>, onChange: (id: string | null) => void): () => void {
  let frame = 0;
  const read = () => {
    frame = 0;
    let current: string | null = null;
    for (const h of headings()) {
      if (h.getBoundingClientRect().top > LINE) break;
      current = h.id;
    }
    onChange(current);
  };
  const onScroll = () => {
    frame ||= requestAnimationFrame(read);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  read();
  return () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    if (frame) cancelAnimationFrame(frame);
  };
}
