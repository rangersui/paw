export interface Pt {
  x: number;
  y: number;
}

export function bezierPath(a: Pt, b: Pt, steps = 24): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;

  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const px = -dy / dist;
  const py = dx / dist;
  const offset = (Math.random() - 0.5) * dist * 0.4;
  const cx = mx + px * offset;
  const cy = my + py * offset;

  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * a.x + 2 * u * t * cx + t * t * b.x,
      y: u * u * a.y + 2 * u * t * cy + t * t * b.y,
    });
  }
  return out;
}
