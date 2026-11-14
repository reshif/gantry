import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import type { Logger } from "pino";
import type { WorkerConfig } from "./config.js";
import { errMsg } from "./errors.js";

/**
 * Nothing in compose creates the object-storage bucket (platform notes), so the worker does at boot: idempotent, and it waits for MinIO.
 * Returns false when it gave up (the worker still runs; the edge reports the problem when it cannot store a checkpoint).
 */
export async function ensureBucket(cfg: WorkerConfig, log: Logger, o: { attempts?: number; delayMs?: number } = {}): Promise<boolean> {
  if (!cfg.s3.endpoint || !cfg.s3.secretKey) {
    log.info("object storage is not configured; bucket creation skipped");
    return true;
  }
  const s3 = new S3Client({
    endpoint: cfg.s3.endpoint, region: cfg.s3.region, forcePathStyle: true, credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
  const attempts = o.attempts ?? 20;
  for (let i = 1; i <= attempts; i++) {
    try {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: cfg.s3.bucket }));
        return true;
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 404 && (e as { name?: string }).name !== "NotFound") throw e;
      }
      await s3.send(new CreateBucketCommand({ Bucket: cfg.s3.bucket }));
      log.info({ bucket: cfg.s3.bucket }, "created object storage bucket");
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === "BucketAlreadyOwnedByYou") return true;
      log.warn({ attempt: i, err: errMsg(e) }, "object storage not ready");
      await new Promise((r) => setTimeout(r, o.delayMs ?? 3_000));
    }
  }
  log.error({ bucket: cfg.s3.bucket }, "could not create the object storage bucket");
  return false;
}
