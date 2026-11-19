/** S-69: Postgres refuses U+0000 in text, so a NUL anywhere in a request is refused with 400 before a handler can turn it into a 500. */
/** A NUL in the raw or percent-decoded request target (path or query). */
export function hasNul(url: string): boolean {
  if (url.includes("\u0000")) return true;
  if (/%00/i.test(url)) return true;
  try {
    return decodeURIComponent(url).includes("\u0000");
  } catch {
    return false;
  }
}

/** A NUL in any string or key of a parsed JSON body (bounded depth: a deeper body is left to the schema's own limits). */
export function bodyHasNul(v: unknown, depth = 0): boolean {
  if (typeof v === "string") return v.includes("\u0000");
  if (depth > 32 || !v || typeof v !== "object") return false;
  for (const [k, x] of Array.isArray(v) ? v.entries() : Object.entries(v)) if ((typeof k === "string" && k.includes("\u0000")) || bodyHasNul(x, depth + 1)) return true;
  return false;
}

