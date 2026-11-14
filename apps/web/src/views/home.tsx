/** Home (#home): the factory overview for Factory Admins and the Auditor, My work for everyone else. Ported from legacy/js/views/home.js. */
import { useState } from "react";
import { useHome, useMe } from "../api/queries";
import { Empty, ViewHead } from "../ui/primitives";
import { FactoryView } from "./home/Factory";
import { MyWork } from "./home/Mine";
import type { HomeFull } from "./home/data";

export default function HomeView() {
  const me = useMe();
  const q = useHome();
  const [pick, setPick] = useState<{ who: string; mode: "factory" | "mine" } | null>(null);
  const home = q.data as unknown as HomeFull | undefined;
  if (!me) return null;
  if (q.isError) {
    return (
      <div className="view hm">
        <ViewHead kicker="Home" title="Home" />
        <Empty title="Home could not be loaded" text="Reload the page, or try again in a moment." />
      </div>
    );
  }
  if (!home) {
    return (
      <div className="view hm">
        <ViewHead kicker="Home" title="Home" />
        <p className="muted small">Loading…</p>
      </div>
    );
  }
  // Factory-wide roles start on the overview; the choice is theirs for this visit.
  const mode = home.mine.factoryRole && home.mode === "factory" ? (pick?.who === me.person.id ? pick.mode : "factory") : "mine";
  const to = (m: "factory" | "mine") => setPick({ who: me.person.id, mode: m });
  return mode === "factory" ? <FactoryView home={home} onMine={() => to("mine")} /> : <MyWork home={home} onFactory={() => to("factory")} />;
}
