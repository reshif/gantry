import "../../lib/data.css";
import { Btn } from "../../ui/primitives";
import type { ReposRead } from "./data";

/** Shown where repos are listed or picked when a repo read failed: say so (with Retry) instead of an empty list or an empty picker. */
export function ReposReadNote({ read, id = "repos-read" }: { read: ReposRead; id?: string }) {
  if (!read.failed) return null;
  return (
    <div className="async-stale" role="alert" id={id}>
      <span>{read.hidden ? `Some repos are not visible to you. ${read.msg}` : `Couldn't load every repo, so the list below may be missing some. ${read.msg}`}</span>
      {read.hidden ? null : <Btn small icon="refresh" label="Try again" id={`${id}-retry`} onClick={read.retry} />}
    </div>
  );
}
