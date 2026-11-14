/** Runner variants and the ecosystems each carries (the base image has Node and Python); override with RUNNER_TOOLCHAINS="base=node,python;go=go". */
export const DEFAULT_TOOLCHAINS: Record<string, string[]> = { base: ["node", "python"] };

export const parseToolchains = (v: string | undefined): Record<string, string[]> => {
  if (!v) return DEFAULT_TOOLCHAINS;
  const out: Record<string, string[]> = {};
  for (const part of v.split(";")) {
    const [name, list] = part.split("=");
    if (name?.trim() && list) out[name.trim()] = list.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return Object.keys(out).length ? out : DEFAULT_TOOLCHAINS;
};
