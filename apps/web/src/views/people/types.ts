/** GET /api/v1/people/{id}/effective-permissions: compact cells, decided now by can(). */
export interface EffectivePermissions {
  person: string;
  at: number;
  projects: Array<{ id: string; name: string }>;
  actions: Array<{ id: string; name: string; group: string; scope: "project" | "factory" }>;
  /** `[allowed, deciding rule, sources]`: sources are "direct" and/or team ids (names in `teams`). */
  cells: Record<string, Record<string, [0 | 1, string, string[]?]>>;
  teams?: Record<string, string>;
  grants?: Array<{ role: string; roleName: string; scope: string; via: string | null }>;
  rules: Record<string, { kind: string; name: string }>;
  factory: Record<string, { allowed: boolean; reason: string; rule: { id: string; name?: string }; needs?: string; sources?: string[] }>;
}
