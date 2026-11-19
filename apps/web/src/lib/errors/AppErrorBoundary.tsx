/**
 * One error boundary, used at three levels: the root (whole app), the chrome (top bar, nav) and the route (one screen).
 * The fallback moves focus to its heading, is a role=alert, shows an error id the person can quote, and offers Retry (re-render)
 * and Reload. Raw error text is shown only in development builds. It deliberately uses plain elements: the root fallback must
 * work when providers and primitives are what broke.
 */
import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import "../session/reconnect.css";
import { reportError } from "./reporter";

export type BoundaryLevel = "root" | "chrome" | "route";

interface Props {
  level: BoundaryLevel;
  /** When this changes the boundary clears itself (route changes). */
  resetKey?: string;
  children: ReactNode;
}
interface State {
  error: Error | null;
  id: string;
}

const isChunkError = (e: Error): boolean => /dynamically imported module|importing a module script|Loading chunk|Failed to fetch dynamically/i.test(e.message);

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, id: "" };
  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    const id = reportError(error, this.props.level);
    this.setState({ id });
    if (import.meta.env.DEV) console.error(error, info.componentStack);
  }
  override componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, id: "" });
  }
  private retry = () => this.setState({ error: null, id: "" });
  override render() {
    const { error, id } = this.state;
    if (!error) return this.props.children;
    return <Fallback level={this.props.level} error={error} id={id} onRetry={this.retry} />;
  }
}

function Fallback({ level, error, id, onRetry }: { level: BoundaryLevel; error: Error; id: string; onRetry: () => void }) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (level !== "chrome") head.current?.focus();
  }, [level]);
  const chunk = isChunkError(error);
  const title =
    level === "chrome" ? "This part of the page failed" : chunk ? "A newer version of Gantry is available" : level === "root" ? "Gantry hit a problem" : "This screen failed to render";
  const text = chunk ? "Reload to get the latest version." : "Nothing you entered elsewhere was lost. Try again, or reload the page.";
  const body = (
    <div className={`error-fallback error-${level}`} role="alert" id={`error-${level}`}>
      <h2 className="empty-title" tabIndex={-1} ref={head}>{title}</h2>
      <p>{text}</p>
      {import.meta.env.DEV ? <pre className="error-detail">{error.message}</pre> : null}
      {id ? <p className="error-id">Error id <code>{id}</code></p> : null}
      <p>
        {/* React.lazy caches the rejected import, so re-rendering would throw the same error: a missing chunk offers Reload only */}
        {chunk ? null : <button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button>}{" "}
        <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>Reload</button>
      </p>
    </div>
  );
  if (level === "root") return <div className="boot">{body}</div>;
  if (level === "route") {
    // prototype crash sheet: "Something went wrong" header, one panel, Retry and Home
    return (
      <div className="view error-route" id="error-route">
        <header className="ph vhead"><div className="title vhead-main"><h1 className="vtitle" tabIndex={-1} ref={head}>{chunk ? "This screen could not load" : "Something went wrong"}</h1></div></header>
        <section className="panel">
          <div className="state" role="alert">
            <svg className="art" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M12 3l10 18H2zM12 10v5M12 18h.01" /></svg>
            <h3 className="empty-title">{chunk ? "Reload to continue" : "This sheet failed to draw"}</h3>
            <p>{chunk ? "This screen could not load (a new version may have been deployed). Reload to get the latest version." : "Nothing you entered elsewhere was lost."}</p>
            {import.meta.env.DEV ? <pre className="error-detail">{error.message}</pre> : null}
            {id ? <p className="error-id">Error id <code>{id}</code></p> : null}
            <div className="row">
              {/* React.lazy caches the rejected import, so re-rendering would throw the same error: a missing chunk offers Reload only */}
              {chunk ? <button type="button" className="btn primary" onClick={() => window.location.reload()}>Reload</button> : <button type="button" className="btn primary" onClick={onRetry}>Retry</button>}
              <a className="btn" href="#home">{chunk ? "Go home" : "Home"}</a>
            </div>
          </div>
        </section>
      </div>
    );
  }
  return body;
}
