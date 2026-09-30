import { NextRequest } from "next/server";

export const runtime = "edge";

/**
 * GET /api/desktop/latest — resolves the newest published GitHub release and
 * returns its tag plus per-platform installer download URLs. The product page
 * uses this to render always-current download buttons; the desktop app can
 * use it later for update checks.
 */
export async function GET(_req: NextRequest) {
  const upstream = await fetch(
    "https://api.github.com/repos/thirdbase1/entry-desktop/releases/latest",
    { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" },
  );
  if (!upstream.ok) {
    return Response.json({ error: "release lookup failed" }, { status: 502 });
  }
  const rel = (await upstream.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string; size: number }[];
  };

  const pick = (test: RegExp) =>
    rel.assets.find((a) => test.test(a.name))?.browser_download_url ?? null;

  return Response.json(
    {
      version: rel.tag_name,
      downloads: {
        windows: pick(/x64-setup\.exe$/),
        windowsMsi: pick(/x64_en-US\.msi$/),
        macos: pick(/aarch64\.dmg$/),
        linuxAppImage: pick(/amd64\.AppImage$/),
        linuxDeb: pick(/amd64\.deb$/),
        linuxRpm: pick(/x86_64\.rpm$/),
      },
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
