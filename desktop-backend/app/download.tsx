"use client";

import { useEffect, useState } from "react";

type Asset = { name: string; browser_download_url: string; size: number };

type Rel = {
  tag_name: string;
  published_at: string;
  assets: Asset[];
};

function fmtSize(n: number) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Polled live from the GitHub release API — never stale, no rebuild needed. */
export function DownloadSection() {
  const [rel, setRel] = useState<Rel | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(
          "https://api.github.com/repos/thirdbase1/entry-desktop/releases/latest",
          { cache: "no-store" },
        );
        if (res.ok && alive) setRel((await res.json()) as Rel);
      } catch {
        /* keep last good */
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const pick = (t: RegExp) =>
    rel?.assets.find((a) => t.test(a.name)) ?? null;
  const win = pick(/x64-setup\.exe$/);
  const msi = pick(/x64_en-US\.msi$/);
  const mac = pick(/aarch64\.dmg$/);
  const app = pick(/amd64\.AppImage$/);
  const deb = pick(/amd64\.deb$/);
  const rpm = pick(/x86_64\.rpm$/);

  return (
    <section className="download" id="download">
      <h2>Entry Desktop for desktop</h2>
      <p className="dl-desc">
        Work in the background, edit local files, and handle long, complex
        tasks with ease.{" "}
        {rel ? (
          <>
            Latest release:{" "}
            <code>
              {rel.tag_name}
            </code>
            <span className="dl-live">
              ● auto-updates
            </span>
          </>
        ) : (
          "Fetching the latest release…"
        )}
      </p>

      <div className="dl-grid">
        {win ? (
          <a className="dl-card primary" href={win.browser_download_url}>
            <img src="/os/windows.svg" alt="" className="dl-logo" />
            <div className="dl-body">
              <strong>Windows</strong>
              <span>
                Windows 10 or later ·{" "}
                {fmtSize(win.size)}
              </span>
            </div>
            <em>Download</em>
          </a>
        ) : null}
        {msi ? (
          <a className="dl-card" href={msi.browser_download_url}>
            <img src="/os/windows.svg" alt="" className="dl-logo" />
            <div className="dl-body">
              <strong>Windows</strong>
              <span>MSI package · {fmtSize(msi.size)}</span>
            </div>
            <em>Download</em>
          </a>
        ) : null}
        {mac ? (
          <a className="dl-card primary" href={mac.browser_download_url}>
            <img src="/os/apple.svg" alt="" className="dl-logo" />
            <div className="dl-body">
              <strong>macOS</strong>
              <span>Apple silicon · {fmtSize(mac.size)}</span>
            </div>
            <em>Download</em>
          </a>
        ) : null}

        <div className="dl-card soon">
          <img src="/os/apple.svg" alt="" className="dl-logo" />
          <div className="dl-body">
            <strong>macOS Intel</strong>
            <span>Coming soon</span>
          </div>
          <em className="soon-tag">Soon</em>
        </div>
        <div className="dl-card soon">
          <img src="/os/linux.svg" alt="" className="dl-logo" />
          <div className="dl-body">
            <strong>Linux</strong>
            <span>AppImage · coming soon</span>
          </div>
          <em className="soon-tag">Soon</em>
        </div>
        <div className="dl-card soon">
          <img src="/os/linux.svg" alt="" className="dl-logo" />
          <div className="dl-body">
            <strong>Linux</strong>
            <span>deb / rpm · coming soon</span>
          </div>
          <em className="soon-tag">Soon</em>
        </div>
      </div>

      {rel && (app || deb || rpm) ? (
        <p className="dl-more">
          Linux builds exist for this release (AppImage/deb/rpm) but the public
          page lists Windows and macOS first — grab them on{" "}
          <a
            href={`https://github.com/thirdbase1/entry-desktop/releases/tag/${rel.tag_name}`}
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          .
        </p>
      ) : null}
    </section>
  );
}
