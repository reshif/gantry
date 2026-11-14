// Row-to-legacy-shape mappers shared by the read model. A row's jsonb `data` carries legacy fields that have no column;
// they are spread first so named columns always win.
export const ms = (d: Date | string | null | undefined): number | undefined => (d == null ? undefined : new Date(d).getTime());
export const num = (v: unknown, dflt = 0): number => (v == null ? dflt : Number(v));
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

type Thunks<T extends readonly unknown[]> = { [K in keyof T]: () => Promise<T[K]> };

/**
 * Runs independent reads. On a pool they run concurrently; on a single transaction client (which executes one query at a time)
 * they run in order, so the driver never queues queries on a busy client.
 */
export async function reads<T extends readonly unknown[]>(db: object, thunks: Thunks<T>): Promise<T> {
  if ("release" in db) {
    const out: unknown[] = [];
    for (const t of thunks) out.push(await t());
    return out as unknown as T;
  }
  return (await Promise.all(thunks.map((t) => t()))) as unknown as T;
}
