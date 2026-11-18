import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ApiError, setUnauthorizedHandler } from "./api/client";
import { bindQueryClient, invalidateSlices } from "./api/keys";
import { useMeState } from "./api/queries";
import { useClearDraftsOnUserSwitch } from "./lib/useDraft";
import { startStream } from "./api/stream";
import { canBatcher } from "./api/can";
import { startConnectionWatch } from "./lib/connection/store";
import { deriveSession, noteUnauthorized, registerSessionReset, useSessionLifecycle } from "./lib/session/session";
import { ReconnectBanner } from "./lib/session/ReconnectBanner";
import { AppErrorBoundary } from "./lib/errors/AppErrorBoundary";
import { applyTheme, reducedMotion, resetPrefsInMemory, usePrefs } from "./lib/prefs";
import { OverlayProvider } from "./ui/Overlay";
import { Tip } from "./ui/Tip";
import { Shell } from "./shell/Shell";
import { SignIn } from "./shell/SignIn";
import { useDropStaleSearch } from "./lib/staleSearch";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        // a 4xx is an answer (permission, missing), not a blip: do not retry it
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  });
}

function Root() {
  const meState = useMeState();
  const client = useQueryClient();
  const prefs = usePrefs();
  const session = deriveSession(meState);
  const signedIn = session.state === "in";
  const me = meState.data?.status === "in" ? meState.data.me : null;
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const onSigninRoute = hash === "#/signin" || hash === "#signin";

  useSessionLifecycle(client, meState.data);
  useClearDraftsOnUserSwitch(meState.data?.status === "in" ? meState.data.me.person.id : null);
  useEffect(() => applyTheme(prefs.theme), [prefs.theme]);
  useEffect(() => {
    document.body.classList.toggle("signed-out", session.state === "out");
    if (reducedMotion()) document.documentElement.setAttribute("data-reduced-motion", "true");
  }, [session.state]);

  // live updates only while signed in
  useEffect(() => (signedIn ? startStream() : undefined), [signedIn]);
  useEffect(() => startConnectionWatch(), []);
  useDropStaleSearch();

  // Branch on data FIRST: a failed refetch of /me must never unmount a signed-in app.
  if (me && onSigninRoute) {
    // the prototype keeps #/signin reachable while signed in: it draws the sign-in card (a route of its own, no redirect to Home)
    return <SignIn config={null} error={null} needs={null} />;
  }
  if (me) {
    return (
      <>
        <Shell key={me.person.id} me={me} />
        {session.stale ? <ReconnectBanner onRetry={() => void meState.refetch()} retrying={meState.isFetching} /> : null}
      </>
    );
  }
  if (meState.data?.status === "out") {
    const qs = new URLSearchParams(window.location.search);
    const needs = qs.get("auth_needs") ?? meState.data.needs ?? null;
    return <SignIn config={meState.data.config} error={qs.get("auth_error")} needs={needs} />;
  }
  if (session.state === "offline") {
    return (
      <div className="boot" role="alert">
        Gantry could not be reached. <button type="button" className="btn btn-sm" onClick={() => void meState.refetch()}>Try again</button>
      </div>
    );
  }
  return <div className="boot">Loading…</div>;
}

export default function App() {
  const client = useMemo(() => makeQueryClient(), []);
  // Bind in an effect, not in useMemo: React StrictMode (dev) runs the memo twice and keeps one result, so binding there can leave
  // ops.invalidateSlices pointing at a client the UI does not use and no screen refreshes after a change.
  useEffect(() => {
    bindQueryClient(client);
    return () => bindQueryClient(null);
  }, [client]);
  useEffect(
    () =>
      registerSessionReset((reason) => {
        canBatcher.clear();
        // storage keeps prefs only across an expiry; otherwise memory must match the wiped storage
        if (reason !== "expired") resetPrefsInMemory();
      }),
    [],
  );
  useEffect(() => {
    setUnauthorizedHandler(() => {
      noteUnauthorized();
      invalidateSlices(["session"]);
    });
    return () => setUnauthorizedHandler(null);
  }, []);
  return (
    <QueryClientProvider client={client}>
      <OverlayProvider>
        <AppErrorBoundary level="root">
          <Root />
        </AppErrorBoundary>
        <Tip />
      </OverlayProvider>
    </QueryClientProvider>
  );
}
