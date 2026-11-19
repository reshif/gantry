import type { HostCapacity } from "../src/config.js";
/** A big host, so the tests do not depend on the machine they run on (the sizing check has its own tests). */
export const BIG_HOST: HostCapacity = { memBytes: 256 * 2 ** 30, cpus: 64 };
