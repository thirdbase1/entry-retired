import { NextRequest } from "next/server";

export const runtime = "edge";

/**
 * GET /desktop/device?code=XXXX-XXXX — the page the desktop opens in the
 * browser. Shows "Continue with GitHub / Vercel" buttons that route through
 * /api/desktop/auth/authorize with the device code attached. After the
 * provider round-trip the user lands back here with ?approved=1 and can
 * simply close the window — the app picks up automatically.
 */
export default async function DevicePage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const code = sp.code ?? "";
  const error = sp.error;
  const approved = sp.approved === "1";
  const user = sp.user ?? "";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Entry Desktop — Sign in</title>
        <style>{`
          :root { color-scheme: dark; }
          body { margin: 0; background: #0a0a0a; color: #ededed;
                 font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
                 display: grid; place-items: center; min-height: 100vh; }
          .card { background: #111; border: 1px solid #262626; border-radius: 12px;
                  padding: 40px; width: min(400px, calc(100vw - 32px)); }
          h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.6px; margin: 0 0 8px; }
          p.sub { color: #a1a1a1; font-size: 14px; margin: 0 0 28px; }
          .code { font-family: ui-monospace, monospace; font-size: 20px; text-align: center;
                  background: #171717; border: 1px solid #262626; border-radius: 8px;
                  padding: 14px; margin-bottom: 28px; letter-spacing: 2px; }
          a.btn { display: flex; align-items: center; justify-content: center; gap: 10px;
                  width: 100%; box-sizing: border-box; padding: 12px 14px; margin-bottom: 12px;
                  border-radius: 6px; font-size: 14px; font-weight: 500; text-decoration: none;
                  border: 1px solid #262626; color: #ededed; background: #171717; }
          a.btn:hover { background: #202020; }
          a.btn svg { width: 18px; height: 18px; }
          .ok { text-align: center; color: #4ade80; font-size: 15px; }
          .err { color: #f87171; font-size: 14px; }
          .foot { margin-top: 24px; color: #666; font-size: 12px; text-align: center; }
        `}</style>
      </head>
      <body>
        <div className="card">
          {approved ? (
            <div>
              <div className="ok">✓ Approved</div>
              <p className="sub" style={{ marginTop: 16 }}>
                Signed in as <strong>{user}</strong>. You can close this window —
                the Entry desktop app is already connected.
              </p>
            </div>
          ) : error ? (
            <div>
              <h1>Sign-in failed</h1>
              <p className="err">{error}</p>
              <p className="sub" style={{ marginTop: 16 }}>
                Close this window and restart sign-in from the Entry app.
              </p>
            </div>
          ) : (
            <div>
              <h1>Sign in to Entry</h1>
              <p className="sub">Approve desktop access for device code</p>
              <div className="code">{code || "—"}</div>
              <a className="btn" href={`/api/desktop/auth/authorize?provider=github&user_code=${encodeURIComponent(code)}`}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
                Continue with GitHub
              </a>
              <a className="btn" href={`/api/desktop/auth/authorize?provider=vercel&user_code=${encodeURIComponent(code)}`}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L24 22H0L12 1Z" /></svg>
                Continue with Vercel
              </a>
              <div className="foot">Only approve if you started this from the Entry desktop app.</div>
            </div>
          )}
        </div>
      </body>
    </html>
  );
}
