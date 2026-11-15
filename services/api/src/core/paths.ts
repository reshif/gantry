/**
 * The path every security check reads. The router decodes percent-escapes before it matches a route, so a check that reads the raw
 * `req.url` can be skipped by encoding one character (`/api/v1/%70eople` routes to `/api/v1/people`). This returns the path as the
 * router sees it: each segment decoded once, with `%` and `/` inside a segment re-escaped so segment boundaries and a later single
 * decode of a captured id give exactly the router's parameter value. `null` for a path that cannot be decoded (the caller refuses it).
 */
export function canonicalPath(rawUrl: string): string | null {
  const raw = rawUrl.split("?")[0] ?? "";
  try {
    return raw
      .split("/")
      .map((seg) => decodeURIComponent(seg).replace(/%/g, "%25").replace(/\//g, "%2F"))
      .join("/");
  } catch {
    return null;
  }
}
