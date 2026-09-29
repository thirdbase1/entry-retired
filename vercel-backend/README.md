# Entry Desktop — Vercel Backend API

Secure-key proxy layer between the desktop app (Tauri 2) and third-party
services. **The desktop client holds no secret keys** — only a session
Bearer token. All secrets live in Vercel environment variables.

Deployed as part of the existing Entry Next.js app (it imports the same
`lib/billing`, `lib/auth`, `lib/db` modules as the web app — single source
of truth for plans, ledger, and sessions).

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/desktop/me` | GET | Plan, credit balance, usage windows, identity |
| `/api/desktop/models` | GET | Model catalog filtered by plan + credit gates, with per-model reasoning vocabularies |
| `/api/desktop/chat` | POST | **Model proxy** — calls entry-gateway with the server-held key, enforces plan/credit gates, debits usage |
| `/api/desktop/proxy/[service]` | GET/POST | **Generic secret proxy** for github / vercel / openai / paystack |

## Security model

1. **Zero client secrets** — the desktop app authenticates with a Better
   Auth session token (`Authorization: Bearer <token>`). Nothing else.
2. **Secure key proxying** — `GATEWAY_API_KEY`, `OPENAI_SECRET_KEY`,
   `VERCEL_API_SECRET_KEY`, `PAYSTACK_SECRET_KEY` are read from
   `process.env` server-side only. Responses are stripped of
   `set-cookie`/`authorization`/`server` headers before returning.
3. **CORS** — requests must (a) originate from a Tauri custom protocol
   (`tauri://localhost`, `http(s)://tauri.localhost`), and (b) carry the
   `x-entry-desktop: 1` header. Ordinary browsers fail both checks → 403.
4. **Auth** — `requireDesktopSession` verifies the Bearer token through
   Better Auth's session store before any DB or third-party work.
5. **Rate limiting** — per-user, per-bucket fixed windows via Upstash
   Redis (falls back to in-process when Redis is not configured):
   `me` 60/min, `models` 30/min, `chat` 20/min, `proxy:*` 60/min.

## Environment variables (Vercel dashboard)

| Key | Used by | Notes |
|---|---|---|
| `GATEWAY_BASE_URL` | /chat | e.g. `https://entry-gateway-six.vercel.app/v1` |
| `GATEWAY_API_KEY` | /chat | server-held gateway key |
| `UPSTASH_REDIS_REST_URL` | rate limiting | optional; local fallback otherwise |
| `UPSTASH_REDIS_REST_TOKEN` | rate limiting | |
| `OPENAI_SECRET_KEY` | proxy/openai | optional; 503 when absent |
| `VERCEL_API_SECRET_KEY` | proxy/vercel | optional |
| `PAYSTACK_SECRET_KEY` | proxy/paystack | optional, GET-only (billing is Paystack upstream) |
| — | proxy/github | no secret: uses the caller's own GitHub token |

(Auth/DB env — `BETTER_AUTH_SECRET`, `POSTGRES_URL` — are shared with the
web app and already configured.)

## Desktop payload contract

All requests: `Origin: tauri://localhost`, header `x-entry-desktop: 1`,
header `Authorization: Bearer <session token>`.

### GET /api/desktop/me → 200
```json
{
  "user": { "id": "usr_...", "email": "you@example.com" },
  "plan": "free",
  "planName": "Free",
  "modelAccess": "luna-only",
  "creditBalanceCents": 250,
  "creditGrantCents": 250,
  "usageWindows": null
}
```
Errors: `401 { "error": "Not authenticated" }`, `403` (not desktop), `429`.

### GET /api/desktop/models → 200
```json
{
  "models": [
    { "id": "qwen3.8-flash", "reasoningCapable": true,
      "reasoningLevels": [{ "value": "none", "label": "Off" }, ...],
      "freeTierAllowed": true }
  ],
  "plan": "free",
  "modelAccess": "luna-only",
  "creditGate": { "blocked": false, "kind": null, "reason": null },
  "defaultModelId": "qwen3.8-flash:free"
}
```

### POST /api/desktop/chat
Request:
```json
{
  "modelId": "deepseek-v4-pro",
  "reasoningEffort": "high",
  "messages": [{ "role": "user", "content": "..." }],
  "tools": []
}
```
Response 200:
```json
{
  "message": { "role": "assistant", "content": "...", "tool_calls": null },
  "usage": { "promptTokens": 1200, "completionTokens": 340,
             "debitedCents": 3, "durationMs": 4210 },
  "creditBalanceCents": 247
}
```
Errors: `400` (bad body), `402` (out of credit / model not in plan, with
`code: "free_tier_ended" | "out_of_credit" | "model_not_in_plan"`),
`429`, `502/503/504` (gateway issues — upstream auth errors are never
relayed verbatim).

### POST /api/desktop/proxy/github
Request: query param `path` (e.g. `/repos/thirdbase1/entry-desktop`),
optional header `x-upstream-token: <user's GitHub token>`, optional JSON
body for POSTs. Response: the upstream JSON body verbatim (sanitized
headers). GitHub is the one service where the user's own token is
accepted — validated for shape, authorized as that user.
