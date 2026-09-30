/**
 * Minimal OAuth for the Entry desktop, implemented in OUR backend.
 * No Better Auth instance, no changes to the web app: we reuse the same
 * GitHub / Vercel OAuth apps (their client ids + secrets) and write the
 * resulting user + session into the SHARED Postgres tables the web app owns
 * (users / accounts / auth_sessions). That's what makes plan + credits work
 * for desktop users on day one.
 */

export type ProviderId = "github" | "vercel";

export interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  scope: string;
  clientId: () => string;
  clientSecret: () => string;
  /** Extra headers/body handling differences between providers. */
  acceptsJson: boolean;
}

export function providerConfig(id: ProviderId, redirectUri: string): ProviderConfig {
  if (id === "github") {
    return {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      profileUrl: "https://api.github.com/user",
      scope: "user:email read:user",
      clientId: () => process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: () => process.env.GITHUB_CLIENT_SECRET ?? "",
      acceptsJson: true,
    };
  }
  return {
    authorizeUrl: "https://vercel.com/oauth/authorize",
    tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
    profileUrl: "https://api.vercel.com/login/oauth/userinfo",
    scope: "openid email profile offline_access",
    clientId: () => process.env.VERCEL_CLIENT_ID ?? "",
    clientSecret: () => process.env.VERCEL_CLIENT_SECRET ?? "",
    acceptsJson: false,
  };
}

export function buildAuthorizeUrl(cfg: ProviderConfig, redirectUri: string, state: string) {
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state);
  if (cfg.acceptsJson) url.searchParams.set("response_type", "code");
  else url.searchParams.set("response_type", "code");
  return url.toString();
}

export interface Profile {
  providerAccountId: string;
  email: string;
  name: string;
  avatar: string;
  username: string;
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresAt?: Date | null;
}

export async function exchangeCode(
  cfg: ProviderConfig,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken?: string; scope?: string; expiresIn?: number }> {
  const body = new URLSearchParams({
    client_id: cfg.clientId(),
    client_secret: cfg.clientSecret(),
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const raw = await res.text();
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      accessToken: String(j.access_token ?? ""),
      refreshToken: j.refresh_token ? String(j.refresh_token) : undefined,
      scope: j.scope ? String(j.scope) : undefined,
      expiresIn: typeof j.expires_in === "number" ? j.expires_in : undefined,
    };
  } catch {
    const params = new URLSearchParams(raw);
    return {
      accessToken: params.get("access_token") ?? "",
      refreshToken: params.get("refresh_token") ?? undefined,
      scope: params.get("scope") ?? undefined,
    };
  }
}

export async function fetchProfile(
  id: ProviderId,
  cfg: ProviderConfig,
  accessToken: string,
): Promise<Omit<Profile, "accessToken" | "refreshToken" | "scope" | "expiresAt">> {
  const res = await fetch(cfg.profileUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "entry-desktop",
    },
  });
  if (!res.ok) throw new Error(`profile fetch failed: ${res.status}`);
  const p = (await res.json()) as Record<string, unknown>;

  if (id === "github") {
    let email = (p.email as string) ?? "";
    if (!email) {
      const er = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (er.ok) {
        const list = (await er.json()) as { email: string; primary: boolean; verified: boolean }[];
        email = list.find((e) => e.primary && e.verified)?.email ?? list[0]?.email ?? "";
      }
    }
    return {
      providerAccountId: String(p.id),
      email,
      name: (p.name as string) ?? (p.login as string) ?? "",
      avatar: (p.avatar_url as string) ?? "",
      username: (p.login as string) ?? "",
    };
  }

  return {
    providerAccountId: String(p.sub ?? p.id ?? ""),
    email: (p.email as string) ?? "",
    name: (p.name as string) ?? (p.preferred_username as string) ?? "",
    avatar: (p.picture as string) ?? "",
    username: (p.preferred_username as string) ?? (p.email as string)?.split("@")[0] ?? "",
  };
}
