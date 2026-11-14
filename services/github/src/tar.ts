/**
 * Minimal tar writer and reader, so the broker needs no archive library and controls exactly what it accepts.
 * The reader is the security boundary for workspace contents (untrusted): only regular files and directories are materialised,
 * links and devices are skipped, names that escape the destination are refused, and sizes are capped.
 */
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readlink, open } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const BLOCK = 512;

function octal(n: number, len: number): Buffer {
  const b = Buffer.alloc(len, 0);
  b.write(n.toString(8).padStart(len - 1, "0").slice(-(len - 1)), 0, "ascii");
  return b;
}

function header(name: string, o: { size: number; mode: number; uid: number; gid: number; mtime: number; type: string; link?: string }): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name.slice(0, 100), 0, "utf8");
  octal(o.mode & 0o7777, 8).copy(h, 100);
  octal(o.uid, 8).copy(h, 108);
  octal(o.gid, 8).copy(h, 116);
  octal(o.size, 12).copy(h, 124);
  octal(Math.floor(o.mtime), 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h.write(o.type, 156, "ascii");
  if (o.link) h.write(o.link.slice(0, 100), 157, "utf8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

const pad = (n: number): Buffer => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK, 0);

function* entryHeaders(name: string, o: Parameters<typeof header>[1]): Generator<Buffer> {
  const bytes = Buffer.byteLength(name);
  if (bytes > 100) {
    // GNU long name: a pseudo entry carrying the name.
    const data = Buffer.from(`${name}\0`);
    yield header("././@LongLink", { size: data.length, mode: 0o644, uid: 0, gid: 0, mtime: 0, type: "L" });
    yield data;
    yield pad(data.length);
  }
  yield header(name, o);
}

/** Streams a directory as a tar, owned by uid:gid (the runner user, so the workspace is writable by it). Names are relative to `dir`. */
export function tarDirectory(dir: string, o: { uid: number; gid: number }): Readable {
  async function* gen(): AsyncGenerator<Buffer> {
    async function* walk(rel: string): AsyncGenerator<Buffer> {
      const abs = rel ? join(dir, rel) : dir;
      for (const ent of (await readdir(abs)).sort()) {
        const r = rel ? posix.join(rel, ent) : ent;
        const st = await lstat(join(dir, r));
        const base = { uid: o.uid, gid: o.gid, mtime: st.mtimeMs / 1000, mode: st.mode };
        if (st.isDirectory()) {
          yield* entryHeaders(`${r}/`, { ...base, size: 0, type: "5" });
          yield* walk(r);
        } else if (st.isSymbolicLink()) {
          yield* entryHeaders(r, { ...base, size: 0, type: "2", link: await readlink(join(dir, r)) });
        } else if (st.isFile()) {
          yield* entryHeaders(r, { ...base, size: st.size, type: "0" });
          const fh = await open(join(dir, r), "r");
          let sent = 0;
          try {
            for await (const chunk of fh.createReadStream({ highWaterMark: 256 * 1024 })) { sent += (chunk as Buffer).length; yield chunk as Buffer; }
          } finally { await fh.close().catch(() => undefined); }
          if (sent !== st.size) throw new Error(`${r} changed while archiving`);
          yield pad(st.size);
        }
      }
    }
    yield* walk("");
    yield Buffer.alloc(BLOCK * 2, 0);
  }
  return Readable.from(gen(), { objectMode: false });
}

export interface ExtractOptions {
  /** Total bytes of file content accepted. */
  maxBytes: number;
  maxEntries?: number;
  /** Return the path to materialise (relative, already stripped of any prefix), or null to skip the entry and its data. */
  map?: (name: string, isDir: boolean) => string | null;
}

export class TarError extends Error {}

const str = (b: Buffer, from: number, len: number): string => {
  const s = b.subarray(from, from + len);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? len : z).toString("utf8");
};
const num = (b: Buffer, from: number, len: number): number => {
  if (b[from]! & 0x80) { let v = 0; for (let i = from + 1; i < from + len; i++) v = v * 256 + b[i]!; return v; } // base-256
  const t = str(b, from, len).trim();
  return t ? parseInt(t, 8) : 0;
};

function paxPath(data: Buffer): string | null {
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString("ascii"), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    if (rec.startsWith("path=")) return rec.slice(5);
    i += len;
  }
  return null;
}

/** Extracts the regular files and directories of a tar stream under `dest`. Returns the number of files and bytes written. */
export async function extractTar(src: AsyncIterable<Buffer | Uint8Array>, dest: string, o: ExtractOptions): Promise<{ files: number; bytes: number }> {
  const root = resolve(dest);
  const it = src[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  let ended = false;
  const need = async (n: number): Promise<boolean> => {
    while (buf.length < n && !ended) {
      const r = await it.next();
      if (r.done) ended = true; else buf = Buffer.concat([buf, Buffer.from(r.value)]);
    }
    return buf.length >= n;
  };
  const take = (n: number): Buffer => { const out = buf.subarray(0, n); buf = buf.subarray(n); return out; };
  let files = 0, bytes = 0, entries = 0;
  let longName: string | null = null, paxName: string | null = null;

  for (;;) {
    if (!(await need(BLOCK))) break;
    const h = take(BLOCK);
    if (h.every((x) => x === 0)) break;
    if (++entries > (o.maxEntries ?? 500_000)) throw new TarError("too many entries");
    const type = String.fromCharCode(h[156] || 0x30);
    const size = num(h, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (type === "L" || type === "x" || type === "g") {
      if (size > 1024 * 1024) throw new TarError("oversized metadata entry");
      if (!(await need(padded))) throw new TarError("truncated archive");
      const data = take(padded).subarray(0, size);
      if (type === "L") longName = str(data, 0, data.length);
      else if (type === "x") paxName = paxPath(data);
      continue;
    }
    let name = longName ?? paxName ?? ((): string => { const p = str(h, 345, 155); const n = str(h, 0, 100); return p && str(h, 257, 5) === "ustar" ? `${p}/${n}` : n; })();
    longName = paxName = null;
    const isDir = type === "5" || name.endsWith("/");
    const isFile = type === "0" || type === "7" || type === "\0";
    const rel = name.replace(/\/+$/, "");
    const mapped = isDir || isFile ? (o.map ? o.map(rel, isDir) : rel) : null;
    const skipN = async (n: number): Promise<void> => {
      let left = n;
      while (left > 0) { if (!(await need(1))) throw new TarError("truncated archive"); const k = Math.min(left, buf.length); take(k); left -= k; }
    };
    const skip = (): Promise<void> => skipN(padded);
    if (mapped === null) { await skip(); continue; }
    if (!mapped || mapped.includes("\0") || posix.isAbsolute(mapped) || mapped.split("/").includes("..")) throw new TarError(`refused unsafe path ${JSON.stringify(name)}`);
    const target = resolve(root, mapped);
    if (target !== root && !target.startsWith(root + sep)) throw new TarError(`refused unsafe path ${JSON.stringify(name)}`);
    if (isDir) { await mkdir(target, { recursive: true }); await skip(); continue; }
    if ((bytes += size) > o.maxBytes) throw new TarError("archive is larger than the allowed size");
    await mkdir(dirname(target), { recursive: true });
    const out = createWriteStream(target, { mode: 0o644, flags: "w" });
    let left = size;
    try {
      while (left > 0) {
        if (!(await need(1))) throw new TarError("truncated archive");
        const k = Math.min(left, buf.length);
        if (!out.write(take(k))) await new Promise<void>((r) => out.once("drain", r));
        left -= k;
      }
      out.end();
      await finished(out);
    } catch (e) { out.destroy(); throw e; }
    await skipN(padded - size);
    files++;
  }
  return { files, bytes };
}
