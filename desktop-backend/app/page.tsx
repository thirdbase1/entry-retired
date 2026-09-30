import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Entry Desktop | The agent that works on your machine",
  description:
    "Entry Desktop is the native desktop app for the Entry agent: everyday work, coding, research, and background tasks — running locally on your machine.",
};

export default function HomePage() {
  return (
    <div className="site">
      <header className="nav">
        <div className="nav-inner">
          <a className="brand" href="/">
            <img src="/entry.svg" alt="Entry" />
            <span>Entry Desktop</span>
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

      <section className="hero">
        <span className="badge">Preview</span>
        <h1>
          Entry Desktop
          <br />
          <span className="hero-sub">Ready to use. Right now.</span>
        </h1>
        <p className="hero-desc">
          Everyday tasks, coding, or your own agent — it starts here. Entry
          runs its tools, files, and processes natively on your machine.
        </p>
        <div className="hero-cta">
          <a className="cta-primary" href="#download">Download Desktop</a>
          <a className="cta-ghost" href="https://github.com/thirdbase1/entry-desktop" target="_blank" rel="noreferrer">
            View on GitHub
          </a>
        </div>

        <div className="mock" aria-label="Entry Desktop interface preview">
          <div className="mock-side">
            <div className="mock-side-title">New Session</div>
            <div className="mock-item active">Welcome to Entry</div>
            <div className="mock-item">Refactor login validation</div>
            <div className="mock-item">Analyze sales spreadsheet</div>
            <div className="mock-item">Fix failing unit tests</div>
            <div className="mock-side-title" style={{ marginTop: 18 }}>Workspace</div>
            <div className="mock-item">entry-desktop</div>
            <div className="mock-item">docs</div>
          </div>
          <div className="mock-chat">
            <div className="mock-user">Could you introduce yourself?</div>
            <div className="mock-ai">
              I&apos;m Entry, an AI coding agent running natively on your
              computer. I can help with:
              <ul>
                <li><strong>Coding</strong> — explore repos, fix bugs, build features, run tests.</li>
                <li><strong>Everyday work</strong> — organize files, analyze data, draft docs.</li>
                <li><strong>Research</strong> — find information and verify facts.</li>
                <li><strong>Background tasks</strong> — run scripts and track progress.</li>
              </ul>
            </div>
            <div className="mock-composer">Describe what you want to build…</div>
          </div>
        </div>
      </section>

      <section className="features" id="features">
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
              The model is the soul; the harness is what lets it work. Entry&apos;s
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
      </section>

      <DownloadSection />

      <footer className="foot">
        <span>© 2026 Entry · the desktop is the execution environment</span>
        <span>
          <a href="https://github.com/thirdbase1/entry-desktop" target="_blank" rel="noreferrer">GitHub</a>
          {" · "}
          <a href="https://entry-agents.dev" target="_blank" rel="noreferrer">entry-agents.dev</a>
        </span>
      </footer>
    </div>
  );
}

type DlLinks = {
  win: string | null;
  msi: string | null;
  mac: string | null;
  app: string | null;
  deb: string | null;
  rpm: string | null;
};

async function DownloadSection() {
  let version = "latest";
  let d: DlLinks = { win: null, msi: null, mac: null, app: null, deb: null, rpm: null };
  try {
    const res = await fetch(
      "https://api.github.com/repos/thirdbase1/entry-desktop/releases/latest",
      { next: { revalidate: 300 } },
    );
    if (res.ok) {
      const rel = (await res.json()) as {
        tag_name: string;
        assets: { name: string; browser_download_url: string }[];
      };
      version = rel.tag_name;
      const pick = (t: RegExp) =>
        rel.assets.find((a) => t.test(a.name))?.browser_download_url ?? null;
      d = {
        win: pick(/x64-setup\.exe$/),
        msi: pick(/x64_en-US\.msi$/),
        mac: pick(/aarch64\.dmg$/),
        app: pick(/amd64\.AppImage$/),
        deb: pick(/amd64\.deb$/),
        rpm: pick(/x86_64\.rpm$/),
      };
    }
  } catch {
    // offline build: render the section without links
  }

  const card = (
    href: string | null,
    os: string,
    note: string,
    primary = false,
  ) =>
    href ? (
      <a className={`dl-card${primary ? " primary" : ""}`} href={href}>
        <strong>{os}</strong>
        <span>{note}</span>
        <em>Download</em>
      </a>
    ) : null;

  return (
    <section className="download" id="download">
      <h2>Entry Desktop for desktop</h2>
      <p className="dl-desc">
        Work in the background, edit local files, and handle long, complex
        tasks with ease. Latest release: <code>{version}</code>.
      </p>
      <div className="dl-grid">
        {card(d.win, "Windows", "Windows 10 or later · installer", true)}
        {card(d.msi, "Windows (MSI)", "Managed / group-policy install")}
        {card(d.mac, "macOS", "Apple silicon · macOS 13 or later")}
        {card(d.app, "Linux", "AppImage · runs anywhere")}
        {card(d.deb, "Linux", "Debian / Ubuntu package")}
        {card(d.rpm, "Linux", "Fedora / RHEL package")}
      </div>
    </section>
  );
}
