/**
 * Desktop backend's own Better Auth instance.
 *
 * Separate sessions table prefix (`desktop_`) in the same Postgres DB, same
 * OAuth apps as the web app (redirect URLs differ per app — the Vercel/
 * GitHub OAuth app settings must list this backend's callback URLs).
 *
 * Sign-in is a pure redirect flow, no pairing code needed:
 * 1. Desktop opens system browser → GET /api/auth/sign-in/social?provider=github
 *    &callbackURL=/desktop/callback
 * 2. User signs in with GitHub/Vercel in the browser (real 2FA, real cookies)
 * 3. Better Auth callback completes → /desktop/callback page reads its own
 *    session cookie → shows the session token once → also offers a
 *    one-click "entry://auth#token=…" deep link back into the app
 * 4. Desktop stores the token in the OS keychain; all API calls use it.
 *
 * Same-session trick for seamlessness: the callback page can also mint a
 * device code; but the token display + deep link is the zero-friction path.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { sql } from "./db";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL:
    process.env.BETTER_AUTH_URL ?? "https://entry-desktop-backend.vercel.app",
  trustedOrigins: [
    "https://entry-desktop-backend.vercel.app",
    "https://desktop.entry-agents.dev",
    "https://entry-agents.dev",
  ],
  database: drizzleAdapter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sql as any,
    { provider: "pg" },
  ),
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    storeSessionInDatabase: true,
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
    vercel: {
      clientId: process.env.VERCEL_CLIENT_ID!,
      clientSecret: process.env.VERCEL_CLIENT_SECRET!,
    },
  },
  plugins: [bearer()],
});
