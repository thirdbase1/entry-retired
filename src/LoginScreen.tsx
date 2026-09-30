import { useEffect, useRef, useState } from "react";
import {
  deviceStart,
  devicePoll,
  openInBrowser,
  type DeviceStart,
} from "./auth";

interface LoginScreenProps {
  onSignedIn: () => void;
}

/**
 * Two-step sign-in: the app prepares a device code on mount, but the
 * browser launches ONLY when the user presses "Sign in". After the press,
 * everything is automatic: browser opens, polling connects on approval.
 */
export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [start, setStart] = useState<DeviceStart | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "expired" | "error">("idle");
  const [error, setError] = useState("");
  const pollRef = useRef<number | null>(null);
  const begunRef = useRef(false);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  async function begin() {
    if (begunRef.current) return;
    begunRef.current = true;
    try {
      setPhase("starting");
      const s = await deviceStart();
      setStart(s);
      setPhase("waiting");
      // Browser launches here — only after the user pressed Sign in.
      openInBrowser(s.verifyUrl).catch(() => {});
      const interval = Math.max(2, s.intervalSecs ?? 3) * 1000;
      pollRef.current = window.setInterval(async () => {
        try {
          const result = await devicePoll(s.deviceCode);
          if (result.status === "complete") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            onSignedIn();
          } else if (result.status === "expired" || result.status === "denied") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            begunRef.current = false;
            setPhase("expired");
          }
        } catch {
          // transient network error: keep polling
        }
      }, interval);
    } catch (e) {
      setError(String(e));
      setPhase("error");
      begunRef.current = false;
    }
  }

  function reset() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
    begunRef.current = false;
    setStart(null);
    setError("");
    setPhase("idle");
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="/logos/entry.svg" alt="Entry" className="login-logo" />
        <h1>Sign in to Entry</h1>
        {phase === "idle" && (
          <>
            <p className="login-sub">
              Sign in to connect this desktop to your Entry account. Your
              browser will open to approve access — the app connects
              automatically the moment you approve.
            </p>
            <button className="btn-primary login-btn" onClick={begin}>
              Sign in
            </button>
          </>
        )}

        {phase === "starting" && (
          <div className="login-waiting">
            <span className="spinner" /> Starting sign-in…
          </div>
        )}

        {phase === "waiting" && start && (
          <>
            <div className="device-code">{start.userCode}</div>
            <p className="login-sub">
              Nothing to type — just approve in the browser. If it didn't
              open, reopen it below.
            </p>
            <div className="login-waiting">
              <span className="spinner" /> Waiting for approval…
            </div>
            <button
              className="btn-ghost login-btn"
              onClick={() => start && openInBrowser(start.verifyUrl)}
            >
              Reopen browser window
            </button>
            <button className="btn-ghost login-btn" onClick={reset}>
              Cancel
            </button>
          </>
        )}

        {(phase === "expired" || phase === "error") && (
          <>
            {phase === "expired" && (
              <div className="login-error">Code expired — press Sign in to retry.</div>
            )}
            {phase === "error" && <div className="login-error">{error}</div>}
            <button className="btn-primary login-btn" onClick={begin}>
              Sign in
            </button>
            <button className="btn-ghost login-btn" onClick={reset}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
