/** Typed read of the egress hosts (S-67). Its own module, imported by the Security screen only, so it stays out of the entry bundle. Keys come from ../keys (`qk`). */
import { useQuery } from "@tanstack/react-query";
import { api, get } from "../client";
import { qk } from "../keys";
import { readIfAllowed } from "../can";

const SECURITY = ["security.manage", "policy.view"] as const;

/** Every host on the run and worker egress lists, with where it came from (S-67). */
export interface EgressHost { host: string; list: "run" | "worker"; kind: string; source: string }
export const useEgressHosts = () => useQuery({ queryKey: [...qk.security(), "egress"] as const, queryFn: () => readIfAllowed(SECURITY, () => get<{ hosts: EgressHost[] }>(api("security/egress-hosts"))) });
