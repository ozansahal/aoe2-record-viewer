/**
 * Play/pause, in the one place the glyphs are decided.
 *
 * Two toolbars show it -- the scrubber's and the floating HUD's -- and they
 * are shaped differently enough to bring their own class, so that is all this
 * takes from the caller.
 */
interface Props {
  playing: boolean;
  onToggle: () => void;
  className?: string;
}

export function PlayButton({ playing, onToggle, className }: Props) {
  return (
    <button
      type="button"
      className={className}
      aria-label={playing ? "Pause" : "Play"}
      aria-pressed={playing}
      title={playing ? "Pause — space" : "Play — space"}
      onClick={onToggle}
    >
      {playing ? "❚❚" : "▶"}
    </button>
  );
}
