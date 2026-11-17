import { useEffect, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, setUnauthorizedHandler } from "./api/client";
import { bindQueryClient, invalidateSlices } from "./api/keys";
import { useMeState } from "./api/queries";
import { useClearDraftsOnUserSwitch } from "./lib/useDraft";
import { startStream } from "./api/stream";
import { applyTheme, reducedMotion, usePrefs } from "./lib/prefs";
import { OverlayProvider } from "./ui/Overlay";
import { Tip } from "./ui/Tip";
import { Shell } from "./shell/Shell";
import { SignIn } from "./shell/SignIn";

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
  const prefs = usePrefs();
  const signedIn = meState.data?.status === "in";

  useClearDraftsOnUserSwitch(meState.data?.status === "in" ? meState.data.me.person.id : null);
  useEffect(() => applyTheme(prefs.theme), [prefs.theme]);
  useEffect(() => {
    document.body.classList.toggle("signed-out", meState.data?.status === "out");
    if (reducedMotion()) document.documentElement.setAttribute("data-reduced-motion", "true");
  }, [meState.data?.status]);

  // live updates only while signed in
  useEffect(() => (signedIn ? startStream() : undefined), [signedIn]);

  if (meState.isPending) return <div className="boot">Loading…</div>;
  if (meState.isError) {
    return (
      <div className="boot" role="alert">
        Gantry could not be reached. <button type="button" className="btn btn-sm" onClick={() => void meState.refetch()}>Try again</button>
      </div>
    );
  }
  if (meState.data.status === "out") {
    const err = new URLSearchParams(window.location.search).get("auth_error");
    return <SignIn config={meState.data.config} error={err} />;
  }
  return <Shell me={meState.data.me} />;
}

export default function App() {
  const client = useMemo(() => makeQueryClient(), []);
  // Bind in an effect, not in useMemo: React StrictMode (dev) runs the memo twice and keeps one result, so binding there can leave
  // ops.invalidateSlices pointing at a client the UI does not use and no screen refreshes after a change.
  useEffect(() => {
    bindQueryClient(client);
    return () => bindQueryClient(null);
  }, [client]);
  useEffect(() => {
    setUnauthorizedHandler(() => invalidateSlices(["session"]));
    return () => setUnauthorizedHandler(null);
  }, []);
  return (
    <QueryClientProvider client={client}>
      <OverlayProvider>
        <Root />
        <Tip />
      </OverlayProvider>
    </QueryClientProvider>
  );
}
