import { useCallback, useEffect, useRef } from "react";

const HOLD_DELAY = 320;
const HOLD_TICK = 50;

/**
 * A tap fires once, holding repeats.
 *
 * Pointer capture keeps the repeat alive if the cursor slides off the button
 * mid-hold, and a window-level pointerup guarantees it stops even when the
 * button is released somewhere else entirely.
 */
export function useHoldRepeat(step: (shift: boolean) => void) {
  const delay = useRef<number | null>(null);
  const repeat = useRef<number | null>(null);
  const latest = useRef(step);
  latest.current = step;

  const stop = useCallback(() => {
    if (delay.current !== null) clearTimeout(delay.current);
    if (repeat.current !== null) clearInterval(repeat.current);
    delay.current = repeat.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", stop);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [stop]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* not fatal */
    }
    const shift = event.shiftKey;
    latest.current(shift);
    delay.current = window.setTimeout(() => {
      repeat.current = window.setInterval(() => latest.current(shift), HOLD_TICK);
    }, HOLD_DELAY);
  }, []);

  return { onPointerDown, onPointerUp: stop, onPointerCancel: stop };
}
