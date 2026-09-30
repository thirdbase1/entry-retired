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
 * Truly seamless device-flow login:
 * 1. The flow starts AUTOMATICALLY on mount — no button press.
 * 2. The system browser opens AUTOMATICALLY with the approval page.
 * 3. Polling connects the app the moment approval lands.
 * Any failure keeps a one-click retry visible; nothing else is manual.
 */
export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [start, setStart] = useState<DeviceStart | null>(null);
  const [state, setState] = useState<
    "starting" | "waiting" | "expired" | "error"
  >("starting");
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
      setState("waiting");
      const s = await deviceStart();
      setStart(s);
      // Launch the browser right away; if the opener is blocked we still
      // show the code + a manual-reopen button, never a dead end.
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
            setState("expired");
          }
        } catch {
          // transient network error: keep polling
        }
      }, interval);
    } catch (e) {
      setError(String(e));
      setState("error");
      begunRef.current = false;
    }
  }

  // Auto-start once on mount.
  useEffect(() => {
    begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="/logos/entry.svg" alt="Entry" className="login-logo" />
        <h1>Sign in to Entry</h1>
        <p className="login-sub">
          Your browser is opening to approve access — the app connects
          automatically the moment you approve.
        </p>

        {state === "starting" && (
          <div className="login-waiting">
            <span className="spinner" /> Starting sign-in…
          </div>
        )}

        {state === "waiting" && start && (
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
          </>
        )}

        {(state === "expired" || state === "error") && (
          <>
            {state === "expired" && (
              <div className="login-error">Code expired — tap to retry.</div>
            )}
            {state === "error" && <div className="login-error">{error}</div>}
            <button
              className="btn-primary login-btn"
              onClick={() => {
                setError("");
                begin();
              }}
            >
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
