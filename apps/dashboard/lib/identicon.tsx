// Deterministic GitHub-style identicon: a 5×5 horizontally-mirrored pixel grid
// with a hashed hue, derived purely from a seed string (e.g. the agent id). The
// same seed always yields the same avatar, so nothing needs to be stored — each
// agent just gets a stable, distinct tile.

/** FNV-1a → unsigned 32-bit hash. Stable across runs/browsers. */
function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A self-contained square avatar. Size + corner rounding come from `className`
 * (e.g. "size-8 rounded-md"); the tile paints its own tinted background so it
 * reads on both light and dark themes (like GitHub's always-light identicons).
 */
export function Identicon({
  seed,
  className = '',
  title,
}: {
  seed: string;
  className?: string;
  title?: string;
}) {
  const h = hashSeed(seed);
  const hue = h % 360;
  const fg = `hsl(${hue} 58% 48%)`;
  const bg = `hsl(${hue} 28% 92%)`;

  // 5 rows × 3 left columns drive the pattern; columns 3–4 mirror 1–0.
  const rects: React.ReactNode[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const src = col < 3 ? col : 4 - col; // mirror
      const bit = (h >> (src * 5 + row)) & 1;
      if (bit) rects.push(<rect key={`${row}-${col}`} x={col} y={row} width={1} height={1} />);
    }
  }

  return (
    <svg
      viewBox="-1 -1 7 7"
      className={className}
      style={{ background: bg, color: fg }}
      role="img"
      aria-label={title ?? `avatar for ${seed}`}
      shapeRendering="crispEdges"
    >
      <g fill="currentColor">{rects}</g>
    </svg>
  );
}
