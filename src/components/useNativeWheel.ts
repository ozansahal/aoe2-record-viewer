import { useEffect, useRef, type RefObject } from "react";

/**
 * A non-passive wheel listener.
 *
 * React registers its own onWheel passively, so preventDefault there is a
 * no-op; the scrubber needs the default cancelled or the page scrolls under
 * the cursor and Firefox's built-in range-wheel handling doubles up.
 */
export function useNativeWheel(
  ref: RefObject<HTMLElement | null>,
  handler: (event: WheelEvent) => void,
) {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => latest.current(event);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}
