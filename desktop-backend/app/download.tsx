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

/**
 * Windows is the only public download for now; every other platform shows as
 * "Coming soon" with its real OS logo. The version and the Windows link are
 * polled straight from the GitHub release API so the page never goes stale.
 */
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
        /* keep the last good value */
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const win =
    rel?.assets.find((a) => /x64-setup\.exe$/.test(a.name)) ?? null;

  return (
    <section className="download" id="download">
      <div className="wrap-site">
        <h2>Entry Desktop for desktop</h2>
        <p className="dl-desc">
          {rel ? (
            <>
              Latest release <code>{rel.tag_name}</code>
              <span className="dl-live">● always current</span>
            </>
          ) : (
            "Loading the latest release…"
          )}
        </p>

        <div className="dl-grid">
          {win ? (
            <a className="dl-card primary" href={win.browser_download_url}>
              <img src="/os/windows.svg" alt="" className="dl-logo" />
              <div className="dl-body">
                <strong>Windows</strong>
                <span>
                  Windows 10 or later · installer · {fmtSize(win.size)}
                </span>
              </div>
              <em>Download</em>
            </a>
          ) : (
            <div className="dl-card primary">
              <img src="/os/windows.svg" alt="" className="dl-logo" />
              <div className="dl-body">
                <strong>Windows</strong>
                <span>Fetching the latest installer…</span>
              </div>
              <em>Download</em>
            </div>
          )}

          <div className="dl-card soon">
            <img src="/os/apple.svg" alt="" className="dl-logo" />
            <div className="dl-body">
              <strong>macOS</strong>
              <span>Apple silicon &amp; Intel · universal build</span>
            </div>
            <em className="soon-tag">Coming soon</em>
          </div>

          <div className="dl-card soon">
            <img src="/os/linux.svg" alt="" className="dl-logo" />
            <div className="dl-body">
              <strong>Linux</strong>
              <span>AppImage · deb · rpm</span>
            </div>
            <em className="soon-tag">Coming soon</em>
          </div>
        </div>

        {rel ? (
          <p className="dl-more">
            Windows is the supported build today. macOS and Linux are in
            progress —{" "}
            <a
              href={`https://github.com/thirdbase1/entry-desktop/releases/tag/${rel.tag_name}`}
              target="_blank"
              rel="noreferrer"
            >
              see the release
            </a>{" "}
            for every artifact as it ships.
          </p>
        ) : null}
      </div>
    </section>
  );
}
