// Deterministic GitHub-style identicon: a 5×5 horizontally-mirrored pixel grid
// with a hashed hue, derived purely from a seed string. The same seed always
// yields the same avatar, so nothing needs to be stored — but agents carry an
// explicit `avatarSeed` (defaulting to their id) so the avatar can be reshuffled
// and stays identical everywhere it's drawn.

/** FNV-1a → unsigned 32-bit hash. Stable across runs/browsers. */
function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Resolved colours + the 5×5 fill grid (row-major) for a seed. */
export function identiconData(seed: string): { fg: string; bg: string; grid: boolean[] } {
  const h = hashSeed(seed);
  const hue = h % 360;
  const grid: boolean[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const src = col < 3 ? col : 4 - col; // mirror cols 3–4 onto 1–0
      grid[row * 5 + col] = ((h >> (src * 5 + row)) & 1) === 1;
    }
  }
  return { fg: `hsl(${hue} 58% 48%)`, bg: `hsl(${hue} 28% 92%)`, grid };
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
  const { fg, bg, grid } = identiconData(seed);
  const rects: React.ReactNode[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      if (grid[row * 5 + col])
        rects.push(<rect key={`${row}-${col}`} x={col} y={row} width={1} height={1} />);
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

/** Render an identicon to a PNG and trigger a browser download. */
export function downloadIdenticon(seed: string, filename: string, size = 256): void {
  const { fg, bg, grid } = identiconData(seed);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cell = size / 7; // viewBox is -1 -1 7 7 → 1-cell margin around the 5×5 grid
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = fg;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      if (grid[row * 5 + col])
        ctx.fillRect((col + 1) * cell, (row + 1) * cell, cell + 0.5, cell + 0.5);
    }
  }
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename.endsWith('.png') ? filename : `${filename}.png`;
  a.click();
}

/** A short random seed for the "shuffle" action. */
export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 12);
}
