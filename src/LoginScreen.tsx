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
 * DeepSeek-style sign-in: no codes shown anywhere in the app.
 * The user presses Sign in, the system browser opens the approval page,
 * and the app connects automatically the moment approval lands.
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
              Your browser will open to approve access. The app connects
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

        {phase === "waiting" && (
          <>
            <p className="login-sub">
              Approve access in your browser — this window connects
              automatically when you're done.
            </p>
            <div className="login-waiting">
              <span className="spinner" /> Waiting for approval…
            </div>
            {start && (
              <button
                className="btn-ghost login-btn"
                onClick={() => openInBrowser(start.verifyUrl)}
              >
                Reopen browser
              </button>
            )}
            <button className="btn-ghost login-btn" onClick={reset}>
              Cancel
            </button>
          </>
        )}

        {(phase === "expired" || phase === "error") && (
          <>
            {phase === "expired" && (
              <div className="login-error">Sign-in expired — try again.</div>
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
