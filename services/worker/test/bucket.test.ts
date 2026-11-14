import http from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ensureBucket } from "../src/bucket.js";
import { testWorkerConfig } from "./world.js";

const log = pino({ level: "silent" });

describe("ensureBucket", () => {
  it("creates the bucket when it is missing, and leaves an existing one alone", async () => {
    const seen: string[] = [];
    let exists = false;
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.method === "HEAD") { res.writeHead(exists ? 200 : 404); return void res.end(); }
      if (req.method === "PUT") { exists = true; res.writeHead(200); return void res.end(); }
      res.writeHead(500); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const cfg = testWorkerConfig({ s3: { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bucket: "gantry", accessKey: "gantry", secretKey: "secret-pw", region: "us-east-1" } });
    expect(await ensureBucket(cfg, log, { attempts: 2, delayMs: 10 })).toBe(true);
    expect(seen).toEqual(["HEAD /gantry/", "PUT /gantry/"]);
    seen.length = 0;
    expect(await ensureBucket(cfg, log, { attempts: 2, delayMs: 10 })).toBe(true);
    expect(seen).toEqual(["HEAD /gantry/"]);
    await new Promise((r) => server.close(r));
  });

  it("gives up without throwing when object storage never answers, and skips when it is not configured", async () => {
    const cfg = testWorkerConfig({ s3: { endpoint: "http://127.0.0.1:1", bucket: "gantry", accessKey: "gantry", secretKey: "x", region: "us-east-1" } });
    expect(await ensureBucket(cfg, log, { attempts: 2, delayMs: 10 })).toBe(false);
    expect(await ensureBucket(testWorkerConfig(), log)).toBe(true);
  });
});
