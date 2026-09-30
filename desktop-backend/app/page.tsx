import type { Metadata } from "next";
import { DownloadSection } from "./download";

export const metadata: Metadata = {
  title: "Entry | The agent that works on your machine",
  description:
    "Entry is the native desktop agent: everyday work, coding, research, and background tasks — running locally on your machine.",
};

export default function HomePage() {
  return (
    <div className="site">
      <header className="nav">
        <div className="nav-inner wrap-site">
          <a className="brand" href="/">
            <img src="/entry.svg" alt="Entry" />
            <span>Entry</span>
          </a>
          <nav className="nav-links">
            <a href="#features">Features</a>
            <a href="#download">Download</a>
            <a href="https://github.com/thirdbase1/entry-desktop" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </nav>
          <a className="nav-cta" href="#download">Download</a>
        </div>
      </header>

      <section className="hero"><div className="wrap-site">
        <span className="badge">Preview</span>
        <h1>
          Entry
          <br />
          <span className="hero-sub">Ready to use. Right now.</span>
        </h1>
        <p className="hero-desc">
          Everyday tasks, coding, or your own agent — it starts here. Entry
          runs its tools, files, and processes natively on your machine.
        </p>
        <div className="hero-cta">
          <a className="cta-primary" href="#download">Download for Windows</a>
          <a className="cta-ghost" href="https://github.com/thirdbase1/entry-desktop" target="_blank" rel="noreferrer">
            View on GitHub
          </a>
        </div>

        <div className="app-shot-frame"><img src="/app-shot.png" alt="Entry app" className="app-shot" /></div>
      </div>
      </section>

      <section className="features" id="features"><div className="wrap-site">
        <h2>
          Expanding capabilities.
          <br />
          Work on your terms.
        </h2>
        <div className="feat-grid">
          <div className="feat">
            <div className="feat-tag">NATIVE CORE</div>
            <h3>Agent = Model + Harness</h3>
            <p>
              The model is the soul; the harness is what lets it work. Entry's
              Rust core owns workspace boundaries, process lifecycles, and
              output streaming — on your machine, not in a cloud.
            </p>
          </div>
          <div className="feat">
            <div className="feat-tag">SECURE BY DEFAULT</div>
            <h3>Workspace-contained</h3>
            <p>
              Bash runs inside your chosen workspace. Dangerous commands need
              approval. File reads are ceilinged. No generic boundaries — every
              one is enforced in native code.
            </p>
          </div>
          <div className="feat">
            <div className="feat-tag">SEAMLESS SIGN-IN</div>
            <h3>One click to connect</h3>
            <p>
              Press Sign in, your browser opens, you approve — done. No codes,
              nothing to copy. The app connects itself and your plan and
              credits carry over.
            </p>
          </div>
        </div>
      </div>
      </section>

      <DownloadSection />

      <footer className="foot"><div className="wrap-site" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <span>© 2026 Entry · the desktop is the execution environment</span>
        <span>
          <a href="https://github.com/thirdbase1/entry-desktop" target="_blank" rel="noreferrer">GitHub</a>
          {" · "}
          <a href="https://entry-agents.dev" target="_blank" rel="noreferrer">entry-agents.dev</a>
        </span>
      </div>
      </footer>
    </div>
  );
}
