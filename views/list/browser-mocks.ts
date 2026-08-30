import { COMPACT_VIEWPORT_QUERY } from "@/components/ui/hooks/use-compact-viewport";

/**
 * jsdom implements neither matchMedia nor ResizeObserver, and the list shell
 * touches both. Suites call this before loading the plugin app.
 *
 * `compactViewport` reports the compact media query as matching, so the
 * responsive sort/filter menus and inline pickers render as their mobile
 * drawers, whose plain buttons are clickable in jsdom (unlike Radix menu
 * items). Leave it off for the desktop branch.
 */
export function installBrowserMocks(options: { compactViewport?: boolean } = {}) {
  const { compactViewport = false } = options;
  const matchMedia = (query: string) =>
    ({
      matches: compactViewport && query === COMPACT_VIEWPORT_QUERY,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: matchMedia,
  });
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
}
