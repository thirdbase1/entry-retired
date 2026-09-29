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
 * Device-flow login: show the code, open the browser, poll until complete.
 * The user's only job: click "Continue" and sign in with GitHub or Vercel.
 */
export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [start, setStart] = useState<DeviceStart | null>(null);
  const [state, setState] = useState<"idle" | "waiting" | "expired" | "error">("idle");
  const [error, setError] = useState<string>("");
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  async function begin() {
    try {
      setState("waiting");
      const s = await deviceStart();
      setStart(s);
      await openInBrowser(s.verifyUrl);

      pollRef.current = window.setInterval(async () => {
        try {
          const result = await devicePoll(s.deviceCode);
          if (result.status === "complete") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            onSignedIn();
          } else if (result.status === "expired" || result.status === "denied") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setState("expired");
          }
        } catch (e) {
          // transient network error: keep polling
          console.warn("poll error", e);
        }
      }, (s.intervalSecs ?? 3) * 1000);
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="/logos/entry.svg" alt="Entry" className="login-logo" />
        <h1>Sign in to Entry</h1>
        <p className="login-sub">
          Your plan, credit balance and integrations — synced with your Entry
          account.
        </p>

        {state === "idle" || state === "expired" || state === "error" ? (
          <>
            {state === "expired" && (
              <div className="login-error">Code expired — start again.</div>
            )}
            {state === "error" && <div className="login-error">{error}</div>}
            <button className="btn-primary login-btn" onClick={begin}>
              Sign in with GitHub or Vercel
            </button>
            <p className="login-foot">
              Opens your browser. Nothing is typed into the app.
            </p>
          </>
        ) : (
          <>
            <div className="device-code">{start?.userCode}</div>
            <p className="login-sub">
              Approve access in the browser window that just opened. This app
              connects automatically the moment you approve.
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
      </div>
    </div>
  );
}
