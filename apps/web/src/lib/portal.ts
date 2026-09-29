/** `use:portal` mounts an element on <body>, above every layer of the page (the shell is its own stacking context). */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return { destroy: () => node.remove() };
}
