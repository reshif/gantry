/** GET /api/v1/people/{id}/effective-permissions: compact cells, decided now by can(). */
export interface EffectivePermissions {
  person: string;
  at: number;
  projects: Array<{ id: string; name: string }>;
  actions: Array<{ id: string; name: string; group: string; scope: "project" | "factory" }>;
  cells: Record<string, Record<string, [0 | 1, string]>>;
  rules: Record<string, { kind: string; name: string }>;
  factory: Record<string, { allowed: boolean; reason: string; rule: { id: string; name?: string }; needs?: string }>;
}
