/** The prototype's relative time: the largest whole unit, `13h ago`, `5m ago`, `2d ago`. */
export function agoMs(ms: number): string {
  const d = Math.max(0, ms) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

/** Time of day greeting. */
export function greetingAt(hour: number): string {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
