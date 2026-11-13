import { ICON_PATHS, type IconName } from "./icon-paths";

export type { IconName };

/** Stroke icon on a 24 grid; same markup as legacy G.icon(). Unknown names fall back to the dots glyph. */
export function Icon({ name, className = "" }: { name: string; className?: string }) {
  const inner = (ICON_PATHS as Record<string, string>)[name] ?? ICON_PATHS.dots;
  return (
    <span className={`ic ${className}`} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: inner }}
      />
    </span>
  );
}

/** The Gantry mark (legacy G.logo). */
export function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <svg
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        dangerouslySetInnerHTML={{
          __html:
            '<path d="M4 28V6h24v22"/><path d="M4 10h24"/><path d="M14 10v8"/><rect x="11" y="18" width="6" height="5"/><path d="M8 6l4 4M24 6l-4 4"/>',
        }}
      />
    </span>
  );
}
