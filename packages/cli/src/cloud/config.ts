// What `malloyyo cloud` needs to reach Malloyyo's control plane: the customer's own
// credential, and nothing else.
//
// The API's address is Malloyyo's, so it is compiled in. There is deliberately nothing here
// about *how* the credential becomes a token — the control plane does that exchange
// (`POST /v1/token`), so no identity-provider configuration reaches the customer at all.

/** Malloyyo's own value, compiled into the binary. Overridable for staging and testing. */
const DEFAULT_API_URL = "https://api.malloyyo.com";

export interface CloudConfig {
  /** Control-plane API base URL. */
  readonly apiUrl: string;
  /** The customer's M2M client ID. */
  readonly clientId: string;
  /** The customer's M2M client secret. Held only in memory, never logged or written. */
  readonly clientSecret: string;
}

export class MissingCloudConfigError extends Error {
  constructor(readonly names: readonly string[]) {
    super(
      `missing required configuration: ${names.join(", ")}.\n` +
        "Set them as environment variables. Your credential comes from Malloyyo when your " +
        "account is created.",
    );
    this.name = "MissingCloudConfigError";
  }
}

const ENV_NAMES: Readonly<Record<keyof CloudConfig, string>> = {
  apiUrl: "MALLOYYO_API_URL",
  clientId: "MALLOYYO_CLIENT_ID",
  clientSecret: "MALLOYYO_CLIENT_SECRET",
};

/**
 * Reads the environment, falling back to the built-in API URL, and names every value that is
 * still missing in one error rather than failing on the first.
 *
 * Values are trimmed on the way in: the most common configuration error is a trailing
 * newline from a copy-pasted credential, and none of these carries significant surrounding
 * whitespace.
 */
export function loadCloudConfig(env: Record<string, string | undefined>): CloudConfig {
  const read = (key: keyof CloudConfig): string | undefined => {
    const raw = env[ENV_NAMES[key]];
    return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
  };

  const values = {
    apiUrl: read("apiUrl") ?? DEFAULT_API_URL,
    clientId: read("clientId"),
    clientSecret: read("clientSecret"),
  };

  const missing = (Object.keys(values) as Array<keyof CloudConfig>)
    .filter((key) => values[key] === undefined)
    .map((key) => ENV_NAMES[key]);
  if (missing.length > 0) throw new MissingCloudConfigError(missing);

  return values as CloudConfig;
}
