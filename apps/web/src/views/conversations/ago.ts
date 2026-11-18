/** "Just now", "40m ago", "2h ago", "3d ago": the prototype's wording for a message time (days from 48 hours on). */
export function agoShort(t: number, now: number = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  return h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
}
