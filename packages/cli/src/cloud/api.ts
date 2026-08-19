// The control-plane HTTP client the `cloud` commands drive. It attaches the bearer token,
// sends an Idempotency-Key on the mutating calls, and projects the API's JSON responses to
// the small shapes the commands print. The wire contract is the control plane's own:
// success bodies are `{ instance }`, `{ instances }`, `{ operation }`, or `{ instance,
// operation }`; error bodies are `{ error: <code>, message? }`. The control plane pins
// these shapes from its side, so the contract is not maintained by hand-copying types.
//
// Requests go through `apiFetch` like every other call this CLI makes to a
// Malloyyo-operated server, which is what puts the `malloyyo/<version>` user agent on them
// and turns an upgrade-required answer into an instruction. One wrapper covers instance
// and control-plane calls alike.
import { apiFetch } from "../http.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface Instance {
  readonly id: string;
  readonly slug: string;
  readonly lifecycle: string;
  readonly hostname: string | null;
  readonly desired: {
    /**
     * An opaque release identifier — the digest of the instance's image, or its tag. Not a
     * pullable reference: the control plane strips the registry it lives in, which is
     * infrastructure the customer neither reaches nor needs. Compare it against
     * `observed.version` to see whether a release has landed; do not parse it.
     */
    readonly version: string | null;
    readonly cpuKind: string;
    readonly cpus: number;
    readonly memoryMb: number;
  };
  readonly observed: {
    readonly version: string | null;
    /** Whether the instance was up when last observed; `null` before anything was. */
    readonly running: boolean | null;
    readonly at: string | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A provisioning step the control plane has finished, in the order it finished.
 *
 * `key` is the control plane's customer-facing step vocabulary, not the name of the step it
 * ran internally. A step the server has no public name for is not reported at all, so this
 * list can be shorter than the work done.
 */
export interface OperationStep {
  readonly key: string;
  readonly at: string;
}

export interface Operation {
  readonly id: string;
  readonly instanceId: string;
  readonly kind: string;
  readonly status: string;
  readonly error: string | null;
  /**
   * Finished steps. Absent on an older control plane, so callers must tolerate that rather
   * than assume the field: this CLI is distributed and will meet a server it is newer than.
   */
  readonly steps?: readonly OperationStep[];
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** A non-2xx from the control plane, carrying the status and the server's own message. */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

/** What the control plane reports about a secret: its name. There is no value field. */
export interface SecretName {
  readonly name: string;
}

/**
 * One name's outcome from an unset. `removed: false` is a name that was not set on the
 * instance — a typo answered honestly rather than echoed back as work done.
 */
export interface SecretRemoval {
  readonly name: string;
  readonly removed: boolean;
}

/**
 * One listed secret: its name and the digest of its value. The digest is opaque and
 * comparable — it answers "did this change since I set it" — and is the closest a value
 * ever comes to leaving the instance's host, which is not close at all.
 */
export interface SecretListing {
  readonly name: string;
  readonly digest: string | null;
}

export interface ControlPlaneClient {
  createInstance(input: {
    readonly slug: string;
    readonly idempotencyKey: string;
  }): Promise<{ instance: Instance; operation: Operation }>;
  getInstance(id: string): Promise<Instance>;
  listInstances(): Promise<readonly Instance[]>;
  /**
   * `operation` is nullable here and nowhere else, mirroring the control plane exactly: a
   * DELETE of an instance already in a terminal delete state answers with the operation
   * that got it there, and that is `null` when it reached that state by some path other
   * than this API. `POST /v1/instances` cannot return null: it 409s rather than answering
   * for a terminal-delete instance.
   */
  deleteInstance(input: {
    readonly id: string;
    readonly idempotencyKey: string;
  }): Promise<{ instance: Instance; operation: Operation | null }>;
  /**
   * Sets warehouse secrets on an instance and rolls it onto them.
   *
   * `values` is the only place in this CLI a customer's warehouse credential is held, and
   * it is held for the length of one request. The response carries names and an operation;
   * the control plane has no field that could return a value, and no endpoint that reads
   * one back.
   */
  setInstanceSecrets(input: {
    readonly id: string;
    readonly values: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<{ instance: Instance; operation: Operation; secrets: readonly SecretName[] }>;
  /**
   * Removes warehouse secrets from an instance and rolls it off them. Names only, in both
   * directions — there was never a value in this request to begin with.
   */
  unsetInstanceSecrets(input: {
    readonly id: string;
    readonly names: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<{ instance: Instance; operation: Operation; secrets: readonly SecretRemoval[] }>;
  /** The instance's customer-owned secrets: names and digests. A read — no operation. */
  listInstanceSecrets(id: string): Promise<{ instance: Instance; secrets: readonly SecretListing[] }>;
  getOperation(id: string): Promise<Operation>;
}

/** The `apiFetch` shape, narrowed to how this client calls it. Injectable for tests. */
export type CloudFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ControlPlaneClientOptions {
  readonly apiUrl: string;
  /** Supplies a bearer token; the cached M2M token source in token-source.ts. */
  readonly getAccessToken: () => Promise<string>;
  /** Defaults to `apiFetch`, so the user agent and the upgrade-required decode are on. */
  readonly fetch?: CloudFetch;
  /** Test seams for the transient retry; both default to real behavior. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
}

/**
 * A request that failed for a reason a second identical attempt could survive: the
 * connection never landed, or the answer came from in front of the control plane rather
 * than from it (a 5xx from something in front, a 429). Retrying these is what makes the
 * `Idempotency-Key` load-bearing — the same key on the same attempt is how a create that
 * may or may not have reached the server resolves to one instance instead of a 409 on a
 * slug the caller themselves took.
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * A `fetch` that rejected — DNS, TCP, TLS, a dropped connection. It never reached the
 * control plane, or reached it and lost the answer; either way the same key can be sent
 * again. A `ControlPlaneError` is not one of these: it is an answer, not a failure to get
 * one, and is classified by its status instead.
 */
function isNetworkError(error: unknown): boolean {
  // `fetch` reports every transport failure as a `TypeError` ("fetch failed"), with the
  // real cause on `.cause`.
  return error instanceof TypeError;
}

const NON_JSON_DETAIL =
  "the control plane returned a body that is not JSON; check that MALLOYYO_API_URL points " +
  "at the control plane and not at something in front of it";

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/** Empty body, or `NOT_JSON` for a body that did not parse. */
const NOT_JSON = Symbol("not-json");

function parseBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

export function createControlPlaneClient(options: ControlPlaneClientOptions): ControlPlaneClient {
  const doFetch: CloudFetch = options.fetch ?? apiFetch;
  const base = options.apiUrl.replace(/\/+$/, "");
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  /** One attempt. Throws `ControlPlaneError` for any non-2xx; never parses past a failure. */
  async function attempt(
    method: string,
    path: string,
    extra?: { readonly idempotencyKey?: string; readonly body?: unknown },
  ): Promise<unknown> {
    const token = await options.getAccessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    if (extra?.idempotencyKey !== undefined) headers["idempotency-key"] = extra.idempotencyKey;
    if (extra?.body !== undefined) headers["content-type"] = "application/json";

    const response = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(extra?.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
    });

    // The status is read before the body, and survives a body that is not JSON. The control
    // plane always answers `{ error, message? }`, but not everything that can answer this
    // request is the control plane: a proxy or CDN in front of it can return an HTML error
    // page, and MALLOYYO_API_URL can point at something else entirely. On those the status
    // is the whole diagnosis, so parsing must never be what decides whether the caller
    // sees it.
    const parsed = parseBody(await response.text());

    if (!response.ok) {
      // Error bodies are `{ error: <code>, message? }`; the message is the detail when the
      // server chose to send one, otherwise the code stands alone.
      const body = parsed === NOT_JSON ? undefined : parsed;
      const code = isRecord(body) && typeof body.error === "string" ? body.error : "error";
      const detail =
        isRecord(body) && typeof body.message === "string"
          ? body.message
          : parsed === NOT_JSON
            ? NON_JSON_DETAIL
            : code;
      throw new ControlPlaneError(response.status, code, detail);
    }
    if (parsed === NOT_JSON) {
      throw new ControlPlaneError(response.status, "invalid_response", NON_JSON_DETAIL);
    }
    return parsed;
  }

  /**
   * The attempt, retried on a transient failure under the *same* Idempotency-Key — which is
   * the only thing that makes retrying a create or a delete safe, and the only reason the
   * header is sent at all.
   */
  async function request(
    method: string,
    path: string,
    extra?: { readonly idempotencyKey?: string; readonly body?: unknown },
  ): Promise<unknown> {
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      try {
        return await attempt(method, path, extra);
      } catch (error) {
        const transient =
          error instanceof ControlPlaneError
            ? isTransientStatus(error.status)
            : isNetworkError(error);
        if (!transient || attemptNumber >= maxAttempts) throw error;
      }
      // The backoff sits after the catch, not inside it: awaited work on an error path can
      // throw over the error already in flight, and here that would replace the failure
      // being retried with whatever the timer did. Leaving the catch first is also the
      // honest shape — this is the wait before the next attempt, not cleanup after a failed
      // one.
      await sleep(RETRY_BASE_DELAY_MS * attemptNumber);
    }
  }

  function expectRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) {
      throw new Error("the control plane returned a response that was not a JSON object");
    }
    return value;
  }

  /**
   * Projects one documented field, refusing a shape the contract does not allow rather than
   * casting and letting the caller trip over `undefined` several frames later. The error
   * names the field, so a MALLOYYO_API_URL pointing at some other JSON API reads as a
   * wrong-endpoint problem instead of a `TypeError`.
   */
  function expectField<T>(body: Record<string, unknown>, field: string): T {
    const value = body[field];
    if (!isRecord(value) && !Array.isArray(value)) {
      throw new Error(`the control plane's response carried no \`${field}\``);
    }
    return value as T;
  }

  return {
    async createInstance({ slug, idempotencyKey }) {
      const body = expectRecord(
        await request("POST", "/v1/instances", { idempotencyKey, body: { slug } }),
      );
      return {
        instance: expectField<Instance>(body, "instance"),
        operation: expectField<Operation>(body, "operation"),
      };
    },
    async getInstance(id) {
      const body = expectRecord(await request("GET", `/v1/instances/${encodeURIComponent(id)}`));
      return expectField<Instance>(body, "instance");
    },
    async listInstances() {
      const body = expectRecord(await request("GET", "/v1/instances"));
      return expectField<Instance[]>(body, "instances");
    },
    async deleteInstance({ id, idempotencyKey }) {
      const body = expectRecord(
        await request("DELETE", `/v1/instances/${encodeURIComponent(id)}`, { idempotencyKey }),
      );
      return {
        instance: expectField<Instance>(body, "instance"),
        // Documented as nullable on this endpoint alone; see `ControlPlaneClient`.
        operation: body.operation === null ? null : expectField<Operation>(body, "operation"),
      };
    },
    async setInstanceSecrets({ id, values, idempotencyKey }) {
      const body = expectRecord(
        await request("POST", `/v1/instances/${encodeURIComponent(id)}/secrets`, {
          idempotencyKey,
          body: { secrets: values },
        }),
      );
      return {
        instance: expectField<Instance>(body, "instance"),
        operation: expectField<Operation>(body, "operation"),
        secrets: expectField<SecretName[]>(body, "secrets"),
      };
    },
    async unsetInstanceSecrets({ id, names, idempotencyKey }) {
      const body = expectRecord(
        await request("DELETE", `/v1/instances/${encodeURIComponent(id)}/secrets`, {
          idempotencyKey,
          body: { names },
        }),
      );
      return {
        instance: expectField<Instance>(body, "instance"),
        operation: expectField<Operation>(body, "operation"),
        secrets: expectField<SecretRemoval[]>(body, "secrets"),
      };
    },
    async listInstanceSecrets(id) {
      const body = expectRecord(
        await request("GET", `/v1/instances/${encodeURIComponent(id)}/secrets`),
      );
      return {
        instance: expectField<Instance>(body, "instance"),
        secrets: expectField<SecretListing[]>(body, "secrets"),
      };
    },
    async getOperation(id) {
      const body = expectRecord(await request("GET", `/v1/operations/${encodeURIComponent(id)}`));
      return expectField<Operation>(body, "operation");
    },
  };
}
