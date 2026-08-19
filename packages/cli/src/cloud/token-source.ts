// Turning the customer's long-lived credential into the short-lived access token every
// `cloud` request carries.
//
// The exchange is one request to Malloyyo, not to an identity provider: `POST /v1/token`
// on the control plane takes the credential and hands back a token. That is deliberate and
// it is why this file has no SDK in it. Doing the exchange here directly would put an
// identity provider's client library inside a published CLI — megabytes, installed by
// everyone including the majority who never run a `cloud` command — name that provider in
// public source, and weld a binary customers upgrade on their own schedule to a choice we
// might revisit. One HTTP call costs none of that.
//
// It is an ordinary OAuth 2.0 client-credentials exchange (RFC 6749 §4.4), so there is
// nothing bespoke to get wrong: form-encoded in, `{ access_token, token_type, expires_in }`
// back.
import { apiFetch } from "../http.js";
import { ControlPlaneError } from "./api.js";

export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
}

export interface TokenSourceConfig {
  /** Control-plane API base URL — the same one the commands call. */
  readonly apiUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** One exchange's result. Only what the CLI uses; the response carries a little more. */
export interface AccessTokenGrant {
  readonly accessToken: string;
  readonly expiresIn: number;
}

/** The exchange, injected so the cache is tested without a network. */
export type ExchangeCredentials = (scopes: readonly string[]) => Promise<AccessTokenGrant>;

export interface TokenSourceOptions {
  /** Re-exchange this many seconds before expiry, covering clock skew and flight time. */
  readonly refreshSkewSeconds?: number;
  /** Injectable clock, in epoch milliseconds. */
  readonly now?: () => number;
}

const DEFAULT_REFRESH_SKEW_SECONDS = 60;

/**
 * Exchanges the credential for a token, over the same wrapper every other call uses — so
 * this request carries the version header too, and an "upgrade required" answer to it reads
 * as an upgrade instruction rather than an authentication failure.
 *
 * Failures leave as `ControlPlaneError`, which is what lets the client in `api.ts` classify
 * them with the same rule it uses for everything else: a 5xx or 429 here is transient and
 * worth retrying, a rejected credential is not.
 */
export function createCredentialExchange(config: TokenSourceConfig): ExchangeCredentials {
  const base = config.apiUrl.replace(/\/+$/, "");
  return async (scopes) => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    // Omitted rather than sent empty: absent means "everything this credential may do",
    // where an empty value would ask for a token that can do nothing.
    if (scopes.length > 0) body.set("scope", scopes.join(" "));

    const response = await apiFetch(`${base}/v1/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const fields =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};

    if (!response.ok) {
      const code = typeof fields.error === "string" ? fields.error : "error";
      throw new ControlPlaneError(
        response.status,
        code,
        // The server deliberately says nothing about *why* a credential was rejected, so
        // the actionable sentence has to come from here — it is the side that knows which
        // two environment variables the values came from.
        code === "invalid_client"
          ? "your Malloyyo credentials were rejected. Check MALLOYYO_CLIENT_ID and " +
            "MALLOYYO_CLIENT_SECRET, and that your account is still active."
          : typeof fields.message === "string"
            ? fields.message
            : `could not get an access token (${code})`,
      );
    }

    if (typeof fields.access_token !== "string" || typeof fields.expires_in !== "number") {
      throw new ControlPlaneError(
        response.status,
        "invalid_response",
        "the control plane returned no access token; check that MALLOYYO_API_URL points at it",
      );
    }
    return { accessToken: fields.access_token, expiresIn: fields.expires_in };
  };
}

/**
 * Caches one access token and re-exchanges shortly before it expires.
 *
 * A command makes several requests — `create` polls its operation — and each exchange is a
 * network round trip, so without this the create would spend one on every poll. Concurrent
 * callers share a single in-flight exchange, because a cold cache with several requests in
 * flight would otherwise exchange once per request and discard all but one.
 */
export function createCachedTokenSource(
  exchange: ExchangeCredentials,
  scopes: readonly string[],
  options: TokenSourceOptions = {},
): AccessTokenSource {
  const now = options.now ?? Date.now;
  const skewMs = (options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000;

  let cached: { accessToken: string; renewAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const grant = await exchange(scopes);
    cached = {
      accessToken: grant.accessToken,
      renewAtMs: now() + grant.expiresIn * 1000 - skewMs,
    };
    return grant.accessToken;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (cached !== null && now() < cached.renewAtMs) return cached.accessToken;
      inFlight ??= fetchToken().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/**
 * A token source scoped to exactly the scopes one command needs, so a `list` token can only
 * read — never create or delete — and a stolen token is bounded to the command it was minted
 * for. The narrowing is enforced by whoever issues the token, not here; asking for less is
 * all this side can do, and all it should.
 */
export function createCloudTokenSource(
  config: TokenSourceConfig,
  scopes: readonly string[],
): AccessTokenSource {
  return createCachedTokenSource(createCredentialExchange(config), scopes);
}
