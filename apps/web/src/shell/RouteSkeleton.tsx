/** Suspense fallback for a lazy screen: shows structure immediately (no blank frame, no delay). */
export function RouteSkeleton() {
  return (
    <div className="view route-skeleton" role="status" aria-busy="true" aria-label="Loading screen">
      <span className="async-bar" style={{ width: "28%", height: 22 }} />
      <span className="async-bar" style={{ width: "92%" }} />
      <span className="async-bar" style={{ width: "78%" }} />
      <span className="async-bar" style={{ width: "64%" }} />
    </div>
  );
}
