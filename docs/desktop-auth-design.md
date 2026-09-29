# Desktop Auth Design — Entry Desktop ↔ Entry Web

Based on the audited upstream reality (see lesson 41): upstream auth is
**cookie-session only** — no bearer tokens, no PKCE, no device code, no
deep-link handlers exist today. This design adds the minimum desktop
plumbing without breaking the web app.

## The flow (browser-handoff + deep link)

```
Desktop (Tauri)                    Web backend (Vercel)            Provider
────────────────                   ─────────────────────           ────────
1. Open system browser →
   {backend}/api/auth/sign-in/social?provider=vercel
   &callbackURL=/desktop/callback
                                          2. redirect ──────────→ Vercel/GitHub
                                          3. callback: code exchanged
                                             server-side, session cookie
                                             set (browser now logged in)
4. /desktop/callback page:
   - generates a one-time PAIRING CODE
   - shows it + auto-copies; page hits
     POST /api/desktop/pair { pairingCode }
     with the browser session cookie
   - long-poll NOT needed: page confirms
   ← desktop polls POST /api/desktop/token
     { pairingCode } every 1.5s (≤120s)
                                          5. pairing row matches →
                                             issues a session token via
                                             Better Auth bearer plugin
   6. token stored in OS keychain
      (tauri-plugin-stronghold / keyring)
   7. all /api/desktop/* calls use
      Authorization: Bearer <token>
```

Why this shape: it reuses upstream's cookie sessions untouched (zero web
changes beyond two new routes + one page), avoids embedding OAuth client
secrets in the desktop (they stay server-side), and the pairing code
binds the browser session to the desktop instance the user controls.

## New backend pieces (small)

1. `betterAuth({ plugins: [bearer()] })` — Better Auth's official bearer
   plugin; session tokens then work as `Authorization: Bearer` headers.
   Cookie sessions keep working unchanged.
2. `POST /api/desktop/pair` — cookie-authenticated; creates a
   `desktop_pairings` row `{ code (nanoid, 8 chars, 10-min TTL, single
   use), userId }`.
3. `POST /api/desktop/token` — no cookie; takes `{ pairingCode }`;
   atomically consumes the row and returns `{ token, expiresAt, user }`
   (token = the Better Auth session token for that user, TTL = session
   TTL). Rate-limited hard (10/min/IP).
4. `/desktop/callback` page — signs the user in (normal web flow), then
   displays the pairing code.

## GitHub App on desktop

`GITHUB_APP_PRIVATE_KEY` never leaves the server (matches upstream:
mintInstallationToken is server-only). Desktop flow:

1. "Connect GitHub" opens the system browser at
   `{backend}/api/github/app/install` (existing route, cookie session).
2. After install, GitHub redirects to the web app; the callback page
   shows the same pairing/confirmation pattern if the desktop is waiting.
3. Agent runs needing repo access call `POST
   /api/desktop/proxy/github` — the server mints a **scoped, single-repo
   installation token** (upstream's mint → operate → revoke in `finally`
   pattern) so the desktop never holds even the installation token.

## Vercel integration on desktop

No Vercel token ever reaches the desktop (upstream: token brokered into
sandbox network policy, never env/CLI/history). Desktop equivalents:

- Deployments/projects listing → `GET /api/desktop/proxy/vercel?path=/v6/deployments?projectId=…`
- Env vars for a workspace → server-side route (decrypt=true stays server-side)
- Vercel CLI runs by the agent → future: same credential-brokering shape
  as upstream's `buildCredentialBrokeringPolicy`, applied to our local
  process manager (placeholder env + network-layer substitution).

## Billing on desktop

Upstream's live provider is **Bachs** (not Paystack — replaced outright;
money is decimal strings, ledger is USD cents). Desktop:

1. "Top up / Upgrade" opens `{backend}/api/billing/checkout` response's
   `checkoutUrl` in the system browser (hosted flow).
2. Desktop polls `GET /api/billing/me` (our route) until
   `creditBalanceCents` changes — webhook stays the source of truth, so
   the desktop just observes, exactly like the web UI does.

## Local storage rules (Tauri)

| Data | Where |
|---|---|
| Session token | OS keychain (`keyring` crate) — never plaintext store |
| Model/reasoning prefs | tauri-plugin-store (non-sensitive) |
| OAuth provider tokens | **never on device** — server-side encrypted `account` table |
| Gateway/API keys | **never on device** — Vercel env only |
