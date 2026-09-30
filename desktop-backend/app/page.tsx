import { NextRequest } from "next/server";

export const runtime = "edge";

const MODELS = [
  { id: "gpt-5.6-luna", note: "flagged, reasoning effort aware" },
  { id: "qwen3.8-max-free", note: "free tier, effort xhigh" },
  { id: "glm-5.3-flash", note: "always thinks, fast" },
];

export default async function HomePage() {
  return (
    <div className="shell">
      <header className="topbar">
        <img src="/entry.svg" alt="Entry" />
        <span className="name">Entry Desktop</span>
        <span className="tagline">desktop backend</span>
        <span className="spacer" />
        <span className="pill live">● live</span>
      </header>

      <main className="wrap">
        <h1>Desktop backend</h1>
        <p className="sub">
          The service the Entry desktop app talks to: device sign-in, agent
          chat through the Entry gateway, account + model info.
        </p>

        <div className="card">
          <h2>Sign in</h2>
          <div className="row">
            <span className="method post">POST</span>
            <span className="m grow">/api/desktop/device/start</span>
            <span className="pill">device code</span>
          </div>
          <div className="row">
            <span className="method post">POST</span>
            <span className="m grow">/api/desktop/device/poll</span>
            <span className="pill">one-time token</span>
          </div>
          <div className="row">
            <span className="method">GET</span>
            <span className="m grow">/desktop/device?code=XXXX-XXXX</span>
            <span className="pill">approval page</span>
          </div>
          <div className="row">
            <span className="method">GET</span>
            <span className="m grow">/api/desktop/auth/authorize?provider=github|vercel</span>
            <span className="pill">GitHub · Vercel</span>
          </div>
        </div>

        <div className="card">
          <h2>Agent</h2>
          <div className="row">
            <span className="method post">POST</span>
            <span className="m grow">/api/desktop/chat</span>
            <span className="pill">session token</span>
          </div>
          <div className="row">
            <span className="method">GET</span>
            <span className="m grow">/api/desktop/models</span>
          </div>
          <div className="row">
            <span className="method">GET</span>
            <span className="m grow">/api/desktop/me</span>
            <span className="pill">plan · credits</span>
          </div>
          <div className="row">
            <span className="method">GET</span>
            <span className="m grow">/api/desktop/proxy/[service]</span>
            <span className="pill">token broker</span>
          </div>
        </div>

        <div className="card">
          <h2>Models served by the gateway</h2>
          <div className="grid">
            {MODELS.map((m) => (
              <div className="stat" key={m.id}>
                <div className="k mono">{m.id}</div>
                <div className="v" style={{ fontSize: 13, fontWeight: 400, color: "var(--fg-muted)" }}>{m.note}</div>
              </div>
            ))}
          </div>
        </div>

        <p className="foot">
          Entry Desktop · the desktop is the execution environment · never holds subscription logic
        </p>
      </main>
    </div>
  );
}
