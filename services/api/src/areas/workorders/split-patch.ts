/** Splits a unified diff of a commit ("diff --git a/x b/x" sections) into the text of each file, keyed by its path. */
export function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  let path: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (path !== null) out.set(path, (out.get(path) ?? "") + buf.join("\n") + "\n");
  };
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      flush();
      path = m[2]!;
      buf = [line];
    } else if (path !== null) buf.push(line);
  }
  flush();
  for (const [k, v] of out) out.set(k, v.replace(/\n+$/, "\n"));
  return out;
}
