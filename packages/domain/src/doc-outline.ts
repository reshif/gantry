/**
 * The headings of a markdown document, outside code fences. One definition for the whole product: the viewer's section picker (web) and the API's
 * check that a comment names a section of that version both read headings through this, so what the picker lists is always accepted.
 */
export interface DocHeading { level: number; text: string }

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** A heading's text as shown and as matched: inline code and emphasis marks removed, nothing else (links and HTML stay as written). */
export const headingText = (raw: string): string => raw.replace(/[`*_~]/g, "").trim();

export function docHeadings(md: string): DocHeading[] {
  const out: DocHeading[] = [];
  let fence = false;
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h) out.push({ level: h[1]!.length, text: headingText(h[2]!) });
  }
  return out;
}
