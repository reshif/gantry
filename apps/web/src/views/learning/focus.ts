/** Other screens deep-link here (legacy G.learningFocus): call it, then navigate to #learning. The next render of the screen reads it once. */
export interface LearningFocus {
  finding?: string;
  proposal?: string;
  tab?: "proposals" | "findings" | "signals";
}
let pending: LearningFocus | null = null;
export const learningFocus = (o: LearningFocus): void => { pending = o; };
export const takeLearningFocus = (): LearningFocus | null => { const p = pending; pending = null; return p; };
