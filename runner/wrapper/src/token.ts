import { open, unlink, stat } from "node:fs/promises";
import { err, ok, type Result } from "./result.js";

/** Where the launcher copies the run token (services/launcher/src/template.ts, TOKEN_FILE_PATH): the workspace volume, mode 0400, our uid. */
export const TOKEN_FILE = "/workspace/.gantry-run-token";

/**
 * Reads the run token from its file and removes the file, fail closed: when the file cannot be removed (or is still there afterwards) the token is
 * not used, because a tool subprocess of the same uid could read it. Called first in main, before the harness or any subprocess exists, so the file
 * lives only from container start to the first moments of the wrapper. The token is not echoed in any error.
 */
export async function takeToken(path: string = TOKEN_FILE): Promise<Result<string, string>> {
  let text: string;
  try {
    const fh = await open(path, "r");
    try {
      text = (await fh.readFile("utf8")).trim();
    } finally {
      await fh.close();
    }
  } catch (e) {
    return err(`The run token file ${path} could not be read: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    await unlink(path);
    await stat(path).then(
      () => {
        throw new Error("still there");
      },
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      },
    );
  } catch (e) {
    return err(`The run token file ${path} could not be removed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); refusing to run with a readable token.`);
  }
  if (!text) return err("The run token file is empty.");
  return ok(text);
}
