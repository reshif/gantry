/** A message ends with exactly one full stop (or the ? or ! it already ends with): never "again.." when a message that ends in a full stop is placed in a sentence. */
export const endSentence = (s: string): string => {
  const t = s.trim().replace(/\.{2,}$/, ".");
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
