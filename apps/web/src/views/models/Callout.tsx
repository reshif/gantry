import type { ReactNode } from "react";
import { Icon } from "../../ui/Icon";

export function Callout({ warn, icon, cls = "", children, role }: { warn?: boolean; icon?: string; cls?: string; children: ReactNode; role?: "status" | "alert" }) {
  return (
    <div className={`callout${warn ? " callout-warn" : ""}${cls ? ` ${cls}` : ""}`} role={role}>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </div>
  );
}
