# Authentication

Malloyyo signs users in with [Auth.js (NextAuth v5)](https://authjs.dev), backed
by the Drizzle Postgres adapter (`src/auth.ts`). Three OAuth / OIDC providers are
supported:

| Provider | Enable with |
|---|---|
| **Google** | `AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET` |
| **Okta** | `AUTH_OKTA_CLIENT_ID` (+ secret, issuer) |
| **Microsoft Entra ID** (Azure AD) | `AUTH_MICROSOFT_ENTRA_ID_ID` (+ secret, optional issuer) |

Every provider is **opt-in and off until its env vars are set** — configure any
subset you want. Sign-in is disabled entirely until at least one provider is
configured.

## How it fits together

- **Sign-in buttons.** The landing page renders one "Sign in with …" button per
  provider that's configured in the environment (it reads the list from
  `/api/me`, which calls `configuredAuthProviders()` in
  `src/lib/auth-providers.ts`). Adding a provider's env vars makes its button
  appear — no code or UI change is needed. Auth.js's built-in page at
  `/api/auth/signin` is the fallback and also lists every configured provider.
- **Redirect (callback) URI.** Every provider posts back to
  `<APP_BASE_URL>/api/auth/callback/<provider-id>`. The provider IDs are
  `google`, `okta`, and `microsoft-entra-id`. You must register the exact URI —
  including the scheme and host — in each provider's console, or the provider
  rejects sign-in (e.g. Google's `redirect_uri_mismatch`). Register both your
  production URL and `http://localhost:3000/...` for local dev.
- **`AUTH_SECRET`.** Signs session tokens and OAuth state. Generate one with
  `openssl rand -base64 32`. Required regardless of provider.
- **Who gets in.** Sign-in is provider-agnostic once identity is established:
  - `EMAIL_ALLOW_LIST` (optional, comma-separated) restricts sign-in to specific
    email addresses. Unset = any account from a configured provider may sign in.
  - `APP_ADMIN_EMAILS` (comma-separated) marks users as admins (create datasets,
    publish, see everything). Both lists match on the account's **email**, so
    they work identically across Google, Okta, and Microsoft.
- **First sign-in** creates the user row and assigns a friendly slug
  (`createUser` event in `src/auth.ts`). New providers store an `accounts` row
  automatically via the Drizzle adapter — no schema or migration change.

---

## Google

Enabled when `AUTH_GOOGLE_ID` is set. Create an OAuth client in the Google Cloud
Console.

1. **Google Cloud Console → APIs & Services → Credentials → Create OAuth client
   ID → Web application.**
2. Add **Authorized redirect URIs**:
   ```
   https://<your-domain>/api/auth/callback/google
   http://localhost:3000/api/auth/callback/google
   ```
3. Set the env vars:
   ```env
   AUTH_GOOGLE_ID=<client-id>.apps.googleusercontent.com
   AUTH_GOOGLE_SECRET=<client-secret>
   ```

Miss the redirect URI and Google rejects sign-in with `redirect_uri_mismatch`.

---

## Okta

Optional. Enabled when `AUTH_OKTA_CLIENT_ID` is set (all three vars are needed to
work).

1. **Okta admin console → Applications → Create App Integration → OIDC - OpenID
   Connect → Web Application.**
2. Add **Sign-in redirect URIs**:
   ```
   https://<your-domain>/api/auth/callback/okta
   http://localhost:3000/api/auth/callback/okta
   ```
3. Set the env vars — the issuer is your Okta org URL:
   ```env
   AUTH_OKTA_CLIENT_ID=0oaxxxxxxxxxxxxxxxx
   AUTH_OKTA_CLIENT_SECRET=<client-secret>
   AUTH_OKTA_ISSUER=https://yourorg.okta.com
   ```

---

## Microsoft Entra ID (Azure AD)

Optional. Enabled when `AUTH_MICROSOFT_ENTRA_ID_ID` is set.

1. **[portal.azure.com](https://portal.azure.com) → Microsoft Entra ID → App
   registrations → New registration.**
   - **Supported account types** — this is the one real decision (see below).
   - **Redirect URI** — platform **Web**:
     ```
     https://<your-domain>/api/auth/callback/microsoft-entra-id
     http://localhost:3000/api/auth/callback/microsoft-entra-id
     ```
2. **Certificates & secrets → New client secret.** Copy the secret **value**
   (not the secret ID) — it's shown only once.
3. The **Application (client) ID** on the app's Overview page is your client ID.
4. Set the env vars:
   ```env
   AUTH_MICROSOFT_ENTRA_ID_ID=<application-client-id>
   AUTH_MICROSOFT_ENTRA_ID_SECRET=<client-secret-value>
   # Optional — see "Which accounts?" below:
   AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0/
   ```

### Which accounts? (the issuer decision)

This is the only design choice, and it must match the **Supported account
types** you picked during registration:

| You want to allow | Registration account type | `AUTH_MICROSOFT_ENTRA_ID_ISSUER` |
|---|---|---|
| **One specific organization** (recommended for a known customer) | Single tenant | `https://login.microsoftonline.com/<tenant-id>/v2.0/` |
| **Any work/school (Azure AD) org, but not personal accounts** | Multitenant | `https://login.microsoftonline.com/organizations/v2.0/` |
| **Any Microsoft account, including personal** | Multitenant + personal | leave unset (defaults to `common`) |

- The issuer and the registration's **Supported account types** must agree, and
  the *more restrictive* of the two wins: a single-tenant registration rejects
  outsiders at Microsoft even if the issuer is `common`, and a narrow issuer
  restricts a multitenant registration. Set both to the audience you want.
- Leaving the issuer **unset** defaults to `common` (not `organizations`) — with
  a multitenant+personal registration this admits **any** Microsoft account,
  personal included. To allow work/school orgs but *not* personal accounts, set
  the issuer to the `.../organizations/v2.0/` authority. Pair with
  `EMAIL_ALLOW_LIST` to narrow further.
- Setting the issuer to your **Directory (tenant) ID** locks sign-in to that one
  organization — the equivalent of the single-Okta-org setup. The tenant ID is
  on the Entra **Overview** page. Note the trailing `/v2.0/`.

---

## Setting the variables

- **Local dev:** copy `.env.local.example` (which lists all three provider
  blocks) into `local/<instance>` and fill in the ones you use.
- **Vercel:** set the vars per environment in the dashboard
  (Project → Settings → Environment Variables → tick Production and/or Preview).
- **Docker / self-host:** see [Self-hosting with Docker](docker.md).

Set `APP_BASE_URL` to the public URL the instance is served at — it's what OAuth
redirects resolve against. Behind a reverse proxy, use the external `https://…`
URL.

## Troubleshooting

A provider is only enabled once **all** its required env vars are set — a
half-configured provider is not registered and shows no button (rather than a
button that fails at the identity provider). On startup the server logs which
providers are live and, for any half-configured one, exactly which var is
missing:

```
[auth] Okta sign-in is disabled — set the missing env var(s): AUTH_OKTA_ISSUER. See docs/authentication.md.
[auth] Sign-in enabled: Google, Microsoft.
```

If a provider's button doesn't appear, check that log line first. If **no**
provider is configured, sign-in is disabled and the landing page says so.

