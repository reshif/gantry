import type pg from "pg";
import type { Logger } from "pino";
import type { WorkerConfig } from "./config.js";
import type { BrokerClient } from "./clients/broker.js";
import type { LauncherClient } from "./clients/launcher.js";
import type { OutboundHttp } from "./outbox/http.js";
import type { Mailer } from "./outbox/smtp.js";

/** Everything a handler needs. Tests pass the same shape with the doubles' URLs behind the real clients. */
export interface Deps {
  pool: pg.Pool;
  cfg: WorkerConfig;
  log: Logger;
  workerId: string;
  launcher: LauncherClient;
  broker: BrokerClient;
  http: OutboundHttp;
  mail: Mailer;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
