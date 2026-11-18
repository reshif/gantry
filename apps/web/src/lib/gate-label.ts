/** The label a person reads for a gate. Combined gates have an id without the "+" ("G0G1"); a label that is missing or is just that id is shown the way the catalog writes it ("G0+G1"). */
const COMBINED: Record<string, string> = { G0G1: "G0+G1", G3G3s: "G3+G3s" };
export const gateLabelOf = (label: string | null | undefined, id?: string | null): string => {
  const l = label && label.trim() ? label : (id ?? "");
  return COMBINED[l] ?? l;
};
