/**
 * The model gateway's outbound fetch (S-68). A vendor endpoint is set by a person in the API and checked there, but the edge checks again on every call:
 * it resolves the name itself and refuses loopback, link-local (cloud metadata), the control network and, unless a Factory Admin listed the LAN range for an
 * on-prem vendor, private space. The address checked is the address connected to (the lookup is the agent's own), so a name rebound after the API's check
 * is caught; an IP literal never reaches a lookup, so it is checked before the request. Redirects are refused: a vendor API does not need one.
 */
import dns from "node:dns";
import net from "node:net";
import { vendorAddressRefusal } from "@gantry/domain/netguard";
import { Agent, fetch as ufetch } from "undici";

/** A fetch init that may carry the LAN ranges the vendor's route allows. */
export type UpstreamInit = RequestInit & { lan?: readonly string[] | undefined };

const agents = new Map<string, Agent>();

function agentFor(lan: readonly string[]): Agent {
  const key = [...lan].sort().join(",");
  const hit = agents.get(key);
  if (hit) return hit;
  const lookup = ((hostname: string, options: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = addrs as dns.LookupAddress[];
      const bad = list.map((a) => vendorAddressRefusal(a.address, lan)).find((r) => r !== null);
      if (!list.length || bad) return cb(Object.assign(new Error(`Vendor endpoint refused: ${hostname} resolves to an address a model call may not reach (${bad ?? "no address"}).`), { code: "EPRIVATE" }));
      return options.all ? cb(null, list) : cb(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as net.LookupFunction;
  const a = new Agent({ connect: { lookup }, bodyTimeout: 0, headersTimeout: 60_000 });
  agents.set(key, a);
  return a;
}

/** The fetch the gateways use when no test double is given. `blockPrivate` false (EDGE_ALLOW_PRIVATE_UPSTREAMS) keeps the old open behaviour for a dev stack. */
export function upstreamFetch(blockPrivate: boolean): (url: string | URL, init?: UpstreamInit) => Promise<Response> {
  return async (url, init = {}) => {
    const { lan, ...rest } = init;
    if (!blockPrivate) return fetch(url, rest);
    const host = new URL(String(url)).hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) {
      const bad = vendorAddressRefusal(host, lan ?? []);
      if (bad) throw new Error(`Vendor endpoint refused: ${bad}`);
    }
    return ufetch(url, { ...(rest as object), redirect: "error", dispatcher: agentFor(lan ?? []) } as never) as unknown as Promise<Response>;
  };
}
